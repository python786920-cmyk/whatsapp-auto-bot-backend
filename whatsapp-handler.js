const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');

class WhatsAppHandler extends EventEmitter {
    constructor(sessionId, logger) {
        super();
        this.sessionId = sessionId;
        this.logger = logger;
        this.client = null;
        this.isReady = false;
        this.isConnected = false;
        this.lastMessageTime = new Map();
        this.replyCount = 0;
        this.messageCount = 0;
        
        // AI Configuration
        this.geminiApiKey = process.env.GEMINI_API_KEY;
        this.geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
        
        // Rate limiting
        this.minReplyInterval = 20000; // 1 minute
        this.maxRepliesPerHour = 60;
        this.hourlyReplyCount = 0;
        this.lastHourReset = Date.now();
        
        // Auto-reply settings
        this.autoReplyEnabled = true;
        this.typingDelayPerChar = 25;
        this.baseTypingDelay = 1500;
        
        // Session directory
        this.sessionDir = path.join(__dirname, 'sessions', sessionId);
        this.ensureSessionDirectory();
    }

    ensureSessionDirectory() {
        try {
            if (!fs.existsSync(this.sessionDir)) {
                fs.mkdirSync(this.sessionDir, { recursive: true });
                this.logger.info(`Session directory created: ${this.sessionDir}`);
            }
        } catch (error) {
            this.logger.error('Session directory creation failed:', error);
        }
    }

    async initialize() {
        try {
            this.logger.info(`Initializing WhatsApp client for session: ${this.sessionId}`);

            // Initialize client with NO Chrome path (let it use bundled Chromium)
            this.client = new Client({
                authStrategy: new LocalAuth({
                    clientId: this.sessionId,
                    dataPath: this.sessionDir
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-extensions',
                        '--disable-plugins',
                        '--disable-default-apps',
                        '--disable-sync',
                        '--hide-scrollbars',
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--memory-pressure-off'
                    ]
                    // NO executablePath - let Puppeteer use bundled Chromium
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
                }
            });

            this.setupEventListeners();
            await this.client.initialize();
            
            // Reset hourly counter
            setInterval(() => {
                this.hourlyReplyCount = 0;
                this.lastHourReset = Date.now();
                this.logger.info('Hourly reply count reset');
            }, 60 * 60 * 1000);

        } catch (error) {
            this.logger.error('WhatsApp initialization failed:', error);
            this.emit('error', error);
            throw error;
        }
    }

    setupEventListeners() {
        // QR Code generation
        this.client.on('qr', async (qr) => {
            try {
                this.logger.info('QR Code received, generating base64...');
                const qrImage = await qrcode.toDataURL(qr, { 
                    width: 300,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
                this.logger.info('QR Code base64 generated successfully');
                this.emit('qr', qrImage);
            } catch (error) {
                this.logger.error('QR code generation error:', error);
                this.emit('error', error);
            }
        });

        // Authentication events
        this.client.on('authenticated', () => {
            this.logger.info('WhatsApp authenticated successfully');
            this.isConnected = true;
            this.emit('authenticated');
        });

        this.client.on('auth_failure', (msg) => {
            this.logger.error('Authentication failed:', msg);
            this.isConnected = false;
            this.emit('auth_failure', msg);
        });

        // Ready event
        this.client.on('ready', () => {
            this.logger.info('WhatsApp Client is ready!');
            this.isReady = true;
            this.emit('ready');
            
            // Log client info
            this.client.info.then(info => {
                this.logger.info(`Connected as: ${info.pushname} (${info.wid.user})`);
            }).catch(() => {
                this.logger.info('Connected successfully');
            });
        });

        // Disconnection event
        this.client.on('disconnected', (reason) => {
            this.logger.warn(`WhatsApp disconnected: ${reason}`);
            this.isReady = false;
            this.isConnected = false;
            this.emit('disconnected', reason);
        });

        // Message handling
        this.client.on('message', async (message) => {
            try {
                await this.handleIncomingMessage(message);
            } catch (error) {
                this.logger.error('Message handling error:', error);
            }
        });

        // Group join event
        this.client.on('group_join', (notification) => {
            this.logger.info(`Joined group: ${notification.chatId}`);
        });

        // Call handling
        this.client.on('call', async (call) => {
            this.logger.info(`Incoming call from: ${call.from}`);
            try {
                await call.reject();
                this.logger.info('Call rejected');
            } catch (error) {
                this.logger.error('Call reject error:', error);
            }
        });
    }

    async handleIncomingMessage(message) {
        try {
            // Skip status and own messages
            if (message.isStatus || message.fromMe) {
                return;
            }

            this.messageCount++;
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            this.logger.info(`📨 Message from: ${contact.pushname || contact.number}`);
            this.logger.info(`💬 Content: ${message.body}`);

            // Emit message received
            this.emit('message_received', {
                from: message.from,
                fromName: contact.pushname || contact.number,
                body: message.body,
                timestamp: message.timestamp,
                isGroup: chat.isGroup
            });

            // Auto-reply check
            if (this.shouldAutoReply(message, contact, chat)) {
                await this.sendAutoReply(message, contact, chat);
            }

        } catch (error) {
            this.logger.error('Message handling error:', error);
        }
    }

    shouldAutoReply(message, contact, chat) {
        // Check if auto-reply enabled
        if (!this.autoReplyEnabled) return false;

        // Skip group messages
        if (chat.isGroup) {
            this.logger.info('Skipping group message');
            return false;
        }

        // Check hourly limit
        if (this.hourlyReplyCount >= this.maxRepliesPerHour) {
            this.logger.info('Hourly limit reached');
            return false;
        }

        // Check per-user rate limit
        const lastReplyTime = this.lastMessageTime.get(message.from) || 0;
        if (Date.now() - lastReplyTime < this.minReplyInterval) {
            this.logger.info(`Rate limit for ${contact.pushname || contact.number}`);
            return false;
        }

        // Skip empty messages
        if (!message.body || message.body.trim().length < 2) {
            this.logger.info('Skipping empty/short message');
            return false;
        }

        return true;
    }

    async sendAutoReply(message, contact, chat) {
        try {
            this.logger.info(`🤖 Generating reply for: ${contact.pushname || contact.number}`);

            // Show typing
            await chat.sendStateTyping();

            // Generate AI response
            const aiResponse = await this.generateAIResponse(message.body, contact.pushname || 'Friend');
            
            if (!aiResponse) {
                this.logger.warn('No AI response generated');
                return;
            }

            // Realistic typing delay
            const typingDuration = this.calculateTypingDelay(aiResponse);
            await this.sleep(typingDuration);

            // Send message
            await chat.clearState();
            await chat.sendMessage(aiResponse);

            // Update counters
            this.replyCount++;
            this.hourlyReplyCount++;
            this.lastMessageTime.set(message.from, Date.now());

            this.logger.info(`✅ Reply sent: ${aiResponse}`);

            // Emit reply sent event
            this.emit('reply_sent', {
                to: message.from,
                toName: contact.pushname || contact.number,
                originalMessage: message.body,
                reply: aiResponse,
                timestamp: Date.now()
            });

        } catch (error) {
            this.logger.error('Auto-reply error:', error);
            
            // Send fallback
            try {
                await chat.clearState();
                const fallback = this.getFallbackMessage();
                await chat.sendMessage(fallback);
                this.logger.info('Fallback message sent');
            } catch (fallbackError) {
                this.logger.error('Fallback failed:', fallbackError);
            }
        }
    }

    async generateAIResponse(userMessage, userName) {
        try {
            if (!this.geminiApiKey) {
                this.logger.warn('Gemini API key missing');
                return this.getFallbackMessage();
            }

            const prompt = this.createHumanPrompt(userMessage, userName);

            const requestBody = {
                contents: [{
                    parts: [{ text: prompt }]
                }],
                generationConfig: {
                    temperature: 0.9,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 150
                },
                safetySettings: [
                    {
                        category: "HARM_CATEGORY_HARASSMENT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    }
                ]
            };

            const response = await axios.post(
                `${this.geminiEndpoint}?key=${this.geminiApiKey}`,
                requestBody,
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                }
            );

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                const aiReply = response.data.candidates[0].content.parts[0].text.trim();
                this.logger.info('✨ AI response generated');
                return this.cleanupAIResponse(aiReply);
            } else {
                this.logger.warn('Invalid AI response structure');
                return this.getFallbackMessage();
            }

        } catch (error) {
            this.logger.error('Gemini API error:', error.message);
            return this.getFallbackMessage();
        }
    }

    createHumanPrompt(userMessage, userName) {
        const prompts = [
            `You are chatting with your friend ${userName}. Reply naturally in a friendly, casual way. Keep it short (1-2 sentences). Mix English and Hindi naturally if it feels right.

User: "${userMessage}"

Reply:`,

            `Act like a close friend talking to ${userName}. Be warm, helpful, and natural. Use casual language. Keep response brief and conversational.

They said: "${userMessage}"

Your reply:`,

            `You're having a casual chat with ${userName}. Reply like a real friend would - natural, brief, and friendly. Mix languages if it feels right.

Message: "${userMessage}"

Response:`
        ];

        return prompts[Math.floor(Math.random() * prompts.length)];
    }

    cleanupAIResponse(response) {
        let cleaned = response
            .replace(/\*\*/g, '')
            .replace(/\*/g, '')
            .replace(/#{1,6}\s/g, '')
            .replace(/```[\s\S]*?```/g, '')
            .trim();

        if (cleaned.length > 200) {
            cleaned = cleaned.substring(0, 200) + '...';
        }

        return cleaned;
    }

    getFallbackMessage() {
        const fallbacks = [
            "Hey! Thanks for the message 😊 Will reply properly soon!",
            "Got your message! Currently busy but will get back to you 👍",
            "Hi there! Message received. Will respond ASAP ⚡",
            "Hey buddy! Got it. Will reply soon 😄",
            "Thanks for reaching out! Will get back to you shortly 🙌",
            "Message received! Currently occupied but will reply soon 📱"
        ];
        
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    calculateTypingDelay(message) {
        const baseDelay = this.baseTypingDelay;
        const charDelay = message.length * this.typingDelayPerChar;
        const randomFactor = 0.5 + Math.random();
        
        const totalDelay = (baseDelay + charDelay) * randomFactor;
        return Math.max(2000, Math.min(8000, totalDelay));
    }

    async sendMessage(number, message) {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client not ready');
            }

            const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
            const sentMessage = await this.client.sendMessage(formattedNumber, message);
            
            this.logger.info(`📤 Message sent to: ${number}`);
            return sentMessage;

        } catch (error) {
            this.logger.error('Send message error:', error);
            throw error;
        }
    }

    async logout() {
        try {
            if (this.client) {
                await this.client.logout();
                this.logger.info('WhatsApp logged out');
            }
        } catch (error) {
            this.logger.error('Logout error:', error);
            throw error;
        }
    }

    async destroy() {
        try {
            if (this.client) {
                await this.client.destroy();
                this.logger.info('WhatsApp client destroyed');
            }
            this.isReady = false;
            this.isConnected = false;
        } catch (error) {
            this.logger.error('Destroy error:', error);
            throw error;
        }
    }

    // Utility methods
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    isClientReady() {
        return this.isReady && this.client;
    }

    getStats() {
        return {
            messageCount: this.messageCount,
            replyCount: this.replyCount,
            hourlyReplies: this.hourlyReplyCount,
            isReady: this.isReady,
            isConnected: this.isConnected,
            activeChats: this.lastMessageTime.size
        };
    }

    setAutoReplyEnabled(enabled) {
        this.autoReplyEnabled = enabled;
        this.logger.info(`Auto-reply ${enabled ? 'enabled' : 'disabled'}`);
    }
}

module.exports = WhatsAppHandler;

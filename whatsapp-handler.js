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
        this.lastMessageTime = new Map(); // Rate limiting per user
        this.replyCount = 0;
        this.messageCount = 0;
        
        // AI Configuration
        this.geminiApiKey = process.env.GEMINI_API_KEY;
        this.geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
        
        // Rate limiting settings
        this.minReplyInterval = 60000; // 1 minute between replies per user
        this.maxRepliesPerHour = 30; // Maximum replies per hour globally
        this.hourlyReplyCount = 0;
        this.lastHourReset = Date.now();
        
        // Auto-reply settings
        this.autoReplyEnabled = true;
        this.typingDelayPerChar = 45; // milliseconds per character for realistic typing
        this.baseTypingDelay = 2000; // base delay before starting to type
        
        // Initialize session directory
        this.sessionDir = path.join(__dirname, 'sessions', sessionId);
        this.ensureSessionDirectory();
    }

    ensureSessionDirectory() {
        try {
            if (!fs.existsSync(this.sessionDir)) {
                fs.mkdirSync(this.sessionDir, { recursive: true });
                this.logger.info(`Created session directory: ${this.sessionDir}`);
            }
        } catch (error) {
            this.logger.error('Failed to create session directory:', error);
        }
    }

    async initialize() {
        try {
            this.logger.info(`Initializing WhatsApp client for session: ${this.sessionId}`);

            // Initialize WhatsApp client with LocalAuth
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
                        '--disable-features=VizDisplayCompositor'
                    ],
                    executablePath: process.env.CHROME_BIN || undefined
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                }
            });

            this.setupEventListeners();
            await this.client.initialize();
            
            // Reset hourly counter every hour
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
                this.logger.info('QR Code received, generating base64 image...');
                const qrImage = await qrcode.toDataURL(qr, { 
                    width: 256,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });
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

        // Call event handling
        this.client.on('call', async (call) => {
            this.logger.info(`Incoming call from: ${call.from}`);
            try {
                await call.reject();
                this.logger.info('Call rejected automatically');
            } catch (error) {
                this.logger.error('Error rejecting call:', error);
            }
        });
    }

    async handleIncomingMessage(message) {
        try {
            // Skip if message is from status broadcast or own messages
            if (message.isStatus || message.fromMe) {
                return;
            }

            this.messageCount++;
            const contact = await message.getContact();
            const chat = await message.getChat();
            
            this.logger.info(`📨 New message from: ${contact.pushname || contact.number} (${message.from})`);
            this.logger.info(`💬 Message: ${message.body}`);

            // Emit message received event
            this.emit('message_received', {
                from: message.from,
                fromName: contact.pushname || contact.number,
                body: message.body,
                timestamp: message.timestamp,
                isGroup: chat.isGroup
            });

            // Check if auto-reply is enabled and should reply
            if (this.shouldAutoReply(message, contact, chat)) {
                await this.sendAutoReply(message, contact, chat);
            }

        } catch (error) {
            this.logger.error('Error handling incoming message:', error);
        }
    }

    shouldAutoReply(message, contact, chat) {
        // Don't reply if auto-reply is disabled
        if (!this.autoReplyEnabled) {
            return false;
        }

        // Don't reply to group messages (optional - can be configured)
        if (chat.isGroup) {
            this.logger.info('Skipping group message auto-reply');
            return false;
        }

        // Rate limiting: Check global hourly limit
        if (this.hourlyReplyCount >= this.maxRepliesPerHour) {
            this.logger.info('Hourly reply limit reached, skipping auto-reply');
            return false;
        }

        // Rate limiting: Check per-user time limit
        const lastReplyTime = this.lastMessageTime.get(message.from) || 0;
        const timeSinceLastReply = Date.now() - lastReplyTime;
        
        if (timeSinceLastReply < this.minReplyInterval) {
            this.logger.info(`Rate limit: Too soon to reply to ${contact.pushname || contact.number}`);
            return false;
        }

        // Skip empty messages or media-only messages without caption
        if (!message.body || message.body.trim().length === 0) {
            this.logger.info('Skipping empty message');
            return false;
        }

        // Skip if message is too short (might be accidental)
        if (message.body.trim().length < 2) {
            this.logger.info('Skipping very short message');
            return false;
        }

        return true;
    }

    async sendAutoReply(message, contact, chat) {
        try {
            this.logger.info(`🤖 Generating AI reply for: ${contact.pushname || contact.number}`);

            // Show typing indicator
            await chat.sendStateTyping();

            // Generate AI response
            const aiResponse = await this.generateAIResponse(message.body, contact.pushname || 'Friend');
            
            if (!aiResponse) {
                this.logger.warn('No AI response generated');
                return;
            }

            // Calculate realistic typing delay
            const typingDuration = this.calculateTypingDelay(aiResponse);
            await this.sleep(typingDuration);

            // Stop typing and send message
            await chat.clearState();
            await chat.sendMessage(aiResponse);

            // Update counters and timestamps
            this.replyCount++;
            this.hourlyReplyCount++;
            this.lastMessageTime.set(message.from, Date.now());

            this.logger.info(`✅ Auto-reply sent to: ${contact.pushname || contact.number}`);
            this.logger.info(`🤖 Reply: ${aiResponse}`);

            // Emit reply sent event
            this.emit('reply_sent', {
                to: message.from,
                toName: contact.pushname || contact.number,
                originalMessage: message.body,
                reply: aiResponse,
                timestamp: Date.now()
            });

        } catch (error) {
            this.logger.error('Error sending auto-reply:', error);
            
            // Send fallback message on error
            try {
                await chat.clearState();
                const fallbackMessage = this.getFallbackMessage();
                await chat.sendMessage(fallbackMessage);
                this.logger.info('Fallback message sent');
            } catch (fallbackError) {
                this.logger.error('Fallback message failed:', fallbackError);
            }
        }
    }

    async generateAIResponse(userMessage, userName) {
        try {
            if (!this.geminiApiKey) {
                this.logger.warn('Gemini API key not configured');
                return this.getFallbackMessage();
            }

            // Create human-like prompt
            const prompt = this.createHumanPrompt(userMessage, userName);

            const requestBody = {
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }],
                generationConfig: {
                    temperature: 0.9,
                    topK: 40,
                    topP: 0.95,
                    maxOutputTokens: 150,
                    stopSequences: []
                },
                safetySettings: [
                    {
                        category: "HARM_CATEGORY_HARASSMENT",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    },
                    {
                        category: "HARM_CATEGORY_HATE_SPEECH",
                        threshold: "BLOCK_MEDIUM_AND_ABOVE"
                    }
                ]
            };

            const response = await axios.post(
                `${this.geminiEndpoint}?key=${this.geminiApiKey}`,
                requestBody,
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.candidates && response.data.candidates[0]) {
                const aiReply = response.data.candidates[0].content.parts[0].text.trim();
                this.logger.info('✨ AI response generated successfully');
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
            `You are a friendly, helpful person chatting with your friend ${userName}. Reply naturally in a conversational way. Keep responses short (1-2 sentences max). Mix English and Hindi naturally (Hinglish style). Be warm and casual like a real friend.

User message: "${userMessage}"

Reply as a friend would:`,

            `Act like a close friend replying to ${userName}. Be natural, warm, and helpful. Use casual language mixing English-Hindi. Keep it brief and conversational.

Their message: "${userMessage}"

Your friendly reply:`,

            `You're chatting with your buddy ${userName}. Reply like a real friend - casual, helpful, and natural. Use Hinglish if it feels right. Keep it short and sweet.

They said: "${userMessage}"

Reply:`
        ];

        return prompts[Math.floor(Math.random() * prompts.length)];
    }

    cleanupAIResponse(response) {
        // Remove any formatting artifacts
        let cleaned = response
            .replace(/\*\*/g, '') // Remove bold markers
            .replace(/\*/g, '') // Remove italic markers
            .replace(/#{1,6}\s/g, '') // Remove headers
            .replace(/```[\s\S]*?```/g, '') // Remove code blocks
            .trim();

        // Limit length for WhatsApp
        if (cleaned.length > 200) {
            cleaned = cleaned.substring(0, 200) + '...';
        }

        return cleaned;
    }

    getFallbackMessage() {
        const fallbacks = [
            "Hey! Thanks for the message yaar 😊 Thoda busy hun abhi, will reply properly soon!",
            "Arre sorry, thoda issue ho gaya. What's up? Tell me properly!",
            "Hey buddy! Got your message. Kya baat hai? Bolo na 😄",
            "Hi there! Received your text. Will get back to you soon! 👍",
            "Yaar, AI thoda confused ho gaya 😅 Can you say that again?",
            "Hey! Message received. Currently busy but will reply ASAP! ⚡"
        ];
        
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    calculateTypingDelay(message) {
        const baseDelay = this.baseTypingDelay;
        const charDelay = message.length * this.typingDelayPerChar;
        const randomFactor = 0.5 + Math.random(); // 50% to 150% of calculated time
        
        const totalDelay = (baseDelay + charDelay) * randomFactor;
        
        // Cap between 2-8 seconds for realistic feeling
        return Math.max(2000, Math.min(8000, totalDelay));
    }

    async sendMessage(number, message) {
        try {
            if (!this.isReady) {
                throw new Error('WhatsApp client is not ready');
            }

            // Format number for WhatsApp
            const formattedNumber = number.includes('@c.us') ? number : `${number}@c.us`;
            
            // Send message
            const sentMessage = await this.client.sendMessage(formattedNumber, message);
            
            this.logger.info(`📤 Manual message sent to: ${number}`);
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
                this.logger.info('WhatsApp client logged out successfully');
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
                this.logger.info('WhatsApp client destroyed successfully');
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
            activeChats: this.lastMessageTime.size,
            lastHourReset: new Date(this.lastHourReset).toISOString()
        };
    }

    // Configuration methods
    setAutoReplyEnabled(enabled) {
        this.autoReplyEnabled = enabled;
        this.logger.info(`Auto-reply ${enabled ? 'enabled' : 'disabled'}`);
    }

    setReplyInterval(intervalMs) {
        this.minReplyInterval = intervalMs;
        this.logger.info(`Reply interval set to: ${intervalMs}ms`);
    }

    setMaxRepliesPerHour(maxReplies) {
        this.maxRepliesPerHour = maxReplies;
        this.logger.info(`Max replies per hour set to: ${maxReplies}`);
    }
}

module.exports = WhatsAppHandler;

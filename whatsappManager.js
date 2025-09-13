const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs').promises;
const path = require('path');

const AIService = require('./aiService');
const SessionStore = require('./sessionStore');
const RateLimiter = require('./ratelimiter');
const { logger, delay, generateTypingDelay } = require('./utils');

class WhatsAppManager {
    constructor(io) {
        this.io = io;
        this.clients = new Map();
        this.sessions = new Map();
        this.aiService = new AIService();
        this.sessionStore = new SessionStore();
        this.rateLimiter = new RateLimiter();
        
        // Ensure data directory exists
        this.initializeDataDirectory();
    }

    async initializeDataDirectory() {
        const dataDir = path.join(__dirname, 'data', 'sessions');
        try {
            await fs.mkdir(dataDir, { recursive: true });
        } catch (error) {
            logger.error('Error creating data directory:', error);
        }
    }

    async createSession(clientId) {
        try {
            if (this.clients.has(clientId)) {
                throw new Error(`Session ${clientId} already exists`);
            }

            logger.info(`Creating new session: ${clientId}`);

            // Create WhatsApp client with LocalAuth
            const client = new Client({
                authStrategy: new LocalAuth({ 
                    clientId: clientId,
                    dataPath: path.join(__dirname, 'data', 'sessions')
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
                        '--disable-gpu'
                    ]
                },
                webVersionCache: {
                    type: 'remote',
                    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
                }
            });

            // Store client and session info
            this.clients.set(clientId, client);
            this.sessions.set(clientId, {
                id: clientId,
                status: 'initializing',
                createdAt: new Date(),
                lastActivity: new Date()
            });

            // Set up event handlers
            this.setupClientEvents(clientId, client);

            // Initialize client
            await client.initialize();

            return {
                clientId,
                status: 'initializing',
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            logger.error(`Error creating session ${clientId}:`, error);
            this.cleanupSession(clientId);
            throw error;
        }
    }

    setupClientEvents(clientId, client) {
        // QR Code event
        client.on('qr', async (qr) => {
            try {
                logger.info(`QR code generated for ${clientId}`);
                
                const qrBase64 = await QRCode.toDataURL(qr, {
                    width: 280,
                    margin: 2,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });

                // Update session status
                this.updateSessionStatus(clientId, 'qr_generated');

                // Emit QR to frontend
                this.io.to(`session_${clientId}`).emit('qr', {
                    clientId,
                    qrBase64,
                    expiresAt: Date.now() + 60000 // 60 seconds
                });

            } catch (error) {
                logger.error(`Error generating QR for ${clientId}:`, error);
                this.io.to(`session_${clientId}`).emit('error', {
                    message: 'Failed to generate QR code'
                });
            }
        });

        // Ready event - WhatsApp connected
        client.on('ready', async () => {
            logger.info(`WhatsApp client ${clientId} is ready`);
            
            this.updateSessionStatus(clientId, 'connected');
            
            // Get client info
            const clientInfo = client.info;
            
            this.io.to(`session_${clientId}`).emit('connected', {
                clientId,
                clientInfo: {
                    wid: clientInfo.wid._serialized,
                    pushname: clientInfo.pushname,
                    platform: clientInfo.platform
                },
                timestamp: new Date().toISOString()
            });

            // Store session metadata
            await this.sessionStore.saveSessionMetadata(clientId, {
                status: 'connected',
                clientInfo,
                connectedAt: new Date()
            });
        });

        // Message received event
        client.on('message_create', async (message) => {
            try {
                // Skip if message is from status broadcast or groups (optional)
                if (message.from === 'status@broadcast') return;
                
                // Skip if message is from the bot itself
                if (message.fromMe) {
                    // Emit to frontend for sent message tracking
                    this.io.to(`session_${clientId}`).emit('message_sent', {
                        clientId,
                        to: message.to,
                        message: message.body,
                        timestamp: new Date(message.timestamp * 1000).toISOString()
                    });
                    return;
                }

                logger.info(`Message received on ${clientId} from ${message.from}: ${message.body}`);

                // Update last activity
                this.updateSessionActivity(clientId);

                // Emit to frontend
                this.io.to(`session_${clientId}`).emit('message_received', {
                    clientId,
                    from: message.from,
                    message: message.body,
                    timestamp: new Date(message.timestamp * 1000).toISOString()
                });

                // Process message for AI response
                await this.processIncomingMessage(clientId, message);

            } catch (error) {
                logger.error(`Error processing message on ${clientId}:`, error);
            }
        });

        // Authentication failure
        client.on('auth_failure', (msg) => {
            logger.error(`Auth failure for ${clientId}:`, msg);
            this.updateSessionStatus(clientId, 'auth_failed');
            
            this.io.to(`session_${clientId}`).emit('error', {
                message: 'Authentication failed. Please scan QR code again.'
            });
        });

        // Disconnected event
        client.on('disconnected', (reason) => {
            logger.warn(`Client ${clientId} disconnected:`, reason);
            this.updateSessionStatus(clientId, 'disconnected');
            
            this.io.to(`session_${clientId}`).emit('disconnected', {
                clientId,
                reason,
                timestamp: new Date().toISOString()
            });
        });

        // Loading screen event
        client.on('loading_screen', (percent, message) => {
            logger.info(`Loading ${clientId}: ${percent}% - ${message}`);
            
            this.io.to(`session_${clientId}`).emit('loading', {
                clientId,
                percent,
                message
            });
        });
    }

    async processIncomingMessage(clientId, message) {
        try {
            const chat = await message.getChat();
            const contact = await message.getContact();
            
            // Check rate limiting
            const senderId = message.from;
            if (!this.rateLimiter.checkLimit(senderId)) {
                logger.warn(`Rate limit exceeded for ${senderId}`);
                
                // Send rate limit message
                const rateLimitMsg = "Sorry yaar, thoda slow karo. Main bohot messages mil rahe hain. 1 minute baad try karo! 🙏";
                await this.sendTypingMessage(clientId, chat, rateLimitMsg);
                return;
            }

            // Save incoming message to history
            await this.sessionStore.saveMessage(clientId, senderId, {
                id: message.id._serialized,
                from: message.from,
                to: message.to,
                body: message.body,
                type: message.type,
                timestamp: new Date(message.timestamp * 1000),
                fromMe: false
            });

            // Get conversation history for context
            const conversationHistory = await this.sessionStore.getConversationHistory(
                clientId, 
                senderId, 
                6 // Last 6 messages for context
            );

            // Generate AI response
            const aiResponse = await this.aiService.generateAdvancedResponse({
                message: message.body,
                sender: contact.name || contact.pushname || senderId,
                conversationHistory,
                language: this.detectLanguage(message.body)
            });

            if (aiResponse) {
                // Send response with typing simulation
                await this.sendTypingMessage(clientId, chat, aiResponse);

                // Save AI response to history
                await this.sessionStore.saveMessage(clientId, senderId, {
                    id: Date.now().toString(),
                    from: message.to, // Bot's number
                    to: message.from,
                    body: aiResponse,
                    type: 'chat',
                    timestamp: new Date(),
                    fromMe: true,
                    aiGenerated: true
                });
            }

        } catch (error) {
            logger.error(`Error processing incoming message:`, error);
            
            // Send fallback message
            try {
                const chat = await message.getChat();
                const fallbackMsg = "Sorry yaar, kuch technical issue ho gaya. Thoda time baad try karo! 🤖";
                await this.sendTypingMessage(clientId, chat, fallbackMsg);
            } catch (fallbackError) {
                logger.error('Error sending fallback message:', fallbackError);
            }
        }
    }

    async sendTypingMessage(clientId, chat, message) {
        try {
            // Show typing indicator
            await chat.sendStateTyping();
            
            // Emit typing to frontend
            this.io.to(`session_${clientId}`).emit('typing', {
                clientId,
                chatId: chat.id._serialized
            });

            // Calculate typing delay (human-like)
            const typingDelay = generateTypingDelay(message);
            
            // Wait with random intervals
            const intervals = Math.floor(typingDelay / 1000);
            for (let i = 0; i < intervals; i++) {
                await delay(1000 + Math.random() * 500);
                
                // Refresh typing state periodically
                if (i % 3 === 0) {
                    await chat.clearState();
                    await delay(200);
                    await chat.sendStateTyping();
                }
            }

            // Clear typing and send message
            await chat.clearState();
            await chat.sendMessage(message);

            logger.info(`Message sent on ${clientId} to ${chat.id._serialized}: ${message.substring(0, 50)}...`);

        } catch (error) {
            logger.error('Error sending typing message:', error);
            throw error;
        }
    }

    detectLanguage(text) {
        // Simple language detection
        const hindiRegex = /[\u0900-\u097F]/;
        const englishWords = ['the', 'and', 'is', 'are', 'was', 'were', 'have', 'has', 'do', 'does'];
        const hindiWords = ['है', 'हैं', 'था', 'थे', 'करे', 'करो', 'क्या', 'कैसे'];
        
        if (hindiRegex.test(text)) return 'hindi';
        
        const lowerText = text.toLowerCase();
        const englishCount = englishWords.filter(word => lowerText.includes(word)).length;
        const hindiCount = hindiWords.filter(word => text.includes(word)).length;
        
        if (hindiCount > englishCount) return 'hindi';
        if (englishCount > 0) return 'english';
        
        return 'hinglish'; // Default to Hinglish
    }

    async sendMessage(clientId, to, message) {
        try {
            const client = this.clients.get(clientId);
            if (!client) {
                throw new Error(`Session ${clientId} not found`);
            }

            // Format phone number
            const formattedNumber = to.includes('@c.us') ? to : `${to}@c.us`;
            
            // Send message
            await client.sendMessage(formattedNumber, message);
            
            // Update activity
            this.updateSessionActivity(clientId);
            
            return { success: true, to: formattedNumber, message };
            
        } catch (error) {
            logger.error(`Error sending message from ${clientId}:`, error);
            throw error;
        }
    }

    async refreshQR(clientId) {
        try {
            const client = this.clients.get(clientId);
            if (!client) {
                throw new Error(`Session ${clientId} not found`);
            }

            // Destroy and recreate client
            await this.destroySession(clientId);
            await this.createSession(clientId);
            
        } catch (error) {
            logger.error(`Error refreshing QR for ${clientId}:`, error);
            throw error;
        }
    }

    async destroySession(clientId) {
        try {
            logger.info(`Destroying session: ${clientId}`);
            
            const client = this.clients.get(clientId);
            if (client) {
                await client.destroy();
            }
            
            this.cleanupSession(clientId);
            
        } catch (error) {
            logger.error(`Error destroying session ${clientId}:`, error);
            this.cleanupSession(clientId); // Force cleanup
        }
    }

    cleanupSession(clientId) {
        this.clients.delete(clientId);
        this.sessions.delete(clientId);
        
        // Cleanup rate limiter
        this.rateLimiter.cleanup(clientId);
    }

    updateSessionStatus(clientId, status) {
        const session = this.sessions.get(clientId);
        if (session) {
            session.status = status;
            session.lastActivity = new Date();
        }
    }

    updateSessionActivity(clientId) {
        const session = this.sessions.get(clientId);
        if (session) {
            session.lastActivity = new Date();
        }
    }

    getActiveSessions() {
        return Array.from(this.sessions.values());
    }

    async restoreExistingSessions() {
        try {
            logger.info('Restoring existing sessions...');
            
            const sessionsDir = path.join(__dirname, 'data', 'sessions');
            const sessionFolders = await fs.readdir(sessionsDir);
            
            for (const folder of sessionFolders) {
                if (folder.startsWith('session-')) {
                    const clientId = folder.replace('session-', '');
                    
                    try {
                        logger.info(`Restoring session: ${clientId}`);
                        await this.createSession(clientId);
                    } catch (error) {
                        logger.error(`Failed to restore session ${clientId}:`, error);
                    }
                }
            }
            
        } catch (error) {
            logger.error('Error restoring sessions:', error);
        }
    }

    async destroyAllSessions() {
        logger.info('Destroying all sessions...');
        
        const promises = Array.from(this.clients.keys()).map(clientId => 
            this.destroySession(clientId).catch(error => 
                logger.error(`Error destroying session ${clientId}:`, error)
            )
        );
        
        await Promise.all(promises);
    }
}

module.exports = WhatsAppManager;

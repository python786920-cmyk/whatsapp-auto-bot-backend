const fs = require('fs').promises;
const path = require('path');
const { logger } = require('./utils');

class SessionStore {
    constructor() {
        this.dataDir = path.join(__dirname, 'data', 'sessions');
        this.conversationsDir = path.join(__dirname, 'data', 'conversations');
        this.maxMessagesPerChat = 100;
        this.maxSessionAge = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
        
        this.initializeDirectories();
    }

    async initializeDirectories() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
            await fs.mkdir(this.conversationsDir, { recursive: true });
            logger.info('Session store directories initialized');
        } catch (error) {
            logger.error('Error initializing directories:', error);
        }
    }

    // Session Metadata Management
    async saveSessionMetadata(clientId, metadata) {
        try {
            const sessionFile = path.join(this.dataDir, `${clientId}_metadata.json`);
            
            const sessionData = {
                clientId,
                ...metadata,
                lastUpdated: new Date().toISOString()
            };

            await fs.writeFile(sessionFile, JSON.stringify(sessionData, null, 2));
            logger.info(`Session metadata saved for ${clientId}`);
            
            return sessionData;
        } catch (error) {
            logger.error(`Error saving session metadata for ${clientId}:`, error);
            throw error;
        }
    }

    async getSessionMetadata(clientId) {
        try {
            const sessionFile = path.join(this.dataDir, `${clientId}_metadata.json`);
            const data = await fs.readFile(sessionFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null; // Session doesn't exist
            }
            logger.error(`Error reading session metadata for ${clientId}:`, error);
            throw error;
        }
    }

    async getAllSessions() {
        try {
            const files = await fs.readdir(this.dataDir);
            const sessionFiles = files.filter(file => file.endsWith('_metadata.json'));
            
            const sessions = [];
            for (const file of sessionFiles) {
                try {
                    const filePath = path.join(this.dataDir, file);
                    const data = await fs.readFile(filePath, 'utf8');
                    const sessionData = JSON.parse(data);
                    sessions.push(sessionData);
                } catch (error) {
                    logger.warn(`Error reading session file ${file}:`, error);
                }
            }
            
            return sessions;
        } catch (error) {
            logger.error('Error getting all sessions:', error);
            return [];
        }
    }

    async deleteSession(clientId) {
        try {
            const sessionFile = path.join(this.dataDir, `${clientId}_metadata.json`);
            await fs.unlink(sessionFile);
            
            // Also delete conversation data
            await this.deleteAllConversations(clientId);
            
            logger.info(`Session ${clientId} deleted`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error(`Error deleting session ${clientId}:`, error);
            }
        }
    }

    // Conversation Management
    async saveMessage(sessionId, chatId, messageData) {
        try {
            const conversationFile = this.getConversationFilePath(sessionId, chatId);
            
            // Load existing conversation
            let conversation = await this.loadConversation(sessionId, chatId);
            
            // Add new message
            conversation.messages.push({
                ...messageData,
                id: messageData.id || Date.now().toString(),
                timestamp: messageData.timestamp || new Date(),
                savedAt: new Date()
            });

            // Keep only last N messages to prevent file bloat
            if (conversation.messages.length > this.maxMessagesPerChat) {
                conversation.messages = conversation.messages.slice(-this.maxMessagesPerChat);
            }

            // Update conversation metadata
            conversation.lastMessage = messageData;
            conversation.lastUpdated = new Date();
            conversation.messageCount = conversation.messages.length;

            // Save to file
            await fs.writeFile(conversationFile, JSON.stringify(conversation, null, 2));
            
            return messageData;
        } catch (error) {
            logger.error(`Error saving message for ${sessionId}/${chatId}:`, error);
            throw error;
        }
    }

    async getConversationHistory(sessionId, chatId, limit = 50) {
        try {
            const conversation = await this.loadConversation(sessionId, chatId);
            
            // Return last N messages
            const messages = conversation.messages.slice(-limit);
            
            return {
                sessionId,
                chatId,
                messages,
                totalMessages: conversation.messageCount || messages.length,
                lastUpdated: conversation.lastUpdated
            };
        } catch (error) {
            logger.error(`Error getting conversation history for ${sessionId}/${chatId}:`, error);
            return {
                sessionId,
                chatId,
                messages: [],
                totalMessages: 0,
                lastUpdated: null
            };
        }
    }

    async loadConversation(sessionId, chatId) {
        try {
            const conversationFile = this.getConversationFilePath(sessionId, chatId);
            const data = await fs.readFile(conversationFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // Create new conversation structure
                return this.createNewConversation(sessionId, chatId);
            }
            throw error;
        }
    }

    createNewConversation(sessionId, chatId) {
        return {
            sessionId,
            chatId,
            messages: [],
            createdAt: new Date(),
            lastUpdated: new Date(),
            messageCount: 0,
            participants: [chatId]
        };
    }

    getConversationFilePath(sessionId, chatId) {
        // Sanitize chatId for filename
        const sanitizedChatId = chatId.replace(/[^a-zA-Z0-9@.-]/g, '_');
        return path.join(this.conversationsDir, `${sessionId}_${sanitizedChatId}.json`);
    }

    // Get all conversations for a session
    async getSessionConversations(sessionId) {
        try {
            const files = await fs.readdir(this.conversationsDir);
            const sessionFiles = files.filter(file => 
                file.startsWith(`${sessionId}_`) && file.endsWith('.json')
            );
            
            const conversations = [];
            for (const file of sessionFiles) {
                try {
                    const filePath = path.join(this.conversationsDir, file);
                    const data = await fs.readFile(filePath, 'utf8');
                    const conversation = JSON.parse(data);
                    
                    // Return summary info only
                    conversations.push({
                        chatId: conversation.chatId,
                        lastMessage: conversation.lastMessage,
                        lastUpdated: conversation.lastUpdated,
                        messageCount: conversation.messageCount
                    });
                } catch (error) {
                    logger.warn(`Error reading conversation file ${file}:`, error);
                }
            }
            
            return conversations.sort((a, b) => 
                new Date(b.lastUpdated) - new Date(a.lastUpdated)
            );
        } catch (error) {
            logger.error(`Error getting conversations for session ${sessionId}:`, error);
            return [];
        }
    }

    async deleteConversation(sessionId, chatId) {
        try {
            const conversationFile = this.getConversationFilePath(sessionId, chatId);
            await fs.unlink(conversationFile);
            logger.info(`Conversation deleted: ${sessionId}/${chatId}`);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error(`Error deleting conversation ${sessionId}/${chatId}:`, error);
            }
        }
    }

    async deleteAllConversations(sessionId) {
        try {
            const files = await fs.readdir(this.conversationsDir);
            const sessionFiles = files.filter(file => 
                file.startsWith(`${sessionId}_`) && file.endsWith('.json')
            );
            
            const deletePromises = sessionFiles.map(file => {
                const filePath = path.join(this.conversationsDir, file);
                return fs.unlink(filePath).catch(error => {
                    logger.warn(`Error deleting conversation file ${file}:`, error);
                });
            });
            
            await Promise.all(deletePromises);
            logger.info(`All conversations deleted for session ${sessionId}`);
        } catch (error) {
            logger.error(`Error deleting all conversations for session ${sessionId}:`, error);
        }
    }

    // Search functionality
    async searchMessages(sessionId, query, limit = 20) {
        try {
            const conversations = await this.getSessionConversations(sessionId);
            const results = [];
            
            for (const conv of conversations) {
                const history = await this.getConversationHistory(sessionId, conv.chatId);
                
                const matchingMessages = history.messages.filter(msg => 
                    msg.body && msg.body.toLowerCase().includes(query.toLowerCase())
                );
                
                results.push(...matchingMessages.map(msg => ({
                    ...msg,
                    chatId: conv.chatId
                })));
            }
            
            // Sort by timestamp and limit results
            results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            return results.slice(0, limit);
            
        } catch (error) {
            logger.error(`Error searching messages for session ${sessionId}:`, error);
            return [];
        }
    }

    // Analytics and Statistics
    async getSessionStats(sessionId) {
        try {
            const conversations = await this.getSessionConversations(sessionId);
            
            let totalMessages = 0;
            let aiMessages = 0;
            let userMessages = 0;
            
            for (const conv of conversations) {
                const history = await this.getConversationHistory(sessionId, conv.chatId);
                
                totalMessages += history.messages.length;
                aiMessages += history.messages.filter(msg => msg.aiGenerated).length;
                userMessages += history.messages.filter(msg => !msg.fromMe).length;
            }
            
            return {
                sessionId,
                totalConversations: conversations.length,
                totalMessages,
                aiMessages,
                userMessages,
                lastActivity: conversations.length > 0 ? conversations[0].lastUpdated : null
            };
        } catch (error) {
            logger.error(`Error getting session stats for ${sessionId}:`, error);
            return {
                sessionId,
                totalConversations: 0,
                totalMessages: 0,
                aiMessages: 0,
                userMessages: 0,
                lastActivity: null
            };
        }
    }

    // Cleanup old sessions and conversations
    async cleanupOldData() {
        try {
            logger.info('Starting cleanup of old data...');
            
            const sessions = await this.getAllSessions();
            const cutoffDate = new Date(Date.now() - this.maxSessionAge);
            
            let cleanedSessions = 0;
            let cleanedConversations = 0;
            
            for (const session of sessions) {
                const sessionDate = new Date(session.lastUpdated || session.createdAt);
                
                if (sessionDate < cutoffDate) {
                    await this.deleteSession(session.clientId);
                    cleanedSessions++;
                }
            }
            
            // Clean up orphaned conversation files
            const conversationFiles = await fs.readdir(this.conversationsDir);
            for (const file of conversationFiles) {
                try {
                    const filePath = path.join(this.conversationsDir, file);
                    const stats = await fs.stat(filePath);
                    
                    if (stats.mtime < cutoffDate) {
                        await fs.unlink(filePath);
                        cleanedConversations++;
                    }
                } catch (error) {
                    logger.warn(`Error cleaning up conversation file ${file}:`, error);
                }
            }
            
            logger.info(`Cleanup completed: ${cleanedSessions} sessions, ${cleanedConversations} conversation files`);
            
            return {
                cleanedSessions,
                cleanedConversations,
                completedAt: new Date().toISOString()
            };
        } catch (error) {
            logger.error('Error during data cleanup:', error);
            throw error;
        }
    }

    // Export conversation data
    async exportConversationData(sessionId, format = 'json') {
        try {
            const conversations = await this.getSessionConversations(sessionId);
            const exportData = {
                sessionId,
                exportDate: new Date().toISOString(),
                conversations: []
            };
            
            for (const conv of conversations) {
                const history = await this.getConversationHistory(sessionId, conv.chatId);
                exportData.conversations.push(history);
            }
            
            if (format === 'json') {
                return JSON.stringify(exportData, null, 2);
            }
            
            // Add other formats as needed (CSV, etc.)
            return exportData;
        } catch (error) {
            logger.error(`Error exporting conversation data for ${sessionId}:`, error);
            throw error;
        }
    }

    // Health check
    async healthCheck() {
        try {
            // Check if directories exist and are writable
            await fs.access(this.dataDir, fs.constants.W_OK);
            await fs.access(this.conversationsDir, fs.constants.W_OK);
            
            const sessions = await this.getAllSessions();
            
            return {
                status: 'healthy',
                totalSessions: sessions.length,
                dataDirectory: this.dataDir,
                conversationsDirectory: this.conversationsDir,
                maxMessagesPerChat: this.maxMessagesPerChat,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                status: 'unhealthy',
                error: error.message,
                timestamp: new Date().toISOString()
            };
        }
    }
}

module.exports = SessionStore;

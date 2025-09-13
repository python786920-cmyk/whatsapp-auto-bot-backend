const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const WhatsAppManager = require('./whatsappManager');
const SessionStore = require('./sessionStore');
const { logger } = require('./utils');

// Initialize Express app
const app = express();
const server = createServer(app);

// Initialize Socket.io with CORS
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Global instances
const whatsappManager = new WhatsAppManager(io);
const sessionStore = new SessionStore();

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        sessions: whatsappManager.getActiveSessions().length
    });
});

// Get all sessions
app.get('/api/sessions', (req, res) => {
    try {
        const sessions = whatsappManager.getActiveSessions();
        res.json({ success: true, sessions });
    } catch (error) {
        logger.error('Error fetching sessions:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Create new session
app.post('/api/sessions', async (req, res) => {
    try {
        const { clientId } = req.body;
        
        if (!clientId) {
            return res.status(400).json({ 
                success: false, 
                error: 'clientId is required' 
            });
        }

        const result = await whatsappManager.createSession(clientId);
        res.json({ success: true, session: result });
        
    } catch (error) {
        logger.error('Error creating session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete session
app.delete('/api/sessions/:clientId', async (req, res) => {
    try {
        const { clientId } = req.params;
        await whatsappManager.destroySession(clientId);
        res.json({ success: true, message: 'Session deleted' });
        
    } catch (error) {
        logger.error('Error deleting session:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Send message endpoint
app.post('/api/send-message', async (req, res) => {
    try {
        const { clientId, to, message } = req.body;
        
        if (!clientId || !to || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'clientId, to, and message are required' 
            });
        }

        const result = await whatsappManager.sendMessage(clientId, to, message);
        res.json({ success: true, result });
        
    } catch (error) {
        logger.error('Error sending message:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get conversation history
app.get('/api/history/:sessionId/:chatId', async (req, res) => {
    try {
        const { sessionId, chatId } = req.params;
        const { limit = 50 } = req.query;
        
        const history = await sessionStore.getConversationHistory(
            sessionId, 
            chatId, 
            parseInt(limit)
        );
        
        res.json({ success: true, history });
        
    } catch (error) {
        logger.error('Error fetching history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    
    // Join client to their room
    socket.on('join_room', (data) => {
        const { clientId } = data;
        if (clientId) {
            socket.join(`session_${clientId}`);
            logger.info(`Client ${socket.id} joined room: session_${clientId}`);
        }
    });

    // Create session event
    socket.on('create_session', async (data) => {
        try {
            const { clientId } = data;
            
            if (!clientId) {
                socket.emit('error', { message: 'clientId is required' });
                return;
            }

            // Join socket to session room first
            socket.join(`session_${clientId}`);
            
            // Create WhatsApp session
            const result = await whatsappManager.createSession(clientId);
            
            socket.emit('session_created', { 
                clientId, 
                status: 'created',
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            logger.error('Error in create_session:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Refresh QR code
    socket.on('refresh_qr', async (data) => {
        try {
            const { clientId } = data;
            await whatsappManager.refreshQR(clientId);
        } catch (error) {
            logger.error('Error refreshing QR:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Send message via socket
    socket.on('send_message', async (data) => {
        try {
            const { clientId, to, message } = data;
            
            if (!clientId || !to || !message) {
                socket.emit('error', { message: 'Missing required fields' });
                return;
            }

            const result = await whatsappManager.sendMessage(clientId, to, message);
            socket.emit('message_sent', { 
                to, 
                message, 
                result,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            logger.error('Error sending message via socket:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Disconnect session
    socket.on('disconnect_session', async (data) => {
        try {
            const { clientId } = data;
            await whatsappManager.destroySession(clientId);
            socket.emit('session_disconnected', { clientId });
        } catch (error) {
            logger.error('Error disconnecting session:', error);
            socket.emit('error', { message: error.message });
        }
    });

    // Handle client disconnect
    socket.on('disconnect', (reason) => {
        logger.info(`Client disconnected: ${socket.id}, reason: ${reason}`);
    });
});

// Global error handlers
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    
    // Close all WhatsApp sessions
    await whatsappManager.destroyAllSessions();
    
    // Close server
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully...');
    
    // Close all WhatsApp sessions
    await whatsappManager.destroyAllSessions();
    
    // Close server
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

// Start server
const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    logger.info(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
    logger.info(`📱 WhatsApp Bot Backend Started Successfully`);
    
    // Initialize existing sessions on startup
    whatsappManager.restoreExistingSessions().catch(error => {
        logger.error('Error restoring sessions:', error);
    });
});

// Export for testing
module.exports = { app, server, io };

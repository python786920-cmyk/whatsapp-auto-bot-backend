const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
require('dotenv').config();

const WhatsAppHandler = require('./whatsapp-handler');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// Configure Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        })
    ]
});

// Rate limiter
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: { error: 'Too many requests' }
});

// Middleware
app.use(helmet());
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(limiter);

// Global variables
const sessions = new Map();
const activeClients = new Map();
let whatsappHandler = null;

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        message: 'WhatsApp Auto Bot Backend Running',
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        connectedClients: activeClients.size
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    const sessionId = 'default';
    const session = sessions.get(sessionId);
    
    res.json({
        sessionId,
        isConnected: session ? session.isConnected : false,
        isReady: session ? session.isReady : false,
        lastActivity: session ? session.lastActivity : null,
        messageStats: session ? session.stats : { sent: 0, received: 0, replies: 0 }
    });
});

app.post('/api/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Number and message required' });
        }

        if (!whatsappHandler || !whatsappHandler.isClientReady()) {
            return res.status(400).json({ error: 'WhatsApp not ready' });
        }

        const result = await whatsappHandler.sendMessage(number, message);
        res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        logger.error('Send message error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// Socket.io connection handling
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    activeClients.set(socket.id, { 
        connectedAt: new Date(),
        sessionId: 'default'
    });

    // Start session
    socket.on('start_session', () => {
        const sessionId = 'default';
        logger.info(`Starting WhatsApp session: ${sessionId}`);
        
        try {
            initializeWhatsAppSession(sessionId, socket);
        } catch (error) {
            logger.error('Failed to start session:', error);
            socket.emit('error', { message: 'Failed to initialize session' });
        }
    });

    // Logout
    socket.on('logout', async () => {
        logger.info('Logout requested');
        
        try {
            if (whatsappHandler) {
                await whatsappHandler.logout();
                whatsappHandler = null;
            }
            
            sessions.clear();
            socket.emit('disconnected');
            logger.info('Session logged out');
        } catch (error) {
            logger.error('Logout error:', error);
            socket.emit('error', { message: 'Logout failed' });
        }
    });

    // Send message via socket
    socket.on('send_message', async (data) => {
        try {
            const { number, message } = data;
            if (!whatsappHandler || !whatsappHandler.isClientReady()) {
                socket.emit('error', { message: 'WhatsApp not connected' });
                return;
            }

            await whatsappHandler.sendMessage(number, message);
            socket.emit('message_sent', { number, message });
        } catch (error) {
            logger.error('Socket send error:', error);
            socket.emit('error', { message: 'Failed to send message' });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
        activeClients.delete(socket.id);
    });

    // Send connection ack
    socket.emit('connect_ack', {
        message: 'Connected to WhatsApp Auto Bot',
        timestamp: new Date().toISOString()
    });
});

// Initialize WhatsApp session
async function initializeWhatsAppSession(sessionId, socket = null) {
    try {
        if (sessions.has(sessionId)) {
            logger.warn(`Session ${sessionId} already exists`);
            return;
        }

        const sessionData = {
            id: sessionId,
            isConnected: false,
            isReady: false,
            createdAt: new Date(),
            lastActivity: new Date(),
            stats: { sent: 0, received: 0, replies: 0 }
        };
        sessions.set(sessionId, sessionData);

        whatsappHandler = new WhatsAppHandler(sessionId, logger);

        // Event listeners
        whatsappHandler.on('qr', (qr) => {
            logger.info('QR Code generated and sent to frontend');
            if (socket) socket.emit('qr', qr);
            io.emit('qr', qr);
        });

        whatsappHandler.on('authenticated', () => {
            logger.info('WhatsApp authenticated');
            sessionData.isConnected = true;
            if (socket) socket.emit('authenticated');
            io.emit('authenticated');
        });

        whatsappHandler.on('ready', () => {
            logger.info('WhatsApp is ready');
            sessionData.isReady = true;
            sessionData.lastActivity = new Date();
            if (socket) socket.emit('ready');
            io.emit('ready');
        });

        whatsappHandler.on('disconnected', (reason) => {
            logger.warn(`WhatsApp disconnected: ${reason}`);
            sessionData.isConnected = false;
            sessionData.isReady = false;
            if (socket) socket.emit('disconnected', { reason });
            io.emit('disconnected', { reason });
        });

        whatsappHandler.on('auth_failure', (msg) => {
            logger.error(`Authentication failed: ${msg}`);
            sessionData.isConnected = false;
            if (socket) socket.emit('auth_failure', { message: msg });
            io.emit('auth_failure', { message: msg });
        });

        whatsappHandler.on('message_received', (messageData) => {
            logger.info(`Message received from: ${messageData.from}`);
            sessionData.stats.received++;
            sessionData.lastActivity = new Date();
            if (socket) socket.emit('message_received', messageData);
            io.emit('message_received', messageData);
        });

        whatsappHandler.on('reply_sent', (replyData) => {
            logger.info(`Auto reply sent to: ${replyData.to}`);
            sessionData.stats.replies++;
            sessionData.stats.sent++;
            sessionData.lastActivity = new Date();
            if (socket) socket.emit('reply_sent', replyData);
            io.emit('reply_sent', replyData);
        });

        whatsappHandler.on('error', (error) => {
            logger.error('WhatsApp handler error:', error.message);
            if (socket) socket.emit('error', { message: error.message });
            io.emit('error', { message: error.message });
        });

        // Start WhatsApp client
        await whatsappHandler.initialize();
        logger.info(`WhatsApp session ${sessionId} initialized`);

    } catch (error) {
        logger.error(`Failed to initialize session ${sessionId}:`, error);
        sessions.delete(sessionId);
        if (socket) socket.emit('error', { message: 'Session initialization failed' });
        throw error;
    }
}

// Cleanup
process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    
    if (whatsappHandler) {
        try {
            await whatsappHandler.destroy();
        } catch (error) {
            logger.error('Cleanup error:', error);
        }
    }
    
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled Rejection:', reason);
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 WhatsApp Auto Bot running on port ${PORT}`);
    logger.info(`🤖 Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ Ready' : '❌ Missing Key'}`);
    logger.info(`🌍 Backend URL: https://whatsapp-auto-bot-backend.onrender.com`);
});

module.exports = { app, server, io };

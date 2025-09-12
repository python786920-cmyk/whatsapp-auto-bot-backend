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
        origin: ["http://localhost:3000", "https://cashearnersofficial.xyz"],
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

// Configure Winston Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
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

// Rate limiter using express-rate-limit
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // limit each IP to 10 requests per windowMs
    message: {
        error: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Middleware
app.use(helmet());
app.use(cors({
    origin: ["http://localhost:3000", "https://cashearnersofficial.xyz"],
    credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(limiter);

// Global variables for session management
const sessions = new Map();
const activeClients = new Map();

// WhatsApp Handler instance
let whatsappHandler = null;

// Health check endpoint
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
    const sessionId = req.query.sessionId || 'default';
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
        const { number, message, sessionId = 'default' } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Number and message are required' });
        }

        const session = sessions.get(sessionId);
        if (!session || !session.isReady) {
            return res.status(400).json({ error: 'WhatsApp session not ready' });
        }

        const result = await whatsappHandler.sendMessage(number, message);
        logger.info(`Message sent manually: ${number}`);
        
        res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
        logger.error('Manual message send error:', error);
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

    // Handle session start request
    socket.on('start_session', () => {
        const sessionId = 'default';
        logger.info(`Starting WhatsApp session: ${sessionId}`);
        
        try {
            initializeWhatsAppSession(sessionId, socket);
        } catch (error) {
            logger.error('Failed to start session:', error);
            socket.emit('error', { message: 'Failed to initialize WhatsApp session' });
        }
    });

    // Handle logout request
    socket.on('logout', async () => {
        const sessionId = 'default';
        logger.info(`Logout requested for session: ${sessionId}`);
        
        try {
            if (whatsappHandler) {
                await whatsappHandler.logout();
                whatsappHandler = null;
            }
            
            sessions.delete(sessionId);
            socket.emit('disconnected');
            logger.info('WhatsApp session logged out successfully');
        } catch (error) {
            logger.error('Logout error:', error);
            socket.emit('error', { message: 'Failed to logout properly' });
        }
    });

    // Handle client disconnect
    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
        activeClients.delete(socket.id);
    });

    // Send current status to newly connected client
    socket.emit('connect_ack', {
        message: 'Connected to WhatsApp Auto Bot Backend',
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

        // Create session entry
        const sessionData = {
            id: sessionId,
            isConnected: false,
            isReady: false,
            createdAt: new Date(),
            lastActivity: new Date(),
            stats: { sent: 0, received: 0, replies: 0 }
        };
        sessions.set(sessionId, sessionData);

        // Initialize WhatsApp handler
        whatsappHandler = new WhatsAppHandler(sessionId, logger);

        // Set up event listeners
        whatsappHandler.on('qr', (qr) => {
            logger.info('QR Code generated');
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
            logger.info(`Message received: ${messageData.from}`);
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
            logger.error('WhatsApp handler error:', error);
            if (socket) socket.emit('error', { message: error.message });
            io.emit('error', { message: error.message });
        });

        // Start the WhatsApp client
        await whatsappHandler.initialize();
        logger.info(`WhatsApp session ${sessionId} initialized successfully`);

    } catch (error) {
        logger.error(`Failed to initialize session ${sessionId}:`, error);
        sessions.delete(sessionId);
        if (socket) socket.emit('error', { message: 'Failed to initialize WhatsApp session' });
        throw error;
    }
}

// Cleanup on process termination
process.on('SIGINT', async () => {
    logger.info('Shutting down server...');
    
    if (whatsappHandler) {
        try {
            await whatsappHandler.destroy();
        } catch (error) {
            logger.error(`Error closing WhatsApp session:`, error);
        }
    }
    
    server.close(() => {
        logger.info('Server closed successfully');
        process.exit(0);
    });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 WhatsApp Auto Bot Backend running on port ${PORT}`);
    logger.info(`🤖 Gemini AI: ${process.env.GEMINI_API_KEY ? '✅ Configured' : '❌ Missing API Key'}`);
});

module.exports = { app, server, io };

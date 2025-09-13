const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Configure Winston logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss'
        }),
        winston.format.errors({ stack: true }),
        winston.format.json()
    ),
    defaultMeta: { service: 'whatsapp-bot' },
    transports: [
        // File transport for errors
        new winston.transports.File({ 
            filename: path.join(logsDir, 'error.log'), 
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        
        // File transport for all logs
        new winston.transports.File({ 
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        
        // Console transport
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
                winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
                    return `${timestamp} [${service}] ${level}: ${message} ${
                        Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''
                    }`;
                })
            )
        })
    ]
});

// Utility Functions

/**
 * Create a delay/sleep function
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} - Promise that resolves after delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate human-like typing delay based on message length
 * @param {string} message - The message to calculate typing time for
 * @returns {number} - Delay in milliseconds
 */
function generateTypingDelay(message) {
    const baseDelay = 500; // Base thinking time
    const charDelay = 35; // ms per character (average human typing speed)
    const randomFactor = 0.3; // 30% randomness
    
    const messageLength = message.length;
    const baseTypingTime = messageLength * charDelay;
    
    // Add randomness
    const randomMultiplier = 1 + (Math.random() - 0.5) * randomFactor;
    const typingTime = baseTypingTime * randomMultiplier;
    
    // Add thinking time
    const thinkingTime = baseDelay + Math.random() * 1000;
    
    // Total delay (minimum 1 second, maximum 8 seconds)
    const totalDelay = Math.min(Math.max(typingTime + thinkingTime, 1000), 8000);
    
    logger.debug(`Typing delay calculated: ${totalDelay}ms for ${messageLength} characters`);
    return Math.floor(totalDelay);
}

/**
 * Format timestamp for display
 * @param {Date|string} timestamp - Timestamp to format
 * @param {string} format - Format type ('short', 'long', 'relative')
 * @returns {string} - Formatted timestamp
 */
function formatTimestamp(timestamp, format = 'short') {
    const date = new Date(timestamp);
    const now = new Date();
    
    switch (format) {
        case 'short':
            return date.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit' 
            });
            
        case 'long':
            return date.toLocaleString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            
        case 'relative':
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);
            
            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return `${diffMins}m ago`;
            if (diffHours < 24) return `${diffHours}h ago`;
            if (diffDays < 7) return `${diffDays}d ago`;
            return date.toLocaleDateString();
            
        default:
            return date.toString();
    }
}

/**
 * Sanitize text for safe storage/display
 * @param {string} text - Text to sanitize
 * @param {number} maxLength - Maximum length (optional)
 * @returns {string} - Sanitized text
 */
function sanitizeText(text, maxLength = null) {
    if (!text || typeof text !== 'string') return '';
    
    // Remove or escape potentially harmful characters
    let sanitized = text
        .replace(/[<>]/g, '') // Remove HTML brackets
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // Remove control characters
        .trim();
    
    // Truncate if max length specified
    if (maxLength && sanitized.length > maxLength) {
        sanitized = sanitized.substring(0, maxLength) + '...';
    }
    
    return sanitized;
}

/**
 * Validate phone number format
 * @param {string} phoneNumber - Phone number to validate
 * @returns {Object} - Validation result
 */
function validatePhoneNumber(phoneNumber) {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
        return { valid: false, error: 'Phone number is required' };
    }
    
    // Remove all non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // Check if it looks like a valid phone number
    const phoneRegex = /^\+?[1-9]\d{10,14}$/;
    
    if (!phoneRegex.test(cleaned)) {
        return { 
            valid: false, 
            error: 'Invalid phone number format' 
        };
    }
    
    return { 
        valid: true, 
        formatted: cleaned,
        whatsappId: cleaned.includes('@c.us') ? cleaned : `${cleaned}@c.us`
    };
}

/**
 * Generate unique session ID
 * @param {string} prefix - Prefix for the ID (optional)
 * @returns {string} - Unique session ID
 */
function generateSessionId(prefix = 'session') {
    const timestamp = Date.now().toString(36);
    const randomStr = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${randomStr}`;
}

/**
 * Retry function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {number} maxRetries - Maximum number of retries
 * @param {number} baseDelay - Base delay in ms
 * @returns {Promise} - Promise that resolves with function result
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;
    
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (i === maxRetries) {
                throw error;
            }
            
            const delayTime = baseDelay * Math.pow(2, i);
            logger.warn(`Retry attempt ${i + 1} failed, waiting ${delayTime}ms:`, error.message);
            await delay(delayTime);
        }
    }
    
    throw lastError;
}

/**
 * Deep merge objects
 * @param {Object} target - Target object
 * @param {Object} source - Source object
 * @returns {Object} - Merged object
 */
function deepMerge(target, source) {
    const output = { ...target };
    
    for (const key in source) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
            output[key] = deepMerge(output[key] || {}, source[key]);
        } else {
            output[key] = source[key];
        }
    }
    
    return output;
}

/**
 * Get system information
 * @returns {Object} - System information
 */
function getSystemInfo() {
    const os = require('os');
    
    return {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        totalMemory: os.totalmem(),
        freeMemory: os.freemem(),
        cpuCount: os.cpus().length,
        uptime: os.uptime(),
        processUptime: process.uptime(),
        processMemory: process.memoryUsage()
    };
}

/**
 * Calculate memory usage
 * @returns {Object} - Memory usage information
 */
function getMemoryUsage() {
    const usage = process.memoryUsage();
    
    return {
        rss: Math.round(usage.rss / 1024 / 1024), // MB
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
        external: Math.round(usage.external / 1024 / 1024), // MB
        arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024) // MB
    };
}

/**
 * Check if object is empty
 * @param {Object} obj - Object to check
 * @returns {boolean} - True if empty
 */
function isEmpty(obj) {
    if (obj === null || obj === undefined) return true;
    if (Array.isArray(obj)) return obj.length === 0;
    if (typeof obj === 'object') return Object.keys(obj).length === 0;
    if (typeof obj === 'string') return obj.trim().length === 0;
    return false;
}

/**
 * Debounce function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @param {boolean} immediate - Execute immediately
 * @returns {Function} - Debounced function
 */
function debounce(func, wait, immediate = false) {
    let timeout;
    
    return function executedFunction(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func.apply(this, args);
        };
        
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        
        if (callNow) func.apply(this, args);
    };
}

/**
 * Throttle function
 * @param {Function} func - Function to throttle
 * @param {number} limit - Time limit in ms
 * @returns {Function} - Throttled function
 */
function throttle(func, limit) {
    let inThrottle;
    
    return function(...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Generate random string
 * @param {number} length - Length of string
 * @param {string} charset - Character set to use
 * @returns {string} - Random string
 */
function generateRandomString(length = 8, charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return result;
}

/**
 * Parse environment variables with defaults
 * @param {string} key - Environment variable key
 * @param {any} defaultValue - Default value
 * @param {string} type - Type to parse ('string', 'number', 'boolean', 'json')
 * @returns {any} - Parsed value
 */
function parseEnvVar(key, defaultValue, type = 'string') {
    const value = process.env[key];
    
    if (value === undefined || value === '') {
        return defaultValue;
    }
    
    switch (type) {
        case 'number':
            const num = parseFloat(value);
            return isNaN(num) ? defaultValue : num;
            
        case 'boolean':
            return value.toLowerCase() === 'true';
            
        case 'json':
            try {
                return JSON.parse(value);
            } catch {
                return defaultValue;
            }
            
        case 'string':
        default:
            return value;
    }
}

/**
 * Graceful shutdown handler
 * @param {Function} cleanupCallback - Cleanup function to call
 */
function setupGracefulShutdown(cleanupCallback) {
    const shutdown = (signal) => {
        logger.info(`Received ${signal}, starting graceful shutdown...`);
        
        if (typeof cleanupCallback === 'function') {
            cleanupCallback()
                .then(() => {
                    logger.info('Cleanup completed, exiting...');
                    process.exit(0);
                })
                .catch((error) => {
                    logger.error('Error during cleanup:', error);
                    process.exit(1);
                });
        } else {
            process.exit(0);
        }
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // nodemon restart
}

/**
 * Safe JSON parse
 * @param {string} str - String to parse
 * @param {any} defaultValue - Default value on parse error
 * @returns {any} - Parsed value or default
 */
function safeJsonParse(str, defaultValue = null) {
    try {
        return JSON.parse(str);
    } catch {
        return defaultValue;
    }
}

// Export all utilities
module.exports = {
    // Core utilities
    logger,
    delay,
    generateTypingDelay,
    formatTimestamp,
    sanitizeText,
    validatePhoneNumber,
    generateSessionId,
    retryWithBackoff,
    deepMerge,
    
    // System utilities
    getSystemInfo,
    getMemoryUsage,
    
    // Utility functions
    isEmpty,
    debounce,
    throttle,
    generateRandomString,
    parseEnvVar,
    safeJsonParse,
    
    // Process utilities
    setupGracefulShutdown
};

const { logger } = require('./utils');

class RateLimiter {
    constructor() {
        // Rate limiting configuration
        this.limits = {
            messagesPerMinute: 2,
            messagesPerHour: 20,
            burstLimit: 3 // Allow burst of 3 messages initially
        };
        
        // Token buckets for each user
        this.userBuckets = new Map();
        
        // Message queues for rate-limited users
        this.messageQueues = new Map();
        
        // Cleanup intervals
        this.cleanupInterval = 5 * 60 * 1000; // 5 minutes
        this.bucketTimeout = 60 * 60 * 1000; // 1 hour
        
        // Start cleanup process
        this.startCleanupProcess();
    }

    // Check if user can send message
    checkLimit(userId) {
        const bucket = this.getUserBucket(userId);
        return this.consumeToken(bucket);
    }

    // Get or create user bucket
    getUserBucket(userId) {
        if (!this.userBuckets.has(userId)) {
            this.userBuckets.set(userId, this.createNewBucket(userId));
        }
        
        const bucket = this.userBuckets.get(userId);
        this.refillBucket(bucket);
        
        return bucket;
    }

    // Create new token bucket for user
    createNewBucket(userId) {
        const now = Date.now();
        
        return {
            userId,
            // Per-minute tracking
            minuteTokens: this.limits.messagesPerMinute,
            minuteRefillTime: now,
            
            // Per-hour tracking
            hourTokens: this.limits.messagesPerHour,
            hourRefillTime: now,
            
            // Burst allowance
            burstTokens: this.limits.burstLimit,
            
            // Metadata
            createdAt: now,
            lastActivity: now,
            totalRequests: 0,
            blockedRequests: 0
        };
    }

    // Refill tokens based on time elapsed
    refillBucket(bucket) {
        const now = Date.now();
        
        // Refill minute tokens
        const minutesElapsed = Math.floor((now - bucket.minuteRefillTime) / (60 * 1000));
        if (minutesElapsed > 0) {
            bucket.minuteTokens = Math.min(
                this.limits.messagesPerMinute,
                bucket.minuteTokens + minutesElapsed
            );
            bucket.minuteRefillTime = now;
        }
        
        // Refill hour tokens
        const hoursElapsed = Math.floor((now - bucket.hourRefillTime) / (60 * 60 * 1000));
        if (hoursElapsed > 0) {
            bucket.hourTokens = Math.min(
                this.limits.messagesPerHour,
                bucket.hourTokens + (hoursElapsed * this.limits.messagesPerHour)
            );
            bucket.hourRefillTime = now;
        }
        
        // Refill burst tokens gradually
        if (bucket.burstTokens < this.limits.burstLimit && minutesElapsed > 0) {
            bucket.burstTokens = Math.min(
                this.limits.burstLimit,
                bucket.burstTokens + Math.floor(minutesElapsed / 2) // Refill slower
            );
        }
    }

    // Try to consume a token
    consumeToken(bucket) {
        bucket.totalRequests++;
        bucket.lastActivity = Date.now();
        
        // Check burst tokens first (for new users)
        if (bucket.burstTokens > 0) {
            bucket.burstTokens--;
            logger.debug(`Burst token consumed for ${bucket.userId}. Remaining: ${bucket.burstTokens}`);
            return true;
        }
        
        // Check minute limit
        if (bucket.minuteTokens <= 0) {
            bucket.blockedRequests++;
            logger.warn(`Minute rate limit exceeded for ${bucket.userId}`);
            return false;
        }
        
        // Check hour limit
        if (bucket.hourTokens <= 0) {
            bucket.blockedRequests++;
            logger.warn(`Hour rate limit exceeded for ${bucket.userId}`);
            return false;
        }
        
        // Consume tokens
        bucket.minuteTokens--;
        bucket.hourTokens--;
        
        logger.debug(`Token consumed for ${bucket.userId}. Minute: ${bucket.minuteTokens}, Hour: ${bucket.hourTokens}`);
        return true;
    }

    // Add message to queue for rate-limited users
    queueMessage(userId, messageData) {
        if (!this.messageQueues.has(userId)) {
            this.messageQueues.set(userId, []);
        }
        
        const queue = this.messageQueues.get(userId);
        
        // Prevent queue overflow
        if (queue.length >= 10) {
            logger.warn(`Message queue full for ${userId}. Dropping oldest message.`);
            queue.shift();
        }
        
        queue.push({
            ...messageData,
            queuedAt: Date.now(),
            retryCount: 0
        });
        
        logger.info(`Message queued for ${userId}. Queue size: ${queue.length}`);
    }

    // Process queued messages
    async processMessageQueue(userId, sendFunction) {
        const queue = this.messageQueues.get(userId);
        if (!queue || queue.length === 0) return;
        
        const processedMessages = [];
        
        for (let i = 0; i < queue.length; i++) {
            const message = queue[i];
            
            // Check if we can send this message now
            if (this.checkLimit(userId)) {
                try {
                    await sendFunction(message);
                    processedMessages.push(i);
                    logger.info(`Queued message sent for ${userId}`);
                } catch (error) {
                    logger.error(`Error sending queued message for ${userId}:`, error);
                    message.retryCount++;
                    
                    // Remove message if too many retries
                    if (message.retryCount >= 3) {
                        processedMessages.push(i);
                        logger.warn(`Message dropped after 3 retries for ${userId}`);
                    }
                }
            } else {
                break; // Still rate limited, stop processing
            }
        }
        
        // Remove processed messages (in reverse order to maintain indices)
        for (let i = processedMessages.length - 1; i >= 0; i--) {
            queue.splice(processedMessages[i], 1);
        }
        
        // Clean up empty queue
        if (queue.length === 0) {
            this.messageQueues.delete(userId);
        }
    }

    // Get user rate limit status
    getUserStatus(userId) {
        const bucket = this.getUserBucket(userId);
        const queue = this.messageQueues.get(userId) || [];
        
        return {
            userId,
            limits: this.limits,
            currentStatus: {
                minuteTokens: bucket.minuteTokens,
                hourTokens: bucket.hourTokens,
                burstTokens: bucket.burstTokens
            },
            queue: {
                size: queue.length,
                oldestMessage: queue.length > 0 ? queue[0].queuedAt : null
            },
            statistics: {
                totalRequests: bucket.totalRequests,
                blockedRequests: bucket.blockedRequests,
                lastActivity: bucket.lastActivity,
                createdAt: bucket.createdAt
            },
            canSend: this.checkLimit(userId) // This will consume a token if true
        };
    }

    // Reset user limits (admin function)
    resetUserLimits(userId) {
        this.userBuckets.delete(userId);
        this.messageQueues.delete(userId);
        logger.info(`Rate limits reset for ${userId}`);
    }

    // Update rate limits configuration
    updateLimits(newLimits) {
        this.limits = { ...this.limits, ...newLimits };
        logger.info('Rate limits updated:', this.limits);
    }

    // Get system-wide statistics
    getSystemStats() {
        const now = Date.now();
        let totalUsers = this.userBuckets.size;
        let activeUsers = 0;
        let totalRequests = 0;
        let blockedRequests = 0;
        let queuedMessages = 0;
        
        for (const [userId, bucket] of this.userBuckets) {
            totalRequests += bucket.totalRequests;
            blockedRequests += bucket.blockedRequests;
            
            // Consider user active if they made a request in the last hour
            if (now - bucket.lastActivity < 60 * 60 * 1000) {
                activeUsers++;
            }
            
            const queue = this.messageQueues.get(userId);
            if (queue) {
                queuedMessages += queue.length;
            }
        }
        
        return {
            totalUsers,
            activeUsers,
            totalRequests,
            blockedRequests,
            queuedMessages,
            limits: this.limits,
            timestamp: new Date().toISOString()
        };
    }

    // Cleanup old buckets and queues
    cleanup(sessionId = null) {
        const now = Date.now();
        let cleanedBuckets = 0;
        let cleanedQueues = 0;
        
        // Clean up old buckets
        for (const [userId, bucket] of this.userBuckets) {
            // Clean specific session or old buckets
            if (sessionId && userId.includes(sessionId)) {
                this.userBuckets.delete(userId);
                cleanedBuckets++;
            } else if (now - bucket.lastActivity > this.bucketTimeout) {
                this.userBuckets.delete(userId);
                cleanedBuckets++;
            }
        }
        
        // Clean up empty or old queues
        for (const [userId, queue] of this.messageQueues) {
            if (sessionId && userId.includes(sessionId)) {
                this.messageQueues.delete(userId);
                cleanedQueues++;
            } else if (queue.length === 0 || 
                       (queue.length > 0 && now - queue[queue.length - 1].queuedAt > this.bucketTimeout)) {
                this.messageQueues.delete(userId);
                cleanedQueues++;
            }
        }
        
        if (cleanedBuckets > 0 || cleanedQueues > 0) {
            logger.info(`Cleanup completed: ${cleanedBuckets} buckets, ${cleanedQueues} queues`);
        }
        
        return { cleanedBuckets, cleanedQueues };
    }

    // Start automatic cleanup process
    startCleanupProcess() {
        setInterval(() => {
            try {
                this.cleanup();
            } catch (error) {
                logger.error('Error during rate limiter cleanup:', error);
            }
        }, this.cleanupInterval);
        
        logger.info('Rate limiter cleanup process started');
    }

    // Advanced rate limiting with different tiers
    checkAdvancedLimit(userId, tier = 'standard') {
        const tierLimits = this.getTierLimits(tier);
        const bucket = this.getUserBucket(userId);
        
        // Temporarily adjust limits for this check
        const originalLimits = { ...this.limits };
        this.limits = tierLimits;
        
        const result = this.consumeToken(bucket);
        
        // Restore original limits
        this.limits = originalLimits;
        
        return result;
    }

    getTierLimits(tier) {
        const tiers = {
            basic: {
                messagesPerMinute: 1,
                messagesPerHour: 10,
                burstLimit: 2
            },
            standard: {
                messagesPerMinute: 2,
                messagesPerHour: 20,
                burstLimit: 3
            },
            premium: {
                messagesPerMinute: 5,
                messagesPerHour: 50,
                burstLimit: 5
            },
            unlimited: {
                messagesPerMinute: 100,
                messagesPerHour: 1000,
                burstLimit: 10
            }
        };
        
        return tiers[tier] || tiers.standard;
    }

    // Adaptive rate limiting based on server load
    adaptiveLimits(serverLoad) {
        if (serverLoad > 0.8) {
            // High load - reduce limits
            this.updateLimits({
                messagesPerMinute: 1,
                messagesPerHour: 15,
                burstLimit: 2
            });
        } else if (serverLoad < 0.4) {
            // Low load - increase limits
            this.updateLimits({
                messagesPerMinute: 3,
                messagesPerHour: 30,
                burstLimit: 4
            });
        }
        
        logger.info(`Adaptive rate limiting applied for server load: ${serverLoad}`);
    }

    // Emergency rate limiting
    enableEmergencyMode() {
        logger.warn('Emergency rate limiting enabled');
        
        this.updateLimits({
            messagesPerMinute: 1,
            messagesPerHour: 5,
            burstLimit: 1
        });
    }

    disableEmergencyMode() {
        logger.info('Emergency rate limiting disabled');
        
        // Restore default limits
        this.updateLimits({
            messagesPerMinute: 2,
            messagesPerHour: 20,
            burstLimit: 3
        });
    }

    // Health check
    healthCheck() {
        const stats = this.getSystemStats();
        
        return {
            status: 'healthy',
            activeBuckets: this.userBuckets.size,
            activeQueues: this.messageQueues.size,
            ...stats
        };
    }

    // Export data for monitoring
    exportMonitoringData() {
        const stats = this.getSystemStats();
        const bucketData = [];
        
        for (const [userId, bucket] of this.userBuckets) {
            bucketData.push({
                userId,
                minuteTokens: bucket.minuteTokens,
                hourTokens: bucket.hourTokens,
                totalRequests: bucket.totalRequests,
                blockedRequests: bucket.blockedRequests,
                lastActivity: bucket.lastActivity
            });
        }
        
        return {
            timestamp: new Date().toISOString(),
            systemStats: stats,
            buckets: bucketData,
            configuration: this.limits
        };
    }
}

module.exports = RateLimiter;

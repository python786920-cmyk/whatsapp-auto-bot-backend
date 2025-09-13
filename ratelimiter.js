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
        if (bucket.burstTokens < this.limits

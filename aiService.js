const { GoogleGenerativeAI } = require('@google/generative-ai');
const { logger, delay } = require('./utils');

class AIService {
    constructor() {
        this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        this.model = this.genAI.getGenerativeModel({ model: 'gemini-pro' });
        
        // Retry configuration
        this.maxRetries = 3;
        this.retryDelay = 1000;
        
        // Rate limiting
        this.lastRequestTime = 0;
        this.minRequestInterval = 1000; // 1 second between requests
        
        // Fallback responses for different languages
        this.fallbackResponses = {
            hindi: [
                "Sorry yaar, abhi thoda technical issue hai. Main jaldi fix kar dunga! 🤖",
                "Arе yaar, server mein thodi problem hai. Thoda wait karo! 😅",
                "Technical difficulty ho rahi hai bhai. Main wapas aaunga! ⚡"
            ],
            english: [
                "Sorry, I'm having some technical difficulties right now! 🤖",
                "Oops! Something went wrong on my end. Give me a moment! 😅",
                "Technical issue happening. I'll be back soon! ⚡"
            ],
            hinglish: [
                "Sorry yaar, technical problem ho gaya hai! Main jaldi theek kar dunga 🤖",
                "Arre bhai, server down hai thoda. Wait karo please! 😅",
                "AI brain mein kuch gadbad hai. Jaldi fix karunga! ⚡"
            ]
        };
    }

    async generateResponse({ message, sender, conversationHistory = [], language = 'hinglish' }) {
        try {
            // Rate limiting check
            await this.enforceRateLimit();

            // Build conversation context
            const contextPrompt = this.buildContextPrompt(message, sender, conversationHistory, language);
            
            // Generate response with retry logic
            let response = null;
            let lastError = null;

            for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
                try {
                    logger.info(`AI request attempt ${attempt} for message: ${message.substring(0, 50)}...`);
                    
                    const result = await this.model.generateContent(contextPrompt);
                    const responseText = result.response.text();
                    
                    if (responseText && responseText.trim().length > 0) {
                        response = this.postProcessResponse(responseText, language);
                        break;
                    }
                    
                } catch (error) {
                    lastError = error;
                    logger.warn(`AI request attempt ${attempt} failed:`, error.message);
                    
                    if (attempt < this.maxRetries) {
                        const delayTime = this.retryDelay * Math.pow(2, attempt - 1);
                        await delay(delayTime);
                    }
                }
            }

            if (!response) {
                logger.error('All AI attempts failed:', lastError);
                return this.getFallbackResponse(language);
            }

            logger.info(`AI response generated: ${response.substring(0, 100)}...`);
            return response;

        } catch (error) {
            logger.error('Error in generateResponse:', error);
            return this.getFallbackResponse(language);
        }
    }

    buildContextPrompt(message, sender, conversationHistory, language) {
        // System personality based on language
        let systemPrompt = '';
        
        switch (language) {
            case 'hindi':
                systemPrompt = `तुम एक दोस्ताना और मददगार AI असिस्टेंट हो। हमेशा हिंदी में जवाब दो। छोटे और प्राकृतिक उत्तर दो। इमोजी का इस्तेमाल करो।`;
                break;
            case 'english':
                systemPrompt = `You are a friendly and helpful AI assistant. Always reply in English. Keep responses short, natural, and conversational. Use emojis appropriately.`;
                break;
            default: // hinglish
                systemPrompt = `You are a friendly AI assistant who speaks Hinglish (Hindi + English mix). Keep replies short, natural, and conversational like a close friend. Use emojis. Mix Hindi and English naturally like Indians do in casual chat.`;
        }

        // Build conversation context
        let contextMessages = '';
        
        if (conversationHistory.length > 0) {
            contextMessages = '\n\nRecent conversation:\n';
            conversationHistory.slice(-6).forEach(msg => {
                const role = msg.fromMe ? 'Assistant' : 'User';
                contextMessages += `${role}: ${msg.body}\n`;
            });
        }

        // Current message context
        const currentContext = `\n\nUser (${sender}): ${message}\n\nAssistant:`;

        // Combine all parts
        const fullPrompt = `${systemPrompt}

Guidelines:
- Keep responses under 100 words
- Be helpful and friendly
- Use appropriate tone for the language
- Don't repeat the user's message
- If asked about yourself, say you're a WhatsApp AI assistant
- For greetings, respond warmly
- For questions, provide helpful answers
- Use emojis naturally but don't overuse

${contextMessages}${currentContext}`;

        return fullPrompt;
    }

    postProcessResponse(response, language) {
        // Clean up the response
        let cleaned = response.trim();
        
        // Remove common AI artifacts
        cleaned = cleaned.replace(/^(Assistant:|AI:|Bot:)\s*/i, '');
        cleaned = cleaned.replace(/\*\*(.*?)\*\*/g, '$1'); // Remove markdown bold
        cleaned = cleaned.replace(/\*(.*?)\*/g, '$1'); // Remove markdown italics
        
        // Ensure response isn't too long
        if (cleaned.length > 300) {
            cleaned = cleaned.substring(0, 300).trim();
            
            // Find last complete sentence
            const lastPeriod = cleaned.lastIndexOf('.');
            const lastQuestion = cleaned.lastIndexOf('?');
            const lastExclamation = cleaned.lastIndexOf('!');
            
            const lastSentence = Math.max(lastPeriod, lastQuestion, lastExclamation);
            if (lastSentence > 200) {
                cleaned = cleaned.substring(0, lastSentence + 1);
            } else {
                cleaned += '...';
            }
        }

        // Add personality touches based on language
        if (language === 'hinglish') {
            // Add typical Hinglish expressions if missing
            if (!cleaned.includes('yaar') && !cleaned.includes('bhai') && Math.random() < 0.3) {
                cleaned = cleaned.replace(/^/, 'Haan ');
            }
        }

        return cleaned;
    }

    async enforceRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.minRequestInterval) {
            const waitTime = this.minRequestInterval - timeSinceLastRequest;
            await delay(waitTime);
        }
        
        this.lastRequestTime = Date.now();
    }

    getFallbackResponse(language) {
        const responses = this.fallbackResponses[language] || this.fallbackResponses.hinglish;
        const randomIndex = Math.floor(Math.random() * responses.length);
        return responses[randomIndex];
    }

    // Helper method to detect message intent
    detectIntent(message) {
        const lowerMsg = message.toLowerCase();
        
        // Greeting detection
        const greetings = ['hi', 'hello', 'hey', 'namaste', 'hola', 'sup', 'kya hal', 'kaise ho'];
        if (greetings.some(g => lowerMsg.includes(g))) {
            return 'greeting';
        }
        
        // Question detection
        if (lowerMsg.includes('?') || lowerMsg.startsWith('what') || lowerMsg.startsWith('how') || 
            lowerMsg.startsWith('kya') || lowerMsg.startsWith('kaise') || lowerMsg.startsWith('kab')) {
            return 'question';
        }
        
        // Help request
        const helpKeywords = ['help', 'madad', 'problem', 'issue', 'kya karu'];
        if (helpKeywords.some(h => lowerMsg.includes(h))) {
            return 'help';
        }
        
        // Goodbye
        const goodbyes = ['bye', 'goodbye', 'see you', 'alvida', 'chalo'];
        if (goodbyes.some(g => lowerMsg.includes(g))) {
            return 'goodbye';
        }
        
        return 'general';
    }

    // Generate quick responses for common intents
    generateQuickResponse(intent, language) {
        const responses = {
            greeting: {
                hinglish: ['Hey! Kaise ho? 😊', 'Namaste! Main tumhara AI friend hun! 🤖', 'Hi there! Kya haal hai? 👋'],
                hindi: ['नमस्ते! कैसे हैं आप? 😊', 'हैलो! मैं आपका AI मित्र हूँ! 🤖', 'हाय! क्या हाल है? 👋'],
                english: ['Hey! How are you doing? 😊', 'Hello! I\'m your AI assistant! 🤖', 'Hi there! What\'s up? 👋']
            },
            goodbye: {
                hinglish: ['Bye bye! Take care yaar! 👋', 'Alvida! Milte hain phir! 😊', 'See you later! Khush raho! ✨'],
                hindi: ['अलविदा! ध्यान रखिए! 👋', 'फिर मिलेंगे! खुश रहिए! 😊', 'बाय बाय! ✨'],
                english: ['Goodbye! Take care! 👋', 'See you later! Stay awesome! 😊', 'Bye! Have a great day! ✨']
            }
        };
        
        if (responses[intent] && responses[intent][language]) {
            const options = responses[intent][language];
            return options[Math.floor(Math.random() * options.length)];
        }
        
        return null;
    }

    // Advanced response generation with intent detection
    async generateAdvancedResponse({ message, sender, conversationHistory = [], language = 'hinglish' }) {
        try {
            // Check for quick response patterns first
            const intent = this.detectIntent(message);
            const quickResponse = this.generateQuickResponse(intent, language);
            
            // For simple greetings/goodbyes, use quick responses
            if (quickResponse && (intent === 'greeting' || intent === 'goodbye') && Math.random() < 0.7) {
                return quickResponse;
            }
            
            // For complex queries, use full AI generation
            return await this.generateResponse({ message, sender, conversationHistory, language });
            
        } catch (error) {
            logger.error('Error in generateAdvancedResponse:', error);
            return this.getFallbackResponse(language);
        }
    }

    // Health check for AI service
    async healthCheck() {
        try {
            const testPrompt = 'Say "OK" if you can respond.';
            const result = await this.model.generateContent(testPrompt);
            const response = result.response.text();
            
            return {
                status: 'healthy',
                response: response.trim(),
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

    // Get service statistics
    getStats() {
        return {
            lastRequestTime: this.lastRequestTime,
            maxRetries: this.maxRetries,
            minRequestInterval: this.minRequestInterval,
            uptime: process.uptime()
        };
    }
}

module.exports = AIService;

// logger.js

/**
 * Simple timestamped logger with log levels
 * Provides consistent formatting across the application
 */

const getTimestamp = () => {
    const now = new Date();
    return `[${now.toLocaleTimeString()}.${now.getMilliseconds().toString().padStart(3, '0')}]`;
};

const logger = {
    /**
     * Info level - general information
     */
    info: (...args) => {
        console.log(getTimestamp(), '[INFO]', ...args);
    },

    /**
     * Warning level - potential issues
     */
    warn: (...args) => {
        console.warn(getTimestamp(), '[WARN]', ...args);
    },

    /**
     * Error level - errors and exceptions
     */
    error: (...args) => {
        console.error(getTimestamp(), '[ERROR]', ...args);
    },

    /**
     * Debug level - detailed debugging information
     */
    debug: (...args) => {
        // Only log debug in development mode
        if (process.env.NODE_ENV !== 'production') {
            console.log(getTimestamp(), '[DEBUG]', ...args);
        }
    },

    /**
     * Success level - successful operations (uses info internally)
     */
    success: (...args) => {
        console.log(getTimestamp(), '[SUCCESS]', ...args);
    }
};

/**
 * Safe message deletion helper - handles common Discord API errors gracefully
 * @param {Message} message - Discord message to delete
 * @param {string} reason - Optional reason for logging purposes
 * @returns {Promise<boolean>} True if deleted, false if already deleted or failed
 */
export const safeDelete = async (message, reason = 'cleanup') => {
    if (!message || !message.delete) {
        logger.debug(`⚠️ safeDelete: Invalid message object (${reason})`);
        return false;
    }
    
    try {
        await message.delete();
        logger.debug(`🗑️ Deleted message (${reason})`);
        return true;
    } catch (err) {
        // Error code 10008 = Unknown Message (already deleted)
        // Error code 10003 = Unknown Channel (channel deleted)
        if (err.code === 10008 || err.code === 10003) {
            logger.debug(`ℹ️ Message already deleted or channel gone (${reason})`);
            return false;
        }
        
        // Log other errors but don't throw
        logger.warn(`⚠️ Failed to delete message (${reason}):`, err.message);
        return false;
    }
};

export default logger;

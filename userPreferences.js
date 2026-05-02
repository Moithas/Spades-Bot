// userPreferences.js
import fs from 'fs/promises';
import path from 'path';
import logger from './logger.js';

const PREFERENCES_FILE = path.join(process.cwd(), 'userPreferences.json');

// Default preferences for new users
const DEFAULT_PREFERENCES = {
    biddingSuggestions: true,
    handStrengthIndicator: true,
    colorBlindMode: false,
    recommendedCardPlay: true,
    cardBackTheme: 'blue', // Options: 'blue', 'red', 'green', 'purple', 'classic'
    deckTheme: 'classic' // Options: 'classic', 'steampunk', 'minimalist', 'neon', 'medieval'
};

/**
 * Load user preferences from JSON file
 * @returns {Promise<Object>} Map of userId -> preferences
 */
export async function loadUserPreferences() {
    try {
        const data = await fs.readFile(PREFERENCES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File doesn't exist yet, create it with empty object
            await saveUserPreferences({});
            return {};
        }
        logger.error('Error loading user preferences:', error);
        return {};
    }
}

/**
 * Save user preferences to JSON file
 * @param {Object} preferences - Map of userId -> preferences
 * @returns {Promise<void>}
 */
export async function saveUserPreferences(preferences) {
    try {
        await fs.writeFile(PREFERENCES_FILE, JSON.stringify(preferences, null, 2), 'utf8');
    } catch (error) {
        logger.error('Error saving user preferences:', error);
    }
}

/**
 * Get preferences for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object>} User's preferences
 */
export async function getUserPreferences(userId) {
    const allPreferences = await loadUserPreferences();
    return allPreferences[userId] || { ...DEFAULT_PREFERENCES };
}

/**
 * Update preferences for a specific user
 * @param {string} userId - Discord user ID
 * @param {Object} newPreferences - Preferences to update
 * @returns {Promise<Object>} Updated preferences
 */
export async function updateUserPreferences(userId, newPreferences) {
    const allPreferences = await loadUserPreferences();
    
    if (!allPreferences[userId]) {
        allPreferences[userId] = { ...DEFAULT_PREFERENCES };
    }
    
    // Merge new preferences with existing ones
    allPreferences[userId] = {
        ...allPreferences[userId],
        ...newPreferences
    };
    
    await saveUserPreferences(allPreferences);
    return allPreferences[userId];
}

/**
 * Get default preferences
 * @returns {Object} Default preferences object
 */
export function getDefaultPreferences() {
    return { ...DEFAULT_PREFERENCES };
}

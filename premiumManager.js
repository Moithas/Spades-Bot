// premiumManager.js
// Handles Discord's native monetization and premium entitlements

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// Owner/Admin Override - These users always have full premium access
// =============================================================================
const PREMIUM_OVERRIDE_IDS = [
    '706155855934128228' // Bot owner - Brian
];

// =============================================================================
// Guild Override - All users in these servers get full premium access
// =============================================================================
const PREMIUM_OVERRIDE_GUILDS = [
    '1417672485964615702' // Brian's server
];

// =============================================================================
// SKU Configuration - Get these from Discord Developer Portal > Monetization
// =============================================================================

// Premium subscription (monthly) - includes cutthroat modes, card backs, custom scores
const PREMIUM_SKU_ID = process.env.PREMIUM_SKU_ID || 'YOUR_MONTHLY_SUB_SKU_HERE';

// Lifetime premium (one-time) - includes everything subscription does
const PREMIUM_LIFETIME_SKU_ID = process.env.PREMIUM_LIFETIME_SKU_ID || 'YOUR_LIFETIME_SKU_HERE';

// Individual deck theme SKUs (one-time purchases)
const THEME_SKUS = {
    steampunk: process.env.THEME_STEAMPUNK_SKU_ID || 'YOUR_STEAMPUNK_SKU_HERE',
    medieval: process.env.THEME_MEDIEVAL_SKU_ID || 'YOUR_MEDIEVAL_SKU_HERE',
    holographic: process.env.THEME_HOLOGRAPHIC_SKU_ID || 'YOUR_HOLOGRAPHIC_SKU_HERE',
    cosmic: process.env.THEME_COSMIC_SKU_ID || 'YOUR_COSMIC_SKU_HERE',
    cyberpunk: process.env.THEME_CYBERPUNK_SKU_ID || 'YOUR_CYBERPUNK_SKU_HERE',
    christmas: process.env.THEME_CHRISTMAS_SKU_ID || 'YOUR_CHRISTMAS_SKU_HERE'
};

// All premium-related SKUs for fetching entitlements
const ALL_SKU_IDS = [
    PREMIUM_SKU_ID,
    PREMIUM_LIFETIME_SKU_ID,
    ...Object.values(THEME_SKUS)
].filter(sku => sku && !sku.startsWith('YOUR_')); // Filter out placeholder values

// Cache file for premium users (backup for API failures)
const PREMIUM_CACHE_FILE = path.join(__dirname, 'stats', 'premiumCache.json');

// In-memory cache with TTL
const premiumCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Feature Definitions
// =============================================================================

// Deck themes - FREE themes available to all, others purchasable individually
const FREE_THEMES = ['classic', 'minimalist', 'neon'];
const PURCHASABLE_THEMES = ['steampunk', 'medieval', 'holographic', 'cosmic', 'cyberpunk', 'christmas'];

// Card back themes - requires premium subscription
const FREE_CARD_BACKS = ['blue'];
const PREMIUM_CARD_BACKS = ['red', 'green', 'purple', 'classic', 'christmas'];

// Game modes - cutthroat requires premium subscription
const FREE_GAME_MODES = ['classic'];
const PREMIUM_GAME_MODES = ['cutthroat3', 'cutthroat4'];

// AI difficulty levels - hard requires premium subscription
const FREE_AI_DIFFICULTIES = ['easy', 'medium'];
const PREMIUM_AI_DIFFICULTIES = ['hard'];

const PREMIUM_FEATURES = {
    // Theme access (purchasable individually)
    themes: {
        free: FREE_THEMES,
        purchasable: PURCHASABLE_THEMES
    },
    // Card back themes (premium subscription)
    cardBacks: {
        free: FREE_CARD_BACKS,
        premium: PREMIUM_CARD_BACKS
    },
    // Game modes (premium subscription)
    gameModes: {
        free: FREE_GAME_MODES,
        premium: PREMIUM_GAME_MODES
    },
    // Target score customization (premium subscription)
    targetScore: {
        free: { min: 500, max: 500 },
        premium: { min: 100, max: 1000 }
    },
    // Stats features
    stats: {
        free: ['basic'],
        premium: ['basic', 'advanced', 'history', 'analytics']
    },
    // AI features
    ai: {
        free: ['standard'],
        premium: ['standard', 'adjustable_difficulty', 'custom_names']
    }
};

/**
 * Load premium cache from disk
 */
function loadPremiumCache() {
    try {
        if (fs.existsSync(PREMIUM_CACHE_FILE)) {
            const data = JSON.parse(fs.readFileSync(PREMIUM_CACHE_FILE, 'utf8'));
            for (const [userId, entry] of Object.entries(data)) {
                premiumCache.set(userId, entry);
            }
            logger.info(`📋 Loaded ${premiumCache.size} premium cache entries`);
        }
    } catch (err) {
        logger.warn('⚠️ Could not load premium cache:', err.message);
    }
}

/**
 * Save premium cache to disk
 */
function savePremiumCache() {
    try {
        const data = Object.fromEntries(premiumCache);
        fs.writeFileSync(PREMIUM_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        logger.warn('⚠️ Could not save premium cache:', err.message);
    }
}

// Load cache on startup
loadPremiumCache();

/**
 * Fetch all entitlements for a user and return structured data
 * @param {Client} client - Discord client
 * @param {string} userId - User's Discord ID
 * @param {string} guildId - Guild ID (optional, for guild-based premium)
 * @returns {Promise<Object>} User's entitlements { isPremium, isLifetime, ownedThemes }
 */
async function fetchUserEntitlements(client, userId, guildId = null) {
    // Check for owner/admin override - full access to everything
    if (PREMIUM_OVERRIDE_IDS.includes(userId)) {
        return {
            isPremium: true,
            isLifetime: true,
            ownedThemes: [...FREE_THEMES, ...PURCHASABLE_THEMES],
            timestamp: Date.now()
        };
    }

    // Check for guild override - all users in these servers get premium
    if (guildId && PREMIUM_OVERRIDE_GUILDS.includes(guildId)) {
        return {
            isPremium: true,
            isLifetime: false,
            ownedThemes: [...FREE_THEMES, ...PURCHASABLE_THEMES],
            timestamp: Date.now()
        };
    }

    // Check in-memory cache first
    const cached = premiumCache.get(userId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached;
    }

    try {
        // Fetch user's entitlements from Discord for all our SKUs
        const skusToCheck = ALL_SKU_IDS.length > 0 ? ALL_SKU_IDS : [PREMIUM_SKU_ID];
        const entitlements = await client.application.entitlements.fetch({
            userId: userId,
            skuIds: skusToCheck
        });

        // Check for active subscription or lifetime
        let isPremium = false;
        let isLifetime = false;
        const ownedThemes = [...FREE_THEMES]; // Everyone gets free themes

        for (const ent of entitlements.values()) {
            // Skip expired entitlements
            if (ent.endsAt && new Date(ent.endsAt) < new Date()) {
                continue;
            }

            // Check if it's a subscription
            if (ent.skuId === PREMIUM_SKU_ID) {
                isPremium = true;
            }
            
            // Check if it's lifetime
            if (ent.skuId === PREMIUM_LIFETIME_SKU_ID) {
                isPremium = true;
                isLifetime = true;
            }

            // Check for individual theme purchases
            for (const [themeName, themeSku] of Object.entries(THEME_SKUS)) {
                if (ent.skuId === themeSku && !ownedThemes.includes(themeName)) {
                    ownedThemes.push(themeName);
                }
            }
        }

        // Build cache entry
        const cacheEntry = {
            isPremium,
            isLifetime,
            ownedThemes,
            timestamp: Date.now()
        };

        // Update cache
        premiumCache.set(userId, cacheEntry);
        savePremiumCache();

        return cacheEntry;
    } catch (err) {
        logger.warn(`⚠️ Could not fetch entitlements for ${userId}:`, err.message);
        
        // Fall back to cache if API fails
        if (cached) {
            return cached;
        }
        
        // Return default (free user)
        return {
            isPremium: false,
            isLifetime: false,
            ownedThemes: [...FREE_THEMES],
            timestamp: Date.now()
        };
    }
}

/**
 * Check if a user has premium subscription (monthly or lifetime)
 * @param {Client} client - Discord client
 * @param {string} userId - User's Discord ID
 * @param {string} guildId - Guild ID (optional)
 * @returns {Promise<boolean>} Whether user has premium
 */
async function checkPremiumEntitlement(client, userId, guildId = null) {
    const entitlements = await fetchUserEntitlements(client, userId, guildId);
    return entitlements.isPremium;
}

/**
 * Check if a user owns a specific theme (purchased or free)
 * @param {Client} client - Discord client
 * @param {string} userId - User's Discord ID
 * @param {string} theme - Theme name
 * @param {string} guildId - Guild ID (optional)
 * @returns {Promise<boolean>} Whether user owns the theme
 */
async function checkThemeOwnership(client, userId, theme, guildId = null) {
    // Free themes are always available
    if (FREE_THEMES.includes(theme)) {
        return true;
    }
    
    const entitlements = await fetchUserEntitlements(client, userId, guildId);
    return entitlements.ownedThemes.includes(theme);
}

/**
 * Get list of themes a user owns
 * @param {Client} client - Discord client
 * @param {string} userId - User's Discord ID
 * @param {string} guildId - Guild ID (optional)
 * @returns {Promise<string[]>} Array of owned theme names
 */
async function getOwnedThemes(client, userId, guildId = null) {
    const entitlements = await fetchUserEntitlements(client, userId, guildId);
    return entitlements.ownedThemes;
}

/**
 * Get the SKU ID for a theme (for purchase prompts)
 * @param {string} theme - Theme name
 * @returns {string|null} SKU ID or null if not purchasable
 */
function getThemeSku(theme) {
    return THEME_SKUS[theme] || null;
}

/**
 * Check if a theme is available for a user (for backward compatibility)
 * This is used in the settings dropdown to determine theme access
 * @param {string} theme - Theme name
 * @param {string[]} ownedThemes - Array of themes the user owns
 * @returns {boolean} Whether theme is accessible
 */
function isThemeAvailable(theme, ownedThemes = FREE_THEMES) {
    return ownedThemes.includes(theme);
}

/**
 * Get available themes for a user based on owned themes
 * @param {string[]} ownedThemes - Array of themes the user owns
 * @returns {string[]} Available theme names
 */
function getAvailableThemes(ownedThemes = FREE_THEMES) {
    return [...ownedThemes];
}

/**
 * Check if target score is valid for user
 * @param {number} score - Target score
 * @param {boolean} isPremium - Whether user has premium
 * @returns {boolean} Whether score is valid
 */
function isTargetScoreValid(score, isPremium) {
    const limits = isPremium ? PREMIUM_FEATURES.targetScore.premium : PREMIUM_FEATURES.targetScore.free;
    return score >= limits.min && score <= limits.max;
}

/**
 * Get target score limits for user
 * @param {boolean} isPremium - Whether user has premium
 * @returns {Object} { min, max }
 */
function getTargetScoreLimits(isPremium) {
    return isPremium ? PREMIUM_FEATURES.targetScore.premium : PREMIUM_FEATURES.targetScore.free;
}

/**
 * Check if a card back theme is available for a user
 * @param {string} theme - Card back theme name
 * @param {boolean} isPremium - Whether user has premium
 * @returns {boolean} Whether card back is accessible
 */
function isCardBackAvailable(theme, isPremium) {
    if (FREE_CARD_BACKS.includes(theme)) {
        return true;
    }
    return isPremium && PREMIUM_CARD_BACKS.includes(theme);
}

/**
 * Get available card back themes for a user
 * @param {boolean} isPremium - Whether user has premium
 * @returns {string[]} Available card back theme names
 */
function getAvailableCardBacks(isPremium) {
    if (isPremium) {
        return [...FREE_CARD_BACKS, ...PREMIUM_CARD_BACKS];
    }
    return [...FREE_CARD_BACKS];
}

/**
 * Check if a game mode is available for a user
 * @param {string} mode - Game mode ('classic', 'cutthroat3', 'cutthroat4')
 * @param {boolean} isPremium - Whether user has premium
 * @returns {boolean} Whether game mode is accessible
 */
function isGameModeAvailable(mode, isPremium) {
    if (FREE_GAME_MODES.includes(mode)) {
        return true;
    }
    return isPremium && PREMIUM_GAME_MODES.includes(mode);
}

/**
 * Get available game modes for a user
 * @param {boolean} isPremium - Whether user has premium
 * @returns {string[]} Available game mode names
 */
function getAvailableGameModes(isPremium) {
    if (isPremium) {
        return [...FREE_GAME_MODES, ...PREMIUM_GAME_MODES];
    }
    return [...FREE_GAME_MODES];
}

/**
 * Check if an AI difficulty is available for a user
 * @param {string} difficulty - AI difficulty ('easy', 'medium', 'hard')
 * @param {boolean} isPremium - Whether user has premium
 * @returns {boolean} Whether difficulty is accessible
 */
function isAIDifficultyAvailable(difficulty, isPremium) {
    if (FREE_AI_DIFFICULTIES.includes(difficulty)) {
        return true;
    }
    return isPremium && PREMIUM_AI_DIFFICULTIES.includes(difficulty);
}

/**
 * Get available AI difficulties for a user
 * @param {boolean} isPremium - Whether user has premium
 * @returns {string[]} Available difficulty levels
 */
function getAvailableAIDifficulties(isPremium) {
    if (isPremium) {
        return [...FREE_AI_DIFFICULTIES, ...PREMIUM_AI_DIFFICULTIES];
    }
    return [...FREE_AI_DIFFICULTIES];
}

/**
 * Handle entitlement create event (user subscribed)
 * @param {Entitlement} entitlement - The entitlement object
 */
function handleEntitlementCreate(entitlement) {
    const userId = entitlement.userId;
    logger.success(`⭐ New premium subscription: ${userId}`);
    
    premiumCache.set(userId, {
        isPremium: true,
        timestamp: Date.now()
    });
    savePremiumCache();
}

/**
 * Handle entitlement update event (subscription changed)
 * @param {Entitlement} oldEntitlement - Old entitlement
 * @param {Entitlement} newEntitlement - New entitlement
 */
function handleEntitlementUpdate(oldEntitlement, newEntitlement) {
    const userId = newEntitlement.userId;
    const isActive = !newEntitlement.endsAt || new Date(newEntitlement.endsAt) > new Date();
    
    logger.info(`📋 Premium update for ${userId}: ${isActive ? 'active' : 'expired'}`);
    
    premiumCache.set(userId, {
        isPremium: isActive,
        timestamp: Date.now()
    });
    savePremiumCache();
}

/**
 * Handle entitlement delete event (subscription cancelled/ended)
 * @param {Entitlement} entitlement - The entitlement object
 */
function handleEntitlementDelete(entitlement) {
    const userId = entitlement.userId;
    logger.info(`📋 Premium ended for ${userId}`);
    
    premiumCache.set(userId, {
        isPremium: false,
        timestamp: Date.now()
    });
    savePremiumCache();
}

/**
 * Clear a user from cache (force refresh)
 * @param {string} userId - User's Discord ID
 */
function clearUserCache(userId) {
    premiumCache.delete(userId);
}

/**
 * Get premium status display info
 * @param {boolean} isPremium - Whether user has premium
 * @returns {Object} Display info with emoji and text
 */
function getPremiumDisplay(isPremium) {
    return isPremium 
        ? { emoji: '⭐', text: 'Premium', color: '#FFD700' }
        : { emoji: '', text: 'Free', color: '#808080' };
}

export {
    PREMIUM_SKU_ID,
    PREMIUM_LIFETIME_SKU_ID,
    THEME_SKUS,
    FREE_THEMES,
    PURCHASABLE_THEMES,
    FREE_CARD_BACKS,
    PREMIUM_CARD_BACKS,
    FREE_GAME_MODES,
    PREMIUM_GAME_MODES,
    FREE_AI_DIFFICULTIES,
    PREMIUM_AI_DIFFICULTIES,
    PREMIUM_FEATURES,
    fetchUserEntitlements,
    checkPremiumEntitlement,
    checkThemeOwnership,
    getOwnedThemes,
    getThemeSku,
    isThemeAvailable,
    getAvailableThemes,
    isCardBackAvailable,
    getAvailableCardBacks,
    isGameModeAvailable,
    getAvailableGameModes,
    isAIDifficultyAvailable,
    getAvailableAIDifficulties,
    isTargetScoreValid,
    getTargetScoreLimits,
    handleEntitlementCreate,
    handleEntitlementUpdate,
    handleEntitlementDelete,
    clearUserCache,
    getPremiumDisplay
};

export default {
    PREMIUM_SKU_ID,
    PREMIUM_LIFETIME_SKU_ID,
    THEME_SKUS,
    FREE_THEMES,
    PURCHASABLE_THEMES,
    FREE_CARD_BACKS,
    PREMIUM_CARD_BACKS,
    FREE_GAME_MODES,
    PREMIUM_GAME_MODES,
    FREE_AI_DIFFICULTIES,
    PREMIUM_AI_DIFFICULTIES,
    PREMIUM_FEATURES,
    fetchUserEntitlements,
    checkPremiumEntitlement,
    checkThemeOwnership,
    getOwnedThemes,
    getThemeSku,
    isThemeAvailable,
    getAvailableThemes,
    isCardBackAvailable,
    getAvailableCardBacks,
    isGameModeAvailable,
    getAvailableGameModes,
    isAIDifficultyAvailable,
    getAvailableAIDifficulties,
    isTargetScoreValid,
    getTargetScoreLimits,
    handleEntitlementCreate,
    handleEntitlementUpdate,
    handleEntitlementDelete,
    clearUserCache,
    getPremiumDisplay
};

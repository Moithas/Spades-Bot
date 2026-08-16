// guildSettings.js
//
// Per-guild (server) settings, keyed by guildId. Mirrors userPreferences.js. Currently
// holds the auto-delete-finished-thread policy, which a server admin can tune via
// /spades autodelete.

import fs from 'fs/promises';
import path from 'path';
import logger from './logger.js';

const GUILD_SETTINGS_FILE = path.join(process.cwd(), 'guildSettings.json');

// Defaults applied to any guild that hasn't customized its settings.
export const DEFAULT_GUILD_SETTINGS = {
    autoDeleteThread: true,       // delete a game's thread after it finishes
    autoDeleteThreadMinutes: 3,   // how long to wait first (for post-game banter)
};

export async function loadGuildSettings() {
    try {
        const data = await fs.readFile(GUILD_SETTINGS_FILE, 'utf8');
        return JSON.parse(data.replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error.code === 'ENOENT') {
            await saveGuildSettings({});
            return {};
        }
        logger.error('Error loading guild settings:', error);
        return {};
    }
}

export async function saveGuildSettings(allSettings) {
    try {
        await fs.writeFile(GUILD_SETTINGS_FILE, JSON.stringify(allSettings, null, 2), 'utf8');
    } catch (error) {
        logger.error('Error saving guild settings:', error);
    }
}

/**
 * Get the effective settings for a guild (defaults merged with any stored overrides).
 * @param {string} guildId
 * @returns {Promise<{autoDeleteThread: boolean, autoDeleteThreadMinutes: number}>}
 */
export async function getGuildSettings(guildId) {
    if (!guildId) return { ...DEFAULT_GUILD_SETTINGS };
    const all = await loadGuildSettings();
    return { ...DEFAULT_GUILD_SETTINGS, ...(all[guildId] || {}) };
}

/**
 * Merge a partial patch into a guild's settings and persist.
 * @param {string} guildId
 * @param {Partial<typeof DEFAULT_GUILD_SETTINGS>} patch
 */
export async function updateGuildSettings(guildId, patch) {
    if (!guildId) return { ...DEFAULT_GUILD_SETTINGS };
    const all = await loadGuildSettings();
    const merged = { ...DEFAULT_GUILD_SETTINGS, ...(all[guildId] || {}), ...patch };
    all[guildId] = merged;
    await saveGuildSettings(all);
    return merged;
}

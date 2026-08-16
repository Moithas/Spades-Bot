// botSettings.js
//
// Global (bot-wide) settings set by the bot owner, applied across every guild/game.
// Currently holds optional announcements shown when a game starts and when it finishes
// (e.g. "Reach out to <@OWNER> with feedback or suggestions.").

import fs from 'fs/promises';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import logger from './logger.js';

const BOT_SETTINGS_FILE = path.join(process.cwd(), 'botSettings.json');

export const DEFAULT_BOT_SETTINGS = {
    startMessage: null, // shown when a game starts
    endMessage: null,   // shown when a game finishes
};

export async function getBotSettings() {
    try {
        const data = await fs.readFile(BOT_SETTINGS_FILE, 'utf8');
        return { ...DEFAULT_BOT_SETTINGS, ...JSON.parse(data.replace(/^\uFEFF/, '')) };
    } catch (error) {
        if (error.code === 'ENOENT') return { ...DEFAULT_BOT_SETTINGS };
        logger.error('Error loading bot settings:', error);
        return { ...DEFAULT_BOT_SETTINGS };
    }
}

export async function updateBotSettings(patch) {
    const current = await getBotSettings();
    const merged = { ...current, ...patch };
    try {
        await fs.writeFile(BOT_SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
    } catch (error) {
        logger.error('Error saving bot settings:', error);
    }
    return merged;
}

/**
 * Post the configured start/end announcement to a game channel, if one is set.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {'start'|'end'} slot
 */
export async function postBotAnnouncement(channel, slot) {
    try {
        if (!channel) return;
        const settings = await getBotSettings();
        const message = slot === 'start' ? settings.startMessage : settings.endMessage;
        if (!message) return;
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📣 Announcement')
            .setDescription(message);
        await channel.send({ embeds: [embed] });
    } catch (e) {
        logger.error('Failed to post bot announcement:', e);
    }
}

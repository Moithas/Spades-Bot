// botSettings.js
//
// Global (bot-wide) settings set by the bot owner, applied across every guild/game.
// Currently holds optional announcements shown when a game starts and when it finishes
// (e.g. "Reach out to <@OWNER> with feedback or suggestions.").

import fs from 'fs/promises';
import path from 'path';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from './logger.js';

const BOT_SETTINGS_FILE = path.join(process.cwd(), 'botSettings.json');

export const DEFAULT_BOT_SETTINGS = {
    startMessage: null,      // shown when a game starts
    startButtonLabel: null,  // optional link-button label for the start announcement
    startButtonUrl: null,    // optional link-button URL for the start announcement
    endMessage: null,        // shown when a game finishes
    endButtonLabel: null,    // optional link-button label for the finish announcement
    endButtonUrl: null,      // optional link-button URL for the finish announcement
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
 * Post the configured start/end announcement to a game channel, if one is set. Renders the
 * message as an embed and, if a button URL is configured, an accompanying link button
 * (works across any server since it's just a URL).
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {'start'|'end'} slot
 */
export async function postBotAnnouncement(channel, slot) {
    try {
        if (!channel) return;
        const settings = await getBotSettings();
        const message = slot === 'start' ? settings.startMessage : settings.endMessage;
        const buttonUrl = slot === 'start' ? settings.startButtonUrl : settings.endButtonUrl;
        const buttonLabel = (slot === 'start' ? settings.startButtonLabel : settings.endButtonLabel) || 'Join';
        if (!message && !buttonUrl) return;

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('📣 Announcement');
        if (message) embed.setDescription(message);

        const payload = { embeds: [embed] };
        if (buttonUrl) {
            const button = new ButtonBuilder()
                .setStyle(ButtonStyle.Link)
                .setLabel(String(buttonLabel).slice(0, 80))
                .setURL(buttonUrl);
            payload.components = [new ActionRowBuilder().addComponents(button)];
        }
        await channel.send(payload);
    } catch (e) {
        logger.error('Failed to post bot announcement:', e);
    }
}

// game_logic/threadCleanup.js
//
// Schedules deletion of a finished game's thread. A completed game can't be resumed, so its
// thread is disposable — but we wait a few minutes first for post-game banter. The delay is
// configurable per server via guild settings (/spades autodelete).
//
// SAFETY: only ever deletes THREADS. Games can fall back to running in a regular guild
// channel (when thread creation isn't available); we must never delete one of those.

import logger from '../logger.js';
import { getGuildSettings } from '../guildSettings.js';

/**
 * @param {import('discord.js').GuildTextBasedChannel} channel - The game channel/thread.
 */
export async function scheduleThreadCleanup(channel) {
    try {
        // Only threads are auto-deletable. Regular channels are left alone.
        if (!channel || typeof channel.isThread !== 'function' || !channel.isThread()) return;

        const guildId = channel.guildId || channel.guild?.id || null;
        const settings = await getGuildSettings(guildId);
        if (!settings.autoDeleteThread) return;

        const minutes = Number(settings.autoDeleteThreadMinutes);
        const mins = Number.isFinite(minutes) && minutes > 0 ? minutes : 3;
        const delayMs = mins * 60 * 1000;

        try {
            await channel.send(
                `🧵 This game is over — this thread will be automatically deleted in **${mins} minute${mins !== 1 ? 's' : ''}**. Say your goodbyes! 👋`
            );
        } catch (e) {
            // Non-fatal: heads-up couldn't be sent (e.g. thread already archived/locked).
            logger.debug('🧵 Could not post auto-delete notice:', e?.message);
        }

        const timer = setTimeout(async () => {
            try {
                await channel.delete('Spades game finished — automatic thread cleanup');
                logger.info(`🧵 Auto-deleted finished game thread ${channel.id}`);
            } catch (e) {
                logger.error(`❌ Failed to auto-delete finished game thread ${channel.id}:`, e);
            }
        }, delayMs);
        if (timer.unref) timer.unref();
    } catch (err) {
        logger.error('❌ scheduleThreadCleanup failed:', err);
    }
}

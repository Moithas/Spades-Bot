// game_logic/threadCleanup.js
//
// Schedules deletion of a finished game's thread. A completed game can't be resumed, so its
// thread is disposable — but we wait a few minutes first for post-game banter. The delay is
// configurable per server via guild settings (/spades autodelete).
//
// SAFETY: only ever deletes THREADS. Games can fall back to running in a regular guild
// channel (when thread creation isn't available); we must never delete one of those.

import logger from '../logger.js';
import { PermissionsBitField } from 'discord.js';
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

        // Can the bot actually delete this thread? Deleting requires Manage Threads.
        let canDelete = false;
        try {
            let me = channel.guild?.members?.me;
            if (!me && channel.guild?.members?.fetchMe) {
                me = await channel.guild.members.fetchMe();
            }
            if (me && typeof channel.permissionsFor === 'function') {
                const perms = channel.permissionsFor(me);
                canDelete = !!perms && perms.has(PermissionsBitField.Flags.ManageThreads);
            }
        } catch (e) {
            logger.debug('🧵 Could not resolve bot thread permissions:', e?.message);
        }

        // Missing permission → don't make a promise we can't keep. Instead, surface the
        // feature so admins can discover it and grant the permission (or disable it).
        if (!canDelete) {
            try {
                await channel.send(
                    `🧵 **Tidy-up tip:** I can automatically delete finished game threads (after **${mins} min**) to keep this server clean — ` +
                    `but I need the **Manage Threads** permission, which I don't have here yet.\n` +
                    `A server admin can grant it, then this thread (and future finished games) will clean themselves up. ` +
                    `Admins can adjust or turn this off with \`/spades autodelete\`.`
                );
            } catch (e) {
                logger.debug('🧵 Could not post permission-discovery notice:', e?.message);
            }
            return;
        }

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

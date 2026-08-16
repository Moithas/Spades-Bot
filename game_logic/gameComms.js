// game_logic/gameComms.js
//
// Rebuilds a game's Discord "voice" (publicAnnounce / privatePrompt) so games restored from
// disk after a restart can talk to Discord again. These functions can't be serialized (they
// hold a live client reference), so the boot loader re-attaches them via buildGameComms().
//
// This mirrors the inline comms created at game-creation time in index.js. It is kept as a
// standalone copy so the (working) creation paths are not modified; the two can be merged
// later once restart recovery is proven in production.

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
} from 'discord.js';
import { renderTrickCards, renderCardBacks } from './CardRenderer.js';
import logger, { safeDelete } from '../logger.js';
import { playerStats } from '../stats/PlayerStats.js';
import { scheduleThreadCleanup } from './threadCleanup.js';

/**
 * @param {import('discord.js').Client} client - Logged-in Discord client.
 * @param {string} channelId - The game channel (thread) id.
 * @param {{ activeGames: Map<string, any>, retryDiscordCall: Function }} deps
 * @returns {{ publicAnnounce: Function, privatePrompt: Function }}
 */
export function buildGameComms(client, channelId, { activeGames, retryDiscordCall }) {
    const publicAnnounce = async (payload) => {
        // payload can be a string (legacy) or structured object
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                logger.error(`❌ Channel ${channelId} not found`);
                return;
            }

            if (typeof payload === 'string') {
                await retryDiscordCall(() => channel.send(payload));
                return;
            }

            // Handle bidding update: create or update unified bidding embed
            if (payload.type === 'bidding_update') {
                try {
                    const game = activeGames.get(channel.id);
                    if (!game) {
                        logger.error('❌ Game not found in activeGames for bidding update');
                        return;
                    }

                    const biddingEmbed = new EmbedBuilder()
                        .setColor('#1E90FF')
                        .setTitle(`🎯 Hand ${payload.round} - Bidding Phase`);

                    let bidsDisplay = '';
                    payload.bids.forEach((bidInfo) => {
                        const playerDisplay = bidInfo.isAI ? `**${bidInfo.playerName}**` : `<@${bidInfo.playerId}>`;
                        const bidDisplay = bidInfo.bid === null ? '❓' : bidInfo.bid;
                        bidsDisplay += `${playerDisplay}: **${bidDisplay}**\n`;
                    });

                    biddingEmbed.addFields({ name: 'Bids', value: bidsDisplay, inline: false });

                    if (payload.biddingComplete) {
                        biddingEmbed.addFields({
                            name: '🚨 BIDDING COMPLETE! 🚨',
                            value: 'All bids are in! Starting trick play in **10 seconds**...\n\n_Last bidder: You have 10 seconds to undo if needed._',
                            inline: false
                        });
                    } else {
                        const currentBidderMention = payload.isCurrentBidderAI
                            ? `**${payload.currentBidderName}**`
                            : `<@${payload.currentBidderId}>`;
                        let waitingMessage;
                        if (payload.aiPendingBid) {
                            waitingMessage = `${currentBidderMention} will bid in **10 seconds**...\n\n_Previous bidder: You have 10 seconds to undo if needed._`;
                        } else {
                            waitingMessage = `${currentBidderMention}, it's your turn to bid!`;
                        }
                        biddingEmbed.addFields({ name: '⏳ Waiting for...', value: waitingMessage, inline: false });
                    }

                    let components = [];
                    if (payload.canUndoPlayerId) {
                        const undoButton = new ButtonBuilder()
                            .setCustomId(`undo_bid:${channel.id}:${payload.canUndoPlayerId}`)
                            .setLabel('↩️ Undo My Bid')
                            .setStyle(ButtonStyle.Secondary);
                        components.push(new ActionRowBuilder().addComponents(undoButton));
                    }

                    if (payload.messageId) {
                        try {
                            const oldMessage = await channel.messages.fetch(payload.messageId);
                            await oldMessage.delete();
                            await new Promise(resolve => setTimeout(resolve, 100));
                        } catch (fetchErr) {
                            logger.debug('⚠️ Could not fetch/delete old bidding message:', fetchErr.message);
                        }
                    }

                    const newMsg = await retryDiscordCall(() => channel.send({ embeds: [biddingEmbed], components }));
                    game.biddingMessageId = newMsg.id;
                } catch (err) {
                    logger.error('❌ Failed to handle bidding_update:', err);
                }
                return;
            }

            // Handle dealing cards animation
            if (payload.type === 'dealing_cards') {
                try {
                    const game = activeGames.get(payload.channelId || channel.id);
                    const cardsPerPlayer = game && game.gameMode === 'cutthroat3' ? 17 : 13;

                    const dealerMention = payload.dealer.isAI ? `**${payload.dealer.username}**` : `<@${payload.dealer.discordId}>`;
                    const bidderMention = payload.firstBidder.isAI ? `**${payload.firstBidder.username}**` : `<@${payload.firstBidder.discordId}>`;

                    const dealingEmbed = new EmbedBuilder()
                        .setColor('#9CA3AF')
                        .setTitle(`🎴 Hand ${payload.round} - Dealing Cards...`)
                        .setDescription(`**Dealer:** ${dealerMention}\n**First to Bid:** ${bidderMention}\n\nEach player receives ${cardsPerPlayer} cards`);

                    let cardBackTheme = 'blue';
                    if (game && game.players && game.hostId) {
                        const host = game.players.find(p => p.discordId === game.hostId);
                        if (host && host.preferences && host.preferences.cardBackTheme) {
                            cardBackTheme = host.preferences.cardBackTheme;
                        }
                    }
                    const cardBacksImage = renderCardBacks(cardsPerPlayer, cardBackTheme);
                    const attachment = new AttachmentBuilder(cardBacksImage, { name: 'dealing.png' });
                    dealingEmbed.setImage('attachment://dealing.png');

                    let playerList = '';
                    payload.players.forEach((player, index) => {
                        const playerDisplay = player.isAI ? `🤖 ${player.username}` : `👤 ${player.username}`;
                        playerList += `${index + 1}. ${playerDisplay}\n`;
                    });
                    dealingEmbed.addFields({ name: 'Players', value: playerList, inline: false });

                    const actionRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`view_hand:${channel.id}`).setLabel('🎴 View Hand').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`view_status:${channel.id}`).setLabel('📊 Game Status').setStyle(ButtonStyle.Secondary)
                        );

                    await retryDiscordCall(() => channel.send({ embeds: [dealingEmbed], files: [attachment], components: [actionRow] }));
                    await new Promise(resolve => setTimeout(resolve, 1500));
                } catch (err) {
                    logger.error('❌ Failed to send dealing cards animation:', err);
                }
                return;
            }

            // Handle trick update: create or update embedded message showing all cards played
            if (payload.type === 'trick_update') {
                try {
                    const trickGame = activeGames.get(channel.id);
                    const maxPlayers = trickGame ? trickGame.getMaxPlayers() : 4;

                    const trickPlays = payload.trick;
                    const suitEmojis = { 'S': '♠️', 'H': '♥️', 'D': '♦️', 'C': '♣️' };

                    let description = '';
                    trickPlays.forEach((play, index) => {
                        const cardDisplay = `${play.card.rankCode === 'T' ? '10' : play.card.rankCode}${suitEmojis[play.card.suitCode]}`;
                        description += `${index + 1}. **${play.playerName}** played **${cardDisplay}**\n`;
                    });

                    const embed = new EmbedBuilder()
                        .setColor('#4169E1')
                        .setTitle(`🃏 Current Trick (${trickPlays.length}/${maxPlayers})`)
                        .setDescription(description || 'No cards played yet.');

                    if (payload.nextPlayerName) {
                        const nextPlayerMention = payload.isNextPlayerAI ? `**${payload.nextPlayerName}**` : `<@${payload.nextPlayerId}>`;
                        embed.addFields({ name: '⏭️ Up Next', value: `${nextPlayerMention}'s turn to play`, inline: false });
                    }

                    let trickImageAttachment = null;
                    if (trickPlays.length > 0) {
                        try {
                            const cardsForRender = trickPlays.map(play => ({ rankCode: play.card.rankCode, suitCode: play.card.suitCode }));
                            const trickImageBuffer = renderTrickCards(cardsForRender, trickGame.options.deckTheme);
                            trickImageAttachment = new AttachmentBuilder(trickImageBuffer, { name: 'trick.png' });
                            embed.setImage('attachment://trick.png');
                        } catch (err) {
                            logger.error('❌ Failed to render trick cards:', err);
                        }
                    }

                    const isFirstCardOfTrick = trickPlays.length === 1;

                    if (isFirstCardOfTrick) {
                        if (payload.previousTrickCardsMessageId) {
                            try {
                                const oldTrickMessage = await retryDiscordCall(() => channel.messages.fetch(payload.previousTrickCardsMessageId));
                                await retryDiscordCall(() => oldTrickMessage.delete());
                            } catch (err) {
                                logger.error('❌ Failed to delete old trick cards message:', err);
                            }
                        }
                    } else if (!isFirstCardOfTrick && payload.messageId) {
                        try {
                            const oldMessage = await retryDiscordCall(() => channel.messages.fetch(payload.messageId));
                            await retryDiscordCall(() => oldMessage.delete());
                        } catch (err) {
                            logger.error('❌ Failed to delete old trick message:', err);
                        }
                    }

                    const messageOptions = { embeds: [embed] };
                    if (trickImageAttachment) {
                        messageOptions.files = [trickImageAttachment];
                    }

                    const game = activeGames.get(channel.id);
                    if (game) {
                        const actionRow = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder().setCustomId(`view_hand:${channel.id}`).setLabel('🎴 View Hand').setStyle(ButtonStyle.Primary),
                                new ButtonBuilder().setCustomId(`view_status:${channel.id}`).setLabel('📊 Game Status').setStyle(ButtonStyle.Secondary)
                            );
                        messageOptions.components = [actionRow];
                    }

                    try {
                        const sentMessage = await retryDiscordCall(() => channel.send(messageOptions));
                        if (game) {
                            game.currentTrickMessageId = sentMessage.id;
                            if (payload.nextPlayerId && !payload.isNextPlayerAI) {
                                const nextPlayer = game.players.find(p => p.discordId === payload.nextPlayerId);
                                if (nextPlayer) {
                                    game.startPlayTimer(nextPlayer);
                                }
                            }
                        }
                    } catch (err) {
                        logger.error('❌ Failed to send new trick message:', err);
                    }
                } catch (err) {
                    logger.error('❌ Failed to send/update trick embed:', err);
                }
                return;
            }

            // Trick won payload: send winner announcement
            if (payload.type === 'trick_won') {
                try {
                    const suitEmojis = { 'S': '♠️', 'H': '♥️', 'D': '♦️', 'C': '♣️' };
                    const winningCardDisplay = `${payload.card.rankCode === 'T' ? '10' : payload.card.rankCode}${suitEmojis[payload.card.suitCode]}`;

                    const embed = new EmbedBuilder()
                        .setColor('#FFD700')
                        .setTitle('🏆 Trick Complete!')
                        .setDescription(`**${payload.playerName}** wins the trick with **${winningCardDisplay}**!`)
                        .addFields({ name: 'Tricks Won', value: `**${payload.playerName}** now has **${payload.tricks}** trick${payload.tricks !== 1 ? 's' : ''}`, inline: false });

                    if (payload.leadsNext && payload.playerName) {
                        const leaderMention = payload.isWinnerAI
                            ? `**${payload.playerName}**`
                            : (payload.playerId ? `<@${payload.playerId}>` : `**${payload.playerName}**`);
                        embed.addFields({ name: '🎴 Up Next', value: `${leaderMention} leads the next trick.`, inline: false });
                    }

                    const sentMessage = await retryDiscordCall(() => channel.send({ embeds: [embed] }));

                    const game = activeGames.get(channel.id);
                    if (game) {
                        game.currentTrickWinnerMessageId = sentMessage.id;
                    }
                } catch (err) {
                    logger.error('❌ Failed to send trick_won payload:', err);
                    await retryDiscordCall(() => channel.send(`${payload.playerName} wins the trick with ${payload.card.rankCode}${payload.card.suitCode}`));
                }
                return;
            }

            // Handle round end
            if (payload.type === 'round_end') {
                try {
                    const finalRoundMessage = new EmbedBuilder()
                        .setColor('#4CAF50')
                        .setTitle(`🏆 Hand ${payload.round} Ended! 🏆`)
                        .setDescription(payload.roundSummary)
                        .addFields(
                            { name: '\u200B', value: '\u200B', inline: false },
                            { name: '📈 Overall Scores & Bags', value: payload.teamScoreDisplay || '', inline: false }
                        );
                    await retryDiscordCall(() => channel.send({ embeds: [finalRoundMessage] }));
                } catch (err) {
                    logger.error('❌ Failed to send round-end embed:', err);
                    await retryDiscordCall(() => channel.send(`--- HAND ${payload.round} ENDED ---\n${payload.roundSummary}`));
                }
                return;
            }

            // Handle spades broken announcement
            if (payload.type === 'spades_broken') {
                try {
                    const spadesEmbed = new EmbedBuilder()
                        .setColor('#FF0000')
                        .setTitle('🚨♠️ SPADES ARE BROKEN! ♠️🚨')
                        .setDescription('Spades can now be led.');
                    await retryDiscordCall(() => channel.send({ embeds: [spadesEmbed] }));
                } catch (err) {
                    logger.error('❌ Failed to send spades broken announcement:', err);
                }
                return;
            }

            // AI thinking indicator
            if (payload.type === 'ai_thinking') {
                try {
                    const thinkingMsg = await retryDiscordCall(() => channel.send(`🤖 **${payload.playerName}** is thinking...`));
                    const keep = typeof payload.duration === 'number' ? payload.duration : 1500;
                    setTimeout(() => safeDelete(thinkingMsg, 'AI thinking cleanup'), keep);
                } catch (err) {
                    logger.error('❌ Failed to send AI thinking indicator:', err);
                }
                return;
            }

            // Handle bidding complete summary
            if (payload.type === 'bidding_complete') {
                try {
                    const game = activeGames.get(channel.id);
                    if (!game) return;

                    const biddingSummary = new EmbedBuilder()
                        .setColor('#00FF00')
                        .setTitle('✅ Bidding Complete!');

                    let bidsText = '';
                    if (game.isCutthroat()) {
                        game.players.forEach(p => {
                            const playerDisplay = p.isAI ? `**${p.username}**` : `<@${p.discordId}>`;
                            const bidDisplay = p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid.toString();
                            bidsText += `${playerDisplay}: ${bidDisplay}\n`;
                        });
                    } else {
                        const team1 = game.players.filter(p => p.team === 1);
                        const team2 = game.players.filter(p => p.team === 2);

                        bidsText += '**🟦 Team 1:**\n';
                        team1.forEach(p => {
                            const playerDisplay = p.isAI ? `**${p.username}**` : `<@${p.discordId}>`;
                            const bidDisplay = p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid.toString();
                            bidsText += `  ${playerDisplay}: ${bidDisplay}\n`;
                        });

                        bidsText += '\n**🟥 Team 2:**\n';
                        team2.forEach(p => {
                            const playerDisplay = p.isAI ? `**${p.username}**` : `<@${p.discordId}>`;
                            const bidDisplay = p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid.toString();
                            bidsText += `  ${playerDisplay}: ${bidDisplay}\n`;
                        });
                    }

                    biddingSummary.setDescription(bidsText);

                    const firstPlayerMention = payload.isAI ? `**${payload.firstPlayerName}**` : `<@${payload.firstPlayerId}>`;
                    biddingSummary.addFields({ name: '🎴 First Play', value: `${firstPlayerMention} will play the first card.`, inline: false });

                    const actionRow = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder().setCustomId(`view_hand:${channel.id}`).setLabel('🎴 View Hand').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`view_status:${channel.id}`).setLabel('📊 Game Status').setStyle(ButtonStyle.Secondary)
                        );

                    await retryDiscordCall(() => channel.send({ embeds: [biddingSummary], components: [actionRow] }));
                } catch (err) {
                    logger.error('❌ Failed to send bidding complete summary:', err);
                }
                return;
            }

            // Handle simple message announcements
            if (payload.type === 'message' && payload.message) {
                await retryDiscordCall(() => channel.send(payload.message));
                return;
            }

            // Handle game over: clean up activeGames and save player stats
            if (payload.type === 'game_over') {
                try {
                    if (payload.gameStats && Array.isArray(payload.gameStats)) {
                        const humanPlayers = payload.gameStats.filter(p => !p.discordId.startsWith('ai_'));
                        for (const playerData of humanPlayers) {
                            try {
                                await playerStats.updateStats(
                                    playerData.discordId,
                                    playerData.username,
                                    {
                                        gameMode: payload.gameMode,
                                        won: playerData.won,
                                        handsPlayed: playerData.handsPlayed,
                                        nilBids: playerData.nilBids,
                                        nilSuccesses: playerData.nilSuccesses,
                                        blindNilBids: playerData.blindNilBids,
                                        blindNilSuccesses: playerData.blindNilSuccesses,
                                        bags: playerData.bags,
                                        finalScore: playerData.finalScore,
                                        tricksWon: playerData.tricksWon
                                    }
                                );
                            } catch (statErr) {
                                logger.error(`❌ Failed to save stats for ${playerData.username}:`, statErr);
                            }
                        }
                    }

                    activeGames.delete(payload.channelId);
                    await channel.send(`🎉 **GAME OVER!** 🎉\n**Winner:** ${payload.message}`);
                    scheduleThreadCleanup(channel);
                } catch (err) {
                    logger.error('❌ Failed to handle game over:', err);
                }
                return;
            }

            // If unhandled structured payload, just send it
            if (payload && typeof payload === 'object') {
                await retryDiscordCall(() => channel.send(payload));
            }
        } catch (err) {
            logger.error('❌ publicAnnounce handler error:', err);
        }
    };

    const privatePrompt = async (playerId, message) => {
        try {
            const user = await client.users.fetch(playerId);
            await user.send(message);
        } catch (err) {
            logger.error(`❌ Failed to DM player ${playerId}:`, err);
        }
    };

    return { publicAnnounce, privatePrompt };
}

/**
 * SpectatorView.js
 * Manages spectator-specific views, notifications, and statistics
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../logger.js';

export class SpectatorView {
    constructor(game, channel) {
        this.game = game;
        this.channel = channel;
        this.viewMode = 'detailed'; // 'compact' or 'detailed'
        this.followingPlayer = null; // Player ID being followed
        this.notificationsEnabled = new Map(); // spectatorId -> boolean
    }

    /**
     * Calculate real-time statistics for the current game state
     */
    calculateStatistics() {
        const stats = {
            cardsRemaining: { C: 0, D: 0, H: 0, S: 0 },
            spadesPlayed: 0,
            totalCardsPlayed: 0,
            bidSuccessRate: new Map(), // playerId -> {made, attempted}
            bagsWarning: new Map(), // playerId -> bag count
            currentRound: this.game.round
        };

        // Count cards remaining in all hands
        for (const player of this.game.players) {
            for (const card of player.hand) {
                stats.cardsRemaining[card.suitCode]++;
            }
        }

        // Count cards played this round
        if (this.game.playedCardsThisRound) {
            stats.totalCardsPlayed = this.game.playedCardsThisRound.length;
            for (const card of this.game.playedCardsThisRound) {
                if (card.suitCode === 'S') {
                    stats.spadesPlayed++;
                }
            }
        }

        // Calculate bid success rates (from previous rounds)
        for (const player of this.game.players) {
            const playerId = player.id;
            // This would need historical data tracking in GameManager
            // For now, we'll use current round bid vs tricks
            if (player.bid !== null && player.bid !== undefined) {
                const isNil = player.bid === 0;
                const madeBid = isNil 
                    ? player.tricks === 0 
                    : player.tricks >= player.bid;
                
                stats.bidSuccessRate.set(playerId, {
                    currentBid: player.bid,
                    currentTricks: player.tricks,
                    onTrack: madeBid || (player.tricks <= player.bid && !isNil)
                });
            }

            // Track bags
            if (player.bags !== undefined) {
                stats.bagsWarning.set(playerId, player.bags);
            }
        }

        return stats;
    }

    /**
     * Create the main spectator dashboard embed
     */
    createSpectatorDashboard() {
        const stats = this.calculateStatistics();
        const embed = new EmbedBuilder()
            .setTitle('👁️ Spectator Dashboard')
            .setColor('#3498DB')
            .setTimestamp();

        // Game State
        let gameStateText = `**Hand:** ${this.game.round}\n`;
        gameStateText += `**State:** ${this.game.state}\n`;
        if (this.game.state === 'PLAYING') {
            const currentPlayer = this.game.players[this.game.currentPlayerIndex];
            gameStateText += `**Current Turn:** ${currentPlayer.username}\n`;
        }
        embed.addFields({ name: '🎮 Game State', value: gameStateText, inline: true });

        // Scores
        let scoresText = '';
        if (this.game.gameMode === 'classic') {
            // Team scores
            const team1Players = this.game.players.filter(p => p.team === 1);
            const team2Players = this.game.players.filter(p => p.team === 2);
            const team1Score = this.game.teamScores?.get(1) || 0;
            const team2Score = this.game.teamScores?.get(2) || 0;
            scoresText += `**Team 1:** ${team1Score} pts\n`;
            scoresText += `${team1Players.map(p => `  • ${p.username}`).join('\n')}\n\n`;
            scoresText += `**Team 2:** ${team2Score} pts\n`;
            scoresText += `${team2Players.map(p => `  • ${p.username}`).join('\n')}`;
        } else {
            // Individual scores for cutthroat
            for (const player of this.game.players) {
                const score = this.game.playerScores?.get(player.id) || 0;
                scoresText += `**${player.username}:** ${score} pts\n`;
            }
        }
        embed.addFields({ name: '📊 Scores', value: scoresText || 'Not started', inline: true });

        // Current Bids & Tricks (if in playing state)
        if (this.game.state === 'BIDDING' || this.game.state === 'PLAYING') {
            let bidsText = '';
            for (const player of this.game.players) {
                const bid = player.bid !== null && player.bid !== undefined ? player.bid : '?';
                const tricks = player.tricks || 0;
                const bidStatus = stats.bidSuccessRate.get(player.id);
                let statusIcon = '';
                if (bidStatus && this.game.state === 'PLAYING') {
                    statusIcon = bidStatus.onTrack ? ' ✅' : ' ⚠️';
                }
                bidsText += `**${player.username}:** Bid ${bid}, Tricks ${tricks}${statusIcon}\n`;
            }
            embed.addFields({ name: '🎯 Bids & Tricks', value: bidsText, inline: false });
        }

        // Statistics Panel
        let statsText = '';
        statsText += `**Cards Remaining:**\n`;
        statsText += `  ♣️ Clubs: ${stats.cardsRemaining.C}\n`;
        statsText += `  ♦️ Diamonds: ${stats.cardsRemaining.D}\n`;
        statsText += `  ♥️ Hearts: ${stats.cardsRemaining.H}\n`;
        statsText += `  ♠️ Spades: ${stats.cardsRemaining.S}\n`;
        statsText += `**Spades Played:** ${stats.spadesPlayed}\n`;
        
        // Bags warnings
        const playersWithBags = Array.from(stats.bagsWarning.entries()).filter(([_, bags]) => bags >= 7);
        if (playersWithBags.length > 0) {
            statsText += `\n⚠️ **Bag Warnings:**\n`;
            for (const [playerId, bags] of playersWithBags) {
                const player = this.game.players.find(p => p.id === playerId);
                statsText += `  • ${player.username}: ${bags} bags\n`;
            }
        }
        
        embed.addFields({ name: '📈 Statistics', value: statsText, inline: false });

        // Current Trick (if in progress)
        if (this.game.trick && this.game.trick.length > 0) {
            let trickText = '';
            for (const entry of this.game.trick) {
                const card = entry.card;
                const suitEmoji = { C: '♣️', D: '♦️', H: '♥️', S: '♠️' }[card.suitCode];
                trickText += `${entry.player.username}: ${card.rankCode}${suitEmoji}\n`;
            }
            embed.addFields({ name: '🃏 Current Trick', value: trickText, inline: false });
        }

        return embed;
    }

    /**
     * Create detailed view showing all player hands
     */
    async createDetailedHandsView() {
        const embeds = [];
        
        for (const player of this.game.players) {
            const embed = new EmbedBuilder()
                .setTitle(`🃏 ${player.username}'s Hand`)
                .setColor(player.team === 1 ? '#E74C3C' : '#3498DB');

            if (player.hand && player.hand.length > 0) {
                // Group cards by suit
                const suits = { S: [], H: [], D: [], C: [] };
                for (const card of player.hand) {
                    suits[card.suitCode].push(card);
                }

                // Sort each suit by rank
                const rankOrder = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
                for (const suit in suits) {
                    suits[suit].sort((a, b) => rankOrder.indexOf(a.rankCode) - rankOrder.indexOf(b.rankCode));
                }

                // Build hand display
                const suitEmojis = { S: '♠️', H: '♥️', D: '♦️', C: '♣️' };
                let handText = '';
                for (const [suit, cards] of Object.entries(suits)) {
                    if (cards.length > 0) {
                        handText += `${suitEmojis[suit]} `;
                        handText += cards.map(c => c.rankCode).join(' ') + '\n';
                    }
                }

                embed.setDescription(handText || 'No cards');
            } else {
                embed.setDescription('Hand not visible');
            }

            // Add current status
            const bid = player.bid !== null && player.bid !== undefined ? player.bid : 'Not bid';
            const tricks = player.tricks || 0;
            embed.addFields({ name: 'Status', value: `Bid: ${bid} | Tricks: ${tricks}`, inline: true });

            embeds.push(embed);
        }

        return embeds;
    }

    /**
     * Create compact view (dashboard only)
     */
    createCompactView() {
        return [this.createSpectatorDashboard()];
    }

    /**
     * Create control buttons for spectator view
     */
    createControlButtons() {
        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('spectator_toggle_view')
                    .setLabel(this.viewMode === 'detailed' ? 'Switch to Compact' : 'Switch to Detailed')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🔄'),
                new ButtonBuilder()
                    .setCustomId('spectator_refresh')
                    .setLabel('Refresh')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🔄'),
                new ButtonBuilder()
                    .setCustomId('spectator_stats')
                    .setLabel('Statistics')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📊')
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('spectator_notifications')
                    .setLabel('Toggle Notifications')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('🔔'),
                new ButtonBuilder()
                    .setCustomId('spectator_history')
                    .setLabel('Trick History')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📜')
            );

        return [row1, row2];
    }

    /**
     * Send spectator view to a specific user
     * @param {boolean} useFollowUp - If true, use followUp instead of reply
     */
    async sendSpectatorView(interaction, useFollowUp = false) {
        const embeds = this.viewMode === 'detailed' 
            ? [this.createSpectatorDashboard(), ...(await this.createDetailedHandsView())]
            : this.createCompactView();

        const components = this.createControlButtons();

        const method = useFollowUp ? 'followUp' : 'reply';
        await interaction[method]({
            embeds: embeds,
            components: components,
            ephemeral: true
        });
    }

    /**
     * Send ephemeral notification to all spectators
     */
    async notifySpectators(message, embedOptions = null) {
        const spectators = this.game.getSpectators();
        
        for (const spectator of spectators) {
            // Check if this spectator has notifications enabled
            if (this.notificationsEnabled.get(spectator.id) === false) {
                continue;
            }

            try {
                // Find the user in the channel
                const member = await this.channel.guild.members.fetch(spectator.id);
                if (!member) continue;

                // Send ephemeral message by creating a temporary interaction response
                // Since we can't send ephemeral messages without an interaction,
                // we'll store these for the next time the spectator interacts
                // For now, we'll use channel messages with mentions that auto-delete
                
                // Alternative: Store notifications and show them when spectator opens their view
                if (!this.game.spectatorNotifications) {
                    this.game.spectatorNotifications = new Map();
                }
                
                if (!this.game.spectatorNotifications.has(spectator.id)) {
                    this.game.spectatorNotifications.set(spectator.id, []);
                }

                const notification = {
                    message,
                    embed: embedOptions,
                    timestamp: Date.now()
                };

                this.game.spectatorNotifications.get(spectator.id).push(notification);

                // Keep only last 10 notifications per spectator
                const notifications = this.game.spectatorNotifications.get(spectator.id);
                if (notifications.length > 10) {
                    notifications.shift();
                }

            } catch (error) {
                logger.error(`Failed to notify spectator ${spectator.username}:`, error);
            }
        }
    }

    /**
     * Get pending notifications for a spectator
     */
    getPendingNotifications(spectatorId) {
        if (!this.game.spectatorNotifications) {
            return [];
        }
        const notifications = this.game.spectatorNotifications.get(spectatorId) || [];
        // Clear after retrieving
        this.game.spectatorNotifications.set(spectatorId, []);
        return notifications;
    }

    /**
     * Toggle view mode
     */
    toggleViewMode() {
        this.viewMode = this.viewMode === 'detailed' ? 'compact' : 'detailed';
    }

    /**
     * Toggle notifications for a spectator
     */
    toggleNotifications(spectatorId) {
        const current = this.notificationsEnabled.get(spectatorId) ?? true;
        this.notificationsEnabled.set(spectatorId, !current);
        return !current;
    }

    /**
     * Create trick history embed
     */
    createTrickHistoryEmbed() {
        const embed = new EmbedBuilder()
            .setTitle('📜 Trick History')
            .setColor('#95A5A6')
            .setTimestamp();

        if (!this.game.trickHistory || this.game.trickHistory.length === 0) {
            embed.setDescription('No tricks played yet this hand.');
            return embed;
        }

        // Show last 10 tricks
        const recentTricks = this.game.trickHistory.slice(-10);
        let historyText = '';

        for (let i = 0; i < recentTricks.length; i++) {
            const trick = recentTricks[i];
            historyText += `**Trick ${this.game.trickHistory.length - recentTricks.length + i + 1}:**\n`;
            
            for (const play of trick.plays) {
                const suitEmoji = { C: '♣️', D: '♦️', H: '♥️', S: '♠️' }[play.card.suitCode];
                const marker = play.player.id === trick.winner.id ? '👑 ' : '  ';
                historyText += `${marker}${play.player.username}: ${play.card.rankCode}${suitEmoji}\n`;
            }
            historyText += `Winner: ${trick.winner.username}\n\n`;
        }

        embed.setDescription(historyText);
        return embed;
    }

    /**
     * Create detailed statistics embed
     */
    createDetailedStatsEmbed() {
        const stats = this.calculateStatistics();
        const embed = new EmbedBuilder()
            .setTitle('📊 Detailed Statistics')
            .setColor('#1ABC9C')
            .setTimestamp();

        // Cards remaining breakdown
        let cardsText = `♣️ Clubs: ${stats.cardsRemaining.C}\n`;
        cardsText += `♦️ Diamonds: ${stats.cardsRemaining.D}\n`;
        cardsText += `♥️ Hearts: ${stats.cardsRemaining.H}\n`;
        cardsText += `♠️ Spades: ${stats.cardsRemaining.S}\n`;
        cardsText += `\n**Total Cards in Play:** ${Object.values(stats.cardsRemaining).reduce((a, b) => a + b, 0)}`;
        embed.addFields({ name: '🃏 Cards Remaining', value: cardsText, inline: true });

        // Spades tracking
        const totalSpades = this.game.gameMode === 'cutthroat3' ? 13 : 13;
        const spadesRemaining = stats.cardsRemaining.S;
        let spadesText = `**Played:** ${stats.spadesPlayed}\n`;
        spadesText += `**In Hands:** ${spadesRemaining}\n`;
        spadesText += `**Total:** ${totalSpades}`;
        embed.addFields({ name: '♠️ Spades Tracking', value: spadesText, inline: true });

        // Player performance
        let perfText = '';
        for (const player of this.game.players) {
            const bidStatus = stats.bidSuccessRate.get(player.id);
            if (bidStatus) {
                const icon = bidStatus.onTrack ? '✅' : '⚠️';
                perfText += `${icon} **${player.username}**\n`;
                perfText += `  Bid: ${bidStatus.currentBid}, Tricks: ${bidStatus.currentTricks}\n`;
            }
        }
        if (perfText) {
            embed.addFields({ name: '🎯 Current Hand Performance', value: perfText, inline: false });
        }

        // Bags overview
        let bagsText = '';
        for (const player of this.game.players) {
            const bags = stats.bagsWarning.get(player.id) || 0;
            const warning = bags >= 7 ? '⚠️ ' : '';
            bagsText += `${warning}${player.username}: ${bags} bags\n`;
        }
        if (bagsText) {
            embed.addFields({ name: '💼 Bags Status', value: bagsText, inline: false });
        }

        return embed;
    }
}

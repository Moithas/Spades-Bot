// index.js

// 1. Corrected dotenv import for ES Module syntax
import 'dotenv/config'; 

// 2. Corrected discord.js import for ES Module syntax
import { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    REST, 
    Routes, 
    PermissionsBitField,
    ActionRowBuilder, 
    ButtonBuilder,   
    ButtonStyle,     
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';

// 3. Corrected local file import for ES Module syntax (must include .js extension)
import GameManager from './game_logic/GameManager.js';
import { buildGameComms } from './game_logic/gameComms.js';
import { gameStateStore } from './stats/GameStateStore.js';
import { renderHand, renderSingleCard, renderTrickCards, renderCardBacks } from './game_logic/CardRenderer.js';
import { AttachmentBuilder } from 'discord.js'; 
import { playerStats } from './stats/PlayerStats.js';
import { getUserPreferences, updateUserPreferences, getDefaultPreferences } from './userPreferences.js';
import logger, { safeDelete } from './logger.js';
import { TIMING, GAME_LIMITS, PLAYER_LIMITS, DISCORD } from './constants.js';
import {
    PREMIUM_SKU_ID,
    THEME_SKUS,
    FREE_THEMES,
    PURCHASABLE_THEMES,
    FREE_CARD_BACKS,
    PREMIUM_CARD_BACKS,
    FREE_GAME_MODES,
    PREMIUM_GAME_MODES,
    FREE_AI_DIFFICULTIES,
    PREMIUM_AI_DIFFICULTIES,
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
    getPremiumDisplay
} from './premiumManager.js';

// --- Configuration ---
const TOKEN = process.env.DISCORD_TOKEN;

/**
 * Retry helper for Discord API calls that may timeout
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} delay - Delay between retries in ms
 * @returns {Promise} Result of the function or throws error
 */
async function retryDiscordCall(fn, maxRetries = DISCORD.MAX_RETRIES, delay = DISCORD.RETRY_DELAY) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isTimeout = error.code === 'UND_ERR_CONNECT_TIMEOUT' || 
                            error.code === 'ETIMEDOUT' ||
                            error.name === 'ConnectTimeoutError';
            
            const isLastAttempt = attempt === maxRetries;
            
            if (isTimeout && !isLastAttempt) {
                logger.warn(`Discord API timeout, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            // If not a timeout error, or we've exhausted retries, throw the error
            throw error;
        }
    }
}

// --- Suit Emoji and Card Display Helpers ---
const SUIT_EMOJIS = {
    'S': '♠️',
    'H': '♥️',
    'D': '♦️',
    'C': '♣️'
};

/**
 * Formats a Card object for display with suit emojis.
 * Assumes Card object has rankCode (e.g., 'A', 'T') and suitCode (e.g., 'S', 'H').
 * @param {object} card - The Card object.
 * @returns {string} The formatted display string (e.g., "A♠️").
 */
const getCardEmojiDisplay = (card) => {
    // Adjust 'T' (for 10) to '10' for better user readability based on Deck.js
    const rank = card.rankCode === 'T' ? '10' : card.rankCode;
    return `${rank}${SUIT_EMOJIS[card.suitCode] || card.suitCode}`; // Fallback to letter if emoji missing
};

// --- Card Play Lock (prevent duplicate plays from rapid button clicks) ---
// Key: "channelId:playerId", Value: timestamp of when lock was acquired
const cardPlayLocks = new Map();

// Cleanup interval for stale locks (runs every minute)
setInterval(() => {
    const now = Date.now();
    const LOCK_TIMEOUT = 30_000; // 30 seconds
    let cleanedCount = 0;
    
    for (const [lockKey, lockTime] of cardPlayLocks.entries()) {
        if (now - lockTime > LOCK_TIMEOUT) {
            cardPlayLocks.delete(lockKey);
            cleanedCount++;
            logger.warn(`🔓 Removed stale card play lock: ${lockKey} (${Math.floor((now - lockTime) / 1000)}s old)`);
        }
    }
    
    if (cleanedCount > 0) {
        logger.info(`🧹 Lock cleanup: Removed ${cleanedCount} stale lock(s)`);
    }
}, TIMING.CARD_LOCK_CLEANUP_INTERVAL);


// --- Helper Function for Card Play Buttons ---
/**
 * Creates buttons for each card in a player's hand, with color coding for legal plays.
 * Cards are sorted to match the hand image display order.
 * @param {string} gameChannelId - The ID of the guild channel where the game is running.
 * @param {Array} hand - Array of Card objects from the player's hand.
 * @param {object} game - The game instance for checking legal plays.
 * @param {object} player - The player object.
 * @returns {ActionRowBuilder[]} An array of ActionRows with card buttons (max 5 per row).
 */
const createCardPlayComponents = (gameChannelId, hand, game, player) => {
    // Sort cards to match the image display: Spades, Hearts, Clubs, Diamonds
    const suitOrder = { 'S': 1, 'H': 2, 'C': 3, 'D': 4 };
    const sortedHand = [...hand].sort((a, b) => {
        if (a.suitCode !== b.suitCode) {
            return suitOrder[a.suitCode] - suitOrder[b.suitCode];
        }
        return b.value - a.value; // Higher cards first
    });

    const buttons = sortedHand.map(card => {
        const cardDisplay = card.rankCode === 'T' ? `10${SUIT_EMOJIS[card.suitCode]}` : `${card.rankCode}${SUIT_EMOJIS[card.suitCode]}`;
        
        // Determine if this card is a legal play
        const isLegal = isCardLegalToPlay(card, game, player);
        
        return new ButtonBuilder()
            .setCustomId(`play_${gameChannelId}_${card.rankCode}${card.suitCode}`)
            .setLabel(cardDisplay)
            .setStyle(isLegal ? ButtonStyle.Success : ButtonStyle.Secondary)
            .setDisabled(!isLegal);
    });

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    return rows;
};

/**
 * Helper function to determine if a card is legal to play based on Spades rules.
 * @param {Card} card - The card to check.
 * @param {object} game - The game instance.
 * @param {object} player - The player object.
 * @returns {boolean} True if the card can be legally played.
 */
const isCardLegalToPlay = (card, game, player) => {
    const leadSuit = game.trick.length > 0 ? game.trick[0].card.suitCode : null;
    const cardSuit = card.suitCode;
    const playerHandSuits = player.getHandSuits();

    // If this is the lead card (first card of the trick)
    if (!leadSuit) {
        // Can't lead with Spades unless broken or only have Spades
        if (cardSuit === 'S' && !game.spadesBroken) {
            const hasOnlySpades = playerHandSuits.length === 1 && playerHandSuits[0] === 'S';
            return hasOnlySpades;
        }
        return true; // Can lead with any other suit
    }

    // Must follow suit if possible
    if (playerHandSuits.includes(leadSuit)) {
        return cardSuit === leadSuit;
    }

    // If player doesn't have the lead suit, any card is legal
    return true;
};


// --- Helper Function for Lobby Button ---
/**
 * Creates the ActionRow with the Join Team buttons and Add AI options
 * @param {string} channelId - The channel ID for the game
 * @param {Object} game - The GameManager instance
 * @returns {ActionRowBuilder[]} An array containing ActionRows
 */
const createLobbyComponents = (channelId, game) => {
    const isCutthroat = game.isCutthroat();
    const maxPlayers = game.getMaxPlayers();
    
    if (isCutthroat) {
        // Cutthroat mode: No team buttons, just join button
        const joinButton = new ButtonBuilder()
            .setCustomId(`join_cutthroat:${channelId}`)
            .setLabel(`Join Game (${game.players.length}/${maxPlayers})`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('👥')
            .setDisabled(game.players.length >= maxPlayers);

        const aiButton = new ButtonBuilder()
            .setCustomId(`add_ai:${channelId}`)
            .setLabel('🤖 Add AI (Medium)')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(game.players.length >= maxPlayers);

        // Settings button
        const settingsButton = new ButtonBuilder()
            .setCustomId(`game_settings:${channelId}`)
            .setLabel('⚙️ Game Settings')
            .setStyle(ButtonStyle.Secondary);

        // Start Game button (only enabled when lobby is full)
        const startGameButton = new ButtonBuilder()
            .setCustomId(`start_game:${channelId}`)
            .setLabel('🎮 Start Game')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!game.isLobbyFull());

        // Difficulty select menu for adding AI
        const aiSelect = new StringSelectMenuBuilder()
            .setCustomId(`add_ai_select:${channelId}`)
            .setPlaceholder('Add AI — choose difficulty')
            .setDisabled(game.players.length >= maxPlayers)
            .addOptions([
                { label: 'Easy', description: 'Low skill, faster moves', value: 'easy' },
                { label: 'Medium', description: 'Balanced AI', value: 'medium' },
                { label: '⭐ Hard', description: 'Premium — Stronger AI', value: 'hard' }
            ]);

        return [
            new ActionRowBuilder().addComponents(joinButton, aiButton),
            new ActionRowBuilder().addComponents(settingsButton, startGameButton),
            new ActionRowBuilder().addComponents(aiSelect)
        ];
    } else {
        // Classic mode: Team buttons
        const team1Count = game.players.filter(p => p.team === 1).length;
        const team2Count = game.players.filter(p => p.team === 2).length;
        
        const joinTeam1Button = new ButtonBuilder()
            .setCustomId(`join_team:${channelId}:1`)
            .setLabel(`Join Team 1 (${team1Count}/2)`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🟦')
            .setDisabled(team1Count >= 2);

        const joinTeam2Button = new ButtonBuilder()
            .setCustomId(`join_team:${channelId}:2`)
            .setLabel(`Join Team 2 (${team2Count}/2)`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🟥')
            .setDisabled(team2Count >= 2);

        const aiButton = new ButtonBuilder()
            .setCustomId(`add_ai:${channelId}`)
            .setLabel('🤖 Add AI (Medium)')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(game.players.length >= 4);

        // Settings button
        const settingsButton = new ButtonBuilder()
            .setCustomId(`game_settings:${channelId}`)
            .setLabel('⚙️ Game Settings')
            .setStyle(ButtonStyle.Secondary);

        // Start Game button (only enabled when lobby is full)
        const startGameButton = new ButtonBuilder()
            .setCustomId(`start_game:${channelId}`)
            .setLabel('🎮 Start Game')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!game.isLobbyFull());

        // Difficulty select menu for adding AI
        const aiSelect = new StringSelectMenuBuilder()
            .setCustomId(`add_ai_select:${channelId}`)
            .setPlaceholder('Add AI — choose difficulty')
            .setDisabled(game.players.length >= 4)
            .addOptions([
                { label: 'Easy', description: 'Low skill, faster moves', value: 'easy' },
                { label: 'Medium', description: 'Balanced AI', value: 'medium' },
                { label: '⭐ Hard', description: 'Premium — Stronger AI', value: 'hard' }
            ]);

        return [
            new ActionRowBuilder().addComponents(joinTeam1Button, joinTeam2Button),
            new ActionRowBuilder().addComponents(aiButton, settingsButton, startGameButton),
            new ActionRowBuilder().addComponents(aiSelect)
        ];
    }
};

/**
 * Creates the settings UI components (buttons and select menus)
 * @param {string} gameChannelId - The game channel ID
 * @param {Object} game - The GameManager instance
 * @returns {Array} Array of ActionRowBuilder components
 */
const createSettingsComponents = (gameChannelId, game) => {
    const row1 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`timer_setting:${gameChannelId}`)
                .setLabel(`⏱️ Timer: ${game.options.autoPlayTimer}s`)
                .setStyle(game.options.autoPlayTimer > 0 ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`toggle_setting:${gameChannelId}:autoPlayLastTrick`)
                .setLabel(game.options.autoPlayLastTrick ? '🎴 Last Trick: ON' : '🎴 Last Trick: OFF')
                .setStyle(game.options.autoPlayLastTrick ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`target_score_setting:${gameChannelId}`)
                .setLabel(`🎯 Score: ${game.options.targetScore}`)
                .setStyle(game.options.targetScore !== 500 ? ButtonStyle.Success : ButtonStyle.Secondary)
        );

    const row2 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`toggle_trash_talk:${gameChannelId}`)
                .setLabel(game.options.trashTalk.enabled ? '💬 Trash Talk: ON' : '💬 Trash Talk: OFF')
                .setStyle(game.options.trashTalk.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`cycle_trash_talk:${gameChannelId}`)
                .setLabel(`📊 Frequency: ${game.options.trashTalk.frequency.toUpperCase()}`)
                .setStyle(ButtonStyle.Primary)
        );

    const row3 = new ActionRowBuilder()
        .addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`select_deck_theme:${gameChannelId}`)
                .setPlaceholder(`🎨 Deck Theme: ${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`)
                .addOptions([
                    {
                        label: 'Classic',
                        description: 'Traditional playing card design',
                        value: 'classic',
                        emoji: '🃏',
                        default: game.options.deckTheme === 'classic'
                    },
                    {
                        label: 'Minimalist',
                        description: 'Clean and simple design',
                        value: 'minimalist',
                        emoji: '▪️',
                        default: game.options.deckTheme === 'minimalist'
                    },
                    {
                        label: 'Neon',
                        description: 'Bright glowing colors on dark background',
                        value: 'neon',
                        emoji: '💫',
                        default: game.options.deckTheme === 'neon'
                    },
                    {
                        label: '⭐ Steampunk',
                        description: 'Premium - Brass, gears, Victorian aesthetics',
                        value: 'steampunk',
                        emoji: '⚙️',
                        default: game.options.deckTheme === 'steampunk'
                    },
                    {
                        label: '⭐ Medieval',
                        description: 'Premium - Parchment texture with ornate decorations',
                        value: 'medieval',
                        emoji: '📜',
                        default: game.options.deckTheme === 'medieval'
                    },
                    {
                        label: '⭐ Holographic',
                        description: 'Premium - Rainbow shimmer with suit gradients',
                        value: 'holographic',
                        emoji: '✨',
                        default: game.options.deckTheme === 'holographic'
                    },
                    {
                        label: '⭐ Cosmic',
                        description: 'Premium - Deep space with stars and nebulae',
                        value: 'cosmic',
                        emoji: '🌌',
                        default: game.options.deckTheme === 'cosmic'
                    },
                    {
                        label: '⭐ Cyberpunk',
                        description: 'Premium - Futuristic tech with neon circuits',
                        value: 'cyberpunk',
                        emoji: '⚡',
                        default: game.options.deckTheme === 'cyberpunk'
                    },
                    {
                        label: '⭐ Christmas',
                        description: 'Premium - Festive holiday theme',
                        value: 'christmas',
                        emoji: '🎄',
                        default: game.options.deckTheme === 'christmas'
                    }
                ])
        );

    const row4 = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`close_settings:${gameChannelId}`)
                .setLabel('✅ Done')
                .setStyle(ButtonStyle.Primary)
        );

    return [row1, row2, row3, row4];
};

/**
 * Creates the settings embed showing current game options
 * @param {Object} game - The GameManager instance
 * @returns {EmbedBuilder} Settings embed
 */
const createSettingsEmbed = (game) => {
    return new EmbedBuilder()
        .setColor('#FFA500')
        .setTitle('⚙️ Game Settings (Host Only)')
        .setDescription('Game-wide settings that affect gameplay timing.\n\n_Display preferences (suggestions, hand strength, etc.) are personal!_\nPlayers can use `/spades preferences` to customize their view.')
        .addFields(
            { 
                name: '⏱️ Auto-Play Timer', 
                value: game.options.autoPlayTimer > 0 ? `✅ ${game.options.autoPlayTimer}s` : '❌ Disabled', 
                inline: true 
            },
            { 
                name: '🎴 Auto-Play Last Trick', 
                value: game.options.autoPlayLastTrick ? '✅ Enabled' : '❌ Disabled', 
                inline: true 
            },
            { 
                name: '🎯 Target Score', 
                value: `${game.options.targetScore} points`, 
                inline: true 
            },
            { 
                name: '💬 AI Trash Talk', 
                value: game.options.trashTalk.enabled ? `✅ ${game.options.trashTalk.frequency.toUpperCase()}` : '❌ Disabled', 
                inline: true 
            },
            { 
                name: '🎨 Deck Theme', 
                value: `${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`, 
                inline: true 
            }
        );
};

/**
 * Updates the lobby message in the channel after settings change
 * @param {Object} channel - Discord channel
 * @param {string} gameChannelId - Game channel ID
 * @param {Object} game - GameManager instance
 */
const updateLobbyMessage = async (channel, gameChannelId, game) => {
    try {
        const messages = await channel.messages.fetch({ limit: 10 });
        // Search for both classic and cutthroat lobby titles
        const lobbyMessage = messages.find(m => 
            m.embeds.length > 0 && 
            (m.embeds[0].title?.includes('Lobby') || m.embeds[0].title?.includes('Cutthroat'))
        );

        if (lobbyMessage) {
            const lobbyEmbed = createLobbyEmbed(game);
            const lobbyComponents = createLobbyComponents(gameChannelId, game);
            await lobbyMessage.edit({
                embeds: [lobbyEmbed],
                components: lobbyComponents
            });
        }
    } catch (err) {
        // Silently fail - lobby update is not critical
    }
};

/**
 * Creates a lobby embed showing teams and players
 * @param {Object} game - The GameManager instance
 * @returns {EmbedBuilder} Lobby embed
 */
const createLobbyEmbed = (game) => {
    const isCutthroat = game.isCutthroat();
    const maxPlayers = game.getMaxPlayers();
    
    if (isCutthroat) {
        // Cutthroat mode: Show all players in one list
        const gameModeDisplay = game.gameMode === 'cutthroat3' ? '3-Player Cutthroat' : '4-Player Cutthroat';
        
        const playersDisplay = game.players.length > 0 
            ? game.players.map(p => {
                const prefix = p.isAI ? '🤖' : '👤';
                const hostBadge = p.discordId === game.hostId ? ' 👑' : '';
                return `${prefix} ${p.username}${hostBadge}`;
            }).join('\n')
            : '*No players yet*';
        
        // Build settings display
        const settingsDisplay = [
            `⏱️ Auto-Play Timer: ${game.options.autoPlayTimer > 0 ? `✅ ${game.options.autoPlayTimer}s` : '❌ Disabled'}`,
            `🎴 Auto-Play Last Trick: ${game.options.autoPlayLastTrick ? '✅ Enabled' : '❌ Disabled'}`,
            `🎯 Target Score: ${game.options.targetScore} points`,
            `💬 AI Trash Talk: ${game.options.trashTalk.enabled ? `✅ ${game.options.trashTalk.frequency.toUpperCase()}` : '❌ Disabled'}`,
            `🎨 Deck Theme: ${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`,
            `\n_Display preferences (suggestions, hand strength, etc.) are now personal!_`,
            `_Use_ \`/spades preferences\` _to customize your view._`
        ].join('\n');
        
        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`♠️ ${gameModeDisplay} Lobby ♠️`)
            .setDescription(`**Waiting for players...** (${game.players.length}/${maxPlayers})\n\n**Every player for themselves!**\n\n👑 = Host (can add AI & change settings)`)
            .addFields(
                { name: '👥 Players', value: playersDisplay, inline: false },
                { name: '⚙️ Game Settings', value: settingsDisplay, inline: false }
            )
            .setFooter({ text: game.isLobbyFull() ? 'Click Start Game when ready!' : `Waiting for ${maxPlayers} players...` })
            .setTimestamp();
        
        return embed;
    } else {
        // Classic mode: Show teams
        const team1Players = game.players.filter(p => p.team === 1);
        const team2Players = game.players.filter(p => p.team === 2);
        
        const team1Display = team1Players.length > 0 
            ? team1Players.map(p => {
                const prefix = p.isAI ? '🤖' : '👤';
                const hostBadge = p.discordId === game.hostId ? ' 👑' : '';
                return `${prefix} ${p.username}${hostBadge}`;
            }).join('\n')
            : '*Empty - Join Team 1!*';
        
        const team2Display = team2Players.length > 0 
            ? team2Players.map(p => {
                const prefix = p.isAI ? '🤖' : '👤';
                const hostBadge = p.discordId === game.hostId ? ' 👑' : '';
                return `${prefix} ${p.username}${hostBadge}`;
            }).join('\n')
            : '*Empty - Join Team 2!*';
        
        // Build settings display - only game-wide settings (auto-play timer)
        const settingsDisplay = [
            `⏱️ Auto-Play Timer: ${game.options.autoPlayTimer > 0 ? `✅ ${game.options.autoPlayTimer}s` : '❌ Disabled'}`,
            `🎴 Auto-Play Last Trick: ${game.options.autoPlayLastTrick ? '✅ Enabled' : '❌ Disabled'}`,
            `🎯 Target Score: ${game.options.targetScore} points`,
            `💬 AI Trash Talk: ${game.options.trashTalk.enabled ? `✅ ${game.options.trashTalk.frequency.toUpperCase()}` : '❌ Disabled'}`,
            `🎨 Deck Theme: ${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`,
            `\n_Display preferences (suggestions, hand strength, etc.) are now personal!_`,
            `_Use_ \`/spades preferences\` _to customize your view._`
        ].join('\n');
        
        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('♠️ Spades Lobby ♠️')
            .setDescription(`**Waiting for players...** (${game.players.length}/4)\n\nSelect a team to join!\n\n👑 = Host (can add AI & change settings)`)
            .addFields(
                { name: '🟦 Team 1', value: team1Display, inline: true },
                { name: '🟥 Team 2', value: team2Display, inline: true },
                { name: '⚙️ Game Settings', value: settingsDisplay, inline: false }
            )
            .setFooter({ text: game.isLobbyFull() ? 'Click Start Game when ready!' : 'Waiting for 4 players...' })
            .setTimestamp();
        
        return embed;
    }
};

// --- Helper Function for Bidding Buttons ---
/**
 * Creates the bidding buttons, embedding the gameChannelId into the customId for reliable lookup.
 * @param {string} gameChannelId - The ID of the guild channel where the game is running.
 * @param {boolean} [blindNilEligible=false] - Whether the current player is eligible for Blind Nil
 * @returns {ActionRowBuilder[]} An array containing the ActionRows with bidding buttons.
 */
const createBiddingComponents = (gameChannelId, blindNilEligible = false) => {
    const buttons = [];

    // 1 to 13 tricks, plus Nil
    for (let i = 1; i <= 13; i++) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`bid_${gameChannelId}_${i}`)
                .setLabel(`${i}`)
                .setStyle(ButtonStyle.Primary)
        );
    }

    // Add Nil button separately
    buttons.push(
        new ButtonBuilder()
            .setCustomId(`bid_${gameChannelId}_nil`)
            .setLabel('Nil (0)')
            .setStyle(ButtonStyle.Danger)
    );

    // Add Blind Nil button if eligible
    if (blindNilEligible) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`bid_${gameChannelId}_blindnil`)
                .setLabel('Blind Nil')
                .setStyle(ButtonStyle.Danger)
        );
    }

    // Split buttons into rows of 5
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }

    return rows;
};


// Command definitions
const commands = [
    new SlashCommandBuilder()
        .setName('spades')
        .setDescription('Spades card game commands.')
        .addSubcommand(subcommand =>
            subcommand.setName('start')
                .setDescription('Starts a new Spades lobby in this channel. Players join via a button.')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('hand')
                .setDescription('View your current hand and play cards or place bids. Spectators can view a player\'s hand.')
                .addStringOption(opt =>
                    opt.setName('player')
                       .setDescription("Spectators: player's username or @mention to view")
                       .setRequired(false)
                       .setAutocomplete(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('status')
                .setDescription('Show the current game status, bids, and scores.')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('spectate')
                .setDescription('Join this Spades game as a spectator (view only).')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('spectator-view')
                .setDescription('Open the interactive spectator dashboard (spectators only).')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('leave')
                .setDescription('Leave this Spades game as a spectator.')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('sub')
                .setDescription('Substitute a player in the active game.')
                .addStringOption(opt =>
                    opt.setName('player_out')
                       .setDescription('Player to remove (username or @mention)')
                       .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('player_in')
                       .setDescription('Player to add (username, @mention, or "ai" for AI)')
                       .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('stats')
                .setDescription('View player statistics.')
                .addUserOption(opt =>
                    opt.setName('player')
                       .setDescription('Player to view stats for (defaults to yourself)')
                       .setRequired(false)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('leaderboard')
                .setDescription('View the top players by wins.')
                .addStringOption(opt =>
                    opt.setName('mode')
                       .setDescription('Game mode (default: combined)')
                       .setRequired(false)
                       .addChoices(
                           { name: 'Combined (All Modes)', value: 'combined' },
                           { name: 'Classic (4P Teams)', value: 'classic' },
                           { name: 'Cutthroat (Solo)', value: 'cutthroat' }
                       )
                )
                .addIntegerOption(opt =>
                    opt.setName('limit')
                       .setDescription('Number of players to show (default: 10, max: 25)')
                       .setRequired(false)
                       .setMinValue(1)
                       .setMaxValue(25)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('settings')
                .setDescription('Change game settings (host only).')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('preferences')
                .setDescription('Manage your personal display preferences.')
        )
        .addSubcommand(subcommand =>
            subcommand.setName('host')
                .setDescription('Transfer host privileges to another player (host only).')
                .addStringOption(opt =>
                    opt.setName('player')
                       .setDescription('Player to make the new host (username or @mention)')
                       .setRequired(true)
                )
        )
        .addSubcommand(subcommand =>
            subcommand.setName('premium')
                .setDescription('View premium features and subscription status.')
        ),
].map(command => command.toJSON());

// --- Bot Setup ---

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages
    ]
});

// --- Premium Entitlement Event Handlers ---
client.on('entitlementCreate', (entitlement) => {
    handleEntitlementCreate(entitlement);
});

client.on('entitlementUpdate', (oldEntitlement, newEntitlement) => {
    handleEntitlementUpdate(oldEntitlement, newEntitlement);
});

client.on('entitlementDelete', (entitlement) => {
    handleEntitlementDelete(entitlement);
});

// Map to store active games: key is channelId, value is GameManager instance.
const activeGames = new Map();

// --- Error Handling ---
client.on('error', error => {
    logger.error('❌ Discord client error:', error);
});

process.on('unhandledRejection', error => {
    logger.error('❌ Unhandled promise rejection:', error);
});

process.on('uncaughtException', error => {
    logger.error('❌ Uncaught exception:', error);
});

// --- Command Deployment ---
client.on('ready', async () => {
    logger.success(`Logged in as ${client.user.tag}!`);
    const botId = client.user.id; // Use the client's actual ID here
    logger.info(`Bot ID: ${botId}`);

    // Initialize player statistics
    await playerStats.initialize();

    const rest = new REST({ version: '10' }).setToken(TOKEN);

    try {
        logger.info('Started refreshing application (/) commands.');
        // Register commands globally using client.user.id
        await rest.put(
            Routes.applicationCommands(botId),
            { body: commands },
        );
        logger.success('Successfully reloaded application (/) commands.');
    } catch (error) {
        logger.error(error);
    }

    // --- Restore in-progress games that were persisted before this restart ---
    try {
        const saved = gameStateStore.getAll();
        const savedChannelIds = Object.keys(saved);
        if (savedChannelIds.length > 0) {
            logger.info(`♻️ Restoring ${savedChannelIds.length} saved game(s) from before restart...`);
            const { SpectatorView } = await import('./game_logic/SpectatorView.js');
            for (const channelId of savedChannelIds) {
                try {
                    if (activeGames.has(channelId)) continue; // already live
                    const snap = saved[channelId];
                    const { publicAnnounce, privatePrompt } = buildGameComms(client, channelId, { activeGames, retryDiscordCall });
                    const game = GameManager.fromSnapshot(snap, { publicAnnounce, privatePrompt });

                    const channel = await client.channels.fetch(channelId).catch(() => null);
                    if (!channel) {
                        logger.error(`♻️ Channel ${channelId} not found; dropping saved game.`);
                        gameStateStore.remove(channelId);
                        continue;
                    }
                    game.channel = channel;
                    game.spectatorView = new SpectatorView(game, channel);
                    activeGames.set(channelId, game);

                    const current = game.players[game.currentPlayerIndex];
                    const turnMention = current
                        ? (current.isAI ? `**${current.username}**` : `<@${current.discordId}>`)
                        : 'the next player';
                    const phaseWord = game.state === 'BIDDING' ? 'bidding' : 'playing';
                    try {
                        await game.publicAnnounce({
                            type: 'message',
                            message: `♻️ **Game resumed after a bot restart.** It's ${turnMention}'s turn (${phaseWord}). Use the **🎴 View Hand** button to continue.`
                        });
                    } catch (e) {
                        logger.error('♻️ Failed to post resume message:', e);
                    }

                    // Re-drive the current actor (timers/AI schedules aren't persisted).
                    if (game.state === 'BIDDING') {
                        try { game.sendBiddingUpdate(); } catch (e) { logger.error('♻️ resume sendBiddingUpdate failed:', e); }
                        if (current && current.isAI) {
                            setTimeout(() => { try { game.processAIBid(current); } catch (e) { logger.error('♻️ resume AI bid failed:', e); } }, 3000);
                        }
                    } else if (game.state === 'PLAYING') {
                        if (current && current.isAI) {
                            game.scheduleAILead(3000);
                        } else if (current && !current.isAI) {
                            game.startPlayTimer(current);
                        }
                    }

                    logger.success(`♻️ Restored game in channel ${channelId} (state=${game.state}, hand=${game.currentRound}).`);
                } catch (err) {
                    logger.error(`❌ Failed to restore game ${channelId}:`, err);
                    try { gameStateStore.remove(channelId); } catch (e) { /* ignore */ }
                }
            }
        }
    } catch (err) {
        logger.error('❌ Game restore routine failed:', err);
    }

    // Start cleanup interval for ended games
    setInterval(() => {
        const now = Date.now();
        const CLEANUP_DELAY = 10 * 60 * 1000; // 10 minutes in milliseconds
        let cleanedCount = 0;
        
        for (const [channelId, game] of activeGames.entries()) {
            // Remove games that ended over 10 minutes ago
            if (game.state === 'ENDED' && game.endedAt) {
                const timeSinceEnd = now - game.endedAt;
                if (timeSinceEnd > CLEANUP_DELAY) {
                    activeGames.delete(channelId);
                    try { gameStateStore.remove(channelId); } catch (e) { /* ignore */ }
                    cleanedCount++;
                    logger.info(`🧹 Cleaned up ended game in channel ${channelId} (ended ${Math.floor(timeSinceEnd / 60000)} minutes ago)`);
                }
            }
        }
        
        if (cleanedCount > 0) {
            logger.info(`🧹 Cleanup complete: Removed ${cleanedCount} ended game(s). Active games: ${activeGames.size}`);
        }
    }, 5 * 60 * 1000); // Run every 5 minutes
    
    logger.success('✅ Game cleanup interval started (runs every 5 minutes)');
});


/**
 * Sends public announcement when bidding starts.
 * @param {GameManager} game - The active game instance.
 * @param {object} channel - The Discord channel object for public announcements.
 * @param {string} gameChannelId - The ID of the guild channel where the game is running.
 */
const sendHandsAndBiddingButtons = async (game, channel, gameChannelId) => {
  // Calculate first bidder based on dealer index (not currentPlayerIndex, which may have advanced if AI bid already)
  const firstBidderIndex = (game.dealerIndex + 1) % game.players.length;
  const firstBidder = game.players[firstBidderIndex];
  const mention = firstBidder.isAI ? `**${firstBidder.username}**` : `<@${firstBidder.discordId}>`;

  // Public announcement (buttons are now on the dealing cards message)
  if (channel) {
    try {
      await channel.send({
        content: `📢 **Bidding has started!** It is ${mention}'s turn to bid first!\n\n` +
                 `**All players:** Click the "🎴 View Hand" button above to view your hand and place your bid!`,
        embeds: [
          new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('Player Order & Bids')
            .setDescription(game.players.map(p => `**${p.username}**`).join(' -> '))
        ]
      });
    } catch (err) {
      logger.error('❌ Failed to send bidding announcement:', err);
    }
  }
};

// --- Interaction Handling ---
client.on('interactionCreate', async interaction => {
    try {
        // ----------------------------------------------------
        // Handle Autocomplete for /spades hand player option
        // ----------------------------------------------------
        if (interaction.isAutocomplete()) {
            const focusedOption = interaction.options.getFocused(true);
            
            if (focusedOption.name === 'player') {
                const game = activeGames.get(interaction.channelId);
                
                if (!game || !game.players || game.players.length === 0) {
                    return interaction.respond([]);
                }
                
                // Get the current input value
                const focusedValue = focusedOption.value.toLowerCase();
                
                // Filter players by username match
                const choices = game.players
                    .filter(p => p.username.toLowerCase().includes(focusedValue))
                    .slice(0, 25) // Discord autocomplete limit
                    .map(p => ({
                        name: p.username,
                        value: p.username
                    }));
                
                return interaction.respond(choices);
            }
            
            return;
        }

        // NOTE: channelId here is the GUILD channel ID for slash commands,
        // but the DM channel ID for bid buttons (hence the lookup fix below).
        const { user, channelId, options } = interaction;
        const game = activeGames.get(channelId); // Only successful for guild-based interactions

        // ----------------------------------------------------
        // Handle Card Play Button Interaction (PLAYING)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('play_')) {
            const parts = interaction.customId.split('_'); // Format: ['play', <channelId>, <cardCode>]
            if (parts.length < 3) {
                return interaction.reply({ content: 'Invalid card button format.', ephemeral: true });
            }

            const gameChannelId = parts[1];
            const cardCode = parts[2]; // e.g., 'AS', 'TC', '10H'

            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'PLAYING') {
                return interaction.reply({ 
                    content: `❌ You can only play cards during the PLAYING phase. Current state: ${game?.state ?? 'no game'}`, 
                    ephemeral: true 
                });
            }

            const player = game.players.find(p => p.discordId === interaction.user.id);

            if (!player) {
                return interaction.reply({ content: '❌ You are not a player in this game.', ephemeral: true });
            }

            // Check for duplicate play lock (prevent rapid double-clicks)
            const lockKey = `${gameChannelId}:${player.id}`;
            const existingLock = cardPlayLocks.get(lockKey);
            
            if (existingLock) {
                const lockAge = Date.now() - existingLock;
                
                // If lock is stale (>30 seconds), force release
                if (lockAge > 30_000) {
                    logger.warn(`🔓 Force-releasing stale lock for ${lockKey} (${Math.floor(lockAge / 1000)}s old)`);
                    cardPlayLocks.delete(lockKey);
                } else {
                    // Lock is recent, reject the request
                    return interaction.reply({
                        content: `🚫 Please wait, your previous card play is still being processed... (${Math.floor(lockAge / 1000)}s)`,
                        ephemeral: true
                    });
                }
            }

            // Set the lock with current timestamp
            cardPlayLocks.set(lockKey, Date.now());

            // Ensure lock is always released after processing (use try-finally)
            try {
                if (player.id !== game.players[game.currentPlayerIndex].id) {
                    return interaction.reply({
                        content: `🚫 It is not your turn. It is **${game.players[game.currentPlayerIndex].username}**'s turn.`,
                        ephemeral: true
                    });
                }

                // Check if player has already played in this trick
                const hasPlayedThisTrick = game.trick.some(play => play.player.id === player.id);
                if (hasPlayedThisTrick) {
                    return interaction.reply({
                        content: `🚫 You have already played a card in this trick.`,
                        ephemeral: true
                    });
                }

            // Parse the card code (format: rankCode + suitCode, e.g., 'AS', 'TC')
            const cardToPlay = game.getCardFromInput(player, cardCode);

            if (cardToPlay.error) {
                return interaction.reply({
                    content: `🚫 Invalid play: ${cardToPlay.error}`,
                    ephemeral: true
                });
            }

            // --- SPADES PLAY VALIDATION RULES START ---
            const leadSuit = game.trick.length > 0 ? game.trick[0].card.suitCode : null;
            const playedSuit = cardToPlay.suitCode;
            const playerHandSuits = player.getHandSuits();

            let validationError = null;

            if (leadSuit) {
                if (playedSuit !== leadSuit && playerHandSuits.includes(leadSuit)) {
                    validationError = `You must follow suit: The leading suit is ${SUIT_EMOJIS[leadSuit]}. You have cards of this suit in your hand.`;
                }
            } else {
                if (playedSuit === 'S' && !game.spadesBroken) {
                    const nonSpadeSuits = playerHandSuits.filter(s => s !== 'S');
                    if (nonSpadeSuits.length > 0) {
                        validationError = `Spades has not been broken yet. You cannot lead with a Spade unless you only have Spades remaining in your hand.`;
                    }
                }
            }

            if (validationError) {
                return interaction.reply({
                    content: `🚫 Invalid play: ${validationError}`,
                    ephemeral: true
                });
            }
            // --- SPADES PLAY VALIDATION RULES END ---

            // Cancel auto-play timer since player is making a move
            game.cancelPlayTimer();

            // Ensure trick is initialized
            if (!Array.isArray(game.trick)) {
                game.trick = [];
            }

            // DON'T remove card from hand yet - wait until Discord confirms receipt

            // Diagnostic: log the play attempt
            try {
                logger.debug(`🧾 humanPlay(button): ${player.username} attempting to play ${cardToPlay.rankCode}${cardToPlay.suitCode}`);
                logger.debug('   game.state=', game.state, 'currentPlayerIndex=', game.currentPlayerIndex);
                logger.debug('   players=', game.players.map((p, i) => `${i}:${p.username}[id=${p.id}]`).join(' | '));
            } catch (e) {
                logger.error('❌ Failed to log humanPlay(button) diagnostics:', e);
            }

            // 1. First, confirm to player (this is ephemeral, ok if it fails)
            const cardDisplayWithEmoji = getCardEmojiDisplay(cardToPlay);
            try {
                await interaction.update({
                    content: `✅ You played **${cardDisplayWithEmoji}**.`,
                    components: [] // Remove card buttons after playing
                });

                // Delete the ephemeral message after 2 seconds
                setTimeout(async () => {
                    try {
                        await interaction.deleteReply();
                    } catch (err) {
                        logger.error('❌ Failed to delete interaction reply:', err);
                    }
                }, 2000);
            } catch (err) {
                logger.error('❌ Failed to update interaction (ephemeral), continuing anyway:', err);
            }

            // 2. Announce the play publicly with trick update - CRITICAL STEP
            const channel = await client.channels.fetch(gameChannelId).catch(err => {
                logger.error('❌ Failed to fetch channel:', err);
                return null;
            });

            if (!channel) {
                // If we can't get the channel, abort the play
                try {
                    await interaction.followUp({
                        content: '❌ Failed to fetch game channel. Your card was not played. Please try again.',
                        ephemeral: true
                    });
                } catch (err) {
                    logger.error('❌ Failed to send error followUp:', err.message);
                }
                return;
            }

            // Build trick update payload BEFORE modifying game state
            let nextPlayerName = null;
            let nextPlayerId = null;
            let isNextPlayerAI = false;
            
            // Temporarily add to trick to calculate next player
            const tempTrick = [...game.trick, { player, card: cardToPlay }];
            
            if (tempTrick.length < game.getMaxPlayers()) {
                const nextPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
                const nextPlayer = game.players[nextPlayerIndex];
                nextPlayerName = nextPlayer.username;
                nextPlayerId = nextPlayer.discordId;
                isNextPlayerAI = nextPlayer.isAI;
            }

            const trickUpdatePayload = {
                type: 'trick_update',
                trick: tempTrick.map(play => ({
                    playerId: play.player.id,
                    playerName: play.player.username,
                    card: { rankCode: play.card.rankCode, suitCode: play.card.suitCode, value: play.card.value }
                })),
                messageId: game.currentTrickMessageId,
                previousTrickCardsMessageId: game.previousTrickCardsMessageId, // Include for deletion of old trick
                nextPlayerName: nextPlayerName,
                nextPlayerId: nextPlayerId,
                isNextPlayerAI: isNextPlayerAI
            };

            // Try to send the trick update to Discord - CRITICAL
            try {
                await game.publicAnnounce(trickUpdatePayload);
                logger.debug('✅ Discord confirmed receipt of card play');
            } catch (err) {
                logger.error('❌ CRITICAL: Failed to announce card play to Discord:', err);
                // Discord failed to receive - don't modify game state
                try {
                    await interaction.followUp({
                        content: '❌ Failed to send your card play to Discord. Your card was NOT played. Please try again.',
                        ephemeral: true
                    });
                } catch (followUpErr) {
                    logger.error('❌ Failed to send error followUp:', followUpErr.message);
                }
                return;
            }

            // 3. ONLY NOW commit the card play to game state (Discord confirmed receipt)
            game.trick.push({ player, card: cardToPlay });
            player.removeCard(cardToPlay);
            
            // Record played card for AIs (include player id)
            try {
                game.recordPlayedCard(cardToPlay, player.id);
            } catch (e) {
                logger.error('❌ Failed to record played card from human play (button):', e);
            }

            logger.debug('✅ Card removed from hand and committed to game state');

            // 4. Break Spades if needed (playedSuit already defined above)
            if (playedSuit === 'S' && !game.spadesBroken) {
                game.spadesBroken = true;
                if (channel) {
                    try {
                        const spadesEmbed = new EmbedBuilder()
                            .setColor('#FF0000')
                            .setTitle('🚨♠️ SPADES ARE BROKEN! ♠️🚨')
                            .setDescription('Spades can now be led.');
                        await retryDiscordCall(() => channel.send({ embeds: [spadesEmbed] }));
                    } catch (err) {
                        logger.error('❌ Failed to announce spades broken:', err);
                    }
                }
            }

            // 5. Check if trick is complete — delegate to GameManager.completeTrick to centralize logic
            const expectedTrickSize = game.players.length; // 3 or 4 players
            if (game.trick.length === expectedTrickSize) {
                try {
                    await game.completeTrick();
                } catch (err) {
                    logger.error('❌ Failed to complete trick via GameManager.completeTrick (button handler):', err);
                }
            } else {
                // Trick continues: advance to next player
                game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
                // Schedule AI play if it's their turn (button-based plays)
                const next = game.players[game.currentPlayerIndex];
                if (next && next.isAI && game.state === 'PLAYING') {
                    logger.error(`🎲 Scheduling AI play for ${next.username} after human play (button)`);
                    try { game.scheduleAILead(2000); } catch (e) { logger.error('❌ Failed to schedule AI lead from button handler:', e); }
                }
            }

            // No need to announce next player - it's already shown in the trick embed

            } finally {
                // Always release the lock, even if there was an error
                cardPlayLocks.delete(lockKey);
            }

            return;
        }

        // ----------------------------------------------------
        // Handle Add AI Difficulty Select (LOBBY)
        // ----------------------------------------------------
        // ----------------------------------------------------
        // Handle Game Mode Selection
        // ----------------------------------------------------
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('game_mode_select')) {
            const [, threadId] = interaction.customId.split(':');
            const selectedMode = interaction.values[0]; // 'classic', 'cutthroat3', or 'cutthroat4'

            // Check premium status for cutthroat modes
            const isPremium = await checkPremiumEntitlement(client, interaction.user.id, interaction.guildId);
            
            if (!isGameModeAvailable(selectedMode, isPremium)) {
                // Cutthroat mode requires premium
                const premiumEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('⭐ Premium Game Mode')
                    .setDescription(`**Cutthroat modes** are premium features!\n\nSubscribe to Premium to unlock:\n• 3-Player Cutthroat\n• 4-Player Cutthroat\n\nClassic 4-player team mode is free!`)
                    .addFields({
                        name: '🆓 Free Mode',
                        value: '♠️ Classic (4 Players, Teams)',
                        inline: true
                    },
                    {
                        name: '⭐ Premium Modes',
                        value: '⚔️ 3-Player Cutthroat\n🎯 4-Player Cutthroat',
                        inline: true
                    });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('premium_subscribe')
                            .setLabel('Subscribe to Premium')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('⭐'),
                        new ButtonBuilder()
                            .setCustomId('premium_info')
                            .setLabel('Learn More')
                            .setStyle(ButtonStyle.Secondary)
                    );

                return interaction.reply({
                    embeds: [premiumEmbed],
                    components: [row],
                    ephemeral: true
                });
            }

            // Check if game already exists for this thread
            if (activeGames.has(threadId)) {
                return interaction.reply({ 
                    content: '❌ A game has already been created in this thread!', 
                    ephemeral: true 
                });
            }

            // Create publicAnnounce and privatePrompt handlers
            const publicAnnounce = async (payload) => {
                // payload can be a string (legacy) or structured object
                try {
                    const channel = await interaction.client.channels.fetch(threadId);
                    if (!channel) {
                        logger.error(`❌ Channel ${threadId} not found`);
                        return;
                    }

                    if (typeof payload === 'string') {
                        await retryDiscordCall(() => channel.send(payload));
                        return;
                    }

                    // Handle bidding update: create or update unified bidding embed
                    if (payload.type === 'bidding_update') {
                        try {
                            // Get the game instance to update biddingMessageId
                            const game = activeGames.get(channel.id);
                            if (!game) {
                                logger.error('❌ Game not found in activeGames for bidding update');
                                return;
                            }
                            
                            logger.error(`📊 Bidding update - current messageId: ${payload.messageId}, complete: ${payload.biddingComplete}`);
                            
                            const biddingEmbed = new EmbedBuilder()
                                .setColor('#1E90FF')
                                .setTitle(`🎯 Hand ${payload.round} - Bidding Phase`);
                            
                            // Build field showing all player bids
                            let bidsDisplay = '';
                            payload.bids.forEach((bidInfo, index) => {
                                const playerDisplay = bidInfo.isAI ? `**${bidInfo.playerName}**` : `<@${bidInfo.playerId}>`;
                                const bidDisplay = bidInfo.bid === null ? '❓' : bidInfo.bid;
                                
                                bidsDisplay += `${playerDisplay}: **${bidDisplay}**\n`;
                            });
                            
                            biddingEmbed.addFields({
                                name: 'Bids',
                                value: bidsDisplay,
                                inline: false
                            });
                            
                            // Show either "waiting for..." or "BIDDING COMPLETE"
                            if (payload.biddingComplete) {
                                biddingEmbed.addFields({
                                    name: '🚨 BIDDING COMPLETE! 🚨',
                                    value: 'All bids are in! Starting trick play in **10 seconds**...\n\n_Last bidder: You have 10 seconds to undo if needed._',
                                    inline: false
                                });
                            } else {
                                // Add current bidder at the bottom
                                const currentBidderMention = payload.isCurrentBidderAI 
                                    ? `**${payload.currentBidderName}**` 
                                    : `<@${payload.currentBidderId}>`;
                                
                                // Check if AI is waiting to bid (gives previous player time to undo)
                                let waitingMessage;
                                if (payload.aiPendingBid) {
                                    waitingMessage = `${currentBidderMention} will bid in **10 seconds**...\n\n_Previous bidder: You have 10 seconds to undo if needed._`;
                                } else {
                                    waitingMessage = `${currentBidderMention}, it's your turn to bid!`;
                                }
                                    
                                biddingEmbed.addFields({
                                    name: '⏳ Waiting for...',
                                    value: waitingMessage,
                                    inline: false
                                });
                            }
                            
                            // Add undo button if someone can undo their bid
                            let components = [];
                            if (payload.canUndoPlayerId) {
                                const undoButton = new ButtonBuilder()
                                    .setCustomId(`undo_bid:${channel.id}:${payload.canUndoPlayerId}`)
                                    .setLabel('↩️ Undo My Bid')
                                    .setStyle(ButtonStyle.Secondary);
                                
                                components.push(new ActionRowBuilder().addComponents(undoButton));
                            }
                            
                            // If messageId exists, delete old message
                            if (payload.messageId) {
                                try {
                                    logger.error(`🗑️ Attempting to delete old bidding message: ${payload.messageId}`);
                                    const oldMessage = await channel.messages.fetch(payload.messageId);
                                    await oldMessage.delete();
                                    logger.error(`✅ Deleted old bidding message`);
                                    // Small delay to ensure deletion is processed
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                } catch (fetchErr) {
                                    logger.debug('⚠️ Could not fetch/delete old bidding message:', fetchErr.message);
                                }
                            }
                            
                            // Send new bidding embed message
                            const newMsg = await retryDiscordCall(() => channel.send({ 
                                embeds: [biddingEmbed],
                                components: components
                            }));
                            game.biddingMessageId = newMsg.id;
                            logger.error(`✅ Sent new bidding message with ID: ${newMsg.id}`);
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

                            // Render card backs using game host's theme preference
                            let cardBackTheme = 'blue';
                            if (game && game.players && game.hostId) {
                                const host = game.players.find(p => p.discordId === game.hostId);
                                if (host && host.preferences && host.preferences.cardBackTheme) {
                                    cardBackTheme = host.preferences.cardBackTheme;
                                    logger.debug(`🎴 Using host's card back theme: ${cardBackTheme}, host: ${host.username}`);
                                } else {
                                    logger.debug(`🎴 Host found but no cardBackTheme preference, using default: blue`);
                                }
                            } else {
                                logger.debug(`🎴 No host found, using default card back theme: blue`);
                            }
                            const cardBacksImage = renderCardBacks(cardsPerPlayer, cardBackTheme);
                            const attachment = new AttachmentBuilder(cardBacksImage, { name: 'dealing.png' });
                            dealingEmbed.setImage('attachment://dealing.png');

                            // Show which players are receiving cards
                            let playerList = '';
                            payload.players.forEach((player, index) => {
                                const playerDisplay = player.isAI ? `🤖 ${player.username}` : `👤 ${player.username}`;
                                playerList += `${index + 1}. ${playerDisplay}\n`;
                            });
                            dealingEmbed.addFields({ name: 'Players', value: playerList, inline: false });

                            // Add action buttons
                            const actionRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`view_hand:${channel.id}`)
                                        .setLabel('🎴 View Hand')
                                        .setStyle(ButtonStyle.Primary),
                                    new ButtonBuilder()
                                        .setCustomId(`view_status:${channel.id}`)
                                        .setLabel('📊 Game Status')
                                        .setStyle(ButtonStyle.Secondary)
                                );

                            await retryDiscordCall(() => channel.send({ 
                                embeds: [dealingEmbed], 
                                files: [attachment],
                                components: [actionRow]
                            }));
                            
                            // Small delay to let the dealing animation be seen
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
                            
                            const trickPlays = payload.trick; // Array of {playerId, playerName, card}
                            const suitEmojis = { 'S': '♠️', 'H': '♥️', 'D': '♦️', 'C': '♣️' };
                            
                            // Build the embed description
                            let description = '';
                            trickPlays.forEach((play, index) => {
                                const cardDisplay = `${play.card.rankCode === 'T' ? '10' : play.card.rankCode}${suitEmojis[play.card.suitCode]}`;
                                description += `${index + 1}. **${play.playerName}** played **${cardDisplay}**\n`;
                            });

                            const embed = new EmbedBuilder()
                                .setColor('#4169E1')
                                .setTitle(`🃏 Current Trick (${trickPlays.length}/${maxPlayers})`)
                                .setDescription(description || 'No cards played yet.');

                            // Add next player info if trick isn't complete
                            if (payload.nextPlayerName) {
                                const nextPlayerMention = payload.isNextPlayerAI 
                                    ? `**${payload.nextPlayerName}**` 
                                    : `<@${payload.nextPlayerId}>`;
                                embed.addFields({ 
                                    name: '⏭️ Up Next', 
                                    value: `${nextPlayerMention}'s turn to play`, 
                                    inline: false 
                                });
                            }

                            // Render composite image of all trick cards
                            let trickImageAttachment = null;
                            if (trickPlays.length > 0) {
                                try {
                                    const cardsForRender = trickPlays.map(play => ({
                                        rankCode: play.card.rankCode,
                                        suitCode: play.card.suitCode
                                    }));
                                    logger.debug(`🎨 Rendering trick cards with theme: ${trickGame.options.deckTheme}, cards:`, cardsForRender);
                                    const trickImageBuffer = renderTrickCards(cardsForRender, trickGame.options.deckTheme);
                                    logger.debug(`✅ Trick image buffer created, size: ${trickImageBuffer.length} bytes`);
                                    trickImageAttachment = new AttachmentBuilder(trickImageBuffer, { 
                                        name: 'trick.png' 
                                    });
                                    embed.setImage('attachment://trick.png');
                                    logger.debug('✅ Trick image attached to embed');
                                } catch (err) {
                                    logger.error('❌ Failed to render trick cards:', err);
                                }
                            }

                            // For the FIRST card of a trick, delete the old trick cards message (but keep winner message)
                            // For cards 2-4, just update the existing message
                            const isFirstCardOfTrick = trickPlays.length === 1;
                            
                            logger.error(`🔍 Trick update: isFirstCard=${isFirstCardOfTrick}, previousTrickCardsMessageId=${payload.previousTrickCardsMessageId}, currentMessageId=${payload.messageId}`);
                            
                            if (isFirstCardOfTrick) {
                                // Delete the previous trick's cards message only
                                if (payload.previousTrickCardsMessageId) {
                                    try {
                                        const oldTrickMessage = await retryDiscordCall(() => channel.messages.fetch(payload.previousTrickCardsMessageId));
                                        await retryDiscordCall(() => oldTrickMessage.delete());
                                        logger.debug('🗑️ Deleted old trick cards message (keeping winner message, starting new trick)');
                                    } catch (err) {
                                        logger.error('❌ Failed to delete old trick cards message:', err);
                                    }
                                } else {
                                    logger.debug('⚠️ No previousTrickCardsMessageId provided for first card of new trick');
                                }
                            } else if (!isFirstCardOfTrick && payload.messageId) {
                                // Delete the previous trick update message (cards 2-4)
                                try {
                                    const oldMessage = await retryDiscordCall(() => channel.messages.fetch(payload.messageId));
                                    await retryDiscordCall(() => oldMessage.delete());
                                    logger.debug('🗑️ Deleted old trick update message');
                                } catch (err) {
                                    logger.error('❌ Failed to delete old trick message:', err);
                                }
                            }

                            // Send new message (always appears at bottom)
                            const messageOptions = { embeds: [embed] };
                            if (trickImageAttachment) {
                                messageOptions.files = [trickImageAttachment];
                            }
                            
                            // Add action buttons to trick messages
                            const game = activeGames.get(channel.id);
                            if (game) {
                                const actionRow = new ActionRowBuilder()
                                    .addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`view_hand:${channel.id}`)
                                            .setLabel('🎴 View Hand')
                                            .setStyle(ButtonStyle.Primary),
                                        new ButtonBuilder()
                                            .setCustomId(`view_status:${channel.id}`)
                                            .setLabel('📊 Game Status')
                                            .setStyle(ButtonStyle.Secondary)
                                    );
                                messageOptions.components = [actionRow];
                            }
                            
                            try {
                                const sentMessage = await retryDiscordCall(() => channel.send(messageOptions));
                                // Store the new message ID
                                if (game) {
                                    game.currentTrickMessageId = sentMessage.id;
                                    
                                    // Start timer for next player if applicable
                                    if (payload.nextPlayerId && !payload.isNextPlayerAI) {
                                        const nextPlayer = game.players.find(p => p.discordId === payload.nextPlayerId);
                                        if (nextPlayer) {
                                            game.startPlayTimer(nextPlayer);
                                        }
                                    }
                                }
                                logger.debug('✅ Sent new trick message at bottom');
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
                            
                            // Store this winner message ID so it gets deleted when next trick starts
                            const game = activeGames.get(channel.id);
                            if (game) {
                                game.currentTrickWinnerMessageId = sentMessage.id;
                            }
                            logger.debug('✅ Sent trick winner message at bottom');
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
                                // Cutthroat: show individual bids
                                game.players.forEach(p => {
                                    const playerDisplay = p.isAI ? `**${p.username}**` : `<@${p.discordId}>`;
                                    const bidDisplay = p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid.toString();
                                    bidsText += `${playerDisplay}: ${bidDisplay}\n`;
                                });
                            } else {
                                // Classic: show team bids
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

                            const firstPlayerMention = payload.isAI 
                                ? `**${payload.firstPlayerName}**` 
                                : `<@${payload.firstPlayerId}>`;

                            // Add field showing who plays first
                            biddingSummary.addFields({
                                name: '🎴 First Play',
                                value: `${firstPlayerMention} will play the first card.`,
                                inline: false
                            });

                            const actionRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`view_hand:${channel.id}`)
                                        .setLabel('🎴 View Hand')
                                        .setStyle(ButtonStyle.Primary),
                                    new ButtonBuilder()
                                        .setCustomId(`view_status:${channel.id}`)
                                        .setLabel('📊 Game Status')
                                        .setStyle(ButtonStyle.Secondary)
                                );

                            await retryDiscordCall(() => channel.send({
                                embeds: [biddingSummary],
                                components: [actionRow]
                            }));
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
                            logger.error(`🏁 Game over in channel ${payload.channelId} - cleaning up...`);
                            
                            // Save player statistics (skip AI players)
                            if (payload.gameStats && Array.isArray(payload.gameStats)) {
                                const humanPlayers = payload.gameStats.filter(p => !p.discordId.startsWith('ai_'));
                                logger.error(`📊 Saving stats for ${humanPlayers.length} human players in ${payload.gameMode} mode...`);
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
                                        logger.error(`✅ Saved stats for ${playerData.username}`);
                                    } catch (statErr) {
                                        logger.error(`❌ Failed to save stats for ${playerData.username}:`, statErr);
                                    }
                                }
                            }
                            
                            activeGames.delete(payload.channelId);
                            await channel.send(`🎉 **GAME OVER!** 🎉\n**Winner:** ${payload.message}`);
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
                    const user = await interaction.client.users.fetch(playerId);
                    await user.send(message);
                } catch (err) {
                    logger.error(`❌ Failed to DM player ${playerId}:`, err);
                }
            };

            // Fetch the channel for the game
            const gameChannel = await interaction.client.channels.fetch(threadId);
            
            // Create the game with the selected mode
            const newGame = new GameManager(publicAnnounce, privatePrompt, 500, selectedMode);
            newGame.guildId = interaction.guildId;
            newGame.guildId = interaction.guildId;
            newGame.channelId = threadId;
            newGame.channel = gameChannel; // Store channel for AI trash talk
            newGame.state = 'LOBBY';
            newGame.hostId = interaction.user.id;

            // Initialize SpectatorView for the game
            const { SpectatorView } = await import('./game_logic/SpectatorView.js');
            newGame.spectatorView = new SpectatorView(newGame, gameChannel);

            const initiator = {
                id: interaction.user.id,
                username: interaction.user.username,
                isAI: false,
                preferences: await getUserPreferences(interaction.user.id)
            };

            const result = newGame.addPlayer(initiator);
            if (result.error) {
                return interaction.reply({ 
                    content: `🚫 Cannot join game: ${result.error}`, 
                    ephemeral: true 
                });
            }

            activeGames.set(threadId, newGame);

            // Create lobby embed and components
            const lobbyEmbed = createLobbyEmbed(newGame);
            const lobbyComponents = createLobbyComponents(threadId, newGame);

            // Update the message with the lobby
            await interaction.update({ 
                embeds: [lobbyEmbed], 
                components: lobbyComponents
            });

            return;
        }

        // ----------------------------------------------------
        // Handle AI Difficulty Selection
        // ----------------------------------------------------
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('add_ai_select')) {
            const [, gameChannelId] = interaction.customId.split(':');

            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'LOBBY') {
                return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can add AI players!', 
                    ephemeral: true 
                });
            }

            const selected = interaction.values && interaction.values[0] ? interaction.values[0] : 'medium';

            // Check premium status for Hard difficulty
            const isPremium = await checkPremiumEntitlement(client, interaction.user.id, interaction.guildId);
            
            if (!isAIDifficultyAvailable(selected, isPremium)) {
                // Hard difficulty requires premium
                const premiumEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('⭐ Premium AI Difficulty')
                    .setDescription(`**Hard difficulty** is a premium feature!\n\nSubscribe to Premium to unlock stronger AI opponents.`)
                    .addFields({
                        name: '🆓 Free Difficulties',
                        value: '🟢 Easy\n🟡 Medium',
                        inline: true
                    },
                    {
                        name: '⭐ Premium',
                        value: '🔴 Hard',
                        inline: true
                    });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('premium_subscribe')
                            .setLabel('Subscribe to Premium')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('⭐'),
                        new ButtonBuilder()
                            .setCustomId('premium_info')
                            .setLabel('Learn More')
                            .setStyle(ButtonStyle.Secondary)
                    );

                return interaction.reply({
                    embeds: [premiumEmbed],
                    components: [row],
                    ephemeral: true
                });
            }

            // Count teams BEFORE adding AI
            const team1Count = game.players.filter(p => p.team === 1).length;
            const team2Count = game.players.filter(p => p.team === 2).length;
            logger.error(`🤖 Adding AI - Team 1: ${team1Count}, Team 2: ${team2Count}`);

            const aiResult = game.addAIPlayerWithLevel(null, selected);

            if (aiResult.error) {
                return interaction.reply({ content: `🚫 Cannot add AI player: ${aiResult.error}`, ephemeral: true });
            }

            // Assign AI to team with fewer players
            aiResult.player.team = team1Count < team2Count ? 1 : 2;
            logger.error(`🤖 Assigned ${aiResult.player.username} to Team ${aiResult.player.team}`);

            // Update lobby display
            const lobbyEmbed = createLobbyEmbed(game);
            const lobbyComponents = createLobbyComponents(gameChannelId, game);

            await interaction.update({
                embeds: [lobbyEmbed],
                components: lobbyComponents
            });

            // Lobby is full, but waiting for manual start now (no auto-start)
            // Players will click the "Start Game" button when ready

            return;
        }

        // ----------------------------------------------------
        // Handle View Hand Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('view_hand:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: '❌ No active game found.', ephemeral: true });
            }

            const player = game.players.find(p => p.discordId === interaction.user.id);

            if (!player) {
                // Check if spectator
                if (game.isSpectator(interaction.user.id)) {
                    return interaction.reply({ 
                        content: '👁️ You are a spectator. Use `/spades hand player:<name>` to view a player\'s hand.', 
                        ephemeral: true 
                    });
                }
                return interaction.reply({ content: '❌ You are not in this game.', ephemeral: true });
            }

            // Show hand with bidding or playing buttons
            try {
                let messageContent = `🃏 **Your Spades Hand**`;
                let handAttachment = null;
                let components = [];

                if (game.state === 'BIDDING') {
                    const hasNotBidYet = player.bid === null || player.bid === undefined;
                    const blindNilEligible = player.blindNilEligible || false;
                    
                    logger.error(`🎯 View Hand Button - Player: ${player.username}, Team: ${player.team}, Bid: ${player.bid}, BlindNilEligible: ${blindNilEligible}`);
                    
                    if (hasNotBidYet) {
                        // Check if player declined Blind Nil (stored temporarily)
                        const hasDeclinedBlindNil = player.declinedBlindNil || false;
                        
                        logger.error(`🎯 Has not bid yet - DeclinedBlindNil: ${hasDeclinedBlindNil}`);
                        
                        // If Blind Nil eligible and hasn't declined yet, show Yes/No choice with card backs
                        if (blindNilEligible && !hasDeclinedBlindNil) {
                            logger.error(`🎯 Showing Blind Nil option to ${player.username}`);
                            messageContent = `🎯 **Blind Nil Available**\n\n`;
                            messageContent += `Your team is **200+ points behind**. You are eligible to bid **Blind Nil** (±200 points).\n\n`;
                            messageContent += `⚠️ **If you bid Blind Nil, you cannot view your cards first.**\n\n`;
                            messageContent += `**Do you want to bid Blind Nil?**`;
                            
                            // Show card backs instead of hiding cards completely
                            try {
                                // Use host's theme for uniform look
                                let cardBackTheme = 'blue';
                                if (game && game.hostId) {
                                    const host = game.players.find(p => p.discordId === game.hostId);
                                    if (host && host.preferences && host.preferences.cardBackTheme) {
                                        cardBackTheme = host.preferences.cardBackTheme;
                                    }
                                }
                                logger.error(`🎴 Player ${player.username} viewing Blind Nil with host's theme: ${cardBackTheme}`);
                                const cardBacksBuffer = renderCardBacks(player.hand.length, cardBackTheme);
                                handAttachment = new AttachmentBuilder(cardBacksBuffer, { name: 'hand_back.png' });
                                logger.debug('✅ Card backs generated for Blind Nil decision');
                            } catch (err) {
                                logger.error('❌ Error generating card backs:', err);
                            }
                            
                            // Yes/No buttons for Blind Nil
                            const blindNilRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`blindnil_yes:${gameChannelId}`)
                                        .setLabel('✅ Yes - Bid Blind Nil')
                                        .setStyle(ButtonStyle.Success),
                                    new ButtonBuilder()
                                        .setCustomId(`blindnil_no:${gameChannelId}`)
                                        .setLabel('❌ No - View Cards')
                                        .setStyle(ButtonStyle.Danger)
                                );
                            components.push(blindNilRow);
                        } else {
                            // Show hand with bidding buttons
                            const handImageBuffer = renderHand(player.hand, player.preferences.colorBlindMode, game.options.deckTheme);
                            handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                            
                            // Calculate bid suggestion if enabled
                            if (player.preferences.biddingSuggestions) {
                                const suggestion = game.calculateBidSuggestion(player);
                                
                                messageContent += '\n\n**🦅 Mr. Easy Suggests:**\n';
                                
                                // Check if we have primary/alternative format (Nil suggestion)
                                if (suggestion.primary) {
                                    const primary = suggestion.primary;
                                    messageContent += `**${primary.suggestedBid}** (${primary.confidence} confidence)\n`;
                                    messageContent += `_${primary.explanation}_`;
                                    
                                    if (suggestion.alternative) {
                                        const alt = suggestion.alternative;
                                        messageContent += `\n\n**Alternative: Nil** (${alt.confidence} confidence)\n`;
                                        messageContent += `_${alt.explanation}_`;
                                    }
                                } else {
                                    // Simple format
                                    messageContent += `**${suggestion.suggestedBid}** (${suggestion.confidence} confidence)\n`;
                                    messageContent += `_${suggestion.explanation}_`;
                                }
                            }
                            
                            // Calculate hand strength if enabled
                            if (player.preferences.handStrengthIndicator) {
                                const strength = game.calculateHandStrength(player);
                                
                                messageContent += '\n\n**💪 Hand Strength:**\n';
                                messageContent += `**${strength.rating}** (${strength.totalStrength} pts)\n`;
                                messageContent += `HCP: ${strength.hcp} | Distribution: ${strength.distribution}\n`;
                                messageContent += `♠️ Spades: ${strength.spades} (${strength.highSpades} high)`;
                                
                                if (strength.voids > 0 || strength.singletons > 0) {
                                    const shortSuits = [];
                                    if (strength.voids > 0) shortSuits.push(`${strength.voids} void${strength.voids > 1 ? 's' : ''}`);
                                    if (strength.singletons > 0) shortSuits.push(`${strength.singletons} singleton${strength.singletons > 1 ? 's' : ''}`);
                                    messageContent += `\n_${shortSuits.join(', ')}_`;
                                }
                            }
                            
                            // Add bidding buttons
                            const bidButtons = [];
                            for (let i = 0; i <= 13; i++) {
                                bidButtons.push(
                                    new ButtonBuilder()
                                        .setCustomId(`bid_${gameChannelId}_${i}`)
                                        .setLabel(i === 0 ? 'Nil' : i.toString())
                                        .setStyle(i === 0 ? ButtonStyle.Danger : ButtonStyle.Primary)
                                );
                            }

                            // Split into rows of 5
                            for (let i = 0; i < bidButtons.length; i += 5) {
                                components.push(new ActionRowBuilder().addComponents(bidButtons.slice(i, i + 5)));
                            }
                        }
                    } else {
                        // Already bid, just show the hand
                        const handImageBuffer = renderHand(player.hand, player.preferences.colorBlindMode, game.options.deckTheme);
                        handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                    }
                } else if (game.state === 'PLAYING') {
                    // Show hand with card play buttons
                    const handImageBuffer = renderHand(player.hand, player.preferences.colorBlindMode, game.options.deckTheme);
                    handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                    
                    // Show hand strength if enabled (during play)
                    if (player.preferences.handStrengthIndicator && player.hand.length > 0) {
                        const strength = game.calculateHandStrength(player);
                        messageContent += `\n\n**💪 Hand Strength:** ${strength.rating} (${strength.totalStrength} pts)`;
                    }
                    
                    // Show recommended card play if enabled
                    if (player.preferences.recommendedCardPlay && player.hand.length > 0) {
                        const suggestion = game.calculateCardPlaySuggestion(player);
                        
                        if (suggestion) {
                            const card = suggestion.recommendedCard;
                            const suitEmojis = {
                                'S': '♠️',
                                'H': '♥️',
                                'D': '♦️',
                                'C': '♣️'
                            };
                            const rankDisplay = card.rankCode === 'T' ? '10' : card.rankCode;
                            const cardDisplay = `${rankDisplay}${suitEmojis[card.suitCode]}`;
                            const confidenceEmoji = suggestion.confidence === 'high' ? '🎯' : 
                                                   suggestion.confidence === 'medium' ? '👍' : '🤔';
                            
                            messageContent += `\n\n**🦅 Mr. Easy Suggests:**\n`;
                            messageContent += `**${cardDisplay}** ${confidenceEmoji}\n`;
                            messageContent += `_${suggestion.explanation}_`;
                        }
                    }
                    
                    const cardComponents = createCardPlayComponents(gameChannelId, player.hand, game, player);
                    components.push(...cardComponents);
                } else {
                    // Any other state, just show the hand
                    const handImageBuffer = renderHand(player.hand, player.preferences.colorBlindMode, game.options.deckTheme);
                    handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                }

                const embed = new EmbedBuilder()
                    .setColor('#1E90FF')
                    .setTitle(`${player.username}'s Hand`)
                    .setDescription(messageContent);
                
                if (handAttachment) {
                    embed.setImage('attachment://' + handAttachment.name);
                }

                await interaction.reply({
                    embeds: [embed],
                    files: handAttachment ? [handAttachment] : [],
                    components: components,
                    ephemeral: true
                });
            } catch (err) {
                logger.error('❌ Failed to show hand via button:', err);
                return interaction.reply({ content: '❌ Failed to display your hand.', ephemeral: true });
            }

            return;
        }

        // ----------------------------------------------------
        // Handle View Status Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('view_status:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: '❌ No active game found.', ephemeral: true });
            }

            try {
                // Handle Lobby State
                if (game.state === 'LOBBY') {
                    const playerList = game.players.map(p => `\`${p.username}\``).join('\n');
                    const spectators = game.getSpectators();
                    const spectatorDisplay = spectators.length ? spectators.map(s => `• ${s.username}`).join('\n') : 'None';
                    const lobbyEmbed = new EmbedBuilder()
                        .setColor('#FF9900')
                        .setTitle('Spades Lobby Status')
                        .setDescription(`Waiting for **${4 - game.getLobbySize()}** more players to join.`)
                        .addFields(
                            { name: `Current Players (${game.getLobbySize()}/4)`, value: playerList || 'None yet.' },
                            { name: 'Spectators', value: spectatorDisplay, inline: false }
                        );
                        
                    return interaction.reply({ embeds: [lobbyEmbed], ephemeral: true });
                }
                
                // Check if cutthroat mode
                if (game.isCutthroat()) {
                    // Cutthroat: individual player status
                    const playerDetails = game.players.map(p => {
                        const bidDisplay = p.bid === null ? '?' : p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid;
                        return `**${p.username}**\nBid: \`${bidDisplay}\` | Tricks: \`${p.tricks}\` | Score: \`${p.score}\` | Bags: \`${p.bags}\``;
                    }).join('\n\n');

                    const cardsInTrickDisplay = game.trick.length > 0 
                        ? game.trick.map(t => getCardEmojiDisplay(t.card)).join(' ') 
                        : 'None';
                        
                    const currentTurnText = game.state === 'BIDDING'
                        ? `Bidding: **${game.players[game.currentPlayerIndex].username}**`
                        : game.state === 'PLAYING'
                            ? `Playing: **${game.players[game.currentPlayerIndex].username}**`
                            : 'Game Over';

                    const spectators = game.getSpectators();
                    const spectatorDisplay = spectators.length
                        ? spectators.map(s => `• ${s.username}`).join('\n')
                        : 'None';

                    const gameStatusEmbed = new EmbedBuilder()
                        .setColor('#9B59B6')
                        .setTitle(`${game.gameMode === 'cutthroat3' ? '3-Player' : '4-Player'} Cutthroat Status (Hand ${game.currentRound})`)
                        .setDescription(`**Game State:** ${game.state}\n**Dealer:** ${game.players[game.dealerIndex].username}`)
                        .addFields(
                            { name: '👥 Players', value: playerDetails, inline: false },
                            { name: 'Current Turn', value: currentTurnText, inline: true },
                            { name: 'Cards in Trick', value: cardsInTrickDisplay, inline: true },
                            { name: 'Spectators', value: spectatorDisplay, inline: false }
                        );
                    
                    return interaction.reply({ embeds: [gameStatusEmbed], ephemeral: true });
                }
                
                // Classic mode: Organize players by team
                const team1Players = game.players.filter(p => p.team === 1);
                const team2Players = game.players.filter(p => p.team === 2);

                // Team 1 Summary
                const team1Bid = team1Players.reduce((sum, p) => sum + (p.bid || 0), 0);
                const team1Score = team1Players[0].score;
                const team1Bags = team1Players[0].bags;
                
                const team1Summary = `**Bid:** ${team1Bid} | **Score:** ${team1Score} | **Bags:** ${team1Bags}`;
                const team1Details = team1Players.map(p => {
                    const bidDisplay = p.bid === null ? '?' : p.isNil ? 'Nil' : p.bid;
                    return `${p.username}: Bid \`${bidDisplay}\` | Tricks \`${p.tricks}\``;
                }).join('\n');

                // Team 2 Summary
                const team2Bid = team2Players.reduce((sum, p) => sum + (p.bid || 0), 0);
                const team2Score = team2Players[0].score;
                const team2Bags = team2Players[0].bags;
                
                const team2Summary = `**Bid:** ${team2Bid} | **Score:** ${team2Score} | **Bags:** ${team2Bags}`;
                const team2Details = team2Players.map(p => {
                    const bidDisplay = p.bid === null ? '?' : p.isNil ? 'Nil' : p.bid;
                    return `${p.username}: Bid \`${bidDisplay}\` | Tricks \`${p.tricks}\``;
                }).join('\n');
                
                const cardsInTrickDisplay = game.trick.length > 0 
                    ? game.trick.map(t => getCardEmojiDisplay(t.card)).join(' ') 
                    : 'None';
                    
                const currentTurnText = game.state === 'BIDDING'
                    ? `Bidding: **${game.players[game.currentPlayerIndex].username}**`
                    : game.state === 'PLAYING'
                        ? `Playing: **${game.players[game.currentPlayerIndex].username}**`
                        : 'Game Over';

                const spectators = game.getSpectators();
                const spectatorDisplay = spectators.length
                    ? spectators.map(s => `• ${s.username}`).join('\n')
                    : 'None';

                const gameStatusEmbed = new EmbedBuilder()
                    .setColor('#1080A0')
                    .setTitle(`Spades Game Status (Hand ${game.currentRound})`)
                    .setDescription(`**Game State:** ${game.state}\n**Dealer:** ${game.players[game.dealerIndex].username}`)
                    .addFields(
                        { name: '🟦 Team 1', value: team1Summary, inline: false },
                        { name: 'Players', value: team1Details, inline: false },
                        { name: '\u200B', value: '\u200B', inline: false }, // Spacer
                        { name: '🟥 Team 2', value: team2Summary, inline: false },
                        { name: 'Players', value: team2Details, inline: false },
                        { name: '\u200B', value: '\u200B', inline: false }, // Spacer
                        { name: 'Current Turn', value: currentTurnText, inline: true },
                        { name: 'Cards in Trick', value: cardsInTrickDisplay, inline: true },
                        { name: 'Spectators', value: spectatorDisplay, inline: false }
                    );
                
                return interaction.reply({ embeds: [gameStatusEmbed], ephemeral: true });
            } catch (error) {
                logger.error('❌ Error in view status button:', error);
                return interaction.reply({ content: '❌ Failed to display game status.', ephemeral: true });
            }

            return;
        }

        // ----------------------------------------------------
        // Handle Add AI Button Interaction (LOBBY)
        if (interaction.isButton() && interaction.customId.startsWith('add_ai')) {
            const [, gameChannelId] = interaction.customId.split(':');

            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'LOBBY') {
                return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can add AI players!', 
                    ephemeral: true 
                });
            }

            // Count teams BEFORE adding AI
            const team1Count = game.players.filter(p => p.team === 1).length;
            const team2Count = game.players.filter(p => p.team === 2).length;
            logger.error(`🤖 Adding AI - Team 1: ${team1Count}, Team 2: ${team2Count}`);

            // Add AI with medium difficulty by default
            const aiResult = game.addAIPlayerWithLevel(null, 'medium');
            if (aiResult.error) {
                return interaction.reply({ content: `🚫 Cannot add AI player: ${aiResult.error}`, ephemeral: true });
            }

            // Assign AI to team with fewer players
            aiResult.player.team = team1Count < team2Count ? 1 : 2;
            logger.error(`🤖 Assigned ${aiResult.player.username} to Team ${aiResult.player.team}`);

            // Update lobby display
            const lobbyEmbed = createLobbyEmbed(game);
            const lobbyComponents = createLobbyComponents(gameChannelId, game);

            await interaction.update({
                embeds: [lobbyEmbed],
                components: lobbyComponents
            });

            // Lobby full check removed - players must click Start Game button

            return;
        }

        // Handle Join Game Button Interaction (LOBBY)
        // ----------------------------------------------------
        // ----------------------------------------------------
        // Handle Join Team Button (new team selection system)
        // ----------------------------------------------------
        // ----------------------------------------------------
        // Handle Join Cutthroat Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('join_cutthroat')) {
            const [, gameChannelId] = interaction.customId.split(':');

            logger.debug('📘 Join cutthroat button clicked by:', interaction.user.username);
            logger.debug('🔍 Parsed gameChannelId:', gameChannelId);

            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'LOBBY') {
                logger.debug('❌ Game not found or not in LOBBY state.');
                return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
            }

            // Check if player is already in the game
            const existingPlayer = game.players.find(p => p.discordId === interaction.user.id);
            
            if (existingPlayer) {
                return interaction.reply({ content: `You're already in this game!`, ephemeral: true });
            }

            // Check if game is full
            if (game.players.length >= game.getMaxPlayers()) {
                return interaction.reply({ content: `This game is full!`, ephemeral: true });
            }

            // Add new player
            const playerDetails = {
                id: interaction.user.id,
                username: interaction.user.username,
                guildId: interaction.guildId,
                preferences: await getUserPreferences(interaction.user.id)
            };

            const result = game.addPlayer(playerDetails);

            if (result.error) {
                return interaction.reply({ content: `🚫 Cannot join game: ${result.error}`, ephemeral: true });
            }

            // Update lobby display
            const lobbyEmbed = createLobbyEmbed(game);
            const lobbyComponents = createLobbyComponents(gameChannelId, game);

            await interaction.update({
                embeds: [lobbyEmbed],
                components: lobbyComponents
            });

            return;
        }

        // ----------------------------------------------------
        // Handle Join Team Button (Classic Mode)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('join_team')) {
            const [, gameChannelId, teamId] = interaction.customId.split(':');

            logger.debug('📘 Join team button clicked by:', interaction.user.username);
            logger.debug('� Parsed gameChannelId:', gameChannelId, 'Team:', teamId);

            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'LOBBY') {
                logger.debug('� Game not found or not in LOBBY state.');
                return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
            }

            // Check if player is already in the game
            const existingPlayer = game.players.find(p => p.discordId === interaction.user.id);
            
            if (existingPlayer) {
                // Player is already in game, check if they're trying to switch teams
                if (existingPlayer.team === parseInt(teamId)) {
                    return interaction.reply({ content: `You're already on Team ${teamId}!`, ephemeral: true });
                }
                
                // Switch teams
                const newTeamPlayers = game.players.filter(p => p.team === parseInt(teamId));
                if (newTeamPlayers.length >= 2) {
                    return interaction.reply({ content: `Team ${teamId} is full! Can't switch teams.`, ephemeral: true });
                }
                
                existingPlayer.team = parseInt(teamId);
                
                // Update lobby display
                const lobbyEmbed = createLobbyEmbed(game);
                const lobbyComponents = createLobbyComponents(gameChannelId, game);

                await interaction.update({
                    embeds: [lobbyEmbed],
                    components: lobbyComponents
                });

                await interaction.followUp({ 
                    content: `✅ You switched to Team ${teamId}!`, 
                    ephemeral: true 
                });

                return;
            }

            // Check if team is full
            const teamPlayers = game.players.filter(p => p.team === parseInt(teamId));
            if (teamPlayers.length >= 2) {
                return interaction.reply({ content: `Team ${teamId} is full! Please join the other team.`, ephemeral: true });
            }

            // Add new player to the selected team
            const playerDetails = {
                id: interaction.user.id,
                username: interaction.user.username,
                guildId: interaction.guildId,
                preferences: await getUserPreferences(interaction.user.id)
            };

            const result = game.addPlayer(playerDetails);

            if (result.error) {
                return interaction.reply({ content: `🚫 Cannot join game: ${result.error}`, ephemeral: true });
            }

            // Set the player's team
            const newPlayer = game.players.find(p => p.discordId === interaction.user.id);
            newPlayer.team = parseInt(teamId);

            // Update lobby display
            const lobbyEmbed = createLobbyEmbed(game);
            const lobbyComponents = createLobbyComponents(gameChannelId, game);

            await interaction.update({
                embeds: [lobbyEmbed],
                components: lobbyComponents
            });

            // Lobby full check removed - players must click Start Game button

            return;
        }

        // ----------------------------------------------------
        // Handle Start Game Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('start_game:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'LOBBY') {
                return interaction.reply({ content: 'That game lobby is no longer active or has already started!', ephemeral: true });
            }

            if (!game.isLobbyFull()) {
                return interaction.reply({ content: '❌ Cannot start game yet! Need 4 players.', ephemeral: true });
            }

            // Start the game
            await game.startGame(); // Deals cards, sets dealer, and sets state to BIDDING

            // Send DMs and start bidding sequence
            const channel = interaction.channel;
            await sendHandsAndBiddingButtons(game, channel, gameChannelId);

            // Final update to remove buttons after starting
            const startEmbed = new EmbedBuilder()
                .setColor('#00FF00')
                .setTitle('🎮 Game Starting!')
                .setDescription('All 4 players are ready! The game is beginning now.')
                .addFields(
                    { name: '🟦 Team 1', value: game.players.filter(p => p.team === 1).map(p => p.isAI ? `🤖 ${p.username}` : `👤 ${p.username}`).join('\n'), inline: true },
                    { name: '🟥 Team 2', value: game.players.filter(p => p.team === 2).map(p => p.isAI ? `🤖 ${p.username}` : `👤 ${p.username}`).join('\n'), inline: true }
                );

            await interaction.update({
                embeds: [startEmbed],
                components: [], // Remove all components
            });

            return;
        }

        // ----------------------------------------------------
        // Handle Game Settings Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('game_settings:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Create settings embed with current values
            const settingsEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('⚙️ Game Settings (Host Only)')
                .setDescription('Game-wide settings that affect gameplay timing.\n\n_Display preferences (suggestions, hand strength, etc.) are personal!_\nPlayers can use `/spades preferences` to customize their view.')
                .addFields(
                    { 
                        name: '⏱️ Auto-Play Timer', 
                        value: game.options.autoPlayTimer > 0 ? `✅ ${game.options.autoPlayTimer}s` : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎴 Auto-Play Last Trick', 
                        value: game.options.autoPlayLastTrick ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎯 Target Score', 
                        value: `${game.options.targetScore} points`, 
                        inline: true 
                    },
                    { 
                        name: '💬 AI Trash Talk', 
                        value: game.options.trashTalk.enabled ? `✅ ${game.options.trashTalk.frequency.toUpperCase()}` : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎨 Deck Theme', 
                        value: `${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`, 
                        inline: true 
                    }
                );

            // Create setting buttons
            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`timer_setting:${gameChannelId}`)
                        .setLabel(`⏱️ Timer: ${game.options.autoPlayTimer}s`)
                        .setStyle(game.options.autoPlayTimer > 0 ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`toggle_setting:${gameChannelId}:autoPlayLastTrick`)
                        .setLabel(game.options.autoPlayLastTrick ? '🎴 Last Trick: ON' : '🎴 Last Trick: OFF')
                        .setStyle(game.options.autoPlayLastTrick ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`target_score_setting:${gameChannelId}`)
                        .setLabel(`🎯 Score: ${game.options.targetScore}`)
                        .setStyle(game.options.targetScore !== 500 ? ButtonStyle.Success : ButtonStyle.Secondary)
                );

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`toggle_trash_talk:${gameChannelId}`)
                        .setLabel(game.options.trashTalk.enabled ? '💬 Trash Talk: ON' : '💬 Trash Talk: OFF')
                        .setStyle(game.options.trashTalk.enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`cycle_trash_talk:${gameChannelId}`)
                        .setLabel(`📊 Frequency: ${game.options.trashTalk.frequency.toUpperCase()}`)
                        .setStyle(ButtonStyle.Primary)
                );

            const row3 = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(`select_deck_theme:${gameChannelId}`)
                        .setPlaceholder(`🎨 Deck Theme: ${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`)
                        .addOptions([
                            {
                                label: 'Classic',
                                description: 'Traditional playing card design',
                                value: 'classic',
                                emoji: '🃏',
                                default: game.options.deckTheme === 'classic'
                            },
                            {
                                label: 'Steampunk',
                                description: 'Brass, gears, and Victorian aesthetics',
                                value: 'steampunk',
                                emoji: '⚙️',
                                default: game.options.deckTheme === 'steampunk'
                            },
                            {
                                label: 'Minimalist',
                                description: 'Clean and simple design',
                                value: 'minimalist',
                                emoji: '▪️',
                                default: game.options.deckTheme === 'minimalist'
                            },
                            {
                                label: 'Neon',
                                description: 'Bright glowing colors on dark background',
                                value: 'neon',
                                emoji: '💫',
                                default: game.options.deckTheme === 'neon'
                            },
                            {
                                label: 'Medieval',
                                description: 'Parchment texture with ornate decorations',
                                value: 'medieval',
                                emoji: '📜',
                                default: game.options.deckTheme === 'medieval'
                            },
                            {
                                label: 'Holographic',
                                description: 'Rainbow shimmer with suit-specific gradients',
                                value: 'holographic',
                                emoji: '✨',
                                default: game.options.deckTheme === 'holographic'
                            },
                            {
                                label: 'Cosmic',
                                description: 'Deep space with stars, nebulae, and cosmic colors',
                                value: 'cosmic',
                                emoji: '🌌',
                                default: game.options.deckTheme === 'cosmic'
                            },
                            {
                                label: 'Cyberpunk',
                                description: 'Futuristic tech with neon circuits and hexagons',
                                value: 'cyberpunk',
                                emoji: '⚡',
                                default: game.options.deckTheme === 'cyberpunk'
                            },
                            {
                                label: 'Christmas',
                                description: 'Festive holiday theme with snowflakes and holly',
                                value: 'christmas',
                                emoji: '🎄',
                                default: game.options.deckTheme === 'christmas'
                            }
                        ])
                );

            const row4 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`close_settings:${gameChannelId}`)
                        .setLabel('✅ Done')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.reply({
                embeds: [settingsEmbed],
                components: [row1, row2, row3, row4],
                ephemeral: true
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Toggle Setting Buttons
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('toggle_setting:')) {
            const [, gameChannelId, settingName] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Toggle the setting
            const newValue = !game.options[settingName];
            const result = game.updateOptions({ [settingName]: newValue });

            if (result.error) {
                return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            }

            // Update the settings display using helper functions
            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });

            // Update lobby display in background
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Toggle Trash Talk Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('toggle_trash_talk:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Toggle trash talk
            game.options.trashTalk.enabled = !game.options.trashTalk.enabled;

            // Update AI players' trash talk settings
            game.players.filter(p => p.isAI).forEach(ai => {
                ai.setTrashTalkPreferences(game.options.trashTalk.enabled, game.options.trashTalk.frequency);
            });

            // Update the settings display using helper functions
            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });

            // Update lobby display in background
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Cycle Trash Talk Frequency Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('cycle_trash_talk:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Cycle through frequencies: low -> medium -> high -> low
            const frequencies = ['low', 'medium', 'high'];
            const currentIndex = frequencies.indexOf(game.options.trashTalk.frequency);
            const nextIndex = (currentIndex + 1) % frequencies.length;
            game.options.trashTalk.frequency = frequencies[nextIndex];

            // Update AI players' trash talk settings
            game.players.filter(p => p.isAI).forEach(ai => {
                ai.setTrashTalkPreferences(game.options.trashTalk.enabled, game.options.trashTalk.frequency);
            });

            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Deck Theme Select Menu
        // ----------------------------------------------------
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_deck_theme:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Check theme ownership (free or purchased)
            const selectedTheme = interaction.values[0];
            const ownsTheme = await checkThemeOwnership(client, interaction.user.id, selectedTheme, interaction.guildId);
            
            if (!ownsTheme) {
                // Theme requires purchase - show a la carte upsell
                const themeSku = getThemeSku(selectedTheme);
                const themeName = selectedTheme.charAt(0).toUpperCase() + selectedTheme.slice(1);
                
                const premiumEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('🎨 Premium Theme')
                    .setDescription(`**${themeName}** is available for purchase!\n\nBuy this theme once and use it forever.`)
                    .addFields({
                        name: '🆓 Free Themes',
                        value: FREE_THEMES.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', '),
                        inline: true
                    },
                    {
                        name: '💎 Premium Themes',
                        value: PURCHASABLE_THEMES.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', '),
                        inline: true
                    });

                const components = [];
                
                // Only add buy button if we have a valid SKU
                if (themeSku) {
                    components.push(
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`buy_theme:${selectedTheme}`)
                                    .setLabel(`Buy ${themeName} Theme`)
                                    .setStyle(ButtonStyle.Primary)
                                    .setEmoji('🎨'),
                                new ButtonBuilder()
                                    .setCustomId(`close_premium_upsell:${gameChannelId}`)
                                    .setLabel('Maybe Later')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                    );
                } else {
                    components.push(
                        new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`close_premium_upsell:${gameChannelId}`)
                                    .setLabel('Close')
                                    .setStyle(ButtonStyle.Secondary)
                            )
                    );
                }

                return interaction.reply({
                    embeds: [premiumEmbed],
                    components,
                    ephemeral: true
                });
            }

            // Set the selected deck theme
            game.options.deckTheme = selectedTheme;

            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Timer Setting Button (opens modal for number input)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('timer_setting:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Show modal for timer input
            const modal = new ModalBuilder()
                .setCustomId(`timer_modal:${gameChannelId}`)
                .setTitle('⏱️ Auto-Play Timer');

            const timerInput = new TextInputBuilder()
                .setCustomId('timer_value')
                .setLabel('Timer in seconds (0 = disabled, max 300)')
                .setStyle(TextInputStyle.Short)
                .setValue(game.options.autoPlayTimer.toString())
                .setPlaceholder('60')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(timerInput));

            await interaction.showModal(modal);
            return;
        }

        // ----------------------------------------------------
        // Handle Target Score Setting Button (opens modal for number input)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('target_score_setting:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            // Show modal for target score input
            const modal = new ModalBuilder()
                .setCustomId(`score_modal:${gameChannelId}`)
                .setTitle('🎯 Target Score');

            const scoreInput = new TextInputBuilder()
                .setCustomId('score_value')
                .setLabel('Points to win (100-1000)')
                .setStyle(TextInputStyle.Short)
                .setValue(game.options.targetScore.toString())
                .setPlaceholder('500')
                .setRequired(true);

            modal.addComponents(new ActionRowBuilder().addComponents(scoreInput));

            await interaction.showModal(modal);
            return;
        }

        // ----------------------------------------------------
        // Handle Timer Modal Submit
        // ----------------------------------------------------
        if (interaction.isModalSubmit() && interaction.customId.startsWith('timer_modal:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            const timerValue = parseInt(interaction.fields.getTextInputValue('timer_value'));

            const result = game.updateOptions({ autoPlayTimer: timerValue });

            if (result.error) {
                return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            }

            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Target Score Modal Submit
        // ----------------------------------------------------
        if (interaction.isModalSubmit() && interaction.customId.startsWith('score_modal:')) {
            const [, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game) {
                return interaction.reply({ content: 'No active game found!', ephemeral: true });
            }

            // Check if user is the host
            if (game.hostId !== interaction.user.id) {
                return interaction.reply({ 
                    content: '🚫 Only the game host can change settings!', 
                    ephemeral: true 
                });
            }

            const scoreValue = parseInt(interaction.fields.getTextInputValue('score_value'));

            // Check premium status for custom target scores
            const isPremium = await checkPremiumEntitlement(client, interaction.user.id, interaction.guildId);
            
            if (!isTargetScoreValid(scoreValue, isPremium)) {
                const limits = getTargetScoreLimits(isPremium);
                if (!isPremium && (scoreValue !== 500)) {
                    // Non-premium user trying to set custom score
                    return interaction.reply({
                        content: `⭐ **Premium Feature**\n\nCustom target scores require Premium. Free users can only play to 500 points.\n\nUse \`/spades premium\` to learn more!`,
                        ephemeral: true
                    });
                } else {
                    return interaction.reply({ 
                        content: `❌ Target score must be between ${limits.min} and ${limits.max}.`, 
                        ephemeral: true 
                    });
                }
            }

            const result = game.updateOptions({ targetScore: scoreValue });

            if (result.error) {
                return interaction.reply({ content: `❌ ${result.error}`, ephemeral: true });
            }

            await interaction.update({
                embeds: [createSettingsEmbed(game)],
                components: createSettingsComponents(gameChannelId, game)
            });
            await updateLobbyMessage(interaction.channel, gameChannelId, game);

            return;
        }

        // ----------------------------------------------------
        // Handle Close Settings Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('close_settings:')) {
            await interaction.update({
                content: '✅ Settings saved!',
                embeds: [],
                components: []
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Close Preferences Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('close_preferences:')) {
            await interaction.update({
                content: '✅ Preferences saved!',
                embeds: [],
                components: []
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Premium Subscribe Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId === 'premium_subscribe') {
            try {
                // Use Discord's native premium subscription flow
                await interaction.response.sendPremiumRequired({
                    skus: [PREMIUM_SKU_ID]
                });
            } catch (error) {
                logger.error('❌ Error showing premium subscription:', error);
                // Fallback if premium flow fails
                await interaction.reply({
                    content: '❌ Unable to show subscription options. Please try again later or contact support.',
                    ephemeral: true
                });
            }
            return;
        }

        // ----------------------------------------------------
        // Handle Buy Theme Button (A La Carte Theme Purchase)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('buy_theme:')) {
            const themeName = interaction.customId.split(':')[1];
            const themeSku = getThemeSku(themeName);
            
            if (!themeSku) {
                return interaction.reply({
                    content: '❌ This theme is not available for purchase.',
                    ephemeral: true
                });
            }
            
            try {
                // Use Discord's native purchase flow for the specific theme
                await interaction.response.sendPremiumRequired({
                    skus: [themeSku]
                });
            } catch (error) {
                logger.error('❌ Error showing theme purchase:', error);
                await interaction.reply({
                    content: '❌ Unable to show purchase options. Please try again later.',
                    ephemeral: true
                });
            }
            return;
        }

        // ----------------------------------------------------
        // Handle Premium Manage Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId === 'premium_manage') {
            await interaction.reply({
                content: '⚙️ To manage your subscription, go to **User Settings** > **Subscriptions** in Discord.',
                ephemeral: true
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Close Premium Upsell Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('close_premium_upsell:')) {
            await interaction.update({
                content: '👍 No problem! You can subscribe anytime with `/spades premium`',
                embeds: [],
                components: []
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Premium Info Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId === 'premium_info') {
            const infoEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('⭐ About Premium')
                .setDescription('Premium subscriptions help support the development of Spades Bot and unlock exclusive features!')
                .addFields(
                    {
                        name: '💰 Pricing',
                        value: 'Premium is available through Discord\'s native subscription system. Pricing varies by region.',
                        inline: false
                    },
                    {
                        name: '🔄 How It Works',
                        value: '1. Click "Subscribe to Premium"\n2. Complete purchase through Discord\n3. Features unlock instantly!\n4. Cancel anytime in Discord settings',
                        inline: false
                    },
                    {
                        name: '❓ Questions?',
                        value: 'Join our support server or contact us for help!',
                        inline: false
                    }
                );

            await interaction.reply({
                embeds: [infoEmbed],
                ephemeral: true
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Spectator View Buttons
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId === 'spectator_toggle_view') {
            const game = activeGames.get(interaction.channelId);
            if (!game || !game.spectatorView) {
                return interaction.reply({ content: '❌ Spectator view not available.', ephemeral: true });
            }
            
            game.spectatorView.toggleViewMode();
            
            const embeds = game.spectatorView.viewMode === 'detailed'
                ? [game.spectatorView.createSpectatorDashboard(), ...(await game.spectatorView.createDetailedHandsView())]
                : game.spectatorView.createCompactView();
            
            const components = game.spectatorView.createControlButtons();
            
            await interaction.update({
                embeds: embeds,
                components: components
            });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'spectator_refresh') {
            const game = activeGames.get(interaction.channelId);
            if (!game || !game.spectatorView) {
                return interaction.reply({ content: '❌ Spectator view not available.', ephemeral: true });
            }
            
            const embeds = game.spectatorView.viewMode === 'detailed'
                ? [game.spectatorView.createSpectatorDashboard(), ...(await game.spectatorView.createDetailedHandsView())]
                : game.spectatorView.createCompactView();
            
            const components = game.spectatorView.createControlButtons();
            
            await interaction.update({
                embeds: embeds,
                components: components
            });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'spectator_stats') {
            const game = activeGames.get(interaction.channelId);
            if (!game || !game.spectatorView) {
                return interaction.reply({ content: '❌ Spectator view not available.', ephemeral: true });
            }
            
            const statsEmbed = game.spectatorView.createDetailedStatsEmbed();
            
            await interaction.reply({
                embeds: [statsEmbed],
                ephemeral: true
            });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'spectator_notifications') {
            const game = activeGames.get(interaction.channelId);
            if (!game || !game.spectatorView) {
                return interaction.reply({ content: '❌ Spectator view not available.', ephemeral: true });
            }
            
            const enabled = game.spectatorView.toggleNotifications(interaction.user.id);
            
            await interaction.reply({
                content: enabled 
                    ? '🔔 Spectator notifications enabled! You will receive updates about Nils, sets, and game events.'
                    : '🔕 Spectator notifications disabled.',
                ephemeral: true
            });
            return;
        }

        if (interaction.isButton() && interaction.customId === 'spectator_history') {
            const game = activeGames.get(interaction.channelId);
            if (!game || !game.spectatorView) {
                return interaction.reply({ content: '❌ Spectator view not available.', ephemeral: true });
            }
            
            const historyEmbed = game.spectatorView.createTrickHistoryEmbed();
            
            await interaction.reply({
                embeds: [historyEmbed],
                ephemeral: true
            });
            return;
        }

        // ----------------------------------------------------
        // Handle Toggle Preference Buttons
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('toggle_pref:')) {
            const [, userId, setting] = interaction.customId.split(':');
            
            // Verify user can only change their own preferences
            if (userId !== interaction.user.id) {
                return interaction.reply({
                    content: '❌ You can only change your own preferences!',
                    ephemeral: true
                });
            }

            // Get current preferences
            const userPrefs = await getUserPreferences(userId);
            
            // Toggle the setting
            userPrefs[setting] = !userPrefs[setting];
            
            // Save updated preferences
            await updateUserPreferences(userId, userPrefs);
            
            // Also update the player's preferences if they're in an active game
            let gamesUpdated = 0;
            for (const [channelId, game] of activeGames.entries()) {
                const player = game.players.find(p => p.discordId === userId);
                if (player) {
                    player.preferences = userPrefs;
                    gamesUpdated++;
                    logger.error(`🔄 Updated ${setting} for ${player.username} in game ${channelId}`);
                }
            }
            if (gamesUpdated === 0) {
                logger.error(`🔄 No active games found for user ${userId} - preferences saved for next game`);
            }

            // Get theme display name
            const themeNames = {
                'blue': '🔵 Blue',
                'red': '🔴 Red',
                'green': '🟢 Green',
                'purple': '🟣 Purple',
                'classic': '⚫ Classic',
                'christmas': '🎄 Christmas'
            };
            const currentTheme = userPrefs.cardBackTheme || 'blue';

            // Update the embed and buttons
            const preferencesEmbed = new EmbedBuilder()
                .setColor('#9B59B6')
                .setTitle('⚙️ Your Personal Preferences')
                .setDescription('These settings only affect what YOU see. Other players have their own preferences.')
                .addFields(
                    { 
                        name: '🦅 Bidding Suggestions', 
                        value: userPrefs.biddingSuggestions ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '💪 Hand Strength Indicator', 
                        value: userPrefs.handStrengthIndicator ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎨 Color Blind Mode', 
                        value: userPrefs.colorBlindMode ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎯 Recommended Card Play', 
                        value: userPrefs.recommendedCardPlay ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎴 Card Back Theme', 
                        value: themeNames[currentTheme], 
                        inline: true 
                    }
                );

            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:biddingSuggestions`)
                        .setLabel(userPrefs.biddingSuggestions ? '🦅 Suggestions: ON' : '🦅 Suggestions: OFF')
                        .setStyle(userPrefs.biddingSuggestions ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:handStrengthIndicator`)
                        .setLabel(userPrefs.handStrengthIndicator ? '💪 Strength: ON' : '💪 Strength: OFF')
                        .setStyle(userPrefs.handStrengthIndicator ? ButtonStyle.Success : ButtonStyle.Secondary)
                );

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:colorBlindMode`)
                        .setLabel(userPrefs.colorBlindMode ? '🎨 Color Blind: ON' : '🎨 Color Blind: OFF')
                        .setStyle(userPrefs.colorBlindMode ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:recommendedCardPlay`)
                        .setLabel(userPrefs.recommendedCardPlay ? '🎯 Card Play: ON' : '🎯 Card Play: OFF')
                        .setStyle(userPrefs.recommendedCardPlay ? ButtonStyle.Success : ButtonStyle.Secondary)
                );

            // Card back theme selector
            const themeSelect = new StringSelectMenuBuilder()
                .setCustomId(`theme_select:${userId}`)
                .setPlaceholder('Select card back theme')
                .addOptions([
                    {
                        label: '🔵 Blue Theme',
                        description: 'Deep navy to bright blue gradient',
                        value: 'blue',
                        default: currentTheme === 'blue'
                    },
                    {
                        label: '⭐ Red Theme',
                        description: 'Premium - Dark crimson to bright red',
                        value: 'red',
                        default: currentTheme === 'red'
                    },
                    {
                        label: '⭐ Green Theme',
                        description: 'Premium - Forest to emerald gradient',
                        value: 'green',
                        default: currentTheme === 'green'
                    },
                    {
                        label: '⭐ Purple Theme',
                        description: 'Premium - Deep violet to vibrant purple',
                        value: 'purple',
                        default: currentTheme === 'purple'
                    },
                    {
                        label: '⭐ Classic Theme',
                        description: 'Premium - Charcoal to gray gradient',
                        value: 'classic',
                        default: currentTheme === 'classic'
                    },
                    {
                        label: '⭐ Christmas Theme',
                        description: 'Premium - Icy blue frosted with snowflake',
                        value: 'christmas',
                        default: currentTheme === 'christmas'
                    }
                ]);

            const row3 = new ActionRowBuilder().addComponents(themeSelect);

            const row4 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`close_preferences:${userId}`)
                        .setLabel('✅ Done')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.update({
                embeds: [preferencesEmbed],
                components: [row1, row2, row3, row4]
            });

            return;
        }

        // ----------------------------------------------------
        // Handle Card Back Theme Selection
        // ----------------------------------------------------
        if (interaction.isStringSelectMenu() && interaction.customId.startsWith('theme_select:')) {
            const [, userId] = interaction.customId.split(':');
            
            // Verify user can only change their own preferences
            if (userId !== interaction.user.id) {
                return interaction.reply({
                    content: '❌ You can only change your own preferences!',
                    ephemeral: true
                });
            }

            const selectedTheme = interaction.values[0];

            // Check premium status for card back themes
            const isPremium = await checkPremiumEntitlement(client, interaction.user.id, interaction.guildId);
            
            if (!isCardBackAvailable(selectedTheme, isPremium)) {
                // Card back requires premium
                const premiumEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle('⭐ Premium Card Back')
                    .setDescription(`**${selectedTheme.charAt(0).toUpperCase() + selectedTheme.slice(1)}** card back is a premium feature!\n\nSubscribe to Premium to unlock all card back themes.`)
                    .addFields({
                        name: '🆓 Free',
                        value: '🔵 Blue',
                        inline: true
                    },
                    {
                        name: '⭐ Premium',
                        value: '🔴 Red\n🟢 Green\n🟣 Purple\n⚫ Classic\n🎄 Christmas',
                        inline: true
                    });

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('premium_subscribe')
                            .setLabel('Subscribe to Premium')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('⭐'),
                        new ButtonBuilder()
                            .setCustomId(`close_premium_upsell:preferences`)
                            .setLabel('Maybe Later')
                            .setStyle(ButtonStyle.Secondary)
                    );

                return interaction.reply({
                    embeds: [premiumEmbed],
                    components: [row],
                    ephemeral: true
                });
            }

            // Get current preferences
            const userPrefs = await getUserPreferences(userId);
            
            // Update theme
            userPrefs.cardBackTheme = selectedTheme;
            
            // Save updated preferences
            await updateUserPreferences(userId, userPrefs);
            
            // Also update the player's preferences if they're in an active game
            let gamesUpdated = 0;
            for (const [channelId, game] of activeGames.entries()) {
                const player = game.players.find(p => p.discordId === userId);
                if (player) {
                    player.preferences = userPrefs;
                    gamesUpdated++;
                    logger.error(`🔄 Updated preferences for ${player.username} in game ${channelId} - new theme: ${selectedTheme}`);
                }
            }
            if (gamesUpdated === 0) {
                logger.error(`🔄 No active games found for user ${userId} - preferences saved for next game`);
            }

            // Get theme display name
            const themeNames = {
                'blue': '🔵 Blue',
                'red': '🔴 Red',
                'green': '🟢 Green',
                'purple': '🟣 Purple',
                'classic': '⚫ Classic',
                'christmas': '🎄 Christmas'
            };

            // Update the embed and buttons
            const preferencesEmbed = new EmbedBuilder()
                .setColor('#9B59B6')
                .setTitle('⚙️ Your Personal Preferences')
                .setDescription('These settings only affect what YOU see. Other players have their own preferences.')
                .addFields(
                    { 
                        name: '🦅 Bidding Suggestions', 
                        value: userPrefs.biddingSuggestions ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '💪 Hand Strength Indicator', 
                        value: userPrefs.handStrengthIndicator ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎨 Color Blind Mode', 
                        value: userPrefs.colorBlindMode ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎯 Recommended Card Play', 
                        value: userPrefs.recommendedCardPlay ? '✅ Enabled' : '❌ Disabled', 
                        inline: true 
                    },
                    { 
                        name: '🎴 Card Back Theme', 
                        value: themeNames[selectedTheme], 
                        inline: true 
                    }
                );

            const row1 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:biddingSuggestions`)
                        .setLabel(userPrefs.biddingSuggestions ? '🦅 Suggestions: ON' : '🦅 Suggestions: OFF')
                        .setStyle(userPrefs.biddingSuggestions ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:handStrengthIndicator`)
                        .setLabel(userPrefs.handStrengthIndicator ? '💪 Strength: ON' : '💪 Strength: OFF')
                        .setStyle(userPrefs.handStrengthIndicator ? ButtonStyle.Success : ButtonStyle.Secondary)
                );

            const row2 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:colorBlindMode`)
                        .setLabel(userPrefs.colorBlindMode ? '🎨 Color Blind: ON' : '🎨 Color Blind: OFF')
                        .setStyle(userPrefs.colorBlindMode ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`toggle_pref:${userId}:recommendedCardPlay`)
                        .setLabel(userPrefs.recommendedCardPlay ? '🎯 Card Play: ON' : '🎯 Card Play: OFF')
                        .setStyle(userPrefs.recommendedCardPlay ? ButtonStyle.Success : ButtonStyle.Secondary)
                );

            // Card back theme selector
            const themeSelect = new StringSelectMenuBuilder()
                .setCustomId(`theme_select:${userId}`)
                .setPlaceholder('Select card back theme')
                .addOptions([
                    {
                        label: '🔵 Blue Theme',
                        description: 'Deep navy to bright blue gradient',
                        value: 'blue',
                        default: selectedTheme === 'blue'
                    },
                    {
                        label: '🔴 Red Theme',
                        description: 'Dark crimson to bright red gradient',
                        value: 'red',
                        default: selectedTheme === 'red'
                    },
                    {
                        label: '🟢 Green Theme',
                        description: 'Forest to emerald gradient',
                        value: 'green',
                        default: selectedTheme === 'green'
                    },
                    {
                        label: '🟣 Purple Theme',
                        description: 'Deep violet to vibrant purple gradient',
                        value: 'purple',
                        default: selectedTheme === 'purple'
                    },
                    {
                        label: '⚫ Classic Theme',
                        description: 'Charcoal to gray gradient',
                        value: 'classic',
                        default: selectedTheme === 'classic'
                    },
                    {
                        label: '🎄 Christmas Theme',
                        description: 'Icy blue frosted gradient with snowflake',
                        value: 'christmas',
                        default: selectedTheme === 'christmas'
                    }
                ]);

            const row3 = new ActionRowBuilder().addComponents(themeSelect);

            const row4 = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`close_preferences:${userId}`)
                        .setLabel('✅ Done')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.update({
                embeds: [preferencesEmbed],
                components: [row1, row2, row3, row4]
            });

            return;
        }

        // ----------------------------------------------------
        // Handle Blind Nil Yes/No Decision Buttons
        // ----------------------------------------------------
        if (interaction.isButton() && (interaction.customId.startsWith('blindnil_yes:') || interaction.customId.startsWith('blindnil_no:'))) {
            const [decision, gameChannelId] = interaction.customId.split(':');
            const game = activeGames.get(gameChannelId);

            if (!game || game.state !== 'BIDDING') {
                return interaction.reply({ content: 'No active Spades game found or bidding is complete.', ephemeral: true });
            }

            const player = game.players.find(p => p.discordId === interaction.user.id);

            if (!player) {
                return interaction.reply({ content: 'You are not a player in this game.', ephemeral: true });
            }

            if (decision === 'blindnil_yes') {
                // Player chose to bid Blind Nil - place the bid immediately
                const bidResult = game.tryPlaceBid(player.discordId, -1);

                if (bidResult.error) {
                    return interaction.update({
                        content: `🚫 Cannot place Blind Nil bid: ${bidResult.error}`,
                        components: []
                    });
                }

                await interaction.update({
                    content: `✅ You successfully bid **Blind Nil**.`,
                    components: []
                });
            } else if (decision === 'blindnil_no') {
                // Player declined Blind Nil - mark it and show their cards with normal bid buttons
                player.declinedBlindNil = true;

                let handAttachment = null;
                try {
                    const handImageBuffer = renderHand(player.hand, false, game.options.deckTheme);
                    handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                } catch (err) {
                    logger.error('❌ Error generating hand image:', err);
                }

                const components = createBiddingComponents(gameChannelId, false);
                const replyOptions = {
                    content: `🃏 **Your Spades Hand**\n\n**Select your bid using the buttons below:**`,
                    components: components
                };

                if (handAttachment) {
                    replyOptions.files = [handAttachment];
                }

                await interaction.update(replyOptions);
            }

            return;
        }

        // ----------------------------------------------------
        // ----------------------------------------------------
        // Handle Undo Bid Button
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('undo_bid:')) {
            const [, gameChannelId, allowedPlayerId] = interaction.customId.split(':');
            
            const game = activeGames.get(gameChannelId);
            if (!game || game.state !== 'BIDDING') {
                return interaction.reply({ content: 'Bidding is no longer active.', ephemeral: true });
            }

            // Check if this user is allowed to undo (only the player who placed the last bid)
            if (interaction.user.id !== allowedPlayerId) {
                return interaction.reply({ content: 'Only the player who just bid can undo their bid.', ephemeral: true });
            }

            const undoResult = game.undoBid(interaction.user.id);

            if (undoResult.error) {
                return interaction.reply({ content: `🚫 ${undoResult.error}`, ephemeral: true });
            }

            // Acknowledge the button click
            await interaction.deferUpdate();

            // Send public embed announcing the undo
            const undoEmbed = new EmbedBuilder()
                .setColor('#FFA500')
                .setTitle('↩️ Bid Undone')
                .setDescription(`<@${interaction.user.id}> has undone their bid of **${undoResult.oldBid}**.`)
                .addFields({ name: 'Status', value: `Waiting for <@${interaction.user.id}> to place a new bid.`, inline: false });

            await interaction.channel.send({ embeds: [undoEmbed] });

            return;
        }

        // Handle Bid Button Interaction (BIDDING)
        // ----------------------------------------------------
        if (interaction.isButton() && interaction.customId.startsWith('bid_')) {
            const parts = interaction.customId.split('_'); // Format: ['bid', <channelId>, <bidValue>]
            if (parts.length < 3) {
                return interaction.reply({ content: 'Invalid bid button format.', ephemeral: true });
            }

            const gameChannelId = parts[1];
            const bidValue = parts[2];
            
            // Parse bid amount: 'nil' = 0, 'blindnil' = -1, numbers = parseInt
            let bidAmount;
            if (bidValue === 'nil') {
                bidAmount = 0;
            } else if (bidValue === 'blindnil') {
                bidAmount = -1;
            } else {
                bidAmount = parseInt(bidValue, 10);
            }

            const gameForBid = activeGames.get(gameChannelId);

            if (!gameForBid || gameForBid.state !== 'BIDDING') {
                return interaction.reply({ content: 'No active Spades game found or bidding is complete.', ephemeral: true });
            }

            logger.error(`🔍 Bid attempt by user: ${interaction.user.username} (${interaction.user.id})`);
            logger.error(`   Players in game:`, gameForBid.players.map(p => `${p.username}(discordId:${p.discordId}, id:${p.id})`));

            const player = gameForBid.players.find(p => p.discordId === interaction.user.id);

            if (!player) {
                logger.error(`❌ Player not found in game!`);
                return interaction.reply({ content: 'You are not a player in this game.', ephemeral: true });
            }

            logger.error(`✅ Found player: ${player.username}, passing discordId: ${player.discordId} to tryPlaceBid`);

            const bidResult = gameForBid.tryPlaceBid(player.discordId, bidAmount);

            if (bidResult.error) {
                return interaction.reply({
                    content: `🚫 Cannot place bid: ${bidResult.error}`,
                    ephemeral: true
                });
            }

            const bidDisplay = bidResult.bidDisplay;

            await interaction.update({
                content: `✅ You successfully bid **${bidDisplay}**.`,
                components: [] // Remove buttons after bidding
            });

            return;
        }

        // ------------------------------------------------------------------------

        // Use the modern, type-specific check for slash commands
        if (!interaction.isChatInputCommand()) return;

        const commandName = interaction.commandName; 

        if (commandName !== 'spades') return;

        const subcommand = options.getSubcommand();

        // ------------------------------------------------------------------------
        // /spades leave (spectator leave)
        if (subcommand === 'leave') {
            const game = activeGames.get(interaction.channelId);
            if (!game) {
                return interaction.reply({
                    content: '❌ No active Spades game found in this channel.',
                    ephemeral: true
                });
            }
            // Only spectators can use this
            if (!game.isSpectator(interaction.user.id)) {
                return interaction.reply({
                    content: '🚫 You are not a spectator in this game.',
                    ephemeral: true
                });
            }
            const result = game.removeSpectator(interaction.user.id);
            if (result.error) {
                return interaction.reply({ content: `🚫 ${result.error}`, ephemeral: true });
            }
            return interaction.reply({
                content: '👋 You have left as a spectator. You will no longer receive updates or be able to view hands.',
                ephemeral: true
            });
        }
        // ------------------------------------------------------------------------

        // /spades spectate
        if (subcommand === 'spectate') {
            const game = activeGames.get(interaction.channelId);
            if (!game) {
                return interaction.reply({
                    content: '❌ No active Spades game found in this channel.',
                    ephemeral: true
                });
            }
            // Check if user is already a player
            const isPlayer = game.players.some(p => p.discordId === interaction.user.id);
            if (isPlayer) {
                return interaction.reply({
                    content: '🚫 You are already a player in this game and cannot spectate.',
                    ephemeral: true
                });
            }
            // Add as spectator
            const result = game.addSpectator({ id: interaction.user.id, username: interaction.user.username });
            if (result.error) {
                return interaction.reply({ content: `🚫 ${result.error}`, ephemeral: true });
            }
            return interaction.reply({
                content: '👀 You are now spectating this Spades game! Use `/spades spectator-view` to open your interactive dashboard.',
                ephemeral: true
            });
        }

        // ----------------------------------------------------
        // /spades spectator-view
        // ----------------------------------------------------
        if (subcommand === 'spectator-view') {
            const game = activeGames.get(interaction.channelId);
            if (!game) {
                return interaction.reply({
                    content: '❌ No active Spades game found in this channel.',
                    ephemeral: true
                });
            }
            
            // Check if user is a spectator
            if (!game.isSpectator(interaction.user.id)) {
                return interaction.reply({
                    content: '🚫 You must be a spectator to use this command. Use `/spades spectate` to join as a spectator.',
                    ephemeral: true
                });
            }
            
            // Import and initialize SpectatorView if not already done
            if (!game.spectatorView) {
                const { SpectatorView } = await import('./game_logic/SpectatorView.js');
                game.spectatorView = new SpectatorView(game, interaction.channel);
            }
            
            // Show pending notifications first if any
            const pendingNotifications = game.spectatorView.getPendingNotifications(interaction.user.id);
            if (pendingNotifications.length > 0) {
                let notifText = '📬 **Recent Notifications:**\n';
                for (const notif of pendingNotifications) {
                    notifText += `• ${notif.message}\n`;
                }
                await interaction.reply({ content: notifText, ephemeral: true });
                
                // Give them a moment to read, then send the full view as followUp
                setTimeout(async () => {
                    await game.spectatorView.sendSpectatorView(interaction, true);
                }, 1500);
            } else {
                // Send the spectator view directly
                await game.spectatorView.sendSpectatorView(interaction, false);
            }
            return;
        }

        // ----------------------------------------------------
        // /spades start (LOBBY INITIATION)
        // ----------------------------------------------------
        if (subcommand === 'start') {
            if (game) {
                return interaction.reply({ content: 'A game is already active in this channel.', ephemeral: true });
            }

            // Create a thread for this game
            try {
                // First, send a message that we'll create the thread from
                const threadStartMessage = await interaction.reply({ 
                    content: '🎮 Creating new Spades game thread...',
                    fetchReply: true 
                });

                // Create a thread from the message; if unsupported, run in current channel.
                let thread = interaction.channel;
                try {
                    thread = await threadStartMessage.startThread({
                        name: `Spades Game (Started by ${interaction.user.username})`,
                        autoArchiveDuration: 10080, // Archive after 7 days of inactivity
                        reason: 'New Spades game starting'
                    });
                } catch (threadError) {
                    logger.error('❌ Thread creation unavailable, continuing in current channel:', threadError);
                    try {
                        await interaction.editReply('🎮 Thread creation is unavailable here. Starting Spades in this channel instead.');
                    } catch (editErr) {
                        logger.error('❌ Failed to edit start reply after thread fallback:', editErr);
                    }
                }

                // The user initiating the command is the first player
                const initiator = {
                    id: user.id,
                    username: user.username,
                    guildId: interaction.guildId,
                    preferences: await getUserPreferences(user.id)
                };

            // Define communication hooks required by GameManager
            const publicAnnounce = async (payload) => {
                // payload can be a string (legacy) or structured object
                try {
                    const channel = thread; // Use the created thread instead of original channel
                    if (!channel) return;

                    if (typeof payload === 'string') {
                        await retryDiscordCall(() => channel.send(payload));
                        return;
                    }

                    // Handle trick update: create or update embedded message showing all cards played
                    if (payload.type === 'trick_update') {
                        try {
                            const trickGame = activeGames.get(channel.id);
                            const maxPlayers = trickGame ? trickGame.getMaxPlayers() : 4;
                            
                            const trickPlays = payload.trick; // Array of {playerId, playerName, card}
                            const suitEmojis = { 'S': '♠️', 'H': '♥️', 'D': '♦️', 'C': '♣️' };
                            
                            // Build the embed description
                            let description = '';
                            trickPlays.forEach((play, index) => {
                                const cardDisplay = `${play.card.rankCode === 'T' ? '10' : play.card.rankCode}${suitEmojis[play.card.suitCode]}`;
                                description += `${index + 1}. **${play.playerName}** played **${cardDisplay}**\n`;
                            });

                            const embed = new EmbedBuilder()
                                .setColor('#4169E1')
                                .setTitle(`🃏 Current Trick (${trickPlays.length}/${maxPlayers})`)
                                .setDescription(description || 'No cards played yet.');

                            // Add next player info if trick isn't complete
                            if (payload.nextPlayerName) {
                                const nextPlayerMention = payload.isNextPlayerAI 
                                    ? `**${payload.nextPlayerName}**` 
                                    : `<@${payload.nextPlayerId}>`;
                                embed.addFields({ 
                                    name: '⏭️ Up Next', 
                                    value: `${nextPlayerMention}'s turn to play`, 
                                    inline: false 
                                });
                            }

                            // Render composite image of all trick cards
                            let trickImageAttachment = null;
                            if (trickPlays.length > 0) {
                                try {
                                    const cardsForRender = trickPlays.map(play => ({
                                        rankCode: play.card.rankCode,
                                        suitCode: play.card.suitCode
                                    }));
                                    logger.debug(`🎨 Rendering trick cards with theme: ${game.options.deckTheme}, cards:`, cardsForRender);
                                    const trickImageBuffer = renderTrickCards(cardsForRender, game.options.deckTheme);
                                    logger.debug(`✅ Trick image buffer created, size: ${trickImageBuffer.length} bytes`);
                                    trickImageAttachment = new AttachmentBuilder(trickImageBuffer, { 
                                        name: 'trick.png' 
                                    });
                                    // Set the image in the embed
                                    embed.setImage('attachment://trick.png');
                                    logger.debug('✅ Trick image attached to embed');
                                } catch (err) {
                                    logger.error('❌ Failed to render trick cards:', err);
                                }
                            }

                            // For the FIRST card of a trick, delete the old trick cards message (but keep winner message)
                            // For cards 2-4, just update the existing message
                            const isFirstCardOfTrick = trickPlays.length === 1;
                            
                            logger.error(`🔍 Trick update: isFirstCard=${isFirstCardOfTrick}, previousTrickCardsMessageId=${payload.previousTrickCardsMessageId}, currentMessageId=${payload.messageId}`);
                            
                            if (isFirstCardOfTrick) {
                                // Delete the previous trick's cards message only
                                if (payload.previousTrickCardsMessageId) {
                                    try {
                                        const oldTrickMessage = await retryDiscordCall(() => channel.messages.fetch(payload.previousTrickCardsMessageId));
                                        await retryDiscordCall(() => oldTrickMessage.delete());
                                        logger.debug('🗑️ Deleted old trick cards message (keeping winner message, starting new trick)');
                                    } catch (err) {
                                        logger.error('❌ Failed to delete old trick cards message:', err);
                                    }
                                } else {
                                    logger.debug('⚠️ No previousTrickCardsMessageId provided for first card of new trick');
                                }
                                // DON'T delete the winner message - it stays visible
                            } else if (!isFirstCardOfTrick && payload.messageId) {
                                // Delete the previous trick update message (cards 2-4)
                                try {
                                    const oldMessage = await retryDiscordCall(() => channel.messages.fetch(payload.messageId));
                                    await retryDiscordCall(() => oldMessage.delete());
                                    logger.debug('🗑️ Deleted old trick update message');
                                } catch (err) {
                                    logger.error('❌ Failed to delete old trick message:', err);
                                }
                            }

                            // Send new message (always appears at bottom)
                            const messageOptions = { embeds: [embed] };
                            if (trickImageAttachment) {
                                messageOptions.files = [trickImageAttachment];
                            }
                            
                            // Add action buttons to trick messages
                            const game = activeGames.get(channel.id);
                            if (game) {
                                const actionRow = new ActionRowBuilder()
                                    .addComponents(
                                        new ButtonBuilder()
                                            .setCustomId(`view_hand:${channel.id}`)
                                            .setLabel('🎴 View Hand')
                                            .setStyle(ButtonStyle.Primary),
                                        new ButtonBuilder()
                                            .setCustomId(`view_status:${channel.id}`)
                                            .setLabel('📊 Game Status')
                                            .setStyle(ButtonStyle.Secondary)
                                    );
                                messageOptions.components = [actionRow];
                            }
                            
                            try {
                                const sentMessage = await retryDiscordCall(() => channel.send(messageOptions));
                                // Store the new message ID
                                if (game) {
                                    game.currentTrickMessageId = sentMessage.id;
                                    
                                    // Start timer for next player if applicable
                                    if (payload.nextPlayerId && !payload.isNextPlayerAI) {
                                        const nextPlayer = game.players.find(p => p.discordId === payload.nextPlayerId);
                                        if (nextPlayer) {
                                            game.startPlayTimer(nextPlayer);
                                        }
                                    }
                                }
                                logger.debug('✅ Sent new trick message at bottom');
                            } catch (err) {
                                logger.error('❌ Failed to send new trick message:', err);
                            }
                        } catch (err) {
                            logger.error('❌ Failed to send/update trick embed:', err);
                        }
                        return;
                    }

                    // Handle card play object => render single card image and send (LEGACY - can be removed if not used)
                    if (payload.type === 'card_play') {
                        try {
                            const cardObj = payload.card;
                            const cardBuf = renderSingleCard({ rankCode: cardObj.rankCode, suitCode: cardObj.suitCode, value: cardObj.value });
                            const att = new AttachmentBuilder(cardBuf, { name: `${cardObj.rankCode}${cardObj.suitCode}.png` });
                            const content = `**${payload.playerName}** played:`;
                            await channel.send({ content, files: [att] });
                        } catch (err) {
                            logger.error('❌ Failed to render/send card image for AI play:', err);
                            // Fallback to emoji/text display
                            try {
                                const fallbackEmoji = getCardEmojiDisplay({ rankCode: payload.card.rankCode, suitCode: payload.card.suitCode });
                                await channel.send({ content: `**${payload.playerName}** played **${fallbackEmoji}**` });
                            } catch (e2) {
                                await channel.send({ content: `${payload.playerName} played ${payload.card.rankCode}${payload.card.suitCode}` });
                            }
                        }
                        return;
                    }

                    // Trick won payload: DON'T delete trick cards, just send winner announcement
                    // Both the trick cards AND winner message stay visible until next trick starts
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

                            // DON'T delete the trick cards - let them stay visible alongside winner message
                            
                            // Send new winner message at bottom and store its ID for later deletion
                            const sentMessage = await retryDiscordCall(() => channel.send({ embeds: [embed] }));
                            
                            // Store this winner message ID so it gets deleted when next trick starts
                            const game = activeGames.get(channel.id);
                            if (game) {
                                game.currentTrickWinnerMessageId = sentMessage.id;
                            }
                            logger.debug('✅ Sent trick winner message at bottom (both cards and winner visible until next trick)');
                        } catch (err) {
                            logger.error('❌ Failed to send trick_won payload:', err);
                            await retryDiscordCall(() => channel.send(`${payload.playerName} wins the trick with ${payload.card.rankCode}${payload.card.suitCode}`));
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

                    // Handle AI bid announcement (match human bid format)
                    if (payload.type === 'ai_bid') {
                        try {
                            const bidEmbed = new EmbedBuilder()
                                .setColor('#1E90FF')
                                .setDescription(`**${payload.playerName}** bids **${payload.bidDisplay}**!`);

                            await retryDiscordCall(() => channel.send({ embeds: [bidEmbed] }));
                        } catch (err) {
                            logger.error('❌ Failed to send AI bid announcement:', err);
                        }
                        return;
                    }

                    // Handle auto-play announcement
                    if (payload.type === 'auto_play') {
                        try {
                            const suitEmojis = { 'S': '♠️', 'H': '♥️', 'D': '♦️', 'C': '♣️' };
                            const cardDisplay = `${payload.card.rankCode === 'T' ? '10' : payload.card.rankCode}${suitEmojis[payload.card.suitCode]}`;
                            
                            const autoPlayEmbed = new EmbedBuilder()
                                .setColor('#FFA500')
                                .setTitle('⏰ Auto-Play')
                                .setDescription(`**${payload.playerName}** took too long. Mr. Easy played **${cardDisplay}** for them.`);
                            
                            await retryDiscordCall(() => channel.send({ embeds: [autoPlayEmbed] }));
                        } catch (err) {
                            logger.error('❌ Failed to send auto-play announcement:', err);
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

                    // Handle bidding update: create or update unified bidding embed
                    if (payload.type === 'bidding_update') {
                        try {
                            // Get the game instance to update biddingMessageId
                            const game = activeGames.get(channel.id);
                            if (!game) {
                                logger.error('❌ Game not found in activeGames for bidding update');
                                return;
                            }
                            
                            logger.error(`📊 Bidding update - current messageId: ${payload.messageId}, complete: ${payload.biddingComplete}`);
                            
                            const biddingEmbed = new EmbedBuilder()
                                .setColor('#1E90FF')
                                .setTitle(`🎯 Round ${payload.round} - Bidding Phase`);
                            
                            // Build field showing all player bids
                            let bidsDisplay = '';
                            payload.bids.forEach((bidInfo, index) => {
                                const playerDisplay = bidInfo.isAI ? `**${bidInfo.playerName}**` : `<@${bidInfo.playerId}>`;
                                const bidDisplay = bidInfo.bid === null ? '❓' : bidInfo.bid;
                                
                                bidsDisplay += `${playerDisplay}: **${bidDisplay}**\n`;
                            });
                            
                            biddingEmbed.addFields({
                                name: 'Bids',
                                value: bidsDisplay,
                                inline: false
                            });
                            
                            // Show either "waiting for..." or "BIDDING COMPLETE"
                            if (payload.biddingComplete) {
                                biddingEmbed.addFields({
                                    name: '🚨 BIDDING COMPLETE! 🚨',
                                    value: 'All bids are in! Starting trick play in **10 seconds**...\n\n_Last bidder: You have 10 seconds to undo if needed._',
                                    inline: false
                                });
                            } else {
                                // Add current bidder at the bottom
                                const currentBidderMention = payload.isCurrentBidderAI 
                                    ? `**${payload.currentBidderName}**` 
                                    : `<@${payload.currentBidderId}>`;
                                
                                // Check if AI is waiting to bid (gives previous player time to undo)
                                let waitingMessage;
                                if (payload.aiPendingBid) {
                                    waitingMessage = `${currentBidderMention} will bid in **10 seconds**...\n\n_Previous bidder: You have 10 seconds to undo if needed._`;
                                } else {
                                    waitingMessage = `${currentBidderMention}, it's your turn to bid!`;
                                }
                                    
                                biddingEmbed.addFields({
                                    name: '⏳ Waiting for...',
                                    value: waitingMessage,
                                    inline: false
                                });
                            }
                            
                            // Add undo button if someone can undo their bid
                            let components = [];
                            if (payload.canUndoPlayerId) {
                                const undoButton = new ButtonBuilder()
                                    .setCustomId(`undo_bid:${channel.id}:${payload.canUndoPlayerId}`)
                                    .setLabel('↩️ Undo My Bid')
                                    .setStyle(ButtonStyle.Secondary);
                                
                                components.push(new ActionRowBuilder().addComponents(undoButton));
                            }
                            
                            // If messageId exists, delete old message
                            if (payload.messageId) {
                                try {
                                    logger.error(`🗑️ Attempting to delete old bidding message: ${payload.messageId}`);
                                    const oldMessage = await channel.messages.fetch(payload.messageId);
                                    await oldMessage.delete();
                                    logger.error(`✅ Deleted old bidding message`);
                                    // Small delay to ensure deletion is processed
                                    await new Promise(resolve => setTimeout(resolve, 100));
                                } catch (fetchErr) {
                                    logger.debug('⚠️ Could not fetch/delete old bidding message:', fetchErr.message);
                                }
                            }
                            
                            // Send new bidding embed message
                            const newMsg = await retryDiscordCall(() => channel.send({ 
                                embeds: [biddingEmbed],
                                components: components
                            }));
                            game.biddingMessageId = newMsg.id;
                            logger.error(`✅ Sent new bidding message with ID: ${newMsg.id}`);
                        } catch (err) {
                            logger.error('❌ Failed to handle bidding_update:', err);
                        }
                        return;
                    }

                    // Handle bidding complete: send summary embed (with delay to show last bid first)
                    if (payload.type === 'bidding_complete') {
                        try {
                            // Wait 800ms to ensure the last bid embed is displayed first
                            await new Promise(resolve => setTimeout(resolve, 800));
                            
                            const playerMention = payload.isAI ? `**${payload.firstPlayerName}**` : `<@${payload.firstPlayerId}>`;
                            const biddingSummary = new EmbedBuilder()
                                .setColor('#FFD700')
                                .setTitle('🚨 BIDDING COMPLETE! 🚨')
                                .setDescription(`The first card is led by ${playerMention}!`)
                                .addFields({
                                    name: 'Scores & Bids',
                                    value: payload.teamScoreDisplay,
                                    inline: false
                                });

                            // Add action buttons
                            const actionRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`view_hand:${channel.id}`)
                                        .setLabel('🎴 View Hand')
                                        .setStyle(ButtonStyle.Primary),
                                    new ButtonBuilder()
                                        .setCustomId(`view_status:${channel.id}`)
                                        .setLabel('📊 Game Status')
                                        .setStyle(ButtonStyle.Secondary)
                                );

                            await retryDiscordCall(() => channel.send({
                                embeds: [biddingSummary],
                                content: `It is ${playerMention}'s turn to play the first card.`,
                                components: [actionRow]
                            }));
                        } catch (err) {
                            logger.error('❌ Failed to send bidding complete summary:', err);
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
                                .setTitle(`🎴 Round ${payload.round} - Dealing Cards...`)
                                .setDescription(`**Dealer:** ${dealerMention}\n**First to Bid:** ${bidderMention}\n\nEach player receives ${cardsPerPlayer} cards`);

                            // Render card backs using game host's theme preference
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

                            // Show which players are receiving cards
                            let playerList = '';
                            payload.players.forEach((player, index) => {
                                const playerDisplay = player.isAI ? `🤖 ${player.username}` : `👤 ${player.username}`;
                                playerList += `${index + 1}. ${playerDisplay}\n`;
                            });
                            dealingEmbed.addFields({ name: 'Players', value: playerList, inline: false });

                            // Add action buttons
                            const actionRow = new ActionRowBuilder()
                                .addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`view_hand:${channel.id}`)
                                        .setLabel('🎴 View Hand')
                                        .setStyle(ButtonStyle.Primary),
                                    new ButtonBuilder()
                                        .setCustomId(`view_status:${channel.id}`)
                                        .setLabel('📊 Game Status')
                                        .setStyle(ButtonStyle.Secondary)
                                );

                            await retryDiscordCall(() => channel.send({ 
                                embeds: [dealingEmbed], 
                                files: [attachment],
                                components: [actionRow]
                            }));
                            
                            // Small delay to let the dealing animation be seen
                            await new Promise(resolve => setTimeout(resolve, 1500));
                        } catch (err) {
                            logger.error('❌ Failed to send dealing cards animation:', err);
                        }
                        return;
                    }

                    // Handle round end: build embed for tidy display
                    if (payload.type === 'round_end') {
                        try {
                            const finalRoundMessage = new EmbedBuilder()
                                .setColor('#4CAF50')
                                .setTitle(`🏆 Round ${payload.round} Ended! 🏆`)
                                .setDescription(payload.roundSummary)
                                .addFields(
                                    { name: '\u200B', value: '\u200B', inline: false },
                                    { name: '📈 Overall Scores & Bags', value: payload.teamScoreDisplay || '', inline: false }
                                );

                            await channel.send({ embeds: [finalRoundMessage] });
                        } catch (err) {
                            logger.error('❌ Failed to send round-end embed:', err);
                            await channel.send(`--- ROUND ${payload.round} ENDED ---\n${payload.roundSummary}`);
                        }
                        return;
                    }

                    // Handle game over: clean up activeGames and save player stats
                    if (payload.type === 'game_over') {
                        try {
                            logger.error(`🏁 Game over in channel ${payload.channelId} - cleaning up...`);
                            
                            // Save player statistics
                            if (payload.gameStats && Array.isArray(payload.gameStats)) {
                                logger.error(`📊 Saving stats for ${payload.gameStats.length} players in ${payload.gameMode} mode...`);
                                for (const playerData of payload.gameStats) {
                                    try {
                                        await playerStats.updateStats(
                                            playerData.discordId,
                                            playerData.username,
                                            {
                                                gameMode: payload.gameMode, // Pass game mode for separate tracking
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
                                        logger.error(`✅ Saved stats for ${playerData.username}`);
                                    } catch (statErr) {
                                        logger.error(`❌ Failed to save stats for ${playerData.username}:`, statErr);
                                    }
                                }
                            }
                            
                            activeGames.delete(payload.channelId);
                            await channel.send(`🎉 **GAME OVER!** 🎉\n**Winner:** ${payload.message}`);
                        } catch (err) {
                            logger.error('❌ Failed to handle game over:', err);
                        }
                        return;
                    }

                    // Handle simple message announcements
                    if (payload.type === 'message' && payload.message) {
                        await retryDiscordCall(() => channel.send(payload.message));
                        return;
                    }

                    // Generic object fallback to channel.send
                    await channel.send(payload);
                } catch (err) {
                    logger.error('❌ publicAnnounce handler error:', err);
                }
            };

            const privatePrompt = async (playerId, message) => {
                try {
                    const user = await interaction.client.users.fetch(playerId);
                    await user.send(message);
                } catch (err) {
                    logger.error(`❌ Failed to DM player ${playerId}:`, err);
                }
            };

            // Create game mode selection menu
            const gameModeSelect = new StringSelectMenuBuilder()
                .setCustomId(`game_mode_select:${thread.id}`)
                .setPlaceholder('Select game mode')
                .addOptions([
                    { 
                        label: 'Classic (4 Players, Teams)', 
                        description: '2v2 team play - traditional Spades',
                        value: 'classic',
                        emoji: '♠️'
                    },
                    { 
                        label: '⭐ 3-Player Cutthroat', 
                        description: 'Premium - Every player for themselves',
                        value: 'cutthroat3',
                        emoji: '⚔️'
                    },
                    { 
                        label: '⭐ 4-Player Cutthroat', 
                        description: 'Premium - Every player for themselves',
                        value: 'cutthroat4',
                        emoji: '🎯'
                    }
                ]);

            const gameModeRow = new ActionRowBuilder().addComponents(gameModeSelect);

            const selectionEmbed = new EmbedBuilder()
                .setColor('#FFD700')
                .setTitle('♠️ Create New Spades Game ♠️')
                .setDescription('Choose your game mode to begin!')
                .addFields(
                    { 
                        name: '♠️ Classic (4 Players, Teams)', 
                        value: '2v2 team play - traditional Spades rules\n• 4 players required\n• Partners sit opposite\n• Team scoring', 
                        inline: false 
                    },
                    { 
                        name: '⭐ 3-Player Cutthroat (Premium)', 
                        value: 'Every player for themselves!\n• 3 players required\n• 51 cards (2♣ removed)\n• Individual scoring', 
                        inline: false 
                    },
                    { 
                        name: '⭐ 4-Player Cutthroat (Premium)', 
                        value: 'Every player for themselves!\n• 4 players required\n• Full 52-card deck\n• Individual scoring', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Select a mode from the dropdown below' });

            await thread.send({ 
                embeds: [selectionEmbed], 
                components: [gameModeRow]
            });
            
            } catch (error) {
                logger.error('❌ Error creating game thread:', error);
                if (!interaction.replied) {
                    return interaction.reply({ 
                        content: '❌ Failed to create game thread. Please try again.',
                        ephemeral: true 
                    });
                }
            }

            return;
        }

        // ----------------------------------------------------
        // /spades hand
        // ----------------------------------------------------
        if (subcommand === 'hand') {
            try {
                const game = activeGames.get(interaction.channelId);

                if (!game) {
                    return interaction.reply({
                        content: '❌ No active Spades game found in this channel.',
                        ephemeral: true
                    });
                }

                const requestedPlayerRaw = interaction.options.getString('player');
                const isSpectator = game.isSpectator(interaction.user.id);
                let player;

                if (requestedPlayerRaw && isSpectator) {
                    // Parse mention or username
                    const cleaned = requestedPlayerRaw.trim();
                    let targetId = null;
                    const mentionMatch = cleaned.match(/^<@!?([0-9]+)>$/);
                    if (mentionMatch) {
                        targetId = mentionMatch[1];
                    }
                    if (targetId) {
                        player = game.players.find(p => p.discordId === targetId);
                    } else {
                        // Try exact username match (case-insensitive)
                        player = game.players.find(p => p.username.toLowerCase() === cleaned.toLowerCase());
                    }
                    if (!player) {
                        return interaction.reply({
                            content: '❌ Could not find that player. Use exact username or @mention.',
                            ephemeral: true
                        });
                    }
                } else {
                    // Regular player viewing own hand
                    player = game.players.find(p => p.discordId === interaction.user.id);
                    if (!player) {
                        if (isSpectator) {
                            return interaction.reply({
                                content: '❌ As a spectator you must provide a player with the `player` option.',
                                ephemeral: true
                            });
                        }
                        return interaction.reply({
                            content: '❌ You are not a player in this game.',
                            ephemeral: true
                        });
                    }
                }

                // Debug logging
                logger.debug('🎴 Rendering hand for player:', player.username);
                logger.debug('🎴 Player has', player.hand.length, 'cards');

                let components = [];
                let messageContent = `🃏 **Your Spades Hand**`;
                let handAttachment = null;

                // BIDDING phase: Handle Blind Nil restriction
                if (game.state === 'BIDDING') {
                    const hasNotBidYet = player.bid === null || player.bid === undefined;
                    const blindNilEligible = player.blindNilEligible || false;
                    
                    logger.error(`🎯 View Hand - Player: ${player.username}, Team: ${player.team}, Bid: ${player.bid}, BlindNilEligible: ${blindNilEligible}`);
                    
                    if (hasNotBidYet) {
                        // Check if player declined Blind Nil (stored temporarily)
                        const hasDeclinedBlindNil = player.declinedBlindNil || false;
                        
                        logger.error(`🎯 Has not bid yet - DeclinedBlindNil: ${hasDeclinedBlindNil}`);
                        
                        // If Blind Nil eligible and hasn't declined yet, show Yes/No choice with card backs
                        if (blindNilEligible && !hasDeclinedBlindNil) {
                            logger.error(`🎯 Showing Blind Nil option to ${player.username}`);
                            messageContent = `🎯 **Blind Nil Available**\n\n`;
                            messageContent += `Your team is **200+ points behind**. You are eligible to bid **Blind Nil** (±200 points).\n\n`;
                            messageContent += `⚠️ **If you bid Blind Nil, you cannot view your cards first.**\n\n`;
                            messageContent += `**Do you want to bid Blind Nil?**`;
                            
                            // Show card backs instead of hiding cards completely
                            try {
                                // Use host's theme for uniform look
                                let cardBackTheme = 'blue';
                                if (game && game.hostId) {
                                    const host = game.players.find(p => p.discordId === game.hostId);
                                    if (host && host.preferences && host.preferences.cardBackTheme) {
                                        cardBackTheme = host.preferences.cardBackTheme;
                                    }
                                }
                                logger.error(`🎴 [/hand] Using host's cardBackTheme: ${cardBackTheme}`);
                                const cardBacksBuffer = renderCardBacks(player.hand.length, cardBackTheme);
                                handAttachment = new AttachmentBuilder(cardBacksBuffer, { name: 'hand_back.png' });
                                logger.debug('✅ Card backs generated for Blind Nil decision');
                            } catch (err) {
                                logger.error('❌ Error generating card backs:', err);
                            }
                            
                            // Yes/No buttons for Blind Nil decision
                            components = [
                                new ActionRowBuilder().addComponents(
                                    new ButtonBuilder()
                                        .setCustomId(`blindnil_yes:${interaction.channelId}`)
                                        .setLabel('Yes - Bid Blind Nil')
                                        .setStyle(ButtonStyle.Danger),
                                    new ButtonBuilder()
                                        .setCustomId(`blindnil_no:${interaction.channelId}`)
                                        .setLabel('No - See Cards & Bid Normally')
                                        .setStyle(ButtonStyle.Primary)
                                )
                            ];
                        } else {
                            // Normal bidding - show cards
                            try {
                                const handImageBuffer = renderHand(player.hand, false, game.options.deckTheme);
                                handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                                logger.debug('✅ Hand image generated successfully');
                            } catch (err) {
                                logger.error('❌ Error generating hand image:', err);
                            }
                            components = createBiddingComponents(interaction.channelId, false);
                            messageContent += `\n\n**Select your bid using the buttons below:**`;
                        }
                    } else {
                        // Already bid - always show cards now
                        try {
                            const handImageBuffer = renderHand(player.hand, false, game.options.deckTheme);
                            handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                            logger.debug('✅ Hand image generated successfully');
                        } catch (err) {
                            logger.error('❌ Error generating hand image:', err);
                        }
                        const bidDisplay = player.isBlindNil ? 'Blind Nil' : player.isNil ? 'Nil' : player.bid;
                        messageContent += `\n\n✅ You have already bid **${bidDisplay}**. Waiting for other players.`;
                    }
                }
                // PLAYING phase: Always show cards during play
                else if (game.state === 'PLAYING') {
                    // Generate hand image
                    try {
                        const handImageBuffer = renderHand(player.hand, false, game.options.deckTheme);
                        handAttachment = new AttachmentBuilder(handImageBuffer, { name: 'hand.png' });
                        logger.debug('✅ Hand image generated successfully');
                    } catch (err) {
                        logger.error('❌ Error generating hand image:', err);
                    }
                    
                    const isPlayersTurn = player.id === game.players[game.currentPlayerIndex].id;
                    
                    if (isPlayersTurn && player.hand.length > 0) {
                        components = createCardPlayComponents(interaction.channelId, player.hand, game, player);
                        messageContent += `\n\n**It's your turn! Click a card to play:**\n🟢 = Legal play | ⚪ = Illegal play`;
                    } else if (!isPlayersTurn) {
                        const currentPlayer = game.players[game.currentPlayerIndex];
                        messageContent += `\n\n⏳ Waiting for **${currentPlayer.username}** to play.`;
                    }
                }

                const replyOptions = {
                    content: messageContent,
                    components: components,
                    ephemeral: true
                };

                if (handAttachment) {
                    replyOptions.files = [handAttachment];
                }

                await interaction.reply(replyOptions);
            } catch (error) {
                logger.error('❌ Error in /spades hand command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    try {
                        await interaction.reply({
                            content: '❌ An error occurred while retrieving your hand. Please try again.',
                            ephemeral: true
                        });
                    } catch (e) {
                        logger.error('❌ Could not send error message:', e);
                    }
                }
            }

            return;
        }

        // ----------------------------------------------------
        // 3. /spades status
        // ----------------------------------------------------
        if (subcommand === 'status') {
            try {
                if (!game) {
                    return interaction.reply({
                        content: '❌ No active Spades game found in this channel.',
                        ephemeral: true
                    });
                }

                // Handle Lobby State
                if (game.state === 'LOBBY') {
                    const playerList = game.players.map(p => `\`${p.username}\``).join('\n');
                    const spectators = game.getSpectators();
                    const spectatorDisplay = spectators.length ? spectators.map(s => `• ${s.username}`).join('\n') : 'None';
                    const lobbyEmbed = new EmbedBuilder()
                        .setColor('#FF9900')
                        .setTitle('Spades Lobby Status')
                        .setDescription(`Waiting for **${4 - game.getLobbySize()}** more players to join.`)
                        .addFields(
                            { name: `Current Players (${game.getLobbySize()}/4)`, value: playerList || 'None yet.' },
                            { name: 'Spectators', value: spectatorDisplay, inline: false }
                        );
                        
                    return interaction.reply({ embeds: [lobbyEmbed], ephemeral: true });
                }
                
                // Check if cutthroat mode
                if (game.isCutthroat()) {
                    // Cutthroat: individual player status
                    const playerDetails = game.players.map(p => {
                        const bidDisplay = p.bid === null ? '?' : p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid;
                        return `**${p.username}**\nBid: \`${bidDisplay}\` | Tricks: \`${p.tricks}\` | Score: \`${p.score}\` | Bags: \`${p.bags}\``;
                    }).join('\n\n');

                    const cardsInTrickDisplay = game.trick.length > 0 
                        ? game.trick.map(t => getCardEmojiDisplay(t.card)).join(' ') 
                        : 'None';
                        
                    const currentTurnText = game.state === 'BIDDING'
                        ? `Bidding: **${game.players[game.currentPlayerIndex].username}**`
                        : game.state === 'PLAYING'
                            ? `Playing: **${game.players[game.currentPlayerIndex].username}**`
                            : 'Game Over';

                    const spectators = game.getSpectators();
                    const spectatorDisplay = spectators.length
                        ? spectators.map(s => `• ${s.username}`).join('\n')
                        : 'None';

                    const gameStatusEmbed = new EmbedBuilder()
                        .setColor('#9B59B6')
                        .setTitle(`${game.gameMode === 'cutthroat3' ? '3-Player' : '4-Player'} Cutthroat Status (Hand ${game.currentRound})`)
                        .setDescription(`**Game State:** ${game.state}\n**Dealer:** ${game.players[game.dealerIndex].username}`)
                        .addFields(
                            { name: '👥 Players', value: playerDetails, inline: false },
                            { name: 'Current Turn', value: currentTurnText, inline: true },
                            { name: 'Cards in Trick', value: cardsInTrickDisplay, inline: true },
                            { name: 'Spectators', value: spectatorDisplay, inline: false }
                        );
                    
                    return interaction.reply({ embeds: [gameStatusEmbed], ephemeral: true });
                }
                
                // Classic mode: Organize players by team
                const team1Players = game.players.filter(p => p.team === 1);
                const team2Players = game.players.filter(p => p.team === 2);

                // Team 1 Summary
                const team1Bid = team1Players.reduce((sum, p) => sum + (p.bid || 0), 0);
                const team1Score = team1Players[0].score;
                const team1Bags = team1Players[0].bags;
                
                const team1Summary = `**Bid:** ${team1Bid} | **Score:** ${team1Score} | **Bags:** ${team1Bags}`;
                const team1Details = team1Players.map(p => {
                    const bidDisplay = p.bid === null ? '?' : p.isNil ? 'Nil' : p.bid;
                    return `${p.username}: Bid \`${bidDisplay}\` | Tricks \`${p.tricks}\``;
                }).join('\n');

                // Team 2 Summary
                const team2Bid = team2Players.reduce((sum, p) => sum + (p.bid || 0), 0);
                const team2Score = team2Players[0].score;
                const team2Bags = team2Players[0].bags;
                
                const team2Summary = `**Bid:** ${team2Bid} | **Score:** ${team2Score} | **Bags:** ${team2Bags}`;
                const team2Details = team2Players.map(p => {
                    const bidDisplay = p.bid === null ? '?' : p.isNil ? 'Nil' : p.bid;
                    return `${p.username}: Bid \`${bidDisplay}\` | Tricks \`${p.tricks}\``;
                }).join('\n');
                
                const cardsInTrickDisplay = game.trick.length > 0 
                    ? game.trick.map(t => getCardEmojiDisplay(t.card)).join(' ') 
                    : 'None';
                    
                const currentTurnText = game.state === 'BIDDING'
                    ? `Bidding: **${game.players[game.currentPlayerIndex].username}**`
                    : game.state === 'PLAYING'
                        ? `Playing: **${game.players[game.currentPlayerIndex].username}**`
                        : 'Game Over';

                const spectators = game.getSpectators();
                const spectatorDisplay = spectators.length
                    ? spectators.map(s => `• ${s.username}`).join('\n')
                    : 'None';

                const gameStatusEmbed = new EmbedBuilder()
                    .setColor('#1080A0')
                    .setTitle(`Spades Game Status (Hand ${game.currentRound})`)
                    .setDescription(`**Game State:** ${game.state}\n**Dealer:** ${game.players[game.dealerIndex].username}`)
                    .addFields(
                        { name: '🟦 Team 1', value: team1Summary, inline: false },
                        { name: 'Players', value: team1Details, inline: false },
                        { name: '\u200B', value: '\u200B', inline: false }, // Spacer
                        { name: '🟥 Team 2', value: team2Summary, inline: false },
                        { name: 'Players', value: team2Details, inline: false },
                        { name: '\u200B', value: '\u200B', inline: false }, // Spacer
                        { name: 'Current Turn', value: currentTurnText, inline: true },
                        { name: 'Cards in Trick', value: cardsInTrickDisplay, inline: true },
                        { name: 'Spectators', value: spectatorDisplay, inline: false }
                    );
                
                return interaction.reply({ embeds: [gameStatusEmbed], ephemeral: true });
            } catch (error) {
                logger.error('❌ Error in /spades status command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    try {
                        await interaction.reply({
                            content: '❌ An error occurred while retrieving game status.',
                            ephemeral: true
                        });
                    } catch (e) {
                        logger.error('❌ Could not send error message:', e);
                    }
                }
            }

            return;
        }

        // ----------------------------------------------------
        // 4. /spades sub
        // ----------------------------------------------------
        if (subcommand === 'sub') {
            try {
                if (!game) {
                    return interaction.reply({
                        content: '❌ No active Spades game found in this channel.',
                        ephemeral: true
                    });
                }

                if (game.state === 'LOBBY') {
                    return interaction.reply({
                        content: '❌ Cannot substitute players during lobby. The game must be in progress.',
                        ephemeral: true
                    });
                }

                const playerOutInput = interaction.options.getString('player_out').trim();
                const playerInInput = interaction.options.getString('player_in').trim();

                // Find player to remove
                let playerOut = null;
                
                // Check if input is a mention
                const mentionMatch = playerOutInput.match(/<@!?(\d+)>/);
                if (mentionMatch) {
                    const userId = mentionMatch[1];
                    playerOut = game.players.find(p => p.discordId === userId);
                } else {
                    // Search by username
                    playerOut = game.players.find(p => 
                        p.username.toLowerCase() === playerOutInput.toLowerCase()
                    );
                }

                if (!playerOut) {
                    return interaction.reply({
                        content: `❌ Player "${playerOutInput}" not found in this game.`,
                        ephemeral: true
                    });
                }

                const playerOutIndex = game.players.findIndex(p => p.id === playerOut.id);

                // Determine player to add
                let playerIn = null;
                let isAI = false;

                // Pool of AI names (must match GameManager.js)
                const aiNames = [
                    'Dale', 'Tucker', 'Allison', 'Chad', 'JohnDoe',
                    'Quiet', 'Stu', 'Raven', 'Dollface', 'Zack',
                    'Mr. Easy', 'SweetTooth', 'Beavis', 'Butthead', 'MilkMan',
                    'Katniss', 'Smurf', 'JokerJoe', 'QueenOfHearts', 'KingKong',
                    'SplendaDaddy', 'Gracin', 'BidBot', 'TrickTina', 'SpadeSally'
                ];

                // Check if input is "ai" or an AI name from the pool
                const isAIRequest = playerInInput.toLowerCase() === 'ai';
                const matchedAIName = aiNames.find(name => name.toLowerCase() === playerInInput.toLowerCase());

                if (isAIRequest || matchedAIName) {
                    // Create AI player
                    isAI = true;
                    const { AIPlayer } = await import('./game_logic/AIPlayer.js');
                    const aiDifficulty = 'medium'; // Default difficulty
                    
                    // Use the matched name, or generate a default name
                    let aiName;
                    if (matchedAIName) {
                        // Check if this name is already in use
                        const nameInUse = game.players.some(p => p.username.toLowerCase() === matchedAIName.toLowerCase());
                        if (nameInUse) {
                            return interaction.reply({
                                content: `❌ AI name "${matchedAIName}" is already in use in this game. Choose a different name or use \`ai\` for a random name.`,
                                ephemeral: true
                            });
                        }
                        aiName = matchedAIName;
                    } else {
                        // Pick a random available name
                        const usedNames = game.players.filter(p => p.isAI).map(p => p.username.toLowerCase());
                        const availableNames = aiNames.filter(n => !usedNames.includes(n.toLowerCase()));
                        aiName = availableNames.length > 0 
                            ? availableNames[Math.floor(Math.random() * availableNames.length)]
                            : `AI Bot (${playerOut.team === 1 ? 'Team 1' : 'Team 2'})`;
                    }
                    
                    playerIn = new AIPlayer(
                        `ai_sub_${Date.now()}`,
                        aiName,
                        playerOut.team,
                        aiDifficulty
                    );
                } else {
                    // Add human player
                    const mentionMatchIn = playerInInput.match(/<@!?(\d+)>/);
                    let userId = null;
                    let username = null;

                    if (mentionMatchIn) {
                        userId = mentionMatchIn[1];
                        try {
                            const user = await client.users.fetch(userId);
                            username = user.username;
                        } catch (err) {
                            return interaction.reply({
                                content: `❌ Could not fetch user ${playerInInput}.`,
                                ephemeral: true
                            });
                        }
                    } else if (playerInInput.toLowerCase() === 'me') {
                        // Allow "me" to substitute yourself in
                        userId = interaction.user.id;
                        username = interaction.user.username;
                    } else {
                        // Username provided - need to find their Discord ID
                        return interaction.reply({
                            content: `❌ For human players, please use @mention or "me" instead of username. Example: \`/spades sub player_out:MilkMan player_in:@YourName\` or \`player_in:me\`\n\nFor AI substitution, use an AI name: \`player_in:Zack\` or \`player_in:ai\` for random.`,
                            ephemeral: true
                        });
                    }

                    const { Player } = await import('./game_logic/Player.js');
                    const userPrefs = await getUserPreferences(userId);
                    playerIn = new Player(userId, username, userPrefs);
                    playerIn.team = playerOut.team; // Set team explicitly
                    playerIn.isAI = false; // Explicitly set for human players
                }

                // Copy game state from old player to new player
                playerIn.hand = [...playerOut.hand];
                // Always preserve seat/team ownership for substitutions (critical for classic scoring)
                playerIn.team = playerOut.team;
                playerIn.bid = playerOut.bid;
                playerIn.tricks = playerOut.tricks;
                playerIn.score = playerOut.score;
                playerIn.bags = playerOut.bags;
                playerIn.isNil = playerOut.isNil;
                playerIn.isBlindNil = playerOut.isBlindNil;
                playerIn.declinedBlindNil = playerOut.declinedBlindNil;

                // Replace in players array
                game.players[playerOutIndex] = playerIn;

                // Update trick if player is currently in it
                game.trick = game.trick.map(play => {
                    if (play.player.id === playerOut.id) {
                        return { ...play, player: playerIn };
                    }
                    return play;
                });

                const channel = interaction.channel;
                const subMessage = isAI 
                    ? `🔄 **${playerOut.username}** has been substituted with **${playerIn.username}** (AI).`
                    : `🔄 **${playerOut.username}** has been substituted with **${playerIn.username}**.`;

                await retryDiscordCall(() => channel.send(subMessage));

                // If it's currently this player's turn and game is in BIDDING, trigger their action
                const currentPlayer = game.players[game.currentPlayerIndex];
                if (currentPlayer.id === playerIn.id) {
                    if (game.state === 'BIDDING' && playerIn.isAI) {
                        // Trigger AI bid
                        logger.error(`🤖 Substituted AI player ${playerIn.username} is current bidder, triggering bid`);
                        setTimeout(() => {
                            game.processAIBid(playerIn);
                        }, 2000);
                    } else if (game.state === 'BIDDING' && !playerIn.isAI) {
                        // Notify human player it's their turn
                        const mention = `<@${playerIn.discordId}>`;
                        await retryDiscordCall(() => channel.send(
                            `${mention}, it's your turn to bid! Use \`/spades hand\` to view your cards and place your bid.`
                        ));
                    } else if (game.state === 'PLAYING' && playerIn.isAI) {
                        // Trigger AI play
                        logger.error(`🤖 Substituted AI player ${playerIn.username} is current player, triggering play`);
                        setTimeout(() => {
                            game.scheduleAILead(2000);
                        }, 2000);
                    } else if (game.state === 'PLAYING' && !playerIn.isAI) {
                        // Notify human player it's their turn
                        const mention = `<@${playerIn.discordId}>`;
                        await retryDiscordCall(() => channel.send(
                            `${mention}, it's your turn to play! Use \`/spades hand\` to view your cards and play.`
                        ));
                    }
                }

                return interaction.reply({
                    content: `✅ Substitution complete! ${playerOut.username} → ${playerIn.username}`,
                    ephemeral: true
                });

            } catch (error) {
                logger.error('❌ Error in /spades sub command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while substituting players.',
                        ephemeral: true
                    });
                }
            }

            return;
        }

        // ----------------------------------------------------
        // /spades stats
        // ----------------------------------------------------
        if (subcommand === 'stats') {
            try {
                // Get the target player (defaults to the user running the command)
                const targetUser = interaction.options.getUser('player') || interaction.user;
                const targetId = targetUser.id;

                // Get calculated stats for all modes
                const stats = playerStats.getCalculatedStats(targetId);

                if (!stats) {
                    return interaction.reply({
                        content: `📊 **${targetUser.username}** has not played any games yet.`,
                        ephemeral: true
                    });
                }

                const { classic, cutthroat3, cutthroat4 } = stats;
                const hasClassic = classic.gamesPlayed > 0;
                const hasCutthroat3 = cutthroat3.gamesPlayed > 0;
                const hasCutthroat4 = cutthroat4.gamesPlayed > 0;

                if (!hasClassic && !hasCutthroat3 && !hasCutthroat4) {
                    return interaction.reply({
                        content: `📊 **${targetUser.username}** has not played any games yet.`,
                        ephemeral: true
                    });
                }

                // Build stats embed
                const statsEmbed = new EmbedBuilder()
                    .setColor('#4169E1')
                    .setTitle(`📊 Spades Statistics - ${stats.username}`)
                    .setTimestamp();

                // Add Classic Mode stats if player has played classic
                if (hasClassic) {
                    statsEmbed.addFields(
                        { name: '🎴 **Classic Mode (4-Player Teams)**', value: `Games Played: **${classic.gamesPlayed}**`, inline: false },
                        { name: '🏆 Win Rate', value: `${classic.winRate}%`, inline: true },
                        { name: '📈 Avg Score/Game', value: `${classic.avgScorePerGame}`, inline: true },
                        { name: '🏅 Highest Score', value: `${classic.highestScore}`, inline: true },
                        { name: '🎴 Hands Played', value: `${classic.handsPlayed}`, inline: true },
                        { name: '🃏 Tricks Won', value: `${classic.totalTricksWon}`, inline: true },
                        { name: '📦 Avg Bags/Game', value: `${classic.avgBagsPerGame}`, inline: true },
                        { name: '🎯 Nil Attempts', value: `${classic.nilAttempts}`, inline: true },
                        { name: '✅ Nil Success', value: `${classic.nilSuccessRate}%`, inline: true },
                        { name: '🎯 Blind Nil', value: `${classic.blindNilAttempts}`, inline: true },
                        { name: '✅ Blind Success', value: `${classic.blindNilSuccessRate}%`, inline: true },
                        { name: '\u200B', value: '\u200B', inline: false } // Spacer
                    );
                }

                // Add 3-Player Cutthroat stats if player has played
                if (hasCutthroat3) {
                    statsEmbed.addFields(
                        { name: '⚔️ **3-Player Cutthroat (Solo)**', value: `Games Played: **${cutthroat3.gamesPlayed}**`, inline: false },
                        { name: '🏆 Win Rate', value: `${cutthroat3.winRate}%`, inline: true },
                        { name: '📈 Avg Score/Game', value: `${cutthroat3.avgScorePerGame}`, inline: true },
                        { name: '🏅 Highest Score', value: `${cutthroat3.highestScore}`, inline: true },
                        { name: '🎴 Hands Played', value: `${cutthroat3.handsPlayed}`, inline: true },
                        { name: '🃏 Tricks Won', value: `${cutthroat3.totalTricksWon}`, inline: true },
                        { name: '📦 Avg Bags/Game', value: `${cutthroat3.avgBagsPerGame}`, inline: true },
                        { name: '🎯 Nil Attempts', value: `${cutthroat3.nilAttempts}`, inline: true },
                        { name: '✅ Nil Success', value: `${cutthroat3.nilSuccessRate}%`, inline: true },
                        { name: '🎯 Blind Nil', value: `${cutthroat3.blindNilAttempts}`, inline: true },
                        { name: '✅ Blind Success', value: `${cutthroat3.blindNilSuccessRate}%`, inline: true },
                        { name: '\u200B', value: '\u200B', inline: false } // Spacer
                    );
                }

                // Add 4-Player Cutthroat stats if player has played
                if (hasCutthroat4) {
                    statsEmbed.addFields(
                        { name: '🎯 **4-Player Cutthroat (Solo)**', value: `Games Played: **${cutthroat4.gamesPlayed}**`, inline: false },
                        { name: '🏆 Win Rate', value: `${cutthroat4.winRate}%`, inline: true },
                        { name: '📈 Avg Score/Game', value: `${cutthroat4.avgScorePerGame}`, inline: true },
                        { name: '🏅 Highest Score', value: `${cutthroat4.highestScore}`, inline: true },
                        { name: '🎴 Hands Played', value: `${cutthroat4.handsPlayed}`, inline: true },
                        { name: '🃏 Tricks Won', value: `${cutthroat4.totalTricksWon}`, inline: true },
                        { name: '📦 Avg Bags/Game', value: `${cutthroat4.avgBagsPerGame}`, inline: true },
                        { name: '🎯 Nil Attempts', value: `${cutthroat4.nilAttempts}`, inline: true },
                        { name: '✅ Nil Success', value: `${cutthroat4.nilSuccessRate}%`, inline: true },
                        { name: '🎯 Blind Nil', value: `${cutthroat4.blindNilAttempts}`, inline: true },
                        { name: '✅ Blind Success', value: `${cutthroat4.blindNilSuccessRate}%`, inline: true },
                        { name: '\u200B', value: '\u200B', inline: false } // Spacer
                    );
                }

                if (stats.lastPlayed) {
                    statsEmbed.setFooter({ text: `Last played: ${new Date(stats.lastPlayed).toLocaleDateString()}` });
                }

                return interaction.reply({
                    embeds: [statsEmbed],
                    ephemeral: true
                });

            } catch (error) {
                logger.error('❌ Error in /spades stats command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while retrieving statistics.',
                        ephemeral: true
                    });
                }
            }

            return;
        }

        // ----------------------------------------------------
        // /spades leaderboard
        // ----------------------------------------------------
        if (subcommand === 'leaderboard') {
            try {
                const limit = interaction.options.getInteger('limit') || 10;
                const mode = interaction.options.getString('mode') || 'combined';
                
                // Get leaderboard data - pass mode only if not combined
                const gameMode = mode === 'combined' ? null : mode;
                const leaderboard = playerStats.getLeaderboard(limit, gameMode);
                
                if (leaderboard.length === 0) {
                    return interaction.reply({
                        content: '📊 No games have been played yet. Be the first to play!',
                        ephemeral: true
                    });
                }
                
                // Build leaderboard title based on mode
                const modeTitle = mode === 'combined' ? 'All Modes' 
                                : mode === 'classic' ? 'Classic (4P Teams)' 
                                : 'Cutthroat (Solo)';
                
                // Build leaderboard embed
                const leaderboardEmbed = new EmbedBuilder()
                    .setColor('#FFD700')
                    .setTitle(`🏆 Spades Leaderboard - ${modeTitle}`)
                    .setDescription(`Showing top ${leaderboard.length} player${leaderboard.length !== 1 ? 's' : ''} by wins`)
                    .setTimestamp();
                
                // Build leaderboard entries
                let leaderboardText = '';
                leaderboard.forEach((player, index) => {
                    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
                    leaderboardText += `${medal} **${player.username}**\n`;
                    leaderboardText += `   Wins: ${player.gamesWon} / ${player.gamesPlayed} (${player.winRate}%)\n\n`;
                });
                
                leaderboardEmbed.addFields({
                    name: 'Rankings',
                    value: leaderboardText,
                    inline: false
                });
                
                return interaction.reply({
                    embeds: [leaderboardEmbed],
                    ephemeral: false // Public leaderboard
                });
                
            } catch (error) {
                logger.error('❌ Error in /spades leaderboard command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while retrieving the leaderboard.',
                        ephemeral: true
                    });
                }
            }
            
            return;
        }

        // ----------------------------------------------------
        // /spades settings
        // ----------------------------------------------------
        if (subcommand === 'settings') {
            try {
                const game = activeGames.get(interaction.channelId);

                if (!game) {
                    return interaction.reply({
                        content: '❌ No active Spades game found in this channel.',
                        ephemeral: true
                    });
                }

                // Check if user is the host
                if (game.hostId !== interaction.user.id) {
                    return interaction.reply({ 
                        content: '🚫 Only the game host can change settings!', 
                        ephemeral: true 
                    });
                }

                // Create settings embed with current values
                const settingsEmbed = new EmbedBuilder()
                    .setColor('#FFA500')
                    .setTitle('⚙️ Game Settings (Host Only)')
                    .setDescription('Game-wide settings that affect gameplay timing.\n\n_Display preferences (suggestions, hand strength, etc.) are personal!_\nPlayers can use `/spades preferences` to customize their view.')
                    .addFields(
                        { 
                            name: '⏱️ Auto-Play Timer', 
                            value: game.options.autoPlayTimer > 0 ? `✅ ${game.options.autoPlayTimer}s` : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎴 Auto-Play Last Trick', 
                            value: game.options.autoPlayLastTrick ? '✅ Enabled' : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎯 Target Score', 
                            value: `${game.options.targetScore} points`, 
                            inline: true 
                        },
                        { 
                            name: '💬 AI Trash Talk', 
                            value: game.options.trashTalk.enabled ? `✅ ${game.options.trashTalk.frequency.toUpperCase()}` : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎨 Deck Theme', 
                            value: `${game.options.deckTheme.charAt(0).toUpperCase() + game.options.deckTheme.slice(1)}`, 
                            inline: true 
                        }
                    );

                const gameChannelId = interaction.channelId;
                const settingsComponents = createSettingsComponents(gameChannelId, game);

                await interaction.reply({
                    embeds: [settingsEmbed],
                    components: settingsComponents,
                    ephemeral: true
                });

            } catch (error) {
                logger.error('❌ Error in /spades settings command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while opening settings.',
                        ephemeral: true
                    });
                }
            }
            
            return;
        }

        // ----------------------------------------------------
        // Handle /spades preferences command
        // ----------------------------------------------------
        if (subcommand === 'preferences') {
            try {
                // Get user's current preferences
                const userPrefs = await getUserPreferences(interaction.user.id);

                // Get theme display name
                const themeNames = {
                    'blue': '🔵 Blue',
                    'red': '🔴 Red',
                    'green': '🟢 Green',
                    'purple': '🟣 Purple',
                    'classic': '⚫ Classic',
                    'christmas': '🎄 Christmas'
                };
                const currentTheme = userPrefs.cardBackTheme || 'blue';

                // Create preferences embed
                const preferencesEmbed = new EmbedBuilder()
                    .setColor('#9B59B6')
                    .setTitle('⚙️ Your Personal Preferences')
                    .setDescription('These settings only affect what YOU see. Other players have their own preferences.')
                    .addFields(
                        { 
                            name: '🦅 Bidding Suggestions', 
                            value: userPrefs.biddingSuggestions ? '✅ Enabled' : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '💪 Hand Strength Indicator', 
                            value: userPrefs.handStrengthIndicator ? '✅ Enabled' : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎨 Color Blind Mode', 
                            value: userPrefs.colorBlindMode ? '✅ Enabled' : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎯 Recommended Card Play', 
                            value: userPrefs.recommendedCardPlay ? '✅ Enabled' : '❌ Disabled', 
                            inline: true 
                        },
                        { 
                            name: '🎴 Card Back Theme', 
                            value: themeNames[currentTheme], 
                            inline: true 
                        }
                    );

                const userId = interaction.user.id;

                // Create toggle buttons
                const row1 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`toggle_pref:${userId}:biddingSuggestions`)
                            .setLabel(userPrefs.biddingSuggestions ? '🦅 Suggestions: ON' : '🦅 Suggestions: OFF')
                            .setStyle(userPrefs.biddingSuggestions ? ButtonStyle.Success : ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(`toggle_pref:${userId}:handStrengthIndicator`)
                            .setLabel(userPrefs.handStrengthIndicator ? '💪 Strength: ON' : '💪 Strength: OFF')
                            .setStyle(userPrefs.handStrengthIndicator ? ButtonStyle.Success : ButtonStyle.Secondary)
                    );

                const row2 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`toggle_pref:${userId}:colorBlindMode`)
                            .setLabel(userPrefs.colorBlindMode ? '🎨 Color Blind: ON' : '🎨 Color Blind: OFF')
                            .setStyle(userPrefs.colorBlindMode ? ButtonStyle.Success : ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(`toggle_pref:${userId}:recommendedCardPlay`)
                            .setLabel(userPrefs.recommendedCardPlay ? '🎯 Card Play: ON' : '🎯 Card Play: OFF')
                            .setStyle(userPrefs.recommendedCardPlay ? ButtonStyle.Success : ButtonStyle.Secondary)
                    );

            // Card back theme selector
            const themeSelect = new StringSelectMenuBuilder()
                .setCustomId(`theme_select:${userId}`)
                .setPlaceholder('Select card back theme')
                .addOptions([
                    {
                        label: '🔵 Blue Theme',
                        description: 'Deep navy to bright blue gradient',
                        value: 'blue',
                        default: currentTheme === 'blue'
                    },
                    {
                        label: '🔴 Red Theme',
                        description: 'Dark crimson to bright red gradient',
                        value: 'red',
                        default: currentTheme === 'red'
                    },
                    {
                        label: '🟢 Green Theme',
                        description: 'Forest to emerald gradient',
                        value: 'green',
                        default: currentTheme === 'green'
                    },
                    {
                        label: '🟣 Purple Theme',
                        description: 'Deep violet to vibrant purple gradient',
                        value: 'purple',
                        default: currentTheme === 'purple'
                    },
                    {
                        label: '⚫ Classic Theme',
                        description: 'Charcoal to gray gradient',
                        value: 'classic',
                        default: currentTheme === 'classic'
                    },
                    {
                        label: '🎄 Christmas Theme',
                        description: 'Icy blue frosted gradient with snowflake',
                        value: 'christmas',
                        default: currentTheme === 'christmas'
                    }
                ]);
                
                const row3 = new ActionRowBuilder().addComponents(themeSelect);

                const row4 = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`close_preferences:${userId}`)
                            .setLabel('✅ Done')
                            .setStyle(ButtonStyle.Primary)
                    );

                await interaction.reply({
                    embeds: [preferencesEmbed],
                    components: [row1, row2, row3, row4],
                    ephemeral: true
                });

            } catch (error) {
                logger.error('❌ Error in /spades preferences command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while opening preferences.',
                        ephemeral: true
                    });
                }
            }
            
            return;
        }

        // ----------------------------------------------------
        // Handle /spades host command
        // ----------------------------------------------------
        if (subcommand === 'host') {
            try {
                const game = activeGames.get(interaction.channelId);

                if (!game) {
                    return interaction.reply({
                        content: '❌ No active Spades game found in this channel.',
                        ephemeral: true
                    });
                }

                // Check if user is the current host
                if (game.hostId !== interaction.user.id) {
                    return interaction.reply({ 
                        content: '🚫 Only the current game host can transfer host privileges!', 
                        ephemeral: true 
                    });
                }

                // Get the target player string (could be username or mention)
                const playerInput = options.getString('player', true);
                
                // Parse the player input - remove @ symbols and <> from mentions
                const cleanInput = playerInput.replace(/[<@!>]/g, '');
                
                // Try to find the player by Discord ID first (in case of mention)
                let targetPlayer = game.players.find(p => p.discordId === cleanInput);
                
                // If not found by ID, try by username (case-insensitive)
                if (!targetPlayer) {
                    targetPlayer = game.players.find(p => 
                        p.username.toLowerCase() === playerInput.toLowerCase()
                    );
                }

                if (!targetPlayer) {
                    return interaction.reply({
                        content: `❌ Player "${playerInput}" not found in this game. Make sure they are an active player (not a spectator).`,
                        ephemeral: true
                    });
                }

                // Check if trying to transfer to themselves
                if (targetPlayer.discordId === interaction.user.id) {
                    return interaction.reply({
                        content: '❌ You are already the host!',
                        ephemeral: true
                    });
                }

                // Check if target is an AI player
                if (targetPlayer.isAI) {
                    return interaction.reply({
                        content: '❌ Cannot transfer host privileges to an AI player!',
                        ephemeral: true
                    });
                }

                // Transfer host privileges
                const oldHostName = interaction.user.username;
                const newHostName = targetPlayer.username;
                game.hostId = targetPlayer.discordId;

                // Confirm to the old host
                await interaction.reply({
                    content: `✅ Host privileges transferred to **${newHostName}**!`,
                    ephemeral: true
                });

                // Announce to the channel
                const channel = await client.channels.fetch(interaction.channelId);
                if (channel) {
                    const hostTransferEmbed = new EmbedBuilder()
                        .setColor('#FFD700')
                        .setTitle('👑 New Game Host')
                        .setDescription(`**${oldHostName}** has transferred host privileges to **${newHostName}**.`)
                        .addFields({
                            name: 'Host Privileges',
                            value: '• Modify game settings\n• Add AI players\n• Transfer host to others',
                            inline: false
                        });

                    await channel.send({ embeds: [hostTransferEmbed] });
                }

            } catch (error) {
                logger.error('❌ Error in /spades host command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while transferring host privileges.',
                        ephemeral: true
                    });
                }
            }
            
            return;
        }

        // ----------------------------------------------------
        // Handle /spades premium command
        // ----------------------------------------------------
        if (subcommand === 'premium') {
            try {
                const isPremium = await checkPremiumEntitlement(client, interaction.user.id, interaction.guildId);
                const ownedThemes = await getOwnedThemes(client, interaction.user.id, interaction.guildId);
                const premiumDisplay = getPremiumDisplay(isPremium);

                // Build theme status display
                const allThemes = [...FREE_THEMES, ...PURCHASABLE_THEMES];
                const themeStatus = allThemes.map(t => {
                    const name = t.charAt(0).toUpperCase() + t.slice(1);
                    if (FREE_THEMES.includes(t)) {
                        return `✅ ${name} (Free)`;
                    } else if (ownedThemes.includes(t)) {
                        return `✅ ${name} (Owned)`;
                    } else {
                        return `🛒 ${name}`;
                    }
                }).join('\n');

                const premiumEmbed = new EmbedBuilder()
                    .setColor(premiumDisplay.color)
                    .setTitle('⭐ Spades Bot Premium')
                    .setDescription(isPremium 
                        ? '✅ **You have an active Premium subscription!** Thank you for your support!'
                        : 'Unlock exclusive features to enhance your Spades experience!')
                    .addFields(
                        {
                            name: '⚔️ Game Modes',
                            value: isPremium
                                ? '✅ Classic (Teams)\n✅ 3-Player Cutthroat\n✅ 4-Player Cutthroat'
                                : '✅ Classic (Teams)\n🔒 3-Player Cutthroat\n🔒 4-Player Cutthroat',
                            inline: true
                        },
                        {
                            name: '🤖 AI Difficulty',
                            value: isPremium
                                ? '✅ Easy\n✅ Medium\n✅ Hard'
                                : '✅ Easy\n✅ Medium\n🔒 Hard',
                            inline: true
                        },
                        {
                            name: '🎴 Card Backs',
                            value: isPremium
                                ? '✅ Blue\n✅ Red\n✅ Green\n✅ Purple\n✅ Classic\n✅ Christmas'
                                : '✅ Blue\n🔒 Red\n🔒 Green\n🔒 Purple\n🔒 Classic\n🔒 Christmas',
                            inline: true
                        },
                        {
                            name: '🎯 Custom Target Score',
                            value: isPremium 
                                ? '✅ Set 100-1000 points'
                                : '🔒 Free: 500 points only',
                            inline: true
                        },
                        {
                            name: '🎨 Deck Themes',
                            value: themeStatus,
                            inline: true
                        },
                        {
                            name: '\u200B',
                            value: '*🛒 = Available to purchase individually*',
                            inline: false
                        }
                    )
                    .setFooter({ 
                        text: isPremium 
                            ? 'Thank you for supporting Spades Bot! ❤️' 
                            : 'Subscribe for game modes, AI, card backs & scores. Buy themes separately!'
                    });

                const row = new ActionRowBuilder();

                if (isPremium) {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId('premium_manage')
                            .setLabel('Manage Subscription')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('⚙️')
                    );
                } else {
                    row.addComponents(
                        new ButtonBuilder()
                            .setCustomId('premium_subscribe')
                            .setLabel('Subscribe to Premium')
                            .setStyle(ButtonStyle.Primary)
                            .setEmoji('⭐'),
                        new ButtonBuilder()
                            .setCustomId('premium_info')
                            .setLabel('Learn More')
                            .setStyle(ButtonStyle.Secondary)
                            .setEmoji('ℹ️')
                    );
                }

                await interaction.reply({
                    embeds: [premiumEmbed],
                    components: [row],
                    ephemeral: true
                });

            } catch (error) {
                logger.error('❌ Error in /spades premium command:', error);
                if (!interaction.replied && !interaction.deferred) {
                    return interaction.reply({
                        content: '❌ An error occurred while checking premium status.',
                        ephemeral: true
                    });
                }
            }
            
            return;
        }

    } catch (error) {
        logger.error('❌ Unhandled error in interaction handler:', error);
        
        // Try to respond to the user if possible
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            try {
                await interaction.reply({
                    content: '❌ An unexpected error occurred. Please try again.',
                    ephemeral: true
                });
            } catch (e) {
                logger.error('❌ Could not send error response:', e);
            }
        }
    }
}); // ✅ closes client.on('interactionCreate', ...)

// --- Process-Level Error Handlers ---
/**
 * Handle unhandled promise rejections to prevent bot crashes
 * These typically happen with async operations that don't have catch blocks
 */
process.on('unhandledRejection', (reason, promise) => {
    logger.error('🚨 Unhandled Promise Rejection:', reason);
    logger.error('Promise:', promise);
    // Don't exit the process - log the error and continue running
    // In production, you might want to send this to an error tracking service
});

/**
 * Handle uncaught exceptions - these are more serious
 * Log the error and attempt graceful shutdown
 */
process.on('uncaughtException', (error) => {
    logger.error('🚨🚨 CRITICAL - Uncaught Exception:', error);
    logger.error('Stack trace:', error.stack);
    
    // Attempt to log out gracefully
    if (client) {
        client.destroy();
    }
    
    // Exit after a short delay to allow logging to complete
    setTimeout(() => {
        logger.error('Exiting due to uncaught exception...');
        process.exit(1);
    }, 1000);
});

// --- Start Bot ---
client.login(TOKEN);



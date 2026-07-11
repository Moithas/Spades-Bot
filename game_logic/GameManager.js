
// game_logic/GameManager.js

import { Deck } from './Deck.js';
import { Player } from './Player.js';
import { AIPlayer } from './AIPlayer.js';
import { Card } from './Card.js';
import logger from '../logger.js';
import { TIMING, GAME_LIMITS, PLAYER_LIMITS, DECK } from '../constants.js';
import { playerStats } from '../stats/PlayerStats.js';
import { aiLearning } from '../stats/AILearning.js';
import { aiHardTelemetryStore } from '../stats/AIHardTelemetry.js';
import { gameTelemetryStore } from '../stats/GameTelemetry.js';
import { trashTalk } from './TrashTalk.js';

/**
 * Manages the state and flow of a four-player game of Spades, including dealing,
 * bidding, trick play, and scoring.
 */
export default class GameManager {
    /**
     * @param {function(string)} publicAnnounce - Function to send a message to the public game chat.
     * @param {function(string, string)} privatePrompt - Function to send a DM to a specific player ID.
     * @param {number} [targetScore=500] - The score required to win the game.
     * @param {string} [gameMode='classic'] - Game mode: 'classic' (4 players, teams), 'cutthroat3' (3 players, solo), 'cutthroat4' (4 players, solo)
     */
    constructor(publicAnnounce, privatePrompt, targetScore = 500, gameMode = 'classic') {
        // Core game state
            this.deck = new Deck();
            this.players = [];
            this.isGameActive = false;
            this.state = 'LOBBY';
            this.hostId = null; // Discord ID of the player who created the game
            this.gameMode = gameMode; // 'classic', 'cutthroat3', 'cutthroat4'
            this.trumpSuit = null; // Track the trump suit
            // Game options (customizable settings)
            this.options = {
                biddingSuggestions: false,
                handStrengthIndicator: false,
                colorBlindMode: false,
                autoPlayTimer: 0, // 0 = disabled, or time in seconds (60 for 1 min)
                autoPlayLastTrick: true, // Auto-play the last trick when all players have 1 card
                recommendedCardPlay: false,
                targetScore: targetScore, // Points needed to win (100-1000)
                trashTalk: {
                    enabled: true,      // AI trash talk enabled by default
                    frequency: 'medium' // low, medium, high
                },
                deckTheme: 'classic' // Card face theme: 'classic', 'steampunk', 'minimalist', 'neon', 'medieval'
            };
            // Spectator tracking
            this.spectators = []; // Array of {id, username}
            this.spectatorNotifications = new Map(); // spectatorId -> array of notifications
            this.spectatorView = null; // Will be set when SpectatorView is imported
            // Round & Turn management
            this.currentPlayerIndex = 0;
            this.dealerIndex = 0; // ADDED: Track dealer
            this.currentRound = 1; // ADDED: Track round number
            this.bidsTaken = 0;
            this.isBiddingActive = false;
            this.biddingCompleteTimeout = null; // Store timeout ID for bidding complete delay
            this.aiPendingBidTimeout = null; // Store timeout ID for AI bid delay
            // Trick Play State
            this.isTrickActive = false;
            this.trick = [];             // RENAMED from currentTrick for consistency with index.js
            this.trickHistory = [];      // Track all tricks played this round
            this.trickSuit = null;
            this.spadesBroken = false;
            this.currentTrickMessageId = null; // Store Discord message ID for updating trick embed
            this.currentTrickWinnerMessageId = null; // Store Discord message ID for trick winner message
            this.previousTrickCardsMessageId = null; // Store previous trick's cards message ID for deletion
            this.biddingMessageId = null; // Store Discord message ID for updating bidding embed
            // Auto-play timer tracking
            this.currentPlayTimer = null; // Store timeout ID for auto-play timer
            this.currentPlayTimerPlayerId = null; // Track which player the timer is for
            // Communication hooks
            this.publicAnnounce = publicAnnounce;
            this.privatePrompt = privatePrompt;
            this.channel = null; // Discord channel object (set after creation for AI trash talk)
            // Statistics tracking
            this.playerStatTracking = {}; // Track per-player stats during game: {discordId: {nilBids, blindNilBids, nilSuccesses, blindNilSuccesses}}
            // Opponent modeling - track patterns during game for learning
            this.handObservations = {}; // Track observations for each player this hand: {discordId: {bid, handStrength, ledHigh, etc}}
            // Internal debounce map to prevent duplicate AI play invocations
            // Key: aiPlayer.id, Value: timestamp of last play request (ms)
            this._aiPlayTimestamps = new Map();
            // Pending scheduled AI timeout id (to avoid duplicate scheduling)
            this._aiScheduledTimeout = null;
            // Per-game lock to prevent concurrent AI plays (reentrancy)
            this._aiPlaying = false;
            // Hard telemetry context for persistent tracking across live games.
            this.telemetryGameId = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
            this.hardSetPressureGameTotals = {};
        }

    /**
     * Adds a spectator to the game if not already present.
     * @param {Object} spectator - {id, username}
     * @returns {Object} Result object with either success or error.
     */
    addSpectator(spectator) {
        if (this.spectators.find(s => s.id === spectator.id)) {
            return { error: 'You are already spectating this game!' };
        }
        this.spectators.push({ id: spectator.id, username: spectator.username });
        return { success: true };
    }


    /**
     * Removes a spectator from the game.
     * @param {string} spectatorId
     * @returns {Object} Result object with either success or error.
     */
    removeSpectator(spectatorId) {
        const idx = this.spectators.findIndex(s => s.id === spectatorId);
        if (idx === -1) {
            return { error: 'You are not spectating this game.' };
        }
        this.spectators.splice(idx, 1);
        return { success: true };
    }

    /**
     * Checks if a user is a spectator.
     * @param {string} userId
     * @returns {boolean}
     */
    isSpectator(userId) {
        return this.spectators.some(s => s.id === userId);
    }

    /**
     * Returns a list of spectators (array of {id, username}).
     */
    getSpectators() {
        return this.spectators;
    }

    /**
     * Schedule the current leader AI to play after `delay` ms. Clears any previously scheduled AI lead timeout.
     * Useful to centralize AI scheduling and avoid duplicate timers from multiple call sites.
     */
    scheduleAILead(delay = TIMING.AI_PLAY_DELAY) {
        // clear previous timeout
        try {
            if (this._aiScheduledTimeout) {
                clearTimeout(this._aiScheduledTimeout);
                this._aiScheduledTimeout = null;
                logger.debug(`🧭 scheduleAILead: cleared previous scheduled AI lead`);
            }
        } catch (e) {
            // ignore
        }

        const leader = this.players[this.currentPlayerIndex];
        if (!leader || !leader.isAI || this.state !== 'PLAYING') {
            logger.debug(`⏭️ scheduleAILead: skipped (leader=${leader?.username}, isAI=${leader?.isAI}, state=${this.state})`);
            logger.debug('   Players order:', this.players.map((p, i) => `${i}:${p.username}[id=${p.id}]`).join(' | '));
            logger.debug(`   currentPlayerIndex=${this.currentPlayerIndex}`);
            return;
        }

        logger.debug(`🧭 scheduleAILead: scheduling AI lead for ${leader.username} in ${delay}ms`);
        this._aiScheduledTimeout = setTimeout(() => {
            // Double check state and current player
            const currentLeader = this.players[this.currentPlayerIndex];
            if (currentLeader?.id === leader.id && currentLeader.isAI && this.state === 'PLAYING') {
                logger.debug(`🎯 Executing scheduled AI play for ${currentLeader.username}`);
                this.processAIPlay(currentLeader);
            } else {
                logger.debug(`⚠️ Conditions changed, cancelling AI play (current=${currentLeader?.username}, state=${this.state})`);
                logger.debug('   Leader when scheduled:', `${leader.username}[id=${leader.id}] at index ${this.players.findIndex(p=>p.id===leader.id)}`);
                logger.debug('   Current players:', this.players.map((p, i) => `${i}:${p.username}[id=${p.id}]`).join(' | '));
                logger.debug(`   currentPlayerIndex=${this.currentPlayerIndex}`);
            }
            this._aiScheduledTimeout = null;
        }, delay);
    }

    // --- Utility Methods ---

    /**
     * Finds a player object by their Discord ID.
     * @param {string} playerId 
     * @returns {Player|undefined}
     */
    getPlayerById(playerId) {
        return this.players.find(p => p.discordId === playerId);
    }

    /**
     * Check if game is in cutthroat mode (no teams)
     * @returns {boolean}
     */
    isCutthroat() {
        return this.gameMode === 'cutthroat3' || this.gameMode === 'cutthroat4';
    }

    /**
     * Get maximum number of players for current game mode
     * @returns {number}
     */
    getMaxPlayers() {
        if (this.gameMode === 'cutthroat3') return 3;
        return 4; // classic and cutthroat4
    }

    /**
     * Get minimum number of players for current game mode
     * @returns {number}
     */
    getMinPlayers() {
        if (this.gameMode === 'cutthroat3') return 3;
        return 4; // classic and cutthroat4
    }
    
    /**
     * Updates game options (can be changed at any time by the host)
     * @param {object} newOptions - Object with option keys to update
     * @returns {object} Result with success or error
     */
    updateOptions(newOptions) {
        // Options can now be changed at any time during the game
        
        // Validate and update options
        if (newOptions.hasOwnProperty('biddingSuggestions')) {
            this.options.biddingSuggestions = Boolean(newOptions.biddingSuggestions);
        }
        if (newOptions.hasOwnProperty('handStrengthIndicator')) {
            this.options.handStrengthIndicator = Boolean(newOptions.handStrengthIndicator);
        }
        if (newOptions.hasOwnProperty('colorBlindMode')) {
            this.options.colorBlindMode = Boolean(newOptions.colorBlindMode);
        }
        if (newOptions.hasOwnProperty('recommendedCardPlay')) {
            this.options.recommendedCardPlay = Boolean(newOptions.recommendedCardPlay);
        }
        if (newOptions.hasOwnProperty('autoPlayLastTrick')) {
            this.options.autoPlayLastTrick = Boolean(newOptions.autoPlayLastTrick);
        }
        if (newOptions.hasOwnProperty('autoPlayTimer')) {
            const timer = Number(newOptions.autoPlayTimer);
            if (timer < 0 || timer > TIMING.MAX_AUTO_PLAY_TIMER_SECONDS) {
                return { error: `Auto-play timer must be between 0 (disabled) and ${TIMING.MAX_AUTO_PLAY_TIMER_SECONDS} seconds.` };
            }
            this.options.autoPlayTimer = timer;
        }
        if (newOptions.hasOwnProperty('targetScore')) {
            const score = Number(newOptions.targetScore);
            if (score < GAME_LIMITS.MIN_TARGET_SCORE || score > GAME_LIMITS.MAX_TARGET_SCORE) {
                return { error: `Target score must be between ${GAME_LIMITS.MIN_TARGET_SCORE} and ${GAME_LIMITS.MAX_TARGET_SCORE} points.` };
            }
            this.options.targetScore = score;
        }
        
        return { success: true, options: this.options };
    }
    
    /**
     * Calculates a suggested bid for a player based on their hand
     * @param {Player} player - The player to calculate a suggestion for
     * @returns {object} { suggestedBid: number, explanation: string, confidence: string }
     */
    calculateBidSuggestion(player) {
        if (!player || !player.hand || player.hand.length === 0) {
            return { suggestedBid: 1, explanation: 'No hand to analyze', confidence: 'low' };
        }

        let bidValue = 0;
        let explanationParts = [];
        
        // Check if this is 3-player cutthroat (17 cards per player, 17 tricks)
        const isCutthroat3 = this.gameMode === 'cutthroat3';

        // Group cards by suit
        const suits = { 'S': [], 'H': [], 'D': [], 'C': [] };
        player.hand.forEach(c => suits[c.suitCode].push(c));
        
        // Sort each suit by value (high to low)
        Object.keys(suits).forEach(suit => {
            suits[suit].sort((a, b) => b.value - a.value);
        });

        const spades = suits['S'];
        const spadesLength = spades.length;
        const spadeValues = spades.map(c => c.value);
        
        // Count "non-boss" spades (spades that aren't A, K, Q) for trumping potential
        const bossSpadeValues = [14, 13, 12]; // A, K, Q
        const nonBossSpades = spades.filter(c => !bossSpadeValues.includes(c.value)).length;

        // === SPADE EVALUATION (Trump suit) ===
        // Ace of spades = guaranteed winner (+1)
        if (spadeValues.includes(14)) {
            bidValue += 1;
            explanationParts.push('A♠');
        }
        
        // King of spades = winner if supported (2+ spades total)
        if (spadeValues.includes(13) && spadesLength >= 2) {
            bidValue += 1;
            explanationParts.push('K♠');
        }
        
        // Queen of spades = winner if supported (2+ spades total) - it's a trump!
        if (spadeValues.includes(12) && spadesLength >= 2) {
            bidValue += 1;
            explanationParts.push('Q♠');
        }
        
        // In 3-player cutthroat with 17 cards, Jack of spades can win with good support
        if (isCutthroat3 && spadeValues.includes(11) && spadesLength >= 4) {
            bidValue += 1;
            explanationParts.push('J♠');
        }
        
        // Long spades bonus in cutthroat3 (more tricks available)
        if (isCutthroat3 && spadesLength >= 6) {
            const longSpadeBonus = Math.floor((spadesLength - 5) / 2); // +1 for every 2 spades over 5
            if (longSpadeBonus > 0) {
                bidValue += longSpadeBonus;
                explanationParts.push(`${spadesLength} spades`);
            }
        }

        // === SIDE SUIT EVALUATION (Hearts, Diamonds, Clubs) ===
        // Count short suits (voids and singletons) that can be trumped
        let shortSuitCount = 0;
        
        // Threshold for "short" changes in cutthroat3 (17 cards means longer average suits)
        const shortThreshold = isCutthroat3 ? 2 : 1; // 0-2 cards is "short" in cutthroat3
        
        ['H', 'D', 'C'].forEach(suitCode => {
            const suitCards = suits[suitCode];
            const suitLength = suitCards.length;
            const suitSymbol = suitCode === 'H' ? '♥' : suitCode === 'D' ? '♦' : '♣';
            const suitValues = suitCards.map(c => c.value);
            
            // Count Aces (+1 each, always)
            if (suitValues.includes(14)) {
                bidValue += 1;
                explanationParts.push(`A${suitSymbol}`);
            }
            
            // Count supported Kings (+1 if at least 2 cards in suit)
            if (suitValues.includes(13) && suitLength >= 2) {
                bidValue += 1;
                explanationParts.push(`K${suitSymbol}`);
            }
            
            // In cutthroat3, Queens can win more often due to longer suits
            // Count supported Queens (+1 if at least 3 cards in suit)
            if (isCutthroat3 && suitValues.includes(12) && suitLength >= 3) {
                bidValue += 1;
                explanationParts.push(`Q${suitSymbol}`);
            }
            
            // In cutthroat3, very long suits (6+) can generate length tricks
            if (isCutthroat3 && suitLength >= 6 && suitValues.includes(14)) {
                // With the Ace, you might run the suit
                const lengthTricks = Math.floor((suitLength - 5) / 2);
                if (lengthTricks > 0) {
                    bidValue += lengthTricks;
                    explanationParts.push(`${suitLength}-card ${suitSymbol}`);
                }
            }
            
            // Track short suits for trumping potential
            if (suitLength <= shortThreshold) {
                shortSuitCount++;
            }
        });

        // === SHORT SUIT TRUMPING VALUE ===
        // Each short suit (void or singleton) is worth +1 IF we have non-boss spades to trump with
        // We need at least as many non-boss spades as short suits to capitalize
        const trumpableSuits = Math.min(shortSuitCount, nonBossSpades);
        if (trumpableSuits > 0) {
            bidValue += trumpableSuits;
            if (trumpableSuits === 1) {
                explanationParts.push('1 ruff');
            } else {
                explanationParts.push(`${trumpableSuits} ruffs`);
            }
        }

        // Round to nearest integer
        bidValue = Math.round(bidValue);

        // Clamp bid - max is 17 for cutthroat3, 13 for others
        const maxBid = isCutthroat3 ? 17 : PLAYER_LIMITS.MAX_BID;
        bidValue = Math.max(PLAYER_LIMITS.MIN_BID, Math.min(maxBid, bidValue));

        // Check for Nil bid potential
        // A good Nil hand has: no aces, no kings, ideally no queens (except maybe protected)
        // Low spades are dangerous (can't duck under higher spades easily)
        // Short suits are good (can sluff high cards)
        const aceCount = player.hand.filter(c => c.rankCode === 'A').length;
        const kingCount = player.hand.filter(c => c.rankCode === 'K').length;
        const queenCount = player.hand.filter(c => c.rankCode === 'Q').length;
        const highSpadeCount = spades.filter(c => c.value >= 12).length; // Q, K, A of spades
        const lowSpadeCount = spades.filter(c => c.value <= 6).length; // 2-6 of spades are dangerous
        const maxCard = Math.max(...player.hand.map(c => c.value));
        
        // Count short suits (good for sluffing high cards) - threshold differs for cutthroat3
        const shortSuitThreshold = isCutthroat3 ? 3 : 2;
        const shortSuits = ['H', 'D', 'C'].filter(s => suits[s].length <= shortSuitThreshold).length;
        
        let nilSuggestion = null;
        let nilConfidence = null;
        let nilExplanation = [];
        
        // Nil is HARDER in cutthroat3 (17 tricks to dodge, no partner to protect you)
        // Require stricter conditions
        if (isCutthroat3) {
            // Very strict Nil in cutthroat3 - must have extremely weak hand
            if (aceCount === 0 && kingCount === 0 && queenCount === 0 && maxCard <= 10 && lowSpadeCount <= 1) {
                nilConfidence = 'medium';
                nilExplanation.push('no aces/kings/queens');
                nilExplanation.push('17 tricks to dodge (risky!)');
            }
        } else {
            // Standard Nil evaluation for 4-player modes
            // Strong Nil candidate: No aces, no kings, max card is Jack or lower
            if (aceCount === 0 && kingCount === 0 && maxCard <= 11) {
                nilConfidence = 'high';
                nilExplanation.push('no aces/kings');
                if (queenCount === 0) nilExplanation.push('no queens');
                if (shortSuits >= 2) nilExplanation.push(`${shortSuits} short suits`);
            }
            // Moderate Nil candidate: No aces, maybe 1 king that can be sluffed
            else if (aceCount === 0 && kingCount <= 1 && highSpadeCount === 0 && maxCard <= 13) {
                // Check if the king is in a short suit (can be sluffed)
                const kingSuits = ['H', 'D', 'C'].filter(s => suits[s].some(c => c.rankCode === 'K'));
                const kingCanBeSluffed = kingSuits.every(s => suits[s].length <= 2);
                
                if (kingCanBeSluffed && shortSuits >= 1) {
                    nilConfidence = 'medium';
                    nilExplanation.push('no aces');
                    if (kingCount === 1) nilExplanation.push('1 king (sluffable)');
                    if (lowSpadeCount === 0) nilExplanation.push('no low spades');
                }
            }
            // Risky Nil: No aces, weak hand, but some concerns
            else if (aceCount === 0 && kingCount === 0 && queenCount <= 2 && highSpadeCount === 0 && bidValue <= 2) {
                nilConfidence = 'low';
                nilExplanation.push('weak hand');
                if (lowSpadeCount > 0) nilExplanation.push(`${lowSpadeCount} low spades (risky)`);
            }
        }
        
        if (nilConfidence) {
            nilSuggestion = {
                suggestedBid: 0,
                explanation: nilExplanation.join(', ') + ' - consider Nil',
                confidence: nilConfidence
            };
        }

        // Determine confidence level
        let confidence = 'medium';
        if (aceCount >= 2 || (aceCount >= 1 && spadesLength >= 3)) {
            confidence = 'high';
        } else if (bidValue <= 2 && aceCount === 0) {
            confidence = 'low';
        }

        const mainSuggestion = {
            suggestedBid: bidValue,
            explanation: explanationParts.length > 0 ? explanationParts.join(', ') : 'Moderate hand',
            confidence: confidence
        };

        // Return both options if Nil is viable
        if (nilSuggestion) {
            return {
                primary: mainSuggestion,
                alternative: nilSuggestion
            };
        }

        return mainSuggestion;
    }
    
    /**
     * Calculates hand strength metrics for display to player
     * @param {Player} player - The player to analyze
     * @returns {object} Hand strength analysis with HCP, distribution, and rating
     */
    calculateHandStrength(player) {
        if (!player || !player.hand || player.hand.length === 0) {
            return { hcp: 0, distribution: '', rating: 'No Hand', color: '#808080' };
        }

        // Calculate High Card Points (HCP) - standard bridge scoring
        let hcp = 0;
        player.hand.forEach(card => {
            if (card.rankCode === 'A') hcp += 4;
            else if (card.rankCode === 'K') hcp += 3;
            else if (card.rankCode === 'Q') hcp += 2;
            else if (card.rankCode === 'J') hcp += 1;
        });

        // Calculate distribution (suit lengths)
        const suits = { 'S': 0, 'H': 0, 'D': 0, 'C': 0 };
        player.hand.forEach(c => suits[c.suitCode]++);
        
        const suitLengths = [suits.S, suits.H, suits.D, suits.C].sort((a, b) => b - a);
        const distribution = suitLengths.join('-');

        // Count spades (trump suit)
        const spadeCount = suits.S;
        const highSpades = player.hand.filter(c => c.suitCode === 'S' && c.value >= 12).length;

        // Distribution points
        let distPoints = 0;
        const voids = Object.values(suits).filter(count => count === 0).length;
        const singletons = Object.values(suits).filter(count => count === 1).length;
        const doubletons = Object.values(suits).filter(count => count === 2).length;
        
        distPoints += voids * 3;
        distPoints += singletons * 2;
        distPoints += doubletons * 1;

        // Spade bonus (trump suit)
        let spadeBonus = 0;
        if (spadeCount >= 5) spadeBonus += 2;
        else if (spadeCount >= 4) spadeBonus += 1;
        if (highSpades >= 2) spadeBonus += 1;

        // Total strength score
        const totalStrength = hcp + distPoints + spadeBonus;

        // Determine rating and color
        let rating, color;
        if (totalStrength >= 18) {
            rating = 'Excellent';
            color = '#00FF00'; // Bright green
        } else if (totalStrength >= 14) {
            rating = 'Strong';
            color = '#90EE90'; // Light green
        } else if (totalStrength >= 10) {
            rating = 'Good';
            color = '#FFD700'; // Gold
        } else if (totalStrength >= 7) {
            rating = 'Average';
            color = '#FFA500'; // Orange
        } else if (totalStrength >= 4) {
            rating = 'Weak';
            color = '#FF6347'; // Tomato
        } else {
            rating = 'Very Weak';
            color = '#DC143C'; // Crimson
        }

        return {
            hcp: hcp,
            distribution: distribution,
            spades: spadeCount,
            highSpades: highSpades,
            voids: voids,
            singletons: singletons,
            totalStrength: totalStrength,
            rating: rating,
            color: color
        };
    }

    /**
     * Calculate recommended card to play based on game state
     * @param {Player} player - The player who needs a recommendation
     * @returns {object} { recommendedCard, explanation, confidence }
     */
    calculateCardPlaySuggestion(player) {
        if (!player || !player.hand || player.hand.length === 0) {
            return null;
        }

        // Get legal cards
        const legalCards = this.getLegalCards(player);
        
        if (legalCards.length === 0) {
            return null;
        }

        if (legalCards.length === 1) {
            return {
                recommendedCard: legalCards[0],
                explanation: 'Only legal card to play',
                confidence: 'certain'
            };
        }

        const isLeading = this.trick.length === 0;
        
        // Working variables for recommendation
        let recommendedCard = null;
        let explanation = '';
        let confidence = 'low';
        // Detect an opponent who has bid Nil and currently has 0 tricks.
        // Return the first matching opponent object (truthy) or null.
        let opponentOnNil = null;
        if (this.isCutthroat()) {
            opponentOnNil = this.players.find(p => p.id !== player.id && p.isNil && p.tricks === 0) || null;
        } else {
            opponentOnNil = this.players.find(p => p.id !== player.id && p.team !== player.team && p.isNil && p.tricks === 0) || null;
        }
        // In cutthroat mode, there are no partners
        const partner = this.isCutthroat() ? null : (player.team === 1 
            ? this.players.find(p => p.team === 1 && p.id !== player.id)
            : this.players.find(p => p.team === 2 && p.id !== player.id));
        const partnerIsNil = partner && partner.isNil && partner.tricks === 0;
        

        // TODO: Implement logic to check if any opponent is on Nil
        // let opponentOnNil = false;

        if (isLeading) {
            // Leading the trick
            if (partnerIsNil) {
                // Protect partner's Nil - lead high card they can't beat
                const highCards = legalCards.filter(c => c.value >= 12); // A, K, Q
                if (highCards.length > 0) {
                    recommendedCard = highCards.reduce((highest, card) => 
                        card.value > highest.value ? card : highest
                    );
                    explanation = 'Lead high to protect partner\'s Nil bid';
                    confidence = 'high';
                } else {
                    // Lead mid-range if no high cards
                    recommendedCard = legalCards.reduce((mid, card) => 
                        Math.abs(card.value - 8) < Math.abs(mid.value - 8) ? card : mid
                    );
                    explanation = 'Lead mid-range card while protecting partner\'s Nil';
                    confidence = 'medium';
                }
            } else if (opponentOnNil) {
                // Attack opponent's Nil - lead low to force them to win
                const lowCards = legalCards.filter(c => c.value <= 7 && c.suitCode !== 'S');
                if (lowCards.length > 0) {
                    recommendedCard = lowCards.reduce((lowest, card) => 
                        card.value < lowest.value ? card : lowest
                    );
                    explanation = 'Lead low to attack opponent\'s Nil bid';
                    confidence = 'high';
                } else {
                    recommendedCard = legalCards[0];
                    explanation = 'Lead available card against opponent Nil';
                    confidence = 'low';
                }
            } else {
                // Normal play - lead high card to win tricks if needed
                const tricksNeeded = player.bid - player.tricks;
                const tricksRemaining = 13 - (player.hand.length);
                
                if (tricksNeeded > tricksRemaining * 0.7) {
                    // Need tricks urgently - lead high
                    const highCards = legalCards.filter(c => c.value >= 11);
                    if (highCards.length > 0) {
                        recommendedCard = highCards.reduce((highest, card) => 
                            card.value > highest.value ? card : highest
                        );
                        explanation = `Need ${tricksNeeded} more tricks - lead high`;
                        confidence = 'high';
                    } else {
                        recommendedCard = legalCards.reduce((highest, card) => 
                            card.value > highest.value ? card : highest
                        );
                        explanation = 'Lead highest available to win tricks';
                        confidence = 'medium';
                    }
                } else {
                    // Comfortable on bid - lead low to save high cards
                    recommendedCard = legalCards.reduce((lowest, card) => 
                        card.value < lowest.value ? card : lowest
                    );
                    explanation = 'On track for bid - lead low to save high cards';
                    confidence = 'medium';
                }
            }
        } else {
            // Following in the trick
            const leadSuit = this.trick[0].card.suitCode;
            const hasSuit = legalCards.some(c => c.suitCode === leadSuit);
            
            // Determine current winning card
            let currentWinner = this.trick[0];
            for (let i = 1; i < this.trick.length; i++) {
                const entry = this.trick[i];
                if (entry.card.suitCode === 'S' && currentWinner.card.suitCode !== 'S') {
                    currentWinner = entry;
                } else if (entry.card.suitCode === currentWinner.card.suitCode && 
                           entry.card.value > currentWinner.card.value) {
                    currentWinner = entry;
                }
            }
            
            const partnerWinning = currentWinner.player.id === partner?.id;
            
            if (partnerIsNil && !partnerWinning) {
                // Partner on Nil is not winning - try to win the trick
                if (hasSuit) {
                    const suitCards = legalCards.filter(c => c.suitCode === leadSuit);
                    const canWin = suitCards.some(c => c.value > currentWinner.card.value);
                    
                    if (canWin) {
                        recommendedCard = suitCards
                            .filter(c => c.value > currentWinner.card.value)
                            .reduce((lowest, card) => card.value < lowest.value ? card : lowest);
                        explanation = 'Win trick to protect partner\'s Nil';
                        confidence = 'high';
                    } else {
                        recommendedCard = suitCards.reduce((highest, card) => 
                            card.value > highest.value ? card : highest
                        );
                        explanation = 'Can\'t win - play high to support partner\'s Nil';
                        confidence = 'medium';
                    }
                } else {
                    // No suit - trump if possible
                    const spades = legalCards.filter(c => c.suitCode === 'S');
                    if (spades.length > 0) {
                        recommendedCard = spades.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Trump to protect partner\'s Nil';
                        confidence = 'high';
                    } else {
                        recommendedCard = legalCards.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Dump low card to protect partner\'s Nil';
                        confidence = 'medium';
                    }
                }
            } else if (partnerWinning) {
                // Partner is winning - play low
                if (hasSuit) {
                    const suitCards = legalCards.filter(c => c.suitCode === leadSuit);
                    recommendedCard = suitCards.reduce((lowest, card) => 
                        card.value < lowest.value ? card : lowest
                    );
                    explanation = 'Partner winning - play low to save cards';
                    confidence = 'high';
                } else {
                    // No suit - avoid trumping partner! Play lowest non-spade if possible
                    const nonSpades = legalCards.filter(c => c.suitCode !== 'S');
                    if (nonSpades.length > 0) {
                        recommendedCard = nonSpades.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Partner winning - dump lowest non-spade';
                        confidence = 'high';
                    } else {
                        // Only spades available - dump lowest spade
                        recommendedCard = legalCards.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Partner winning - forced to trump (only spades left)';
                        confidence = 'low';
                    }
                }
            } else {
                // Opponent winning
                const tricksNeeded = player.bid - player.tricks;
                
                if (tricksNeeded > 0 && hasSuit) {
                    const suitCards = legalCards.filter(c => c.suitCode === leadSuit);
                    const canWin = suitCards.some(c => c.value > currentWinner.card.value);
                    
                    if (canWin) {
                        recommendedCard = suitCards
                            .filter(c => c.value > currentWinner.card.value)
                            .reduce((lowest, card) => card.value < lowest.value ? card : lowest);
                        explanation = `Need ${tricksNeeded} tricks - take this one`;
                        confidence = 'high';
                    } else {
                        recommendedCard = suitCards.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Can\'t win - play low';
                        confidence = 'medium';
                    }
                } else if (tricksNeeded > 0 && !hasSuit) {
                    // Need tricks and can trump
                    const spades = legalCards.filter(c => c.suitCode === 'S');
                    if (spades.length > 0 && currentWinner.card.suitCode !== 'S') {
                        recommendedCard = spades.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = `Need ${tricksNeeded} tricks - trump`;
                        confidence = 'high';
                    } else {
                        recommendedCard = legalCards.reduce((lowest, card) => 
                            card.value < lowest.value ? card : lowest
                        );
                        explanation = 'Dump lowest card';
                        confidence = 'low';
                    }
                } else {
                    // Don't need tricks - dump low
                    recommendedCard = legalCards.reduce((lowest, card) => 
                        card.value < lowest.value ? card : lowest
                    );
                    explanation = 'On track for bid - play low';
                    confidence = 'medium';
                }
            }
        }

        // Fallback
        if (!recommendedCard) {
            recommendedCard = legalCards[0];
            explanation = 'Play available card';
            confidence = 'low';
        }

        return {
            recommendedCard: recommendedCard,
            explanation: explanation,
            confidence: confidence
        };
    }

    /**
     * Start the auto-play timer for the current player
     * @param {Player} player - The player whose turn it is
     */
    startPlayTimer(player) {
        // Only start timer if it's enabled and player is human
        if (this.options.autoPlayTimer === 0 || player.isAI) {
            return;
        }

        // Cancel any existing timer
        this.cancelPlayTimer();

        logger.debug(`⏱️ Starting ${this.options.autoPlayTimer}s timer for ${player.username}`);
        
        this.currentPlayTimerPlayerId = player.id;
        this.currentPlayTimer = setTimeout(() => {
            this.handleAutoPlay(player);
        }, this.options.autoPlayTimer * 1000);
    }

    /**
     * Cancel the current auto-play timer
     */
    cancelPlayTimer() {
        if (this.currentPlayTimer) {
            clearTimeout(this.currentPlayTimer);
            this.currentPlayTimer = null;
            this.currentPlayTimerPlayerId = null;
            logger.debug('⏱️ Play timer cancelled');
        }
    }

    /**
     * Handle auto-play when timer expires
     * @param {Player} player - The player who didn't play in time
     */
    async handleAutoPlay(player) {
        logger.debug(`⏰ Auto-play triggered for ${player.username}`);
        logger.debug(`[DEBUG] handleAutoPlay: currentPlayerIndex=${this.currentPlayerIndex}, player.id=${player.id}, player.hand.length=${player.hand.length}`);
        
        // Verify it's still their turn
        const currentPlayer = this.players[this.currentPlayerIndex];
        logger.debug(`[DEBUG] handleAutoPlay: Checking if it's still ${player.username}'s turn. currentPlayer.id=${currentPlayer.id}, player.id=${player.id}`);
        if (currentPlayer.id !== player.id) {
            logger.debug(`⏰ Auto-play cancelled: not ${player.username}'s turn anymore`);
            return;
        }

        // Verify they haven't already played
        const hasPlayedThisTrick = this.trick.some(play => play.player.id === player.id);
        logger.debug(`[DEBUG] handleAutoPlay: hasPlayedThisTrick=${hasPlayedThisTrick}`);
        if (hasPlayedThisTrick) {
            logger.debug(`⏰ Auto-play cancelled: ${player.username} already played`);
            return;
        }

        // Get recommended card (use the same logic as card play suggestion)
        let suggestion = this.calculateCardPlaySuggestion(player);
        logger.debug(`[DEBUG] handleAutoPlay: suggestion=${JSON.stringify(suggestion)}`);
        if (!suggestion || !suggestion.recommendedCard) {
            logger.error(`⏰ Auto-play failed: no card suggestion for ${player.username}`);
            // Fallback: play first legal card
            const legalCards = this.getLegalCards(player);
            logger.debug(`[DEBUG] handleAutoPlay: legalCards=${JSON.stringify(legalCards)}`);
            if (legalCards.length > 0) {
                suggestion = { recommendedCard: legalCards[0] };
            } else {
                logger.error(`⏰ Auto-play critical fail: no legal cards for ${player.username}`);
                return;
            }
        }

        const cardToPlay = suggestion.recommendedCard;
        
        // Announce auto-play
        try {
            await this.publicAnnounce({
                type: 'auto_play',
                playerName: player.username,
                card: { rankCode: cardToPlay.rankCode, suitCode: cardToPlay.suitCode, value: cardToPlay.value }
            });
        } catch (e) {
            logger.error('❌ Failed to announce auto-play:', e);
        }

        // Execute the play (same logic as processAIPlay)
        // Determine if this play will be the last trick (everyone has 1 card BEFORE this play)
        const wasLastTrick = this.players.every(p => p.hand.length === 1);
        logger.debug(`[DEBUG] handleAutoPlay: wasLastTrick=${wasLastTrick}, isAutoPlayingLastTrick=${this.isAutoPlayingLastTrick}`);
        this.trick.push({ player: player, card: cardToPlay });
        player.removeCard(cardToPlay);

        // Record the played card
        try {
            this.recordPlayedCard(cardToPlay, player.id);
        } catch (e) {
            logger.error('❌ Failed to record played card:', e);
        }

        // --- FORCE LAST TRICK AUTO-PLAY FOR ALL PLAYERS ---
        const allPlayersHaveOneCard = this.players.every(p => p.hand.length === 1);
        // expectedTrickSize already declared above if needed
        // If this is the first card of the last trick, immediately auto-play the rest

        // If this was the last trick (everyone had 1 card before this play), auto-play remaining cards.
        // ...existing code...

        // Announce the play via trick update
        try {
            let nextPlayerName = null;
            let nextPlayerId = null;
            let isNextPlayerAI = false;
            const expectedTrickSize = this.players.length; // 3 or 4 players
            if (this.trick.length < expectedTrickSize) {
                const nextPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
                const nextPlayer = this.players[nextPlayerIndex];
                nextPlayerName = nextPlayer.username;
                nextPlayerId = nextPlayer.discordId;
                isNextPlayerAI = nextPlayer.isAI;
            }

            await this.publicAnnounce({
                type: 'trick_update',
                trick: this.trick.map(play => ({
                    playerId: play.player.id,
                    playerName: play.player.username,
                    card: { rankCode: play.card.rankCode, suitCode: play.card.suitCode, value: play.card.value }
                })),
                messageId: this.currentTrickMessageId,
                previousTrickCardsMessageId: this.previousTrickCardsMessageId,
                nextPlayerName: nextPlayerName,
                nextPlayerId: nextPlayerId,
                isNextPlayerAI: isNextPlayerAI
            });
        } catch (e) {
            logger.error('❌ Failed during publicAnnounce(trick_update):', e);
        }

        // Check if spades broken
        if (cardToPlay.suitCode === 'S' && !this.spadesBroken) {
            this.spadesBroken = true;
            try { await this.publicAnnounce({ type: 'spades_broken' }); } catch (e) { logger.error('❌ Failed to announce spades broken:', e); }
        }

        // Check if trick is complete
        // expectedTrickSize already declared above if needed
        logger.debug(`🔍 Trick completion check: trick.length=${this.trick.length}, expectedTrickSize=${expectedTrickSize}, players=${this.players.length}`);
        // Before starting a new trick, check if all players have one card left (last trick)

        if (this.trick.length === expectedTrickSize) {
            logger.debug(`✅ Trick is complete! Calling completeTrick()`);
        } else {
            // Trick continues: advance to next player
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            const nextPlayer = this.players[this.currentPlayerIndex];
            logger.debug(`➡️ Advanced currentPlayerIndex to ${this.currentPlayerIndex} (${nextPlayer.username})`);

            // Start timer for next player
            this.startPlayTimer(nextPlayer);

            // Schedule next AI if applicable
            if (nextPlayer.isAI) {
                this.scheduleAILead(TIMING.AI_TRICK_COMPLETION_DELAY);
            }
        }
    }

    /**
     * Get legal cards a player can play based on game rules
     * @param {Player} player 
     * @returns {Array} Array of legal Card objects
     */
    getLegalCards(player) {
        if (this.trick.length === 0) {
            // Leading - check spades broken rule
            if (!this.spadesBroken) {
                // Spades haven't been broken - can't lead spades unless that's all you have
                const nonSpades = player.hand.filter(c => c.suitCode !== 'S');
                if (nonSpades.length > 0) {
                    return nonSpades;
                }
                // Only have spades - can lead them (breaks spades)
                return [...player.hand];
            }
            // Spades broken - all cards are legal
            return [...player.hand];
        }

        const leadSuit = this.trick[0].card.suitCode;
        const cardsOfSuit = player.hand.filter(c => c.suitCode === leadSuit);
        
        if (cardsOfSuit.length > 0) {
            // Must follow suit if possible
            return cardsOfSuit;
        }
        
        // No cards of lead suit - all cards are legal
        return [...player.hand];
    }
    
    /**
     * ADDED: Parses and validates card input from a player.
     * @param {Player} player 
     * @param {string} input - Raw card code like 'AS', '10D', 'D10'
     * @returns {Card | {error: string}}
     */
    getCardFromInput(player, input) {
        const cleanInput = input.toUpperCase().trim();
        let suitCode = '';
        let rankCode = '';

        // Parse 3-character inputs (10D, D10)
        if (cleanInput.length === 3) {
            const suits = ['S', 'H', 'D', 'C'];
            if (cleanInput.startsWith('10') && suits.includes(cleanInput[2])) {
                rankCode = 'T';
                suitCode = cleanInput[2];
            } else if (suits.includes(cleanInput[0]) && cleanInput.endsWith('10')) {
                suitCode = cleanInput[0];
                rankCode = 'T';
            }
        }
        // Parse 2-character inputs (AS, 9D, SA, D9)
        else if (cleanInput.length === 2) {
            const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
            const suits = ['S', 'H', 'D', 'C'];
            
            if (ranks.includes(cleanInput[0]) && suits.includes(cleanInput[1])) {
                rankCode = cleanInput[0];
                suitCode = cleanInput[1];
            } else if (suits.includes(cleanInput[0]) && ranks.includes(cleanInput[1])) {
                suitCode = cleanInput[0];
                rankCode = cleanInput[1];
            }
        }

        if (!suitCode || !rankCode) {
            return { error: `Invalid card format "${input}". Use format like AS, 10D, or D10.` };
        }

        // Find the card in player's hand
        const card = player.hand.find(c => c.rankCode === rankCode && c.suitCode === suitCode);
        
        if (!card) {
            return { error: `You don't have that card in your hand.` };
        }

        return card;
    }

    /**
     * Generates a readable display string for a player's hand, sorted.
     * @param {Player} player 
     * @returns {string} Formatted list of card codes/displays.
     */
    getHandDisplay(player) {
        // Be defensive: some callers may pass plain objects (tests/mocks).
        if (player && typeof player.sortHand === 'function') {
            player.sortHand();
        } else if (player && Array.isArray(player.hand)) {
            // Fallback: sort by suit then value for display
            player.hand.sort((a, b) => {
                if (a.suitCode === b.suitCode) return b.value - a.value;
                return a.suitCode.localeCompare(b.suitCode);
            });
        }

        return (player && Array.isArray(player.hand)) ? player.hand.map(card => card.code || `${card.rankCode}${card.suitCode}`).join(' | ') : '';
    }

    // --- Player & Team Management ---

    /**
     * Adds a player and initializes their state.
     * @param {Object} playerDetails - Contains id, username, and guildId.
     * @returns {Object} Result object with either success or error.
     */
    addPlayer(playerDetails) {
        const maxPlayers = this.getMaxPlayers();
        if (this.players.length >= maxPlayers) {
            return { error: 'Lobby is full!' };
        }

        // Check if player is already in the game
        const existingPlayer = this.players.find(p => p.discordId === playerDetails.id);
        if (existingPlayer) {
            return { error: 'You are already in this game!' };
        }

        const newPlayer = new Player(playerDetails.id, playerDetails.username, playerDetails.preferences);
        newPlayer.guildId = playerDetails.guildId;
        newPlayer.score = 0;
        newPlayer.bags = 0;
        newPlayer.isAI = false; // Explicitly set for human players

        // Team assignment based on game mode
        if (this.isCutthroat()) {
            // Cutthroat: everyone plays solo
            newPlayer.team = null; // Or use player index: this.players.length + 1
        } else {
            // Classic: alternating teams (1, 2, 1, 2)
            const teamId = (this.players.length % 2 === 0) ? 1 : 2;
            newPlayer.team = teamId;
        }

        this.players.push(newPlayer);

        return { success: true };
    }

    /**
     * ADDED: Adds an AI player to the game
     * @param {string} [name] - Optional custom name for the AI
     * @returns {Object} Result object with either success or error
     */
    addAIPlayer(name) {
        const maxPlayers = this.getMaxPlayers();
        if (this.players.length >= maxPlayers) {
            return { error: 'Lobby is full!' };
        }

        // Pool of AI names
        const aiNames = [
            'Dale', 'Tucker', 'Allison', 'Chad', 'JohnDoe',
            'Quiet', 'Stu', 'Raven', 'Dollface', 'Zack',
            'Mr. Easy', 'SweetTooth', 'Beavis', 'Butthead', 'MilkMan',
            'Katniss', 'Smurf', 'JokerJoe', 'QueenOfHearts', 'KingKong',
            'SplendaDaddy', 'Gracin', 'BidBot', 'Tina', 'SpadeSally'
        ];

        // Get already used AI names
        const usedNames = this.players.filter(p => p.isAI).map(p => p.username);
        
        // Find available names
        const availableNames = aiNames.filter(n => !usedNames.includes(n));
        
        // Select a random name from available, or use custom name, or fallback
        let aiName;
        if (name) {
            aiName = name;
        } else if (availableNames.length > 0) {
            aiName = availableNames[Math.floor(Math.random() * availableNames.length)];
        } else {
            // All names used, add number
            const aiNumber = this.players.filter(p => p.isAI).length + 1;
            aiName = `AI Bot ${aiNumber}`;
        }

        const aiId = `ai_${Date.now()}_${Math.random()}`;

        const aiPlayer = new AIPlayer(aiId, aiName);
        aiPlayer.guildId = 'AI';
        aiPlayer.score = 0;
        aiPlayer.bags = 0;

        // Team assignment based on game mode
        if (this.isCutthroat()) {
            // Cutthroat: everyone plays solo
            aiPlayer.team = null;
        } else {
            // Classic: alternating teams (1, 2, 1, 2)
            const teamId = (this.players.length % 2 === 0) ? 1 : 2;
            aiPlayer.team = teamId;
        }

        this.players.push(aiPlayer);

        return { success: true, player: aiPlayer };
    }

    /**
     * Add AI with difficulty level (easy|medium|hard)
     */
    addAIPlayerWithLevel(name, level = 'medium') {
        const res = this.addAIPlayer(name);
        if (res.error) return res;
        const ai = res.player;
        ai.aiLevel = level;
        // Configure parameters based on level
        const cfg = {
            easy: { trials: 75, riskAversion: 0.9, aggressiveness: 0.35 },
            medium: { trials: 350, riskAversion: 0.6, aggressiveness: 0.6 },
            hard: { trials: 1200, riskAversion: 0.38, aggressiveness: 0.82 }
        };
        const s = cfg[level] || cfg.medium;
        ai.monteCarloTrials = s.trials;
        ai.riskAversion = s.riskAversion;
        ai.aggressiveness = s.aggressiveness;

        if (level === 'hard' && typeof ai.applyTuning === 'function') {
            ai.applyTuning(aiLearning.getHardProfile());

            // Guardrail: avoid chronically conservative hard bidding from learned profiles.
            ai.bidAdjustment = Math.max(ai.bidAdjustment || 0, 0.15);
        }

        return { success: true, player: ai };
    }

    /**
     * ADDED: Returns the current lobby size.
     */
    getLobbySize() {
        return this.players.length;
    }

    /**
     * Checks if the lobby has reached max players for the game mode.
     * @returns {boolean}
     */
    isLobbyFull() {
        return this.players.length >= this.getMaxPlayers();
    }

    // --- Game Setup and Dealing ---

    async startGame() {
        const requiredPlayers = this.getMinPlayers();
        if (this.players.length !== requiredPlayers) {
            const modeName = this.gameMode === 'cutthroat3' ? '3-Player Cutthroat' : 
                           this.gameMode === 'cutthroat4' ? '4-Player Cutthroat' : 'Classic Spades';
            this.publicAnnounce(`Error: ${modeName} requires exactly ${requiredPlayers} players to start.`);
            return;
        }

        logger.debug('🔄 Before reorganization:', this.players.map((p, i) => `${i}:${p.username}(T${p.team})`).join(', '));

        // Only reorganize for classic team mode
        if (!this.isCutthroat()) {
            // Reorganize players so teammates sit opposite each other
            // Positions 0 & 2 should be one team, 1 & 3 should be the other team
            const team1Players = this.players.filter(p => p.team === 1);
            const team2Players = this.players.filter(p => p.team === 2);
            
            // Arrange in alternating pattern: Team1, Team2, Team1, Team2
            this.players = [
                team1Players[0],
                team2Players[0],
                team1Players[1],
                team2Players[1]
            ];

            logger.debug('🔄 After reorganization:', this.players.map((p, i) => `${i}:${p.username}(T${p.team})`).join(', '));
        } else {
            logger.debug('🔄 Cutthroat mode - no team reorganization needed');
        }
        this.isGameActive = true;
        this.state = 'BIDDING';
        
        // Load opponent profiles for AI players
        await this.loadOpponentProfiles();
        
        await this.startRound();
    }

    /**
     * Load opponent profiles for all AI players to enable adaptive learning
     */
    async loadOpponentProfiles() {
        const aiPlayers = this.players.filter(p => p.isAI);
        if (aiPlayers.length === 0) return;

        logger.info(`🧠 Loading opponent profiles for ${aiPlayers.length} AI player(s)...`);

        for (const ai of aiPlayers) {
            const profiles = new Map();
            
            // Load profiles for all non-AI players
            const humanPlayers = this.players.filter(p => !p.isAI);
            for (const human of humanPlayers) {
                const profile = playerStats.getOpponentProfile(human.discordId);
                profiles.set(human.discordId, profile);
                
                if (profile.reliable) {
                    logger.info(`🧠 AI ${ai.username} knows ${human.username}: ${profile.biddingStyle} bidder, ${profile.playingStyle} player (${profile.sampleSize} hands observed)`);
                } else if (profile.sampleSize > 0) {
                    logger.debug(`🧠 AI ${ai.username} has limited data on ${human.username} (${profile.sampleSize} hands)`);
                }
            }
            
            ai.setOpponentProfiles(profiles);
            
            // Set trash talk preferences from game options (global for everyone)
            ai.setTrashTalkPreferences(
                this.options.trashTalk.enabled,
                this.options.trashTalk.frequency
            );
        }
    }

    /**
     * ADDED: Starts a new round (dealing cards and beginning bidding).
     */
    async startRound() {
        this.deck.reset();
        this.deck.shuffle();
        await this.dealCards();
        this.spadesBroken = false; // FIXED: Reset spades broken for new round
        this.startBidding();
    }

    async dealCards() {
        // Clear hands and reset round state
        this.players.forEach(p => p.resetForNewRound());
        
        // Reset trash talk hand counters for all AI players
        this.players.filter(p => p.isAI).forEach(ai => {
            trashTalk.resetHandCounters(ai.username);
        });
        
        // Reset bidding message ID for new round
        this.biddingMessageId = null;

        // For 3-player cutthroat, remove 2 of Clubs before dealing
        if (this.gameMode === 'cutthroat3') {
            this.deck.remove2OfClubs();
        }

        // Get dealer and first bidder info
        const dealer = this.players[this.dealerIndex];
        const firstBidderIndex = (this.dealerIndex + 1) % this.players.length;
        const firstBidder = this.players[firstBidderIndex];

        // Announce dealing with animation
        try {
            await this.publicAnnounce({
                type: 'dealing_cards',
                round: this.currentRound,
                dealer: { username: dealer.username, isAI: dealer.isAI, discordId: dealer.discordId },
                firstBidder: { username: firstBidder.username, isAI: firstBidder.isAI, discordId: firstBidder.discordId },
                players: this.players.map(p => ({ username: p.username, isAI: p.isAI }))
            });
        } catch (e) {
            logger.error('❌ Failed to announce dealing cards:', e);
        }

        // Deal cards based on game mode
        // cutthroat3: 51 cards (17 per player), classic/cutthroat4: 52 cards (13 per player)
        const totalCards = this.gameMode === 'cutthroat3' ? 51 : 52;
        for (let i = 0; i < totalCards; i++) {
            const card = this.deck.deal();
            const playerIndex = i % this.players.length;
            this.players[playerIndex].addCard(card);
        }

        // Sort hands
        this.players.forEach(player => player.sortHand());
    }

    // --- Bidding Logic ---

    startBidding() {
        this.state = 'BIDDING';
        this.isBiddingActive = true;
        this.bidsTaken = 0;
        this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;

        // Clear any pending bidding complete timeout from previous round
        if (this.biddingCompleteTimeout) {
            clearTimeout(this.biddingCompleteTimeout);
            this.biddingCompleteTimeout = null;
        }

        // Clear any pending AI bid timeout from previous round
        if (this.aiPendingBidTimeout) {
            clearTimeout(this.aiPendingBidTimeout);
            this.aiPendingBidTimeout = null;
        }

        // Clear any pending play timer from previous phase
        this.cancelPlayTimer();

        logger.debug(`🔔 startBidding: dealerIndex=${this.dealerIndex}, startingPlayerIndex=${this.currentPlayerIndex}`);
        logger.debug(`🔍 Players: ${this.players.map((p, i) => `${i}:${p.username}(${p.isAI ? 'AI' : 'Human'})`).join(', ')}`);

        // Check Blind Nil eligibility (team must be significantly behind)
        this.checkBlindNilEligibility();

        // Send initial bidding embed
        this.sendBiddingUpdate();

        // ADDED: Trigger AI bidding if current player is AI (with delay to allow message ID to be set)
        const currentPlayer = this.players[this.currentPlayerIndex];
        logger.debug(`🎯 First bidder: ${currentPlayer.username}, isAI=${currentPlayer.isAI}`);
        if (currentPlayer.isAI) {
            logger.debug(`🤖 Scheduling processAIBid for ${currentPlayer.username} in 500ms`);
            setTimeout(() => {
                this.processAIBid(currentPlayer);
            }, 500); // Small delay to ensure message ID is set
        } else {
            logger.debug(`👤 First bidder is human, waiting for player input`);
        }
    }

    /**
     * Checks which teams are eligible for Blind Nil (based on score deficit requirement).
     * Sets blindNilEligible flag on eligible players.
     * In cutthroat modes, Blind Nil is disabled (no teams).
     */
    checkBlindNilEligibility() {
        // Disable Blind Nil in cutthroat modes (no teams)
        if (this.isCutthroat()) {
            this.players.forEach(p => p.blindNilEligible = false);
            logger.debug(`🎯 Blind Nil eligibility check: Disabled in cutthroat mode`);
            return;
        }

        const team1 = this.players.filter(p => p.team === 1);
        const team2 = this.players.filter(p => p.team === 2);

        const team1Score = team1[0]?.score || 0;
        const team2Score = team2[0]?.score || 0;

        const team1Behind = team2Score - team1Score >= GAME_LIMITS.BLIND_NIL_SCORE_REQUIREMENT;
        const team2Behind = team1Score - team2Score >= GAME_LIMITS.BLIND_NIL_SCORE_REQUIREMENT;

        // Mark players as eligible for Blind Nil
        this.players.forEach(p => {
            p.blindNilEligible = (p.team === 1 && team1Behind) || (p.team === 2 && team2Behind);
        });

        logger.debug(`🎯 Blind Nil eligibility check:`);
        logger.debug(`   Team 1 Score: ${team1Score}, Team 2 Score: ${team2Score}`);
        logger.debug(`   Team 1 Behind by: ${team2Score - team1Score}, Eligible: ${team1Behind}`);
        logger.debug(`   Team 2 Behind by: ${team1Score - team2Score}, Eligible: ${team2Behind}`);
    }

    /**
     * Sends or updates the bidding embed with current bid status
     */
    sendBiddingUpdate() {
        const bids = this.players.map(p => ({
            playerName: p.username,
            playerId: p.discordId,
            isAI: p.isAI,
            bid: p.bid === null ? null : (p.bid === -1 ? 'Blind Nil' : p.bid === 0 ? 'Nil' : p.bid.toString())
        }));

        // Check if all bids are in
        const allBidsPlaced = this.players.every(p => p.bid !== null);
        
        const currentBidder = this.players[this.currentPlayerIndex];
        
        // Determine who can undo (last player to bid)
        let canUndoPlayerId = null;
        if (this.bidsTaken > 0) {
            if (allBidsPlaced) {
                // When all bids are complete, the current player IS the last bidder
                // (currentPlayerIndex hasn't advanced yet when bidding is complete)
                if (!currentBidder.isAI && currentBidder.bid !== null) {
                    canUndoPlayerId = currentBidder.discordId;
                }
            } else {
                // Normal case: last bidder is the one before current player
                const lastBidderIndex = (this.currentPlayerIndex - 1 + this.players.length) % this.players.length;
                const lastBidder = this.players[lastBidderIndex];
                // Allow undo for human players
                if (!lastBidder.isAI && lastBidder.bid !== null) {
                    canUndoPlayerId = lastBidder.discordId;
                }
            }
        }
        
        // Check if AI is pending bid (allows previous player to undo during the wait)
        const aiPendingBid = currentBidder.isAI && this.aiPendingBidTimeout !== null;
        
        this.publicAnnounce({
            type: 'bidding_update',
            bids: bids,
            currentBidderName: currentBidder.username,
            currentBidderId: currentBidder.discordId,
            isCurrentBidderAI: currentBidder.isAI,
            messageId: this.biddingMessageId,
            round: this.currentRound,
            biddingComplete: allBidsPlaced,
            canUndoPlayerId: canUndoPlayerId,
            aiPendingBid: aiPendingBid
        });
    }

    /**
     * Handles a bid from a player via button interaction.
     * Returns structured data for interaction response.
     * @param {string} playerId - Discord ID of the player
     * @param {number} bidAmount - -1 for Blind Nil, 0 for Nil, 1–13 otherwise
     * @returns {object} Result object with bidDisplay, error, biddingComplete, bidsRemaining
     */
    tryPlaceBid(playerId, bidAmount) {
        if (!this.isBiddingActive || this.state !== 'BIDDING') {
            return { error: 'Bidding is not currently active.' };
        }

        const currentPlayer = this.players[this.currentPlayerIndex];
        
        logger.debug(`🔍 tryPlaceBid DEBUG:`);
        logger.debug(`   playerId passed in: ${playerId}`);
        logger.debug(`   currentPlayer.username: ${currentPlayer.username}`);
        logger.debug(`   currentPlayer.discordId: ${currentPlayer.discordId}`);
        logger.debug(`   currentPlayer.id: ${currentPlayer.id}`);
        logger.debug(`   Match: ${currentPlayer.discordId === playerId}`);

        if (currentPlayer.discordId !== playerId) {
            return { error: `It is not your turn to bid. Please wait for your turn.` };
        }

        if (typeof bidAmount !== 'number' || bidAmount < -1 || bidAmount > 13) {
            return { error: 'Invalid bid amount. Must be -1 (Blind Nil), 0 (Nil), or between 1 and 13.' };
        }

        // Check Blind Nil eligibility
        if (bidAmount === -1 && !currentPlayer.blindNilEligible) {
            // Context-aware error message
            if (this.isCutthroat()) {
                return { error: 'Blind Nil is not available in Cutthroat mode. You can bid regular Nil (0) instead.' };
            } else {
                return { error: `Your team must be ${GAME_LIMITS.BLIND_NIL_SCORE_REQUIREMENT}+ points behind to bid Blind Nil.` };
            }
        }

        currentPlayer.setBid(bidAmount);
        this.bidsTaken++;

        // --- OPPONENT MODELING: Track bidding patterns ---
        // Only track human players (not AI)
        if (!currentPlayer.isAI) {
            // Initialize observation tracking for this player this hand
            if (!this.handObservations[playerId]) {
                this.handObservations[playerId] = {};
            }
            
            // Calculate hand strength for bid correlation analysis
            const handStrength = this.calculateHandStrength(currentPlayer);
            
            this.handObservations[playerId].bid = bidAmount;
            this.handObservations[playerId].handStrength = handStrength.totalStrength;
            this.handObservations[playerId].bidNil = (bidAmount === 0 || bidAmount === -1);
            
            logger.debug(`📊 Tracking ${currentPlayer.username}'s bid: ${bidAmount} (hand strength: ${handStrength.totalStrength})`);
        }

        // Track Nil and Blind Nil bids for statistics
        if (!this.playerStatTracking[playerId]) {
            this.playerStatTracking[playerId] = {
                nilBids: 0,
                blindNilBids: 0,
                nilSuccesses: 0,
                blindNilSuccesses: 0
            };
        }
        
        if (bidAmount === 0) {
            this.playerStatTracking[playerId].nilBids++;
        } else if (bidAmount === -1) {
            this.playerStatTracking[playerId].blindNilBids++;
        }

        const bidDisplay = bidAmount === -1 ? 'Blind Nil' : bidAmount === 0 ? 'Nil' : bidAmount.toString();

        let biddingComplete = false;
        if (this.bidsTaken < this.players.length) {
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            logger.debug(`📝 tryPlaceBid: advanced to index ${this.currentPlayerIndex} (${this.players[this.currentPlayerIndex].username})`);

            // Update the bidding embed
            this.sendBiddingUpdate();

            // ADDED: Trigger AI bidding if next player is AI (with 10 second delay to allow previous player to undo)
            const nextPlayer = this.players[this.currentPlayerIndex];
            if (nextPlayer.isAI) {
                logger.debug(`🤖 tryPlaceBid: scheduling AI bid for ${nextPlayer.username} in 10 seconds`);
                this.aiPendingBidTimeout = setTimeout(() => {
                    this.aiPendingBidTimeout = null;
                    this.processAIBid(nextPlayer);
                }, TIMING.AI_BID_DELAY); // Delay to give previous player time to undo
            }
        } else {
            biddingComplete = true;
            logger.debug('🎯 tryPlaceBid: biddingComplete=true -> scheduling endBidding with delay');
            
            // Send final bidding update showing all bids complete (with undo button)
            this.sendBiddingUpdate();
            
            // Give the last player time to undo their bid before ending bidding
            this.biddingCompleteTimeout = setTimeout(() => {
                logger.debug('⏰ Bidding complete timeout reached, ending bidding phase');
                this.endBidding();
            }, TIMING.UNDO_BID_DELAY);
        }

        return {
            bidDisplay,
            error: null,
            biddingComplete,
            bidsRemaining: this.players.length - this.bidsTaken
        };
    }

    /**
     * Allows a player to undo their bid (only if they were the last to bid)
     * @param {string} playerId - Discord ID of the player
     * @returns {object} Result object with success or error
     */
    undoBid(playerId) {
        if (!this.isBiddingActive) {
            return { error: 'Bidding is not currently active.' };
        }

        // Find the player
        const player = this.players.find(p => p.discordId === playerId);
        if (!player) {
            return { error: 'Player not found in this game.' };
        }

        // Check if player has a bid to undo
        if (player.bid === null || player.bid === undefined) {
            return { error: 'You have not placed a bid yet.' };
        }

        // Check if all bids are complete
        const allBidsPlaced = this.players.every(p => p.bid !== null);
        
        // Calculate who bid last
        let lastBidderIndex;
        if (allBidsPlaced) {
            // When bidding is complete, currentPlayerIndex still points to the last bidder
            lastBidderIndex = this.currentPlayerIndex;
        } else {
            // Normal case: last bidder is the one before current player
            lastBidderIndex = (this.currentPlayerIndex - 1 + this.players.length) % this.players.length;
        }
        
        const lastBidder = this.players[lastBidderIndex];

        // Only allow undo if this player was the last to bid
        if (lastBidder.discordId !== playerId) {
            return { error: 'You can only undo your bid immediately after placing it. Another player has already bid.' };
        }

        // Store the old bid for display
        const oldBid = player.bid === -1 ? 'Blind Nil' : player.bid === 0 ? 'Nil' : player.bid.toString();

        // Undo the bid
        const wasBlindNil = player.bid === -1;
        const wasNil = player.bid === 0;
        
        player.bid = null;
        player.isNil = false;
        player.isBlindNil = false;
        this.bidsTaken--;

        // Cancel the bidding complete timeout if it exists
        if (this.biddingCompleteTimeout) {
            clearTimeout(this.biddingCompleteTimeout);
            this.biddingCompleteTimeout = null;
            logger.debug('⏰ Cancelled bidding complete timeout due to undo');
        }

        // Cancel any pending AI bid timeout if it exists
        if (this.aiPendingBidTimeout) {
            clearTimeout(this.aiPendingBidTimeout);
            this.aiPendingBidTimeout = null;
            logger.debug('⏰ Cancelled AI pending bid timeout due to undo');
        }

        // Update stat tracking if needed
        if (this.playerStatTracking[playerId]) {
            if (wasNil) {
                this.playerStatTracking[playerId].nilBids = Math.max(0, this.playerStatTracking[playerId].nilBids - 1);
            } else if (wasBlindNil) {
                this.playerStatTracking[playerId].blindNilBids = Math.max(0, this.playerStatTracking[playerId].blindNilBids - 1);
            }
        }

        // Move current player index back to this player
        this.currentPlayerIndex = lastBidderIndex;

        // Update the bidding embed
        this.sendBiddingUpdate();

        return {
            success: true,
            oldBid: oldBid,
            playerName: player.username
        };
    }

    /**
     * ADDED: Process an AI player's bid
     */
    processAIBid(aiPlayer) {
        if (!aiPlayer.isAI) return;

        const bidAmount = aiPlayer.calculateBid(this);
        logger.debug(`🤖 processAIBid: ${aiPlayer.username} calculated bid ${bidAmount}`);
        const result = this.tryPlaceBid(aiPlayer.discordId, bidAmount);

        logger.debug(`🤖 processAIBid result for ${aiPlayer.username}:`, result);
        
        // The bidding embed is automatically updated by tryPlaceBid via sendBiddingUpdate()
        // No need for individual AI bid announcements
    }

    endBidding() {
        this.isBiddingActive = false;
        this.state = 'PLAYING';
        this.trick = [];
        this.trickSuit = null;
        // Ensure the player to lead is the one to the left of the dealer
        // (bidding advanced the currentPlayerIndex through each bidder,
        // so reset it to dealer+1 which is the correct first leader)
        if (typeof this.dealerIndex === 'number' && this.players.length > 0) {
            this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
        }
        logger.debug(`🏁 endBidding: set currentPlayerIndex=${this.currentPlayerIndex} (${this.players[this.currentPlayerIndex].username})`);

        // Send bidding complete summary with structured payload
        const firstPlayer = this.players[this.currentPlayerIndex];
        this.publicAnnounce({
            type: 'bidding_complete',
            firstPlayerName: firstPlayer.username,
            firstPlayerId: firstPlayer.discordId,
            isAI: firstPlayer.isAI,
            teamScoreDisplay: this.getTeamScoreDisplay()
        });

        // If the first leader is an AI, trigger its play
        if (firstPlayer && firstPlayer.isAI) {
            logger.debug(`🤖 endBidding: first leader ${firstPlayer.username} is AI — scheduling play`);
            // Use centralized scheduler so other call sites don't double-schedule
            this.scheduleAILead(2000);
        } else {
            logger.debug(`👤 endBidding: first leader ${firstPlayer?.username} is human`);
            // Start timer for human player
            this.startPlayTimer(firstPlayer);
        }
    }

    /**
     * ADDED: Process an AI player's card play
     * @param {AIPlayer} aiPlayer - The AI player
     * @returns {object} Result with card played or error
     */
    async processAIPlay(aiPlayer) {
        if (!aiPlayer.isAI || this.state !== 'PLAYING') {
            logger.debug(`⛔ processAIPlay skipped: isAI=${aiPlayer.isAI}, state=${this.state}`);
            return { error: 'Invalid AI play state' };
        }

        // Additional guard: Check if player already has a card in the current trick
        const hasPlayedThisTrick = this.trick.some(play => play.player.id === aiPlayer.id);
        if (hasPlayedThisTrick) {
            logger.debug(`⛔ processAIPlay blocked: ${aiPlayer.username} already played in this trick`);
            return { error: 'Already played this trick' };
        }

        // Debounce duplicate requests for the same AI within a short window
        try {
            const now = Date.now();
            const last = this._aiPlayTimestamps.get(aiPlayer.id) || 0;
            const DEBOUNCE_MS = 900; // allow ~0.9s between invocations
            if (now - last < DEBOUNCE_MS) {
                logger.debug(`⏱️ Debounced duplicate processAIPlay for ${aiPlayer.username} (last ${now - last}ms ago)`);
                return { error: 'AI play debounced' };
            }
            // Record this request time
            this._aiPlayTimestamps.set(aiPlayer.id, now);
        } catch (e) {
            logger.error('❌ Error checking AI debounce timestamp:', e);
        }

        const currentPlayer = this.players[this.currentPlayerIndex];
        logger.debug(`▶️ processAIPlay called for ${aiPlayer.username}. currentPlayerIndex=${this.currentPlayerIndex}, currentPlayer=${currentPlayer?.username}`);
        if (currentPlayer.id !== aiPlayer.id) {
            logger.debug(`⛔ Not AI's turn: expected ${currentPlayer.id} but got ${aiPlayer.id}`);
            return { error: 'Not AI turn' };
        }

        // If another AI is currently playing, avoid concurrent play — reschedule shortly
        if (this._aiPlaying) {
            logger.debug(`🔒 processAIPlay: aiPlaying lock active; rescheduling play for ${aiPlayer.username}`);
            // attempt to reschedule via centralized scheduler; small delay
            this.scheduleAILead(300);
            return { error: 'aiPlaying_locked' };
        }

        // Acquire per-game AI lock
        this._aiPlaying = true;
        logger.debug(`🔓 processAIPlay: acquired aiPlaying lock for ${aiPlayer.username}`);

        try {

        // Let the UI show an AI-thinking indicator, then pick a card
        try {
            // Await so the UI shows thinking indicator before heavy compute and so ordering is preserved
            await this.publicAnnounce({ type: 'ai_thinking', playerName: aiPlayer.username, duration: 1200 });
        } catch (e) {
            logger.error('❌ Failed to send ai_thinking payload:', e);
        }

        // small pause so the thinking message displays before heavy Monte-Carlo
        await new Promise(resolve => setTimeout(resolve, 600));

        // AI selects a card to play
        const cardToPlay = aiPlayer.selectCardToPlay(this);

        logger.debug(`🤖 ${aiPlayer.username} selected card: ${cardToPlay ? `${cardToPlay.rankCode}${cardToPlay.suitCode}` : 'none'}`);
        if (!cardToPlay) {
            logger.error(`AI ${aiPlayer.username} could not select a card!`);
            return { error: 'AI selection failed' };
        }

        // Execute the play
        this.trick.push({ player: aiPlayer, card: cardToPlay });
        aiPlayer.removeCard(cardToPlay);

        // Record the played card so other AIs can learn (include who played it)
        try {
            this.recordPlayedCard(cardToPlay, aiPlayer.id);
        } catch (e) {
            logger.error('❌ Failed to record played card:', e);
        }

        // Announce the play via structured payload so the caller can render images. Await to preserve ordering.
        try {
            // Determine next player if trick isn't complete yet
            let nextPlayerName = null;
            let nextPlayerId = null;
            let isNextPlayerAI = false;
            const expectedTrickSize = this.players.length; // 3 or 4 players
            if (this.trick.length < expectedTrickSize) {
                const nextPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
                const nextPlayer = this.players[nextPlayerIndex];
                nextPlayerName = nextPlayer.username;
                nextPlayerId = nextPlayer.discordId;
                isNextPlayerAI = nextPlayer.isAI;
            }

            await this.publicAnnounce({
                type: 'trick_update',
                trick: this.trick.map(play => ({
                    playerId: play.player.id,
                    playerName: play.player.username,
                    card: { rankCode: play.card.rankCode, suitCode: play.card.suitCode, value: play.card.value }
                })),
                messageId: this.currentTrickMessageId, // Current trick cards message (for cards 2-4 deletion)
                previousTrickCardsMessageId: this.previousTrickCardsMessageId, // For first card: delete old trick cards
                nextPlayerName: nextPlayerName,
                nextPlayerId: nextPlayerId,
                isNextPlayerAI: isNextPlayerAI
            });
        } catch (e) {
            logger.error('❌ Failed while publicAnnounce(trick_update):', e);
        }

        // Check if spades broken
        if (cardToPlay.suitCode === 'S' && !this.spadesBroken) {
            this.spadesBroken = true;
            try { await this.publicAnnounce({ type: 'spades_broken' }); } catch (e) { logger.error('❌ Failed to announce spades broken:', e); }
        }

        // Check if trick is complete
        const expectedTrickSize = this.players.length; // 3 or 4 players
        logger.debug(`🔍 Trick completion check (AI): trick.length=${this.trick.length}, expectedTrickSize=${expectedTrickSize}, players=${this.players.length}`);
        if (this.trick.length === expectedTrickSize) {
            logger.debug(`✅ Trick is complete! Calling completeTrick()`);
            // await completing trick so announcements (trick_won) are sent in order
            await this.completeTrick();
        } else {
            // Trick continues: advance to next player
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            logger.debug(`➡️ Advanced currentPlayerIndex to ${this.currentPlayerIndex} (${this.players[this.currentPlayerIndex].username})`);
            const nextPlayer = this.players[this.currentPlayerIndex];

            // No need to announce next player - it's already shown in the trick embed

            // Schedule next AI play if applicable
            if (nextPlayer.isAI && this.state === 'PLAYING') {
                logger.debug(`🎲 Scheduling next AI play for ${nextPlayer.username} after previous AI play`);
                this.scheduleAILead(2000);
            } else {
                logger.debug(`👤 Next player ${nextPlayer.username} is human or game not in PLAYING state`);
            }
        }

        return { success: true, card: cardToPlay };
        } finally {
            // Release lock in finally so it always gets cleared
            this._aiPlaying = false;
            logger.debug(`🔒 processAIPlay: released aiPlaying lock for ${aiPlayer.username}`);
        }
    }

    /**
     * Record a card as played; push into AI players' seen lists.
     * @param {Card} card
     */
    recordPlayedCard(card, playedBy = null) {
        if (!card) return;
        this.players.forEach(p => {
            if (p.isAI && Array.isArray(p.playedCards)) {
                // store minimal info: rankCode and suitCode and value and who played it
                p.playedCards.push({ rankCode: card.rankCode, suitCode: card.suitCode, value: card.value, playedBy });
            }
        });
    }

    /**
     * ADDED: Complete a trick and determine winner
     */
    async completeTrick() {
        const { winningPlayer, winningCard } = this.determineTrickWinner();

        if (!winningPlayer) {
            logger.error("Error: Could not determine trick winner");
            return;
        }

        // --- Prevent further scheduling if last trick was auto-played ---
        if (this.isAutoPlayingLastTrick) {
            // Last trick auto-play just completed, skip all further scheduling
            this.isAutoPlayingLastTrick = false;
            logger.debug('[DEBUG] [LAST TRICK] Early return after auto-play. No timers or AI scheduling.');
            return;
        }

        winningPlayer.tricks++;

        // Save trick to history for spectators
        this.trickHistory.push({
            plays: this.trick.map(entry => ({
                player: { id: entry.player.id, username: entry.player.username },
                card: { rankCode: entry.card.rankCode, suitCode: entry.card.suitCode }
            })),
            winner: { id: winningPlayer.id, username: winningPlayer.username }
        });

        // --- TRASH TALK: Detect per-trick events ---
        if (winningPlayer.isAI) {
            const leadSuit = this.trick[0].card.suitCode;
            const winnerEntry = this.trick.find(entry => entry.player.id === winningPlayer.id);
            const aiCard = winnerEntry.card;
            
            // Check for trump play (AI played spade when not leading suit)
            if (aiCard.suitCode === 'S' && leadSuit !== 'S') {
                await winningPlayer.sendTrashTalk('trumpPlay', this.channel);
            }
            // Check for Ace played to win
            else if (aiCard.rankCode === 'A') {
                await winningPlayer.sendTrashTalk('acePlayed', this.channel);
            }
            // Check for King or Queen winning (big card)
            else if (aiCard.rankCode === 'K' || aiCard.rankCode === 'Q') {
                await winningPlayer.sendTrashTalk('bigCardWin', this.channel);
            }
        }
        
        // Check if AI led with a 2 or 3 and someone wasted an Ace on it
        const leadEntry = this.trick[0];
        if (leadEntry.player.isAI && (leadEntry.card.rankCode === '2' || leadEntry.card.rankCode === '3')) {
            // Check if any human player used an Ace to take it
            const aceEntry = this.trick.find(entry => 
                !entry.player.isAI && 
                entry.card.rankCode === 'A' && 
                entry.card.suitCode === leadEntry.card.suitCode
            );
            if (aceEntry) {
                // AI trash talks about the overkill
                await leadEntry.player.sendTrashTalk('aceOnLowLead', this.channel);
            }
        }

        // Announce trick won with structured payload so the front-end can render images
        try {
            await this.publicAnnounce({
                type: 'trick_won',
                playerName: winningPlayer.username,
                card: { rankCode: winningCard.rankCode, suitCode: winningCard.suitCode, value: winningCard.value },
                tricks: winningPlayer.tricks,
                messageId: this.currentTrickMessageId // Pass the message ID to update the same embed
            });
        } catch (e) {
            logger.error('❌ Failed during publicAnnounce(trick_won):', e);
        }

        // Save current trick's message ID for deletion when next trick starts
        this.previousTrickCardsMessageId = this.currentTrickMessageId;
        logger.debug(`💾 Saved previousTrickCardsMessageId: ${this.previousTrickCardsMessageId}`);
        
        this.trick = [];
        this.currentTrickMessageId = null; // Reset for next trick
        // Set the leader to the trick winner
        const winnerIndex = this.players.findIndex(p => p.id === winningPlayer.id);
        this.currentPlayerIndex = winnerIndex;
        // Diagnostic logging to help debug missed scheduling
        logger.debug(`🏁 completeTrick: winner=${winningPlayer.username}[id=${winningPlayer.id}] at index=${winnerIndex}`);
        logger.debug('   Players order:', this.players.map((p, i) => `${i}:${p.username}[id=${p.id}]`).join(' | '));
        logger.debug(`   currentPlayerIndex set to ${this.currentPlayerIndex}, state=${this.state}`);

        // --- LAST TRICK AUTO-PLAY LOGIC ---
        // Check if all players have exactly 1 card left - if so, auto-play the final trick (if option enabled)
        const allPlayersHaveOneCard = this.players.every(p => p.hand.length === 1);
        if (this.options.autoPlayLastTrick && allPlayersHaveOneCard && !this.isAutoPlayingLastTrick) {
            this.isAutoPlayingLastTrick = true;
            const expectedTrickSize = this.players.length;
            logger.debug(`[DEBUG] [LAST TRICK] All players have one card. Auto-playing entire last trick.`);
            try {
                await this.publicAnnounce({ type: 'message', message: '🎴 **Last Trick - Auto-Playing All Cards...**' });
            } catch (e) {
                logger.error('❌ Failed to announce last trick auto-play:', e);
            }
            
            // Auto-play all remaining cards with 3-second delay between each
            for (let i = 0; i < expectedTrickSize; i++) {
                const player = this.players[(this.currentPlayerIndex + i) % this.players.length];
                const lastCard = player.hand[0];
                logger.debug(`[DEBUG] [LAST TRICK] Auto-playing ${lastCard.rankCode}${lastCard.suitCode} for ${player.username}, hand.length=${player.hand.length}`);
                this.trick.push({ player, card: lastCard });
                player.removeCard(lastCard);
                try { this.recordPlayedCard(lastCard, player.id); } catch (e) { logger.error('❌ Failed to record played card:', e); }
                try {
                    await this.publicAnnounce({
                        type: 'trick_update',
                        trick: this.trick.map(play => ({ playerId: play.player.id, playerName: play.player.username, card: { rankCode: play.card.rankCode, suitCode: play.card.suitCode, value: play.card.value } })),
                        messageId: this.currentTrickMessageId,
                        previousTrickCardsMessageId: this.previousTrickCardsMessageId,
                        nextPlayerName: null,
                        nextPlayerId: null,
                        isNextPlayerAI: false
                    });
                } catch (e) {
                    logger.error('❌ Failed during publicAnnounce(trick_update):', e);
                }
                if (lastCard.suitCode === 'S' && !this.spadesBroken) {
                    this.spadesBroken = true;
                    try { await this.publicAnnounce({ type: 'spades_broken' }); } catch (e) { logger.error('❌ Failed to announce spades broken:', e); }
                }
                
                // Add 3-second delay between cards (except after the last card)
                if (i < expectedTrickSize - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
            
            logger.debug('[DEBUG] [LAST TRICK] Last trick auto-play complete! Recursively calling completeTrick()');
            // Reset flag BEFORE recursive call so completeTrick processes normally
            this.isAutoPlayingLastTrick = false;
            // Recursively complete the auto-played trick
            await this.completeTrick();
            return;
        }

        // Check if round is over
        const totalTricks = this.players.reduce((sum, p) => sum + p.tricks, 0);
        // In cutthroat3: 17 tricks (51 cards ÷ 3 players), in classic/cutthroat4: 13 tricks (52 cards ÷ 4 players)
        const expectedTotalTricks = this.gameMode === 'cutthroat3' ? 17 : 13;
        logger.debug(`🔍 Round completion check: totalTricks=${totalTricks}, expectedTotalTricks=${expectedTotalTricks}`);
        
        if (totalTricks === expectedTotalTricks) {
            this.endRound();
        } else {
            const nextPlayer = this.players[this.currentPlayerIndex];
            try { await this.publicAnnounce(`**${nextPlayer.username}** will lead the next trick.`); } catch (e) { logger.error('❌ Failed to announce next leader:', e); }
            
            // Schedule next AI play if it's their turn
            if (nextPlayer.isAI && this.state === 'PLAYING') {
                logger.debug(`🎲 Scheduling AI play for ${nextPlayer.username} after trick completion`);
                this.scheduleAILead(2500); // 2.5 second delay
            } else {
                logger.debug(`👤 Next trick leader ${nextPlayer.username} is human or game not in PLAYING state`);
            }
        }
    }

    /**
     * ADDED: End the round and calculate scores
     */
    endRound() {
        const { roundSummary, isGameOver, trashTalkEvents } = this.calculateRoundScores();
        
        // --- OPPONENT MODELING: Analyze patterns and update profiles ---
        this.analyzeHandPatterns();
        
        // --- TRASH TALK: Send trash talk messages after round ---
        this.sendRoundEndTrashTalk(trashTalkEvents);

        // --- HARD AI TELEMETRY: emit and persist set-pressure summary before next-round reset ---
        for (const p of this.players) {
            if (p?.isAI && typeof p.consumeSetPressureRoundSummary === 'function') {
                const stats = p.consumeSetPressureRoundSummary();
                if (!stats) continue;

                const key = p.discordId || p.id || p.username;
                if (!this.hardSetPressureGameTotals[key]) {
                    this.hardSetPressureGameTotals[key] = {
                        username: p.username,
                        team: p.team,
                        rounds: 0,
                        opportunities: 0,
                        leadPressurePlays: 0,
                        followPressureCaptures: 0
                    };
                }

                const total = this.hardSetPressureGameTotals[key];
                total.rounds += 1;
                total.opportunities += stats.opportunities;
                total.leadPressurePlays += stats.leadPressurePlays;
                total.followPressureCaptures += stats.followPressureCaptures;

                const seatIndex = this.players.findIndex(player => player === p);
                const seat = seatIndex >= 0 ? seatIndex + 1 : null;
                const bidGap = (stats.tricks || 0) - (stats.bid || 0);
                const bidGapBucket =
                    bidGap <= -3 ? '<=-3' :
                    bidGap === -2 ? '-2' :
                    bidGap === -1 ? '-1' :
                    bidGap === 0 ? '0' :
                    bidGap === 1 ? '+1' :
                    bidGap === 2 ? '+2' : '>=+3';

                let aiTeamScore = null;
                let opponentTeamScore = null;
                let scoreDiff = null;
                let scoreState = 'unknown';

                if (!this.isCutthroat() && (p.team === 1 || p.team === 2)) {
                    const aiTeamPlayers = this.players.filter(player => player.team === p.team);
                    const opponentTeam = p.team === 1 ? 2 : 1;
                    const opponentPlayers = this.players.filter(player => player.team === opponentTeam);

                    aiTeamScore = aiTeamPlayers.length > 0 ? (aiTeamPlayers[0].score || 0) : 0;
                    opponentTeamScore = opponentPlayers.length > 0 ? (opponentPlayers[0].score || 0) : 0;
                    scoreDiff = aiTeamScore - opponentTeamScore;

                    if (scoreDiff >= 100) {
                        scoreState = 'leading_big';
                    } else if (scoreDiff >= 25) {
                        scoreState = 'leading';
                    } else if (scoreDiff > -25) {
                        scoreState = 'even';
                    } else if (scoreDiff > -100) {
                        scoreState = 'trailing';
                    } else {
                        scoreState = 'trailing_big';
                    }
                }

                aiHardTelemetryStore.recordRound({
                    gameId: this.telemetryGameId,
                    round: this.currentRound,
                    gameMode: this.gameMode,
                    targetScore: this.options?.targetScore,
                    seat,
                    aiPlayerId: key,
                    aiUsername: p.username,
                    aiTeam: p.team,
                    aiTeamScore,
                    opponentTeamScore,
                    scoreDiff,
                    scoreState,
                    bidGap,
                    bidGapBucket,
                    stats
                });
            }
        }

        // --- GENERAL TELEMETRY: persist round-level bid/trick snapshots for all games ---
        try {
            const roundPlayerSnapshots = this.players.map((p, index) => ({
                seat: index + 1,
                discordId: p.discordId || p.id || null,
                username: p.username,
                isAI: !!p.isAI,
                aiLevel: p.isAI ? (p.aiLevel || 'medium') : 'human',
                team: p.team,
                bid: p.bid ?? 0,
                tricks: p.tricks ?? 0,
                score: p.score ?? 0,
                bags: p.bags ?? 0,
                bidGap: (p.tricks ?? 0) - (p.bid ?? 0),
                nilBid: !!p.isNil,
                blindNilBid: !!p.isBlindNil
            }));

            const finalTrick = this.trickHistory.length > 0 ? this.trickHistory[this.trickHistory.length - 1] : null;
            const finalTrickContext = finalTrick ? {
                plays: (Array.isArray(finalTrick.plays) ? finalTrick.plays : []).map((play, playIndex) => {
                    const seated = this.players.find(player => player.id === play.player.id);
                    const seat = this.players.findIndex(player => player.id === play.player.id) + 1;
                    return {
                        order: playIndex + 1,
                        seat: seat > 0 ? seat : null,
                        playerId: play.player.id,
                        team: seated?.team ?? null,
                        aiLevel: seated?.isAI ? (seated.aiLevel || 'medium') : 'human'
                    };
                }),
                winnerSeat: (() => {
                    const winnerIndex = this.players.findIndex(player => player.id === finalTrick?.winner?.id);
                    return winnerIndex >= 0 ? winnerIndex + 1 : null;
                })()
            } : null;

            gameTelemetryStore.recordRound({
                gameId: this.telemetryGameId,
                guildId: this.guildId || null,
                channelId: this.channelId || null,
                round: this.currentRound,
                gameMode: this.gameMode,
                targetScore: this.options?.targetScore,
                humanPlayerCount: this.players.filter(p => !p.isAI).length,
                aiPlayerCount: this.players.filter(p => p.isAI).length,
                humanOnlyGame: this.players.every(p => !p.isAI),
                players: roundPlayerSnapshots,
                finalTrick: finalTrickContext
            });
        } catch (error) {
            logger.error('Failed to persist general round telemetry:', error);
        }

        // --- SPECTATOR NOTIFICATIONS: Notify about round end ---
        if (this.spectatorView) {
            let roundNotif = `**Hand ${this.currentRound} Complete!**\n`;
            for (const summary of roundSummary) {
                roundNotif += `${summary.playerName}: ${summary.bidsMade ? '✅' : '❌'} (${summary.tricksWon}/${summary.bid})\n`;
            }
            this.spectatorView.notifySpectators(roundNotif);
        }

        // Send structured round-end payload so the front-end (index.js) can render a rich embed
        this.publicAnnounce({
            type: 'round_end',
            round: this.currentRound,
            roundSummary,
            teamScoreDisplay: this.getTeamScoreDisplay()
        });

        if (isGameOver) {
            this.endGame(); // endGame() sends the game_over payload which handles the announcement
            this.isGameActive = false;
        } else {
            // Clear trick history for new round
            this.trickHistory = [];
            this.currentRound++;
            this.dealerIndex = (this.dealerIndex + 1) % this.players.length;
            
            setTimeout(async () => {
                // Calculate who will be dealer and first bidder BEFORE starting the round
                const nextDealer = this.players[this.dealerIndex];
                const firstBidderIndex = (this.dealerIndex + 1) % this.players.length;
                const firstBidder = this.players[firstBidderIndex];
                
                // Dealer and first bidder info now included in dealing_cards embed
                
                // Now start the round (which will call startBidding and modify currentPlayerIndex)
                await this.startRound();
            }, 3000); // 3 second delay before new round
        }
    }
    getTeamScoreDisplay() {
        if (this.isCutthroat()) {
            // Cutthroat mode: Individual scores
            return this.players.map(p => 
                `**${p.username}**: Bid **${p.bid === null ? '?' : p.bid}**, Score **${p.score}**, Bags **${p.bags}**`
            ).join('\n');
        } else {
            // Classic mode: Team scores
            const team1 = this.players.filter(p => p.team === 1);
            const team2 = this.players.filter(p => p.team === 2);

            const team1Bid = team1.reduce((sum, p) => sum + (p.bid || 0), 0);
            const team2Bid = team2.reduce((sum, p) => sum + (p.bid || 0), 0);

            // FIXED: Team score is stored only in the first player of each team
            const team1Score = team1[0].score;
            const team2Score = team2[0].score;

            const team1Bags = team1[0].bags;
            const team2Bags = team2[0].bags;

            return `🟦 **Team 1** (${team1.map(p => p.username).join(' & ')}): Bid **${team1Bid}**, Score **${team1Score}**, Bags **${team1Bags}**\n` +
                   `🟥 **Team 2** (${team2.map(p => p.username).join(' & ')}): Bid **${team2Bid}**, Score **${team2Score}**, Bags **${team2Bags}**`;
        }
    }

    // --- Trick Playing Logic ---

    /**
     * ADDED: Determines the winner of the current trick.
     * @returns {{winningPlayer: Player, winningCard: Card}}
     */
    determineTrickWinner() {
        const expectedTrickSize = this.players.length; // 3 for cutthroat3, 4 for classic/cutthroat4
        
        if (this.trick.length !== expectedTrickSize) {
            return { winningPlayer: null, winningCard: null };
        }

        const leadSuit = this.trick[0].card.suitCode;
        let winningEntry = this.trick[0];

        for (let i = 1; i < expectedTrickSize; i++) {
            const currentEntry = this.trick[i];
            const winningCard = winningEntry.card;
            const currentCard = currentEntry.card;

            const isWinningSpade = winningCard.suitCode === 'S';
            const isCurrentSpade = currentCard.suitCode === 'S';

            // Spade trumps non-spade
            if (isCurrentSpade && !isWinningSpade) {
                winningEntry = currentEntry;
            } else if (isWinningSpade && isCurrentSpade) {
                // Higher spade wins
                if (currentCard.value > winningCard.value) {
                    winningEntry = currentEntry;
                }
            } else if (currentCard.suitCode === leadSuit && winningCard.suitCode === leadSuit) {
                // Both follow suit, higher wins
                if (currentCard.value > winningCard.value) {
                    winningEntry = currentEntry;
                }
            }
        }

        return { 
            winningPlayer: winningEntry.player, 
            winningCard: winningEntry.card 
        };
    }

    // --- Scoring Logic ---

    /**
     * ADDED: Calculates round scores and returns summary.
     * @returns {{roundSummary: string, isGameOver: boolean}}
     */
    calculateRoundScores() {
        let roundSummary = '';
        let nilSuccessful = false; // Track if any Nil was successful
        const trashTalkEvents = []; // Track events for trash talk
        
        if (this.isCutthroat()) {
            // Cutthroat mode: Individual scoring
            this.players.forEach(p => {
                // Handle Nil bids (individual)
                if (p.isNil) {
                    if (p.tricks === 0) {
                        const nilValue = p.isBlindNil ? 200 : 100;
                        p.score += nilValue;
                        const nilType = p.isBlindNil ? 'Blind Nil' : 'Nil';
                        roundSummary += `✅ ${p.username} made ${nilType}! (+${nilValue})\n`;
                        nilSuccessful = true;
                        
                        // Trash talk: Nil success
                        if (p.isAI) {
                            trashTalkEvents.push({ player: p, event: 'nilSuccess' });
                        }
                        
                        // Spectator notification: Nil success
                        if (this.spectatorView) {
                            this.spectatorView.notifySpectators(`🎯 ${p.username} made ${nilType}! (+${nilValue} points)`);
                        }
                        
                        // Track Nil success for statistics
                        if (!this.playerStatTracking[p.discordId]) {
                            this.playerStatTracking[p.discordId] = { nilBids: 0, blindNilBids: 0, nilSuccesses: 0, blindNilSuccesses: 0 };
                        }
                        if (p.isBlindNil) {
                            this.playerStatTracking[p.discordId].blindNilSuccesses++;
                        } else {
                            this.playerStatTracking[p.discordId].nilSuccesses++;
                        }
                    } else {
                        const nilPenalty = p.isBlindNil ? 200 : 100;
                        p.score -= nilPenalty;
                        const nilType = p.isBlindNil ? 'Blind Nil' : 'Nil';
                        
                        // In cutthroat, failed Nil tricks count as bags
                        p.bags += p.tricks;
                        roundSummary += `❌ ${p.username} failed ${nilType}! (-${nilPenalty}, +${p.tricks} bags)\n`;
                        
                        // Trash talk: Nil failure
                        if (p.isAI) {
                            trashTalkEvents.push({ player: p, event: 'nilFailure' });
                        }
                        
                        // Spectator notification: Nil failure
                        if (this.spectatorView) {
                            this.spectatorView.notifySpectators(`❌ ${p.username} failed ${nilType}! (-${nilPenalty} points, +${p.tricks} bags)`);
                        }
                        
                        // Check bag penalty after adding failed Nil tricks
                        if (p.bags >= 10) {
                            p.score -= 100;
                            p.bags -= 10;
                            roundSummary += `💥 ${p.username} bag penalty! (-100 points)\n`;
                            
                            if (this.spectatorView) {
                                this.spectatorView.notifySpectators(`💥 ${p.username} bag penalty! (-100 points)`);
                            }
                        }
                    }
                } else {
                    // Regular bid scoring
                    if (p.tricks >= p.bid) {
                        const bidScore = p.bid * 10;
                        const bags = p.tricks - p.bid;
                        p.score += bidScore;
                        p.bags += bags;
                        roundSummary += `✅ ${p.username} made bid of ${p.bid} (+${bidScore} points, +${bags} bags)\n`;
                    } else {
                        const penalty = p.bid * 10;
                        p.score -= penalty;
                        roundSummary += `❌ ${p.username} set! (-${penalty} points)\n`;
                        
                        // Spectator notification: Player set
                        if (this.spectatorView) {
                            this.spectatorView.notifySpectators(`❌ ${p.username} was set! (-${penalty} points)`);
                        }
                        
                        // Trash talk: Opponent set (AI gloating)
                        if (!p.isAI) {
                            const aiPlayers = this.players.filter(ai => ai.isAI);
                            aiPlayers.forEach(ai => {
                                trashTalkEvents.push({ player: ai, event: 'opponentSet' });
                            });
                        }
                    }

                    // Check bag penalty
                    if (p.bags >= 10) {
                        p.score -= 100;
                        p.bags -= 10;
                        roundSummary += `💥 ${p.username} bag penalty! (-100 points)\n`;
                        
                        // Spectator notification: Bag out
                        if (this.spectatorView) {
                            this.spectatorView.notifySpectators(`💥 ${p.username} bag penalty! (-100 points)`);
                        }
                        
                        // Trash talk: Bag out
                        if (!p.isAI) {
                            const aiPlayers = this.players.filter(ai => ai.isAI);
                            aiPlayers.forEach(ai => {
                                trashTalkEvents.push({ player: ai, event: 'bagOut' });
                            });
                        }
                    }
                }
            });

            // Determine game over
            const highestScore = Math.max(...this.players.map(p => p.score));
            const isGameOver = highestScore >= this.options.targetScore;

            return { roundSummary, isGameOver, trashTalkEvents };
        } else {
            // Classic mode: Team scoring
            const teams = { 1: [], 2: [] };
            
            this.players.forEach(p => teams[p.team].push(p));

            for (const teamId in teams) {
                const teamPlayers = teams[teamId];
                const totalBid = teamPlayers.reduce((sum, p) => sum + (p.isNil ? 0 : p.bid), 0);
                const totalTricks = teamPlayers.reduce((sum, p) => sum + p.tricks, 0);

                // Handle Nil bids (scored individually, not as team)
                let nilScore = 0;
                teamPlayers.forEach(p => {
                    if (p.isNil) {
                        if (p.tricks === 0) {
                            // Blind Nil is worth ±200, regular Nil is worth ±100
                            const nilValue = p.isBlindNil ? 200 : 100;
                            nilScore += nilValue;
                            const nilType = p.isBlindNil ? 'Blind Nil' : 'Nil';
                            roundSummary += `✅ ${p.username} made ${nilType}! (+${nilValue})\n`;
                            nilSuccessful = true; // Mark that a Nil was successful
                            
                            // Trash talk: Nil success
                            if (p.isAI) {
                                trashTalkEvents.push({ player: p, event: 'nilSuccess' });
                            }
                            
                            // Track Nil success for statistics
                            if (!this.playerStatTracking[p.discordId]) {
                                this.playerStatTracking[p.discordId] = { nilBids: 0, blindNilBids: 0, nilSuccesses: 0, blindNilSuccesses: 0 };
                            }
                            if (p.isBlindNil) {
                                this.playerStatTracking[p.discordId].blindNilSuccesses++;
                            } else {
                                this.playerStatTracking[p.discordId].nilSuccesses++;
                            }
                        } else {
                            // Blind Nil is worth ±200, regular Nil is worth ±100
                            const nilPenalty = p.isBlindNil ? 200 : 100;
                            nilScore -= nilPenalty;
                            const nilType = p.isBlindNil ? 'Blind Nil' : 'Nil';
                            roundSummary += `❌ ${p.username} failed ${nilType}! (-${nilPenalty})\n`;
                            
                            // Trash talk: Nil failure
                            if (p.isAI) {
                                trashTalkEvents.push({ player: p, event: 'nilFailure' });
                            }
                        }
                    }
                });

                // Handle team contract
                let contractScore = 0;
                let bags = 0;

                if (totalTricks >= totalBid) {
                    contractScore = totalBid * 10;
                    bags = totalTricks - totalBid;
                    roundSummary += `✅ Team ${teamId} made bid of ${totalBid} (+${contractScore} points, +${bags} bags)\n`;
                } else {
                    contractScore = -(totalBid * 10);
                    roundSummary += `❌ Team ${teamId} set! (${contractScore} points)\n`;
                    
                    // Trash talk: Opponent team set
                    const opposingTeam = teamId === '1' ? 2 : 1;
                    const opposingAIs = teams[opposingTeam].filter(p => p.isAI);
                    opposingAIs.forEach(ai => {
                        trashTalkEvents.push({ player: ai, event: 'opponentSet' });
                    });
                }

                // FIXED: Apply scores only ONCE per team, not to each player
                const totalTeamScore = nilScore + contractScore;
                
                // Add the total score to ONLY the first player (we'll use them as team score holder)
                teamPlayers[0].score += totalTeamScore;
                
                // Update bags for the first player
                teamPlayers[0].bags += bags;

                // Check bag penalty
                if (teamPlayers[0].bags >= 10) {
                    const bagPenalty = 100;
                    teamPlayers[0].score -= bagPenalty;
                    teamPlayers[0].bags -= 10;
                    roundSummary += `💥 Team ${teamId} bag penalty! (-100 points)\n`;
                    
                    // Trash talk: Opposing team bags out
                    const opposingTeam = teamId === '1' ? 2 : 1;
                    const opposingAIs = teams[opposingTeam].filter(p => p.isAI);
                    opposingAIs.forEach(ai => {
                        trashTalkEvents.push({ player: ai, event: 'bagOut' });
                    });
                }
            }

            // Add special message if a Nil was successful
            if (nilSuccessful) {
                roundSummary += `\n🦅 **Mr. Easy Approves** 🦅\n`;
            }

            const team1Score = teams[1][0].score;
            const team2Score = teams[2][0].score;

            const isGameOver = team1Score >= this.options.targetScore || team2Score >= this.options.targetScore;

            return { roundSummary, isGameOver, trashTalkEvents };
        }
    }

    /**
     * Send trash talk messages for round-end events
     * @param {Array} trashTalkEvents - Array of {player, event} objects
     */
    async sendRoundEndTrashTalk(trashTalkEvents) {
        if (!this.channel || trashTalkEvents.length === 0) return;

        // Small delay to let round summary appear first
        await new Promise(resolve => setTimeout(resolve, 1000));

        for (const { player, event } of trashTalkEvents) {
            if (player && player.isAI) {
                await player.sendTrashTalk(event, this.channel);
                // Small delay between messages to avoid spam
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }

    /**
     * Analyze player patterns from this hand and update opponent profiles
     */
    async analyzeHandPatterns() {
        logger.debug('📊 Analyzing hand patterns for opponent modeling...');
        
        for (const player of this.players) {
            // Only track human players (AI doesn't need profiles)
            if (player.isAI) continue;
            
            const observations = this.handObservations[player.discordId] || {};
            
            // Check if player bid Nil and whether they succeeded
            if (observations.bidNil) {
                observations.nilSuccess = (player.tricks === 0);
                logger.debug(`📊 ${player.username} bid Nil: ${observations.nilSuccess ? 'SUCCESS' : 'FAILED'}`);
            }
            
            // Analyze team play patterns (classic mode only)
            if (!this.isCutthroat()) {
                const partner = this.players.find(p => p.team === player.team && p.id !== player.id);
                if (partner && partner.isNil && partner.tricks === 0) {
                    // Partner bid Nil - did this player help?
                    // Simple heuristic: if player took fewer tricks than bid, they were helping
                    const underBid = player.tricks < player.bid;
                    observations.helpedPartnerNil = underBid;
                    observations.ignoredPartnerNil = !underBid;
                    logger.debug(`📊 ${player.username} ${underBid ? 'helped' : 'ignored'} partner's Nil`);
                }
            }
            
            // Track playing style based on leading patterns
            // This is a simplified analysis - in a full implementation, you'd track each lead
            const avgTricks = player.tricks;
            const avgBid = player.bid || 0;
            
            // If player took more tricks than bid, they play aggressively
            if (avgTricks > avgBid) {
                observations.aggressivePlay = true;
                logger.debug(`📊 ${player.username} played aggressively (${avgTricks} tricks vs ${avgBid} bid)`);
            } else {
                observations.conservativePlay = true;
                logger.debug(`📊 ${player.username} played conservatively`);
            }
            
            // Mark this as end of hand for stats purposes
            observations.isGameEnd = false; // Will be marked true in endGame()
            
            // Update opponent profile in playerStats
            await playerStats.updateOpponentProfile(player.discordId, observations);
        }
        
        // Clear observations for next hand
        this.handObservations = {};
    }

    /**
     * ADDED: Returns game winner message.
     */
    endGame() {
        this.isGameActive = false;
        this.state = 'ENDED';
        this.endedAt = Date.now(); // Track when game ended for cleanup
        
        // --- OPPONENT MODELING: Mark game as complete in observations ---
        for (const player of this.players) {
            if (!player.isAI && this.handObservations[player.discordId]) {
                this.handObservations[player.discordId].isGameEnd = true;
                // Update one final time with isGameEnd flag
                playerStats.updateOpponentProfile(player.discordId, this.handObservations[player.discordId])
                    .catch(err => logger.error('Failed to update opponent profile at game end:', err));
            }
        }
        
        // Clear any pending bidding complete timeout
        if (this.biddingCompleteTimeout) {
            clearTimeout(this.biddingCompleteTimeout);
            this.biddingCompleteTimeout = null;
        }
        
        // Clear any pending AI bid timeout
        if (this.aiPendingBidTimeout) {
            clearTimeout(this.aiPendingBidTimeout);
            this.aiPendingBidTimeout = null;
        }
        
        // Clear auto-play timer to prevent memory leaks
        if (this.currentPlayTimer) {
            clearTimeout(this.currentPlayTimer);
            this.currentPlayTimer = null;
            this.currentPlayTimerPlayerId = null;
            logger.debug('🧹 Cleared auto-play timer on game end');
        }
        
        // Clear AI scheduled timeout to prevent memory leaks
        if (this._aiScheduledTimeout) {
            clearTimeout(this._aiScheduledTimeout);
            this._aiScheduledTimeout = null;
            logger.debug('🧹 Cleared AI scheduled timeout on game end');
        }

        // Persist game-level hard telemetry aggregate so later analysis can include missed live games.
        try {
            const totalsArray = Object.values(this.hardSetPressureGameTotals || {});
            const hasTotals = totalsArray.some(t =>
                (t.opportunities || 0) > 0 ||
                (t.leadPressurePlays || 0) > 0 ||
                (t.followPressureCaptures || 0) > 0
            );

            if (hasTotals) {
                aiHardTelemetryStore.recordGame({
                    gameId: this.telemetryGameId,
                    gameMode: this.gameMode,
                    targetScore: this.options?.targetScore,
                    roundsPlayed: Math.max(0, this.currentRound - 1),
                    players: this.players.map(p => ({
                        id: p.discordId || p.id,
                        username: p.username,
                        isAI: !!p.isAI,
                        team: p.team,
                        score: p.score,
                        bags: p.bags
                    })),
                    hardTotals: totalsArray
                });
            }
        } catch (e) {
            logger.error('Failed to persist hard telemetry game aggregate:', e);
        }

        // Persist a general game summary for all games, including human-vs-AI sessions.
        try {
            const finalPlayers = this.players.map((p, index) => ({
                seat: index + 1,
                discordId: p.discordId || p.id || null,
                username: p.username,
                isAI: !!p.isAI,
                aiLevel: p.isAI ? (p.aiLevel || 'medium') : 'human',
                team: p.team,
                finalScore: p.score ?? 0,
                bags: p.bags ?? 0,
                handsWon: p.tricks ?? 0
            }));

            gameTelemetryStore.recordGame({
                gameId: this.telemetryGameId,
                guildId: this.guildId || null,
                channelId: this.channelId || null,
                gameMode: this.gameMode,
                targetScore: this.options?.targetScore,
                roundsPlayed: Math.max(0, this.currentRound - 1),
                humanPlayerCount: this.players.filter(p => !p.isAI).length,
                aiPlayerCount: this.players.filter(p => p.isAI).length,
                humanOnlyGame: this.players.every(p => !p.isAI),
                players: finalPlayers
            });
        } catch (error) {
            logger.error('Failed to persist general game telemetry:', error);
        }
        
        let winningTeam = 0;
        let team1Score = 0;
        let team2Score = 0;
        
        if (this.isCutthroat()) {
            // Cutthroat mode: Find highest scoring player
            const highestScore = Math.max(...this.players.map(p => p.score));
            const winners = this.players.filter(p => p.score === highestScore);
            
            // Collect game statistics for each player (cutthroat)
            const gameStats = this.players.map(player => {
                const tracking = this.playerStatTracking[player.discordId] || {
                    nilBids: 0,
                    blindNilBids: 0,
                    nilSuccesses: 0,
                    blindNilSuccesses: 0
                };
                
                return {
                    discordId: player.discordId,
                    username: player.username,
                    won: winners.some(w => w.discordId === player.discordId),
                    handsPlayed: this.currentRound - 1,
                    nilBids: tracking.nilBids,
                    nilSuccesses: tracking.nilSuccesses,
                    blindNilBids: tracking.blindNilBids,
                    blindNilSuccesses: tracking.blindNilSuccesses,
                    bags: player.bags,
                    finalScore: player.score,
                    tricksWon: player.tricks
                };
            });
            
            const winnerMessage = winners.length === 1 
                ? `${winners[0].username} wins with ${winners[0].score} points!`
                : `Tie game! ${winners.map(w => w.username).join(' & ')} tied at ${winners[0].score} points!`;
            
            // Spectator notification: Game over
            if (this.spectatorView) {
                this.spectatorView.notifySpectators(`🏆 **Game Over!** ${winnerMessage}`);
            }
            
            // Trash talk: Game win/loss for AI players
            this.players.filter(p => p.isAI).forEach(ai => {
                const isWinner = winners.some(w => w.id === ai.id);
                const event = isWinner ? 'gameWin' : 'gameLoss';
                if (this.channel) {
                    setTimeout(() => ai.sendTrashTalk(event, this.channel), 2000); // Delay to let game over message appear first
                }
            });
            
            this.publicAnnounce({
                type: 'game_over',
                channelId: this.channelId,
                gameMode: this.gameMode, // Include game mode for stats tracking
                isCutthroat: true,
                message: winnerMessage, // Add the winner message to the payload
                winners: winners.map(w => ({ username: w.username, score: w.score })),
                players: this.players.map(p => ({
                    username: p.username,
                    score: p.score,
                    bags: p.bags
                })),
                gameStats
            });
            
            return winnerMessage;
        } else {
            // Classic mode: Team-based winner
            const team1 = this.players.filter(p => p.team === 1);
            const team2 = this.players.filter(p => p.team === 2);
            
            // FIXED: Team score is stored only in the first player of each team
            const team1Score = team1[0].score;
            const team2Score = team2[0].score;
            
            // Determine winning team
            const winningTeam = team1Score > team2Score ? 1 : team2Score > team1Score ? 2 : 0;

            // Collect game statistics for each player
            const gameStats = this.players.map(player => {
                const tracking = this.playerStatTracking[player.discordId] || {
                    nilBids: 0,
                    blindNilBids: 0,
                    nilSuccesses: 0,
                    blindNilSuccesses: 0
                };
                
                return {
                    discordId: player.discordId,
                    username: player.username,
                    won: player.team === winningTeam,
                    handsPlayed: this.currentRound - 1, // currentRound is incremented before ending
                    nilBids: tracking.nilBids,
                    nilSuccesses: tracking.nilSuccesses,
                    blindNilBids: tracking.blindNilBids,
                    blindNilSuccesses: tracking.blindNilSuccesses,
                    bags: player.bags,
                    finalScore: player.team === 1 ? team1Score : team2Score,
                    tricksWon: player.tricks // Note: This is only the last round's tricks, we'd need to track total if needed
                };
            });

            // Build winner announcement with metadata for handler
            const result = {
                type: 'game_over',
                channelId: this.channelId,
                gameMode: this.gameMode, // Include game mode for stats tracking
                gameStats: gameStats, // Include stats for the handler to save
                message: team1Score > team2Score
                    ? `Team 1 (${team1.map(p => p.username).join(' & ')}) wins with ${team1Score} points!`
                    : team2Score > team1Score
                        ? `Team 2 (${team2.map(p => p.username).join(' & ')}) wins with ${team2Score} points!`
                        : `It's a tie at ${team1Score} points!`
            };

            // Trash talk: Game win/loss for AI players (team-based)
            this.players.filter(p => p.isAI).forEach(ai => {
                const isWinner = (winningTeam === 1 && ai.team === 1) || (winningTeam === 2 && ai.team === 2);
                const event = isWinner ? 'gameWin' : 'gameLoss';
                if (this.channel) {
                    setTimeout(() => ai.sendTrashTalk(event, this.channel), 2000); // Delay to let game over message appear first
                }
            });

            // Send the structured payload so publicAnnounce can handle cleanup
            this.publicAnnounce(result);

            return result.message;
        }


}
}
// End of GameManager class

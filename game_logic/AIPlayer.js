// game_logic/AIPlayer.js

import { Player } from './Player.js';
import logger from '../logger.js';
import { trashTalk } from './TrashTalk.js';

/**
 * AI Player with intermediate-level strategy
 * - Counts cards and tracks what's been played
 * - Understands partnership play
 * - Protects partner's Nil bids
 * - Makes strategic decisions based on game state
 */
export class AIPlayer extends Player {
    constructor(discordId, username) {
        super(discordId, username);
        this.isAI = true;
        this.playedCards = []; // Cards seen this round
        this.aiPersonality = 'aggressive'; // Could be 'aggressive', 'conservative', 'balanced'
        // Personality tuning parameters
        this.riskAversion = 0.7; // 0..1 higher means avoid risky plays more
        this.aggressiveness = 0.5; // 0..1 higher means more likely to trump/seek tricks
        this.aiLevel = 'medium';
        this.monteCarloTrials = 200; // default, can be tuned by GameManager
        
        // Opponent modeling
        this.opponentProfiles = new Map(); // Map<discordId, profile>
        
        // Trash talk settings
        this.trashTalkEnabled = true;
        this.trashTalkFrequency = 'medium';
    }

    /**
     * Set opponent profiles for AI to use in decision-making
     * @param {Map<string, Object>} profiles - Map of discordId to opponent profile
     */
    setOpponentProfiles(profiles) {
        this.opponentProfiles = profiles;
        logger.debug(`🧠 AI ${this.username} loaded ${profiles.size} opponent profiles`);
    }

    /**
     * Get profile for a specific opponent
     * @param {string} discordId - Opponent's Discord ID
     * @returns {Object} Opponent profile or default unknown profile
     */
    getOpponentProfile(discordId) {
        return this.opponentProfiles.get(discordId) || {
            biddingStyle: 'unknown',
            playingStyle: 'unknown',
            nilTendency: 'unknown',
            teamPlayer: 'unknown',
            reliable: false,
            sampleSize: 0
        };
    }

    /**
     * Generate trash talk message based on context
     * @param {string} category - Trash talk category
     * @param {Object} channel - Discord channel to send message to
     * @returns {Promise<void>}
     */
    async sendTrashTalk(category, channel) {
        if (!this.trashTalkEnabled || !channel) {
            return;
        }

        const personality = trashTalk.getPersonalityFromAIType(this.aiPersonality);
        const message = trashTalk.getMessage(
            this.username,
            category,
            personality,
            this.trashTalkFrequency
        );

        if (message) {
            try {
                // Import EmbedBuilder dynamically to avoid circular dependencies
                const { EmbedBuilder } = await import('discord.js');
                
                // Get category-specific styling
                const styling = trashTalk.getCategoryStyling(category);
                
                const embed = new EmbedBuilder()
                    .setColor(styling.color)
                    .setTitle(`${styling.emoji} ${this.username}`)
                    .setDescription(`**${message}**`)
                    .setTimestamp();
                
                await channel.send({ embeds: [embed] });
            } catch (error) {
                logger.error(`Failed to send trash talk: ${error.message}`);
            }
        }
    }

    /**
     * Set trash talk preferences
     * @param {boolean} enabled - Whether trash talk is enabled
     * @param {string} frequency - Frequency level (low, medium, high)
     */
    setTrashTalkPreferences(enabled, frequency) {
        this.trashTalkEnabled = enabled;
        this.trashTalkFrequency = frequency;
    }

    /**
     * AI makes a bid based on hand strength and position
     * @param {object} game - The game instance for context
     * @returns {number} Bid amount (0 for Nil, 1-13 otherwise)
     */
    calculateBid(game) {
        let bid = 0;

        // Count high cards (likely winners)
        const aces = this.hand.filter(c => c.rankCode === 'A').length;
        const kings = this.hand.filter(c => c.rankCode === 'K').length;
        const queens = this.hand.filter(c => c.rankCode === 'Q').length;

        bid += aces; // Aces are almost always winners
        bid += kings * 0.75; // Kings usually win
        bid += queens * 0.5; // Queens sometimes win

        // Count spades (trump suit advantage)
        const spades = this.hand.filter(c => c.suitCode === 'S');
        const highSpades = spades.filter(c => c.value >= 12).length; // A, K, Q of spades

        bid += highSpades * 0.5;
        if (spades.length >= 5) bid += 0.5; // Long spade suit bonus

        // Check for voids (no cards in a suit = good for trumping)
        const suits = { 'S': 0, 'H': 0, 'D': 0, 'C': 0 };
        this.hand.forEach(c => suits[c.suitCode]++);
        const voids = Object.values(suits).filter(count => count === 0).length;
        bid += voids * 0.5;
        
        // --- OPPONENT MODELING: Adjust bid based on opponents ---
        if (this.opponentProfiles.size > 0) {
            const opponents = game.isCutthroat() 
                ? game.players.filter(p => p.id !== this.id)
                : game.players.filter(p => p.team !== this.team);
            
            let aggressiveOpponents = 0;
            let conservativeOpponents = 0;
            
            opponents.forEach(opp => {
                const profile = this.getOpponentProfile(opp.discordId);
                if (profile.reliable && profile.biddingStyle === 'aggressive') {
                    aggressiveOpponents++;
                } else if (profile.reliable && profile.biddingStyle === 'conservative') {
                    conservativeOpponents++;
                }
            });
            
            // If facing aggressive bidders, be slightly more conservative
            // (they'll compete for tricks, making our high cards less likely to win)
            if (aggressiveOpponents > conservativeOpponents) {
                bid -= 0.3;
                logger.debug(`🧠 AI adjusting bid DOWN (facing aggressive opponents)`);
            }
            
            // If facing conservative bidders, we can bid slightly higher
            if (conservativeOpponents > aggressiveOpponents) {
                bid += 0.2;
                logger.debug(`🧠 AI adjusting bid UP (facing conservative opponents)`);
            }
        }

        // Round to nearest integer
        bid = Math.round(bid);

        // Clamp between 1 and 13
        bid = Math.max(1, Math.min(13, bid));

        // Consider Nil bid - evaluate hand for Nil potential
        // Reuse aces, kings, spades, highSpades from above
        const lowSpades = spades.filter(c => c.value <= 6).length; // 2-6 of spades (dangerous)
        const maxCardValue = Math.max(...this.hand.map(c => c.value));
        
        // Use suits from above for short suit check
        const shortSideSuits = ['H', 'D', 'C'].filter(s => suits[s] <= 2).length;
        
        // Evaluate Nil potential
        let nilChance = 0;
        
        // Strong Nil hand: No aces, no kings, max card is Jack or lower
        if (aces === 0 && kings === 0 && maxCardValue <= 11) {
            nilChance = 0.85; // Very likely to bid Nil
            logger.debug(`🧠 AI has strong Nil hand (no aces/kings, max: ${maxCardValue})`);
        }
        // Good Nil hand: No aces, max 1 king in short suit, no high spades
        else if (aces === 0 && kings <= 1 && highSpades === 0 && maxCardValue <= 13) {
            // Check if king is in a short suit where it can be sluffed
            const kingInShortSuit = ['H', 'D', 'C'].some(s => {
                const suitCards = this.hand.filter(c => c.suitCode === s);
                return suitCards.some(c => c.rankCode === 'K') && suitCards.length <= 2;
            });
            
            if (kingInShortSuit || kings === 0) {
                nilChance = 0.6;
                logger.debug(`🧠 AI has good Nil hand (no aces, sluffable king)`);
            }
        }
        // Marginal Nil hand: No aces, weak hand overall
        else if (aces === 0 && kings === 0 && highSpades === 0 && bid <= 2) {
            nilChance = 0.35;
            logger.debug(`🧠 AI has marginal Nil hand`);
        }
        
        // Adjust for dangerous low spades (hard to duck)
        if (lowSpades >= 2) {
            nilChance *= 0.5; // Halve the chance if multiple low spades
            logger.debug(`🧠 AI Nil chance reduced due to ${lowSpades} low spades`);
        }
        
        // Adjust for short side suits (good for sluffing)
        if (shortSideSuits >= 2 && nilChance > 0) {
            nilChance = Math.min(0.95, nilChance * 1.2);
            logger.debug(`🧠 AI Nil chance increased due to ${shortSideSuits} short suits`);
        }
        
        // --- OPPONENT MODELING: Adjust Nil likelihood based on partner ---
        if (!game.isCutthroat() && nilChance > 0) {
            const partner = game.players.find(p => p.team === this.team && p.id !== this.id);
            if (partner) {
                const partnerProfile = this.getOpponentProfile(partner.discordId);
                
                // If partner is known to be a good team player, more likely to bid Nil
                if (partnerProfile.reliable && partnerProfile.teamPlayer === 'excellent') {
                    nilChance = Math.min(0.95, nilChance * 1.3);
                    logger.debug(`🧠 AI more likely to bid Nil (partner is excellent team player)`);
                }
                
                // If partner is poor team player, less likely to bid Nil
                if (partnerProfile.reliable && partnerProfile.teamPlayer === 'poor') {
                    nilChance *= 0.5;
                    logger.debug(`🧠 AI less likely to bid Nil (partner is poor team player)`);
                }
            }
        }
        
        if (nilChance > 0 && Math.random() < nilChance) {
            logger.debug(`🧠 AI bidding Nil (chance was: ${(nilChance * 100).toFixed(0)}%)`);
            return 0; // Nil bid
        }

        logger.debug(`🧠 AI final bid: ${bid}`);
        return bid;
    }

    /**
     * AI selects which card to play based on game state
     * @param {object} game - The game instance
     * @returns {object} Card object to play
     */
    selectCardToPlay(game) {
        const legalCards = this.getLegalCards(game);

        if (legalCards.length === 0) {
            logger.error('AI has no legal cards to play!');
            return this.hand[0]; // Fallback
        }

        if (legalCards.length === 1) {
            return legalCards[0]; // Only one choice
        }

        // Get game context
        const isLeading = game.trick.length === 0;
        const partner = this.getPartner(game);
        const partnerIsNil = partner && partner.isNil && partner.tricks === 0;
        
        // Check if any opponent is on Nil (still trying to achieve it)
        // In cutthroat mode, everyone except self is an opponent
        const opponents = game.isCutthroat() 
            ? game.players.filter(p => p.id !== this.id)
            : game.players.filter(p => p.team !== this.team);
        const opponentOnNil = opponents.find(opp => opp.isNil && opp.tricks === 0);
        
        if (partnerIsNil) {
            logger.debug(`🤝 AI ${this.username}: Partner ${partner.username} is on Nil (tricks: ${partner.tricks}) - protecting!`);
        }
        
        if (opponentOnNil) {
            logger.debug(`🎯 AI ${this.username}: Detected opponent ${opponentOnNil.username} on Nil (tricks: ${opponentOnNil.tricks})`);
        }

        // Strategy: Leading the trick
        if (isLeading) {
            return this.selectLeadCard(game, legalCards, partnerIsNil, opponentOnNil);
        }

        // Strategy: Following in the trick
        return this.selectFollowCard(game, legalCards, partnerIsNil, opponentOnNil);
    }

    /**
     * Get legal cards that can be played
     */
    getLegalCards(game) {
        const leadSuit = game.trick.length > 0 ? game.trick[0].card.suitCode : null;

        if (!leadSuit) {
            // Leading - can't lead spades unless broken or only have spades
            if (!game.spadesBroken) {
                const nonSpades = this.hand.filter(c => c.suitCode !== 'S');
                if (nonSpades.length > 0) {
                    return nonSpades;
                }
            }
            return [...this.hand];
        }

        // Must follow suit if possible
        const sameSuit = this.hand.filter(c => c.suitCode === leadSuit);
        if (sameSuit.length > 0) {
            return sameSuit;
        }

        // Can play anything if can't follow suit
        return [...this.hand];
    }

    /**
     * Select a card to lead with
     */
    selectLeadCard(game, legalCards, partnerIsNil, opponentOnNil) {
        const needsTricks = this.tricks < this.bid;
        const hasExtraTricks = this.tricks > this.bid;

        // CRITICAL: Filter out Kings where Ace is still outstanding (universal rule)
        // Only lead a King if we also have the Ace or the Ace has been played
        const safeLeadCards = legalCards.filter(c => {
            if (c.rankCode === 'K') {
                const aceOfSuitPlayed = this.playedCards.some(pc => 
                    pc.suitCode === c.suitCode && pc.rankCode === 'A'
                );
                const hasAce = legalCards.some(other => other.suitCode === c.suitCode && other.rankCode === 'A');
                // Only safe to lead King if we have the Ace or Ace has been played
                return hasAce || aceOfSuitPlayed;
            }
            return true; // All non-King cards are safe
        });
        
        // Use safe cards if available, otherwise fall back to all legal cards
        const cardsToConsider = safeLeadCards.length > 0 ? safeLeadCards : legalCards;

        // If partner is on Nil, lead LOW cards to help them
        if (partnerIsNil) {
            return this.getLowestCard(cardsToConsider);
        }

        // AGGRESSIVE: If opponent is on Nil, try to force them to take the trick
        if (opponentOnNil) {
            const opponentProfile = this.getOpponentProfile(opponentOnNil.discordId);
            
            // --- OPPONENT MODELING: Adjust Nil-attacking strategy ---
            let attackStrategy = 'standard'; // 'aggressive' or 'conservative' or 'standard'
            
            if (opponentProfile.reliable) {
                // If opponent is known to bid Nil conservatively (high success rate),
                // they probably have a genuinely weak hand - attack more aggressively
                if (opponentProfile.conservativeNilBidder === true) {
                    attackStrategy = 'aggressive';
                    logger.debug(`🧠 AI: Opponent ${opponentOnNil.username} is conservative Nil bidder - attacking aggressively`);
                }
                // If opponent bids Nil recklessly (low success rate),
                // they might have escape cards - be more careful
                else if (opponentProfile.conservativeNilBidder === false) {
                    attackStrategy = 'conservative';
                    logger.debug(`🧠 AI: Opponent ${opponentOnNil.username} is risky Nil bidder - attacking conservatively`);
                }
            }
            
            // Aggressive attack: lead LOW cards (3-5) to minimize their escape options
            // This forces them to use their precious low cards or take the trick
            if (attackStrategy === 'aggressive') {
                const lowCards = cardsToConsider.filter(c => c.value >= 3 && c.value <= 5);
                if (lowCards.length > 0) {
                    // Lead the HIGHEST of the low cards (e.g., 5 over 3)
                    // This is hardest to duck under while still being "low"
                    logger.debug(`🎯 AI ${this.username}: Aggressive Nil attack - leading high-low card (3-5)`);
                    return this.getHighestCard(lowCards);
                }
            }
            
            // Conservative attack: lead VERY low cards (2-3) to be safe
            // Less risky for us, but gives them slightly more escape room
            if (attackStrategy === 'conservative') {
                const veryLowCards = cardsToConsider.filter(c => c.value >= 2 && c.value <= 3);
                if (veryLowCards.length > 0) {
                    logger.debug(`🎯 AI ${this.username}: Conservative Nil attack - leading very low card (2-3)`);
                    return this.getHighestCard(veryLowCards);
                }
            }
            
            // Standard attack: lead low-range cards (2-6)
            // Best balance of attack effectiveness and safety
            const lowRangeCards = cardsToConsider.filter(c => c.value >= 2 && c.value <= 6);
            
            if (lowRangeCards.length > 0) {
                // Lead the highest of the low cards to minimize their escape room
                // e.g., 6 is harder to duck under than 2
                logger.debug(`🎯 AI ${this.username}: Standard Nil attack - leading low card (2-6)`);
                return this.getHighestCard(lowRangeCards);
            }
            
            // If no low cards, lead the lowest card available
            // This is a fallback - try to at least not give them an easy trick
            logger.debug(`🎯 AI ${this.username}: No low cards - leading lowest available`);
            return this.getLowestCard(cardsToConsider);
        }

        // If we need tricks, lead with suits where we are strongest
        if (needsTricks) {
            // Lead with Aces first (most likely to win)
            const aces = cardsToConsider.filter(c => c.rankCode === 'A');
            if (aces.length > 0) return aces[0];

            // Check for "boss" cards (highest remaining in suit)
            const bossCards = cardsToConsider.filter(c => !this.hasUnseenHigherInSuitThan(c));
            if (bossCards.length > 0) {
                // Lead the highest boss card
                return this.getHighestCard(bossCards);
            }

            // Prefer leading from the longest suit (excluding spades unless strong)
            const suitCounts = cardsToConsider.reduce((acc, c) => {
                acc[c.suitCode] = (acc[c.suitCode] || 0) + 1;
                return acc;
            }, {});
            // Exclude spades unless we have >=3 spades
            const candidateSuits = Object.keys(suitCounts).filter(s => s !== 'S' || suitCounts['S'] >= 3);
            candidateSuits.sort((a, b) => suitCounts[b] - suitCounts[a]);
            if (candidateSuits.length > 0) {
                const suit = candidateSuits[0];
                const suitCards = cardsToConsider.filter(c => c.suitCode === suit);
                // Lead with highest SAFE card in that suit (not one that's likely to be beaten)
                const safeCards = suitCards.filter(c => !this.hasUnseenHigherInSuitThan(c));
                if (safeCards.length > 0) {
                    return this.getHighestCard(safeCards);
                }
                // Otherwise lead highest in suit
                return this.getHighestCard(suitCards);
            }

            // Fallback: lead highest
            return this.getHighestCard(cardsToConsider);
        }

        // If we have extra tricks, lead MEDIUM cards to avoid taking
        if (hasExtraTricks) {
            return this.getMidRangeCard(cardsToConsider);
        }

        // Default: lead low card, prefer non-spade to avoid breaking spades
        const nonSpades = cardsToConsider.filter(c => c.suitCode !== 'S');
        if (nonSpades.length > 0) {
            return this.getLowestCard(nonSpades);
        }

        return this.getLowestCard(cardsToConsider);
    }

    /**
     * Select a card when following in a trick
     */
    selectFollowCard(game, legalCards, partnerIsNil, opponentOnNil) {
        const currentWinningEntry = this.getCurrentWinningEntry(game);
        const currentWinningCard = currentWinningEntry ? currentWinningEntry.card : null;
        const currentWinningPlayer = currentWinningEntry ? currentWinningEntry.player : null;
        const canWin = currentWinningCard ? legalCards.some(c => this.cardBeats(c, currentWinningCard, game)) : false;

        const needsTricks = this.tricks < this.bid;
        const hasExtraTricks = this.tricks > this.bid;

        // Check if partner is currently winning
        const partner = this.getPartner(game);
        const partnerIsWinning = currentWinningPlayer && partner && currentWinningPlayer.id === partner.id;

        // AGGRESSIVE: If opponent is on Nil, try to force them to take the trick
        if (opponentOnNil && game.currentTrick && game.currentTrick.playedBy) {
            // Check if the opponent on Nil has already played
            const nilPlayerIndex = game.players.findIndex(p => p.team !== this.team && p.isNil && p.tricks === 0);
            const nilPlayerHasPlayed = game.currentTrick.playedBy.includes(nilPlayerIndex);

            if (!nilPlayerHasPlayed) {
                // Opponent Nil player hasn't played yet - try to WIN this trick to force them
                logger.debug(`🎯 AI ${this.username}: Trying to win trick before opponent Nil player plays`);
                
                if (canWin) {
                    const winningCard = this.getLowestWinningCard(legalCards, currentWinningCard, game);
                    if (winningCard) {
                        return winningCard;
                    }
                }
                
                // Can't win outright, but play a high card to pressure the Nil player
                const ledSuit = game.currentTrick.cards[0].suit;
                const followSuitCards = legalCards.filter(c => c.suit === ledSuit);
                if (followSuitCards.length > 0) {
                    const highCards = followSuitCards.filter(c => c.value >= 9);
                    if (highCards.length > 0) {
                        return this.getHighestCard(highCards);
                    }
                    return this.getHighestCard(followSuitCards);
                }
                
                // Can't follow suit - consider trumping
                const trumpCards = legalCards.filter(c => c.suit === 'spades');
                if (trumpCards.length > 0 && ledSuit !== 'spades') {
                    logger.debug(`🎯 AI ${this.username}: Trumping to force opponent Nil`);
                    return this.getLowestCard(trumpCards);
                }
            } else {
                // Opponent Nil player HAS played - check if we can force the trick higher
                logger.debug(`🎯 AI ${this.username}: Opponent Nil already played, checking if we can win`);
                
                if (canWin) {
                    const winningCard = this.getLowestWinningCard(legalCards, currentWinningCard, game);
                    if (winningCard) {
                        // Check if this would make the Nil player win
                        const nilPlayer = game.players[nilPlayerIndex];
                        const nilPlayerCardIndex = game.currentTrick.playedBy.indexOf(nilPlayerIndex);
                        const nilPlayerCard = game.currentTrick.cards[nilPlayerCardIndex];
                        
                        // Only win if it doesn't give the trick to the Nil player
                        const wouldNilPlayerWin = this.cardBeats(nilPlayerCard, winningCard, game);
                        if (!wouldNilPlayerWin) {
                            return winningCard;
                        }
                    }
                }
            }
        }

        // If partner is winning OR partner is on Nil, NEVER take the trick from them
        if (partnerIsWinning || partnerIsNil) {
            // Prefer to discard non-spade low card if available
            const nonSpades = legalCards.filter(c => c.suitCode !== 'S');
            if (nonSpades.length > 0) return this.getLowestCard(nonSpades);
            return this.getLowestCard(legalCards);
        }

        // Partner is NOT winning - consider taking the trick if we need tricks
        if (needsTricks) {
            if (canWin) {
                const candidate = this.getLowestWinningCard(legalCards, currentWinningCard, game);
                // Use Monte Carlo to evaluate candidate if it's risky or marginal
                const trials = this.aiLevel === 'hard' ? Math.max(200, this.monteCarloTrials) : this.aiLevel === 'easy' ? 50 : this.monteCarloTrials;
                try {
                    const prob = this.monteCarloWinProbability(candidate, game, trials);
                    // If probability low and alternative winners exist, choose the best alternative by prob
                    if (prob < 0.5) {
                        let best = candidate;
                        let bestProb = prob;
                        const winners = legalCards.filter(c => this.cardBeats(c, currentWinningCard, game));
                        for (const w of winners) {
                            const p = this.monteCarloWinProbability(w, game, Math.max(40, Math.floor(trials / 4)));
                            if (p > bestProb) {
                                best = w; bestProb = p;
                            }
                        }
                        return best;
                    }
                } catch (e) {
                    // fallback to deterministic
                    logger.error('❌ Monte Carlo failed:', e);
                }
                return candidate;
            } else {
                // Can't win by following suit - check if we can trump
                const leadSuit = game.trick[0].card.suitCode;
                const hasLeadSuit = this.hand.some(c => c.suitCode === leadSuit);
                
                // Only consider trumping if we can't follow suit
                if (!hasLeadSuit && leadSuit !== 'S') {
                    const spades = legalCards.filter(c => c.suitCode === 'S');
                    
                    // Check if current winner is already a spade
                    const currentWinnerIsSpade = currentWinningCard && currentWinningCard.suitCode === 'S';
                    
                    if (spades.length > 0) {
                        if (currentWinnerIsSpade) {
                            // Need to beat their spade with a higher spade
                            const higherSpades = spades.filter(c => c.value > currentWinningCard.value);
                            if (higherSpades.length > 0) {
                                logger.debug(`🎯 AI ${this.username}: Need ${this.bid - this.tricks} more tricks - overtrumping with spade`);
                                return this.getLowestCard(higherSpades);
                            }
                            // Can't beat their spade, fall through to dump
                        } else {
                            // Trump with lowest spade to win
                            logger.debug(`🎯 AI ${this.username}: Need ${this.bid - this.tricks} more tricks - trumping to win`);
                            return this.getLowestCard(spades);
                        }
                    }
                }
                // Can't trump or shouldn't - fall through to default dumping logic
            }
        }

        // If we have extra tricks, or can't/shouldn't win, dump low cards (prefer non-spade to conserve trumps)
        if (hasExtraTricks) {
            const nonSpades = legalCards.filter(c => c.suitCode !== 'S');
            return nonSpades.length ? this.getLowestCard(nonSpades) : this.getLowestCard(legalCards);
        }

        // Default: play lowest card to avoid winning; prefer non-spade
        const nonSpadesDefault = legalCards.filter(c => c.suitCode !== 'S');
        return nonSpadesDefault.length ? this.getLowestCard(nonSpadesDefault) : this.getLowestCard(legalCards);
    }

    /**
     * Determine the current winning entry (player + card) in the trick so far.
     * @param {object} game
     * @returns {{player: object, card: object} | null}
     */
    getCurrentWinningEntry(game) {
        if (!game.trick || game.trick.length === 0) return null;

        let winningEntry = game.trick[0];
        const leadSuit = game.trick[0].card.suitCode;

        for (let i = 1; i < game.trick.length; i++) {
            const entry = game.trick[i];
            const winningCard = winningEntry.card;
            const currentCard = entry.card;

            // Spade beats non-spade
            if (currentCard.suitCode === 'S' && winningCard.suitCode !== 'S') {
                winningEntry = entry;
            } else if (currentCard.suitCode === 'S' && winningCard.suitCode === 'S') {
                if (currentCard.value > winningCard.value) winningEntry = entry;
            } else if (currentCard.suitCode === leadSuit && winningCard.suitCode === leadSuit) {
                if (currentCard.value > winningCard.value) winningEntry = entry;
            }
        }

        return winningEntry;
    }

    /**
     * Helper methods for card selection
     */
    getHighestCard(cards) {
        return cards.reduce((highest, card) => 
            card.value > highest.value ? card : highest
        );
    }

    getLowestCard(cards) {
        return cards.reduce((lowest, card) => 
            card.value < lowest.value ? card : lowest
        );
    }

    getMidRangeCard(cards) {
        const sorted = [...cards].sort((a, b) => a.value - b.value);
        return sorted[Math.floor(sorted.length / 2)];
    }

    getLowestWinningCard(cards, cardToBeat, game) {
        const winningCards = cards.filter(c => this.cardBeats(c, cardToBeat, game));
        if (winningCards.length === 0) return this.getLowestCard(cards);
        return this.getLowestCard(winningCards);
    }

    /** Monte Carlo estimate: probability this AI wins the current trick if it plays `candidate` now. */
    monteCarloWinProbability(candidate, game, trials = null) {
        trials = trials || this.monteCarloTrials || 200;

        // Prepare full deck representation
        const ranks = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
        const suits = ['S','H','D','C'];
        const full = [];
        const rankToValue = r => {
            if (r === 'A') return 14;
            if (r === 'K') return 13;
            if (r === 'Q') return 12;
            if (r === 'J') return 11;
            if (r === 'T') return 10;
            return parseInt(r, 10);
        };
        for (const s of suits) for (const r of ranks) full.push({ rankCode: r, suitCode: s, value: rankToValue(r) });

        // Known cards: AI's hand, playedCards, and current trick cards
        const known = [];
        this.hand.forEach(c => known.push({ rankCode: c.rankCode, suitCode: c.suitCode }));
        this.playedCards.forEach(pc => known.push({ rankCode: pc.rankCode, suitCode: pc.suitCode }));
        game.trick.forEach(t => known.push({ rankCode: t.card.rankCode, suitCode: t.card.suitCode }));

        // Remove known cards from deck copy
        const unknownDeck = full.filter(card => !known.some(k => k.rankCode === card.rankCode && k.suitCode === card.suitCode));

        // Determine player ordering for remaining plays in trick
        // Find AI index in game.players
        const aiIndex = game.players.findIndex(p => p.id === this.id);
        if (aiIndex === -1) return 0;

        // Determine turn order for remaining players in this trick after AI plays
        const order = [];
        const playersCount = game.players.length;
        // trick currently has some plays; next to act will be (trick.length + leaderIndex) % playersCount
        // but we just need to simulate remaining players positions after AI
        for (let offset = 1; offset <= playersCount - 1; offset++) {
            const idx = (aiIndex + offset) % playersCount;
            order.push(idx);
        }

        let wins = 0;

        const getLegalPlaysForSim = (simHand, leadSuit) => {
            if (!leadSuit) return simHand.slice();
            const same = simHand.filter(c => c.suitCode === leadSuit);
            return same.length > 0 ? same : simHand.slice();
        };

        for (let t = 0; t < trials; t++) {
            // Shuffle unknown deck copy
            const deck = unknownDeck.slice();
            for (let i = deck.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [deck[i], deck[j]] = [deck[j], deck[i]];
            }

            // Build simulated hands for other players by dealing counts equal to their real hand sizes
            const simHands = game.players.map(p => []);
            // AI's simulated hand is this.hand (known)
            simHands[aiIndex] = this.hand.map(c => ({ rankCode: c.rankCode, suitCode: c.suitCode, value: c.value }));

            // Remove candidate from AI's simulated hand for this trial (we assume AI will play it)
            // But the candidate might be in AI hand; simulate AI playing it now
            // We'll not include candidate in simHands[aiIndex]
            simHands[aiIndex] = simHands[aiIndex].filter(c => !(c.rankCode === candidate.rankCode && c.suitCode === candidate.suitCode));

            // Assign cards from deck to other players to match counts
            let cursor = 0;
            for (let i = 0; i < playersCount; i++) {
                if (i === aiIndex) continue;
                const need = game.players[i].hand.length;
                simHands[i] = deck.slice(cursor, cursor + need).map(c => ({ rankCode: c.rankCode, suitCode: c.suitCode, value: c.value }));
                cursor += need;
            }

            // Simulate the rest of the trick: build current simulated trick entries
            const simTrick = game.trick.map(t => ({ player: t.player, card: { rankCode: t.card.rankCode, suitCode: t.card.suitCode, value: t.card.value } }));

            // Insert AI's candidate at its proper position in the trick
            // Find AI's position in current trick sequence: if trick length < playersCount, determine play order.
            // For simplicity, append AI's play at the end of current trick if AI is next to play, else insert in correct spot
            // We'll find the insertion index by locating how many have already played before AI in this trick
            const playedIds = simTrick.map(e => e.player.id);
            // If AI already played in simTrick (shouldn't), skip
            if (!playedIds.includes(this.id)) {
                // Determine leader index in players array (the player who led the trick is trick[0].player)
                const leaderId = simTrick.length > 0 ? simTrick[0].player.id : null;
                let insertPos = simTrick.length; // default append
                if (leaderId) {
                    const leaderIndex = game.players.findIndex(p => p.id === leaderId);
                    // compute expected position of AI relative to leader
                    const posFromLeader = (aiIndex - leaderIndex + playersCount) % playersCount;
                    insertPos = posFromLeader;
                    // If some have already played, we need to ensure insertPos takes that into account
                    // We'll clamp to simTrick.length
                    if (insertPos > simTrick.length) insertPos = simTrick.length;
                }
                simTrick.splice(insertPos, 0, { player: { id: this.id }, card: { rankCode: candidate.rankCode, suitCode: candidate.suitCode, value: candidate.value } });
            }

            // Now simulate remaining players' plays after AI in the trick order
            // Determine leadSuit
            const leadSuit = simTrick[0] ? simTrick[0].card.suitCode : null;

            // Create a map from player id to simulated hand for ease
            const simHandMap = {};
            for (let i = 0; i < playersCount; i++) simHandMap[game.players[i].id] = simHands[i].slice();

            // Fill missing plays in simTrick by walking players in order from leader
            const leaderIndex = simTrick[0] ? game.players.findIndex(p => p.id === simTrick[0].player.id) : 0;
            for (let offset = 0; offset < playersCount; offset++) {
                const idx = (leaderIndex + offset) % playersCount;
                const pid = game.players[idx].id;
                // If this player already has a card in simTrick at their relative pos, continue
                const existing = simTrick.find(e => e.player && e.player.id === pid);
                if (existing) continue;
                // Determine legal plays
                const hand = simHandMap[pid];
                const legal = getLegalPlaysForSim(hand, leadSuit);
                if (legal.length === 0) {
                    // should not happen, but skip
                    continue;
                }
                // Select a legal card using a simple behavior model instead of purely random.
                // If the simulated player is an AI in the real game, bias choices by their aggressiveness.
                const simPlayer = game.players.find(p => p.id === pid);
                let choice = null;
                if (simPlayer && simPlayer.isAI) {
                    const aggr = typeof simPlayer.aggressiveness === 'number'
                        ? simPlayer.aggressiveness
                        : (simPlayer.aiLevel === 'hard' ? 0.8 : simPlayer.aiLevel === 'easy' ? 0.3 : 0.5);
                    if (Math.random() < aggr) {
                        choice = this.getHighestCard(legal);
                    } else {
                        choice = this.getLowestCard(legal);
                    }
                } else {
                    // Non-AI players: mixed heuristic — sometimes play high card if they can win, otherwise low
                    const hasHigh = legal.some(c => c.value >= 12);
                    if (hasHigh && Math.random() < 0.35) {
                        choice = this.getHighestCard(legal);
                    } else {
                        choice = this.getLowestCard(legal);
                    }
                }
                // Remove from simulated hand
                const idxInHand = hand.findIndex(c => c.rankCode === choice.rankCode && c.suitCode === choice.suitCode);
                if (idxInHand > -1) hand.splice(idxInHand, 1);
                simTrick.push({ player: { id: pid }, card: { rankCode: choice.rankCode, suitCode: choice.suitCode, value: choice.value } });
            }

            // Determine winner of simTrick
            // Use same rules: spades trump, else lead suit higher wins
            let winning = simTrick[0];
            const lead = simTrick[0].card.suitCode;
            for (let i = 1; i < simTrick.length; i++) {
                const cur = simTrick[i];
                const winCard = winning.card;
                const curCard = cur.card;
                const winIsSpade = winCard.suitCode === 'S';
                const curIsSpade = curCard.suitCode === 'S';
                if (curIsSpade && !winIsSpade) winning = cur;
                else if (curIsSpade && winIsSpade) { if (curCard.value > winCard.value) winning = cur; }
                else if (curCard.suitCode === lead && winCard.suitCode === lead) { if (curCard.value > winCard.value) winning = cur; }
            }

            if (winning.player.id === this.id) wins++;
        }

        return wins / trials;
    }

    /**
     * Return true if there may be higher spades unseen than the provided card.
     * Uses this.playedCards and the AI's own hand to approximate.
     */
    hasUnseenHigherSpadeThan(card) {
        if (!card || card.suitCode !== 'S') return false;

        // ranks higher than card.value
        const higher = [14,13,12,11,10].filter(v => v > card.value);

        // Map values to rankCodes used in cards
        const valueToRank = v => {
            if (v === 14) return 'A';
            if (v === 13) return 'K';
            if (v === 12) return 'Q';
            if (v === 11) return 'J';
            if (v === 10) return 'T';
            return String(v);
        };

        for (const v of higher) {
            const rankCode = valueToRank(v);
            // If we have it in hand, it's not unseen
            const inHand = this.hand.some(c => c.suitCode === 'S' && c.rankCode === rankCode);
            if (inHand) continue;

            // If it's been played, it's not unseen
            const played = this.playedCards.some(pc => pc.suitCode === 'S' && pc.rankCode === rankCode);
            if (played) continue;

            // Not in hand and not played => unseen higher spade may exist
            return true;
        }

        return false;
    }

    /**
     * Generalized check: are there unseen higher cards in this card's suit?
     * Uses AI's hand and this.playedCards to determine if any higher ranks remain unknown.
     */
    hasUnseenHigherInSuitThan(card) {
        if (!card) return false;

        const rankOrder = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
        const cardIndex = rankOrder.indexOf(card.rankCode);
        if (cardIndex === -1) return false;

        // For each higher rank, check if present in hand or in playedCards; if neither, it's unseen
        for (let i = rankOrder.length - 1; i > cardIndex; i--) {
            const rankCode = rankOrder[i];
            const inHand = this.hand.some(c => c.suitCode === card.suitCode && c.rankCode === rankCode);
            if (inHand) continue;
            const played = this.playedCards.some(pc => pc.suitCode === card.suitCode && pc.rankCode === rankCode);
            if (played) continue;
            // unseen higher found
            return true;
        }

        return false;
    }

    /**
     * Decide whether to play a candidate card when it risks being beaten by unseen higher cards.
     * Uses a simple heuristic probability: fraction of higher ranks unseen vs riskAversion.
     */
    isPlayRisky(card) {
        if (!card) return false;
        const rankOrder = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];
        const idx = rankOrder.indexOf(card.rankCode);
        if (idx === -1) return false;

        // Count higher ranks total and unseen higher ranks
        const higherRanks = rankOrder.slice(idx + 1);
        const unseen = higherRanks.filter(rc => !this.hand.some(c => c.suitCode === card.suitCode && c.rankCode === rc)
            && !this.playedCards.some(pc => pc.suitCode === card.suitCode && pc.rankCode === rc));

        const fracUnseen = unseen.length / higherRanks.length; // 0..1
        // If fraction of unseen higher ranks exceeds riskAversion, consider it risky
        return fracUnseen >= this.riskAversion;
    }

    cardBeats(card, otherCard, game) {
        const leadSuit = game.trick[0].card.suitCode;

        // Spade beats non-spade
        if (card.suitCode === 'S' && otherCard.suitCode !== 'S') return true;
        if (card.suitCode !== 'S' && otherCard.suitCode === 'S') return false;

        // Both same suit (including both spades)
        if (card.suitCode === otherCard.suitCode) {
            return card.value > otherCard.value;
        }

        // Different suits (neither is spade, neither is lead suit wins)
        if (card.suitCode === leadSuit) return true;
        if (otherCard.suitCode === leadSuit) return false;

        // Neither is lead suit or spade - neither wins
        return false;
    }

    getCurrentWinningCard(game) {
        if (game.trick.length === 0) return null;

        let winningEntry = game.trick[0];
        const leadSuit = game.trick[0].card.suitCode;

        for (let i = 1; i < game.trick.length; i++) {
            const currentEntry = game.trick[i];
            if (this.cardBeats(currentEntry.card, winningEntry.card, game)) {
                winningEntry = currentEntry;
            }
        }

        return winningEntry.card;
    }

    getPartner(game) {
        // No partners in cutthroat mode
        if (game.isCutthroat()) {
            return null;
        }
        
        // In classic mode, partners are opposite (indices 0&2, 1&3)
        const myIndex = game.players.findIndex(p => p.id === this.id);
        const partnerIndex = (myIndex + 2) % 4;
        return game.players[partnerIndex];
    }

    /**
     * Reset AI state for new round
     */
    resetForNewRound() {
        super.resetForNewRound();
        this.playedCards = [];
    }
}


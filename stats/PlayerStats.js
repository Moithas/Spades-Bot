// stats/PlayerStats.js

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATS_FILE = path.join(__dirname, 'playerData.json');

/**
 * PlayerStats - Manages player statistics with JSON file storage
 */
export class PlayerStats {
    constructor() {
        this.data = {};
        this.initialized = false;
        this.saveQueue = Promise.resolve(); // Queue for serializing saves
    }

    /**
     * Initialize the stats system - load existing data or create new file
     */
    async initialize() {
        try {
            const fileData = await fs.readFile(STATS_FILE, 'utf-8');
            this.data = JSON.parse(fileData);
            logger.info(`✅ Loaded player stats for ${Object.keys(this.data).length} players`);
        } catch (err) {
            if (err.code === 'ENOENT') {
                // File doesn't exist, create it
                this.data = {};
                await this.save();
                logger.info('✅ Created new player stats file');
            } else {
                logger.error('❌ Error loading player stats:', err);
                this.data = {};
            }
        }
        this.initialized = true;
    }

    /**
     * Save current data to file
     * Uses a queue to prevent race conditions from concurrent saves
     */
    async save() {
        // Chain this save operation to the end of the queue
        this.saveQueue = this.saveQueue.then(async () => {
            try {
                await fs.writeFile(STATS_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
            } catch (err) {
                logger.error('❌ Error saving player stats:', err);
                throw err; // Re-throw so calling code knows save failed
            }
        }).catch(err => {
            // Log error but don't break the queue chain
            logger.error('❌ Save queue error:', err);
        });
        
        // Return the queued operation so callers can await it if needed
        return this.saveQueue;
    }

    /**
     * Get stats for a specific player, creating entry if it doesn't exist
     * @param {string} discordId - Player's Discord ID
     * @param {string} username - Player's username (for display)
     * @returns {Object} Player statistics object
     */
    getPlayerStats(discordId, username = 'Unknown') {
        if (!this.data[discordId]) {
            this.data[discordId] = {
                discordId: discordId,
                username: username,
                stats: {
                    // Classic mode stats (team-based)
                    classic: {
                        gamesPlayed: 0,
                        gamesWon: 0,
                        handsPlayed: 0,
                        nilBids: 0,
                        nilSuccesses: 0,
                        blindNilBids: 0,
                        blindNilSuccesses: 0,
                        totalBags: 0,
                        totalPoints: 0,
                        totalTricksWon: 0,
                        highestScore: 0
                    },
                    // 3-Player Cutthroat mode stats
                    cutthroat3: {
                        gamesPlayed: 0,
                        gamesWon: 0,
                        handsPlayed: 0,
                        nilBids: 0,
                        nilSuccesses: 0,
                        blindNilBids: 0,
                        blindNilSuccesses: 0,
                        totalBags: 0,
                        totalPoints: 0,
                        totalTricksWon: 0,
                        highestScore: 0
                    },
                    // 4-Player Cutthroat mode stats
                    cutthroat4: {
                        gamesPlayed: 0,
                        gamesWon: 0,
                        handsPlayed: 0,
                        nilBids: 0,
                        nilSuccesses: 0,
                        blindNilBids: 0,
                        blindNilSuccesses: 0,
                        totalBags: 0,
                        totalPoints: 0,
                        totalTricksWon: 0,
                        highestScore: 0
                    },
                    lastPlayed: null
                },
                // Opponent modeling data - AI learns player patterns
                opponentProfile: {
                    // Bidding patterns
                    totalBids: 0,
                    bidSum: 0, // Sum of all bids (for average calculation)
                    bidsByHandStrength: [], // Array of {handStrength, bid} for correlation analysis
                    
                    // Nil bidding behavior
                    nilAttempts: 0,
                    nilSuccesses: 0,
                    conservativeNilBidder: null, // true/false/null (unknown)
                    
                    // Card playing patterns
                    leadsHigh: 0, // Times player led with high card when winning
                    leadsLow: 0, // Times player led with low card when winning
                    aggressivePlay: 0, // Times player took trick unnecessarily
                    conservativePlay: 0, // Times player played safe/low
                    
                    // Team play (classic mode only)
                    helpsPartnerNil: 0, // Times player helped partner's Nil bid
                    ignoresPartnerNil: 0, // Times player didn't help partner's Nil
                    
                    // Calculated tendencies (updated periodically)
                    biddingStyle: 'unknown', // 'aggressive', 'conservative', 'balanced', 'unknown'
                    playingStyle: 'unknown', // 'aggressive', 'conservative', 'balanced', 'unknown'
                    nilTendency: 'unknown', // 'frequent', 'rare', 'never', 'unknown'
                    teamPlayer: 'unknown', // 'excellent', 'good', 'poor', 'unknown'
                    
                    // Sample size tracking
                    handsObserved: 0,
                    gamesObserved: 0,
                    lastUpdated: null
                }
            };
        }
        
        // Migrate old stats format to new format if needed
        if (this.data[discordId].stats && !this.data[discordId].stats.classic) {
            const oldStats = this.data[discordId].stats;
            this.data[discordId].stats = {
                classic: {
                    gamesPlayed: oldStats.gamesPlayed || 0,
                    gamesWon: oldStats.gamesWon || 0,
                    handsPlayed: oldStats.handsPlayed || 0,
                    nilBids: oldStats.nilBids || 0,
                    nilSuccesses: oldStats.nilSuccesses || 0,
                    blindNilBids: oldStats.blindNilBids || 0,
                    blindNilSuccesses: oldStats.blindNilSuccesses || 0,
                    totalBags: oldStats.totalBags || 0,
                    totalPoints: oldStats.totalPoints || 0,
                    totalTricksWon: oldStats.totalTricksWon || 0,
                    highestScore: oldStats.highestScore || 0
                },
                cutthroat3: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    handsPlayed: 0,
                    nilBids: 0,
                    nilSuccesses: 0,
                    blindNilBids: 0,
                    blindNilSuccesses: 0,
                    totalBags: 0,
                    totalPoints: 0,
                    totalTricksWon: 0,
                    highestScore: 0
                },
                cutthroat4: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    handsPlayed: 0,
                    nilBids: 0,
                    nilSuccesses: 0,
                    blindNilBids: 0,
                    blindNilSuccesses: 0,
                    totalBags: 0,
                    totalPoints: 0,
                    totalTricksWon: 0,
                    highestScore: 0
                },
                lastPlayed: oldStats.lastPlayed || null
            };
        }
        
        // Ensure cutthroat3 and cutthroat4 exist (for players with old 'cutthroat' format)
        if (this.data[discordId].stats) {
            const stats = this.data[discordId].stats;
            const defaultCutthroatStats = {
                gamesPlayed: 0,
                gamesWon: 0,
                handsPlayed: 0,
                nilBids: 0,
                nilSuccesses: 0,
                blindNilBids: 0,
                blindNilSuccesses: 0,
                totalBags: 0,
                totalPoints: 0,
                totalTricksWon: 0,
                highestScore: 0
            };
            
            // Migrate old 'cutthroat' to 'cutthroat3' if needed
            if (!stats.cutthroat3) {
                if (stats.cutthroat) {
                    stats.cutthroat3 = { ...stats.cutthroat };
                    delete stats.cutthroat;
                } else {
                    stats.cutthroat3 = { ...defaultCutthroatStats };
                }
            }
            
            // Ensure cutthroat4 exists
            if (!stats.cutthroat4) {
                stats.cutthroat4 = { ...defaultCutthroatStats };
            }
        }
        
        // Ensure opponent profile exists (for players created before this feature)
        if (!this.data[discordId].opponentProfile) {
            this.data[discordId].opponentProfile = {
                totalBids: 0,
                bidSum: 0,
                bidsByHandStrength: [],
                nilAttempts: 0,
                nilSuccesses: 0,
                conservativeNilBidder: null,
                leadsHigh: 0,
                leadsLow: 0,
                aggressivePlay: 0,
                conservativePlay: 0,
                helpsPartnerNil: 0,
                ignoresPartnerNil: 0,
                biddingStyle: 'unknown',
                playingStyle: 'unknown',
                nilTendency: 'unknown',
                teamPlayer: 'unknown',
                handsObserved: 0,
                gamesObserved: 0,
                lastUpdated: null
            };
        }
        
        // Update username if it changed
        if (this.data[discordId].username !== username) {
            this.data[discordId].username = username;
        }
        
        return this.data[discordId];
    }

    /**
     * Update player stats after a game
     * @param {string} discordId - Player's Discord ID
     * @param {string} username - Player's username
     * @param {Object} gameData - Game result data
     */
    async updateStats(discordId, username, gameData) {
        const player = this.getPlayerStats(discordId, username);
        const gameMode = gameData.gameMode || 'classic'; // 'classic', 'cutthroat3', or 'cutthroat4'
        let stats;
        if (gameMode === 'classic') {
            stats = player.stats.classic;
        } else if (gameMode === 'cutthroat3') {
            stats = player.stats.cutthroat3;
        } else if (gameMode === 'cutthroat4') {
            stats = player.stats.cutthroat4;
        } else {
            // fallback for legacy: treat as generic cutthroat
            stats = player.stats.cutthroat3;
        }

        // Update game counts
        stats.gamesPlayed += 1;
        if (gameData.won) {
            stats.gamesWon += 1;
        }

        // Update hand count
        stats.handsPlayed += gameData.handsPlayed || 0;

        // Update Nil stats
        if (gameData.nilBids) {
            stats.nilBids += gameData.nilBids;
            stats.nilSuccesses += gameData.nilSuccesses || 0;
        }

        // Update Blind Nil stats
        if (gameData.blindNilBids) {
            stats.blindNilBids += gameData.blindNilBids;
            stats.blindNilSuccesses += gameData.blindNilSuccesses || 0;
        }

        // Update bags and points
        stats.totalBags += gameData.bags || 0;
        stats.totalPoints += gameData.finalScore || 0;
        stats.totalTricksWon += gameData.tricksWon || 0;

        // Update high score
        if (gameData.finalScore > stats.highestScore) {
            stats.highestScore = gameData.finalScore;
        }

        // Update last played timestamp (shared across modes)
        player.stats.lastPlayed = new Date().toISOString();

        await this.save();
    }

    /**
     * Get calculated statistics for display
     * @param {string} discordId - Player's Discord ID
     * @param {string} gameMode - 'classic', 'cutthroat', or null for combined stats
     * @returns {Object} Calculated stats with percentages and averages
     */
    getCalculatedStats(discordId, gameMode = null) {
        const player = this.data[discordId];
        if (!player) return null;

        // Migrate old stats format to new format if needed
        let migrated = false;
        if (player.stats && !player.stats.classic && !player.stats.cutthroat3 && !player.stats.cutthroat4) {
            const oldStats = player.stats;
            player.stats = {
                classic: oldStats.classic || {
                    gamesPlayed: oldStats.gamesPlayed || 0,
                    gamesWon: oldStats.gamesWon || 0,
                    handsPlayed: oldStats.handsPlayed || 0,
                    nilBids: oldStats.nilBids || 0,
                    nilSuccesses: oldStats.nilSuccesses || 0,
                    blindNilBids: oldStats.blindNilBids || 0,
                    blindNilSuccesses: oldStats.blindNilSuccesses || 0,
                    totalBags: oldStats.totalBags || 0,
                    totalPoints: oldStats.totalPoints || 0,
                    totalTricksWon: oldStats.totalTricksWon || 0,
                    highestScore: oldStats.highestScore || 0
                },
                cutthroat3: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    handsPlayed: 0,
                    nilBids: 0,
                    nilSuccesses: 0,
                    blindNilBids: 0,
                    blindNilSuccesses: 0,
                    totalBags: 0,
                    totalPoints: 0,
                    totalTricksWon: 0,
                    highestScore: 0
                },
                cutthroat4: {
                    gamesPlayed: 0,
                    gamesWon: 0,
                    handsPlayed: 0,
                    nilBids: 0,
                    nilSuccesses: 0,
                    blindNilBids: 0,
                    blindNilSuccesses: 0,
                    totalBags: 0,
                    totalPoints: 0,
                    totalTricksWon: 0,
                    highestScore: 0
                },
                lastPlayed: oldStats.lastPlayed || null
            };
            migrated = true;
        }

        // Ensure stats object exists
        if (!player.stats) {
            player.stats = {
                classic: null,
                cutthroat3: null,
                cutthroat4: null,
                lastPlayed: null
            };
        }

        // Save migrated data
        if (migrated) {
            this.save().catch(err => logger.error('Failed to save migrated stats:', err));
        }

        // If no mode specified, return all three stats
        if (!gameMode) {
            return {
                username: player.username,
                classic: this.calculateModeStats(player.stats.classic, false),
                cutthroat3: this.calculateModeStats(player.stats.cutthroat3, true),
                cutthroat4: this.calculateModeStats(player.stats.cutthroat4, true),
                lastPlayed: player.stats.lastPlayed
            };
        }

        // Return stats for specific mode
        if (gameMode === 'classic') {
            return {
                username: player.username,
                ...this.calculateModeStats(player.stats.classic, false),
                lastPlayed: player.stats.lastPlayed
            };
        } else if (gameMode === 'cutthroat3') {
            return {
                username: player.username,
                ...this.calculateModeStats(player.stats.cutthroat3, true),
                lastPlayed: player.stats.lastPlayed
            };
        } else if (gameMode === 'cutthroat4') {
            return {
                username: player.username,
                ...this.calculateModeStats(player.stats.cutthroat4, true),
                lastPlayed: player.stats.lastPlayed
            };
        }
        // fallback
        return {
            username: player.username,
            ...this.calculateModeStats(player.stats.classic, false),
            lastPlayed: player.stats.lastPlayed
        };
    }

    /**
     * Calculate statistics for a specific game mode
     * @param {Object} stats - Stats object for the mode
     * @param {boolean} isCutthroat - Whether this is cutthroat mode
     * @returns {Object} Calculated stats
     */
    calculateModeStats(stats, isCutthroat) {
        // Safety check: if stats is undefined or null, return default empty stats
        if (!stats) {
            stats = {
                gamesPlayed: 0,
                gamesWon: 0,
                handsPlayed: 0,
                nilBids: 0,
                nilSuccesses: 0,
                blindNilBids: 0,
                blindNilSuccesses: 0,
                totalBags: 0,
                totalPoints: 0,
                totalTricksWon: 0,
                highestScore: 0
            };
        }
        
        const gamesPlayed = stats.gamesPlayed || 0;
        const handsPlayed = stats.handsPlayed || 0;

        const calculated = {
            gamesPlayed: gamesPlayed,
            gamesWon: stats.gamesWon || 0,
            winRate: gamesPlayed > 0 ? ((stats.gamesWon / gamesPlayed) * 100).toFixed(1) : '0.0',
            
            handsPlayed: handsPlayed,
            
            totalBags: stats.totalBags,
            avgBagsPerGame: gamesPlayed > 0 ? (stats.totalBags / gamesPlayed).toFixed(2) : '0.00',
            avgBagsPerHand: handsPlayed > 0 ? (stats.totalBags / handsPlayed).toFixed(2) : '0.00',
            
            avgScorePerGame: gamesPlayed > 0 ? Math.round(stats.totalPoints / gamesPlayed) : 0,
            
            totalTricksWon: stats.totalTricksWon,
            
            highestScore: stats.highestScore,
            
            // Nil stats now included for both classic and cutthroat modes
            nilAttempts: stats.nilBids || 0,
            nilSuccessRate: stats.nilBids > 0 ? ((stats.nilSuccesses / stats.nilBids) * 100).toFixed(1) : '0.0',
            blindNilAttempts: stats.blindNilBids || 0,
            blindNilSuccessRate: stats.blindNilBids > 0 ? ((stats.blindNilSuccesses / stats.blindNilBids) * 100).toFixed(1) : '0.0'
        };

        return calculated;
    }

    /**
     * Get all players sorted by games won (for leaderboard)
     * @param {number} limit - Maximum number of players to return
     * @param {string} gameMode - 'classic', 'cutthroat', or null for combined
     * @returns {Array} Array of player stats sorted by wins
     */
    getLeaderboard(limit = 10, gameMode = null) {
        const players = Object.values(this.data).filter(p => p && p.stats);

        // If no mode specified, combine stats from all modes
        if (!gameMode) {
            return players
                .map(p => {
                    const classicWins = p.stats.classic?.gamesWon || 0;
                    const classicPlayed = p.stats.classic?.gamesPlayed || 0;
                    const cutthroat3Wins = p.stats.cutthroat3?.gamesWon || 0;
                    const cutthroat3Played = p.stats.cutthroat3?.gamesPlayed || 0;
                    const cutthroat4Wins = p.stats.cutthroat4?.gamesWon || 0;
                    const cutthroat4Played = p.stats.cutthroat4?.gamesPlayed || 0;
                    const totalWins = classicWins + cutthroat3Wins + cutthroat4Wins;
                    const totalPlayed = classicPlayed + cutthroat3Played + cutthroat4Played;

                    return {
                        username: p.username,
                        discordId: p.discordId,
                        gamesWon: totalWins,
                        gamesPlayed: totalPlayed,
                        winRate: totalPlayed > 0 ? ((totalWins / totalPlayed) * 100).toFixed(1) : '0.0'
                    };
                })
                .filter(p => p.gamesPlayed > 0)
                .sort((a, b) => b.gamesWon - a.gamesWon)
                .slice(0, limit);
        }

        // Return stats for specific mode
        if (gameMode === 'classic') {
            return players
                .map(p => {
                    const stats = p.stats.classic;
                    const gamesPlayed = stats?.gamesPlayed || 0;
                    const gamesWon = stats?.gamesWon || 0;

                    return {
                        username: p.username,
                        discordId: p.discordId,
                        gamesWon: gamesWon,
                        gamesPlayed: gamesPlayed,
                        winRate: gamesPlayed > 0 ? ((gamesWon / gamesPlayed) * 100).toFixed(1) : '0.0'
                    };
                })
                .filter(p => p.gamesPlayed > 0)
                .sort((a, b) => b.gamesWon - a.gamesWon)
                .slice(0, limit);
        }

        // Cutthroat mode - combine cutthroat3 and cutthroat4
        return players
            .map(p => {
                const ct3Wins = p.stats.cutthroat3?.gamesWon || 0;
                const ct3Played = p.stats.cutthroat3?.gamesPlayed || 0;
                const ct4Wins = p.stats.cutthroat4?.gamesWon || 0;
                const ct4Played = p.stats.cutthroat4?.gamesPlayed || 0;
                const gamesWon = ct3Wins + ct4Wins;
                const gamesPlayed = ct3Played + ct4Played;

                return {
                    username: p.username,
                    discordId: p.discordId,
                    gamesWon: gamesWon,
                    gamesPlayed: gamesPlayed,
                    winRate: gamesPlayed > 0 ? ((gamesWon / gamesPlayed) * 100).toFixed(1) : '0.0'
                };
            })
            .filter(p => p.gamesPlayed > 0)
            .sort((a, b) => b.gamesWon - a.gamesWon)
            .slice(0, limit);
    }

    /**
     * Update opponent profile with observations from a hand of play
     * @param {string} discordId - Player's Discord ID
     * @param {Object} observations - Observations from the hand
     */
    async updateOpponentProfile(discordId, observations) {
        const player = this.data[discordId];
        if (!player || !player.opponentProfile) {
            logger.warn(`Cannot update opponent profile for unknown player: ${discordId}`);
            return;
        }

        const profile = player.opponentProfile;

        // Update bid tracking
        if (observations.bid !== undefined && observations.bid !== null) {
            profile.totalBids++;
            profile.bidSum += observations.bid;
            
            // Track bid vs hand strength correlation
            if (observations.handStrength !== undefined) {
                profile.bidsByHandStrength.push({
                    strength: observations.handStrength,
                    bid: observations.bid,
                    timestamp: Date.now()
                });
                
                // Keep only last 50 data points to avoid infinite growth
                if (profile.bidsByHandStrength.length > 50) {
                    profile.bidsByHandStrength.shift();
                }
            }
        }

        // Update Nil tracking
        if (observations.bidNil) {
            profile.nilAttempts++;
            if (observations.nilSuccess) {
                profile.nilSuccesses++;
            }
        }

        // Update playing patterns
        if (observations.ledHigh) profile.leadsHigh++;
        if (observations.ledLow) profile.leadsLow++;
        if (observations.aggressivePlay) profile.aggressivePlay++;
        if (observations.conservativePlay) profile.conservativePlay++;

        // Update team play patterns (classic mode only)
        if (observations.helpedPartnerNil) profile.helpsPartnerNil++;
        if (observations.ignoredPartnerNil) profile.ignoresPartnerNil++;

        // Update observation counts
        profile.handsObserved++;
        if (observations.isGameEnd) {
            profile.gamesObserved++;
        }

        // Recalculate tendencies every 5 hands
        if (profile.handsObserved % 5 === 0) {
            this.analyzeOpponentTendencies(discordId);
        }

        profile.lastUpdated = Date.now();

        // Save asynchronously
        await this.save();
    }

    /**
     * Analyze opponent tendencies based on collected data
     * @param {string} discordId - Player's Discord ID
     */
    analyzeOpponentTendencies(discordId) {
        const player = this.data[discordId];
        if (!player || !player.opponentProfile) return;

        const profile = player.opponentProfile;
        const minSampleSize = 5; // Need at least 5 observations for meaningful analysis

        // Analyze bidding style
        if (profile.totalBids >= minSampleSize) {
            const avgBid = profile.bidSum / profile.totalBids;
            
            // Compare bid to expected value based on hand strength
            if (profile.bidsByHandStrength.length >= minSampleSize) {
                const avgStrength = profile.bidsByHandStrength.reduce((sum, d) => sum + d.strength, 0) / profile.bidsByHandStrength.length;
                const expectedBid = avgStrength / 10; // Rough heuristic: strength 40 = bid 4
                const bidDiff = avgBid - expectedBid;
                
                if (bidDiff > 0.5) {
                    profile.biddingStyle = 'aggressive'; // Bids higher than hand suggests
                } else if (bidDiff < -0.5) {
                    profile.biddingStyle = 'conservative'; // Bids lower than hand suggests
                } else {
                    profile.biddingStyle = 'balanced';
                }
            } else {
                // Simple analysis based on average bid
                if (avgBid > 4.5) {
                    profile.biddingStyle = 'aggressive';
                } else if (avgBid < 3.5) {
                    profile.biddingStyle = 'conservative';
                } else {
                    profile.biddingStyle = 'balanced';
                }
            }
        }

        // Analyze playing style
        const totalLeads = profile.leadsHigh + profile.leadsLow;
        if (totalLeads >= minSampleSize) {
            const highLeadRate = profile.leadsHigh / totalLeads;
            
            if (highLeadRate > 0.65) {
                profile.playingStyle = 'aggressive'; // Leads high often
            } else if (highLeadRate < 0.35) {
                profile.playingStyle = 'conservative'; // Leads low often
            } else {
                profile.playingStyle = 'balanced';
            }
        }

        // Analyze Nil tendency
        if (profile.handsObserved >= minSampleSize) {
            const nilRate = profile.nilAttempts / profile.handsObserved;
            
            if (nilRate > 0.25) {
                profile.nilTendency = 'frequent'; // Bids Nil often (>25% of hands)
            } else if (nilRate > 0.1) {
                profile.nilTendency = 'occasional'; // Bids Nil sometimes
            } else if (profile.nilAttempts > 0) {
                profile.nilTendency = 'rare'; // Has bid Nil but rarely
            } else {
                profile.nilTendency = 'never'; // Never bid Nil
            }
            
            // Analyze Nil success rate for conservativeness
            if (profile.nilAttempts >= 3) {
                const nilSuccessRate = profile.nilSuccesses / profile.nilAttempts;
                profile.conservativeNilBidder = nilSuccessRate > 0.6; // >60% success = conservative
            }
        }

        // Analyze team play quality
        const totalPartnerNilSituations = profile.helpsPartnerNil + profile.ignoresPartnerNil;
        if (totalPartnerNilSituations >= 3) {
            const helpRate = profile.helpsPartnerNil / totalPartnerNilSituations;
            
            if (helpRate > 0.8) {
                profile.teamPlayer = 'excellent';
            } else if (helpRate > 0.5) {
                profile.teamPlayer = 'good';
            } else {
                profile.teamPlayer = 'poor';
            }
        }

        logger.debug(`📊 Analyzed opponent ${player.username}: bidding=${profile.biddingStyle}, playing=${profile.playingStyle}, nil=${profile.nilTendency}, team=${profile.teamPlayer}`);
    }

    /**
     * Get opponent profile for AI decision-making
     * @param {string} discordId - Player's Discord ID
     * @returns {Object} Opponent profile with tendencies
     */
    getOpponentProfile(discordId) {
        const player = this.data[discordId];
        if (!player || !player.opponentProfile) {
            return {
                biddingStyle: 'unknown',
                playingStyle: 'unknown',
                nilTendency: 'unknown',
                teamPlayer: 'unknown',
                sampleSize: 0,
                reliable: false
            };
        }

        const profile = player.opponentProfile;
        const reliable = profile.handsObserved >= 10; // Need 10+ hands for reliable profile

        return {
            biddingStyle: profile.biddingStyle,
            playingStyle: profile.playingStyle,
            nilTendency: profile.nilTendency,
            teamPlayer: profile.teamPlayer,
            conservativeNilBidder: profile.conservativeNilBidder,
            avgBid: profile.totalBids > 0 ? (profile.bidSum / profile.totalBids).toFixed(1) : null,
            nilSuccessRate: profile.nilAttempts > 0 ? ((profile.nilSuccesses / profile.nilAttempts) * 100).toFixed(0) : null,
            sampleSize: profile.handsObserved,
            gamesObserved: profile.gamesObserved,
            reliable: reliable,
            lastUpdated: profile.lastUpdated
        };
    }
}

// Export singleton instance
export const playerStats = new PlayerStats();


// game_logic/GameManager.js

import { Deck } from './Deck.js';
import { Player } from './Player.js';
import { Card } from './Card.js'; // Used for type hinting and checking card properties

/**
 * Manages the state and flow of a four-player game of Spades, including dealing,
 * bidding, trick play, and scoring.
 */
export default class GameManager {
    /**
     * @param {function(string)} publicAnnounce - Function to send a message to the public game chat.
     * @param {function(string, string)} privatePrompt - Function to send a DM to a specific player ID.
     * @param {number} [targetScore=500] - The score required to win the game.
     */
    constructor(publicAnnounce, privatePrompt, targetScore = 500) {
        // Core game state
        this.deck = new Deck();
        this.players = [];
        this.targetScore = targetScore; 
        this.isGameActive = false;
	this.state = 'LOBBY'; // ✅ Add this line

        // Round & Turn management
        this.currentPlayerIndex = 0; // The index of the player whose turn it is
        this.bidsTaken = 0;
        this.isBiddingActive = false;

        // --- Trick Play State ---
        this.isTrickActive = false;
        this.currentTrick = [];      // Stores {playerId: string, card: Card} objects
        // CHANGED: trickSuit now consistently stores the single-character suit code ('C', 'D', 'H', 'S')
        this.trickSuit = null;       // The suit that was led (e.g., 'C', 'D', 'H', 'S')
        this.spadesBroken = false; // Tracks if a spade has been played as a trump this round
        
        // Communication hooks (MUST be implemented by the platform)
        this.publicAnnounce = publicAnnounce;
        this.privatePrompt = privatePrompt;
    }

    // --- Utility Methods ---

    /**
     * Finds a player object by their Discord ID.
     * @param {string} playerId 
     * @returns {Player|undefined}
     */
    getPlayerById(playerId) {
        // FIX: Use discordId property from Player class
        return this.players.find(p => p.discordId === playerId);
    }
    
    /**
     * Finds a card in a player's hand without removing it.
     * @param {Player} player - The player object.
     * @param {string} cardCode - The two-character code of the card.
     * @returns {Card|undefined} The card object if found.
     */
    peekCardInHand(player, cardCode) {
        const upperCode = cardCode.trim().toUpperCase();
        return player.hand.find(card => card.code.toUpperCase() === upperCode);
    }

    /**
     * Generates a readable display string for a player's hand, sorted.
     * @param {Player} player 
     * @returns {string} Formatted list of card codes/displays.
     */
    getHandDisplay(player) {
        player.sortHand(); // Ensure the hand is sorted before display
        // Use the display property from the Card object (e.g., A♠️)
        const handStrings = player.hand.map(card => card.display);
        return handStrings.join(' | ');
    }

    // --- Player & Team Management ---

    /**
 	* Adds a player and initializes their state.
 	* @param {Object} playerDetails - Contains id, username, and guildId.
 	* @returns {Object} Result object with either success or error.
 	*/
	addPlayer(playerDetails) {
   	 if (this.players.length >= 4) {
        return { error: 'Lobby is full!' };
    }

    // Create and initialize the new player
    const newPlayer = new Player(playerDetails.id, playerDetails.username);
    newPlayer.discordId = playerDetails.id;
    newPlayer.username = playerDetails.username;
    newPlayer.guildId = playerDetails.guildId;
    newPlayer.score = 0;
    newPlayer.bags = 0;

    // Temporary team assignment before partnerships are finalized
    const teamId = (this.players.length % 2 === 0) ? 2 : 1;
    newPlayer.team = teamId;

    this.players.push(newPlayer);

    this.publicAnnounce(`Player **${newPlayer.username}** has joined (Team ${teamId} placeholder).`);

    // Safely call setupPartnerships if it exists
    if (this.players.length === 4 && typeof this.setupPartnerships === 'function') {
        this.setupPartnerships();
    }

    return { success: true };
}


    // --- Game Setup and Dealing ---

	/**
	 * Checks if the lobby has reached 4 players.
	 * @returns {boolean}
	 */
	isLobbyFull() {
	    return this.players.length >= 4;
}


startGame() {
    if (this.players.length !== 4) {
        this.publicAnnounce("Error: Spades requires exactly 4 players to start.");
        return;
    }

    this.isGameActive = true;
    this.deck.reset();
    this.deck.shuffle();
    this.dealCards();
    this.startBidding();
}

dealCards() {
    // Clear hands and reset round state
    this.players.forEach(p => p.resetForNewRound());

    // Deals 13 cards to each of the 4 players
    for (let i = 0; i < 52; i++) {
        const card = this.deck.deal();
        const playerIndex = i % this.players.length;
        this.players[playerIndex].addCard(card);
    }

    // 1. Sort hands and privately send them
    this.players.forEach(player => {
        const handDisplay = this.getHandDisplay(player); // Use the utility method
        this.privatePrompt(player.discordId, `Your hand for this round:\n\`${handDisplay}\``);
    });

    this.publicAnnounce("Cards have been dealt privately to all players. Bidding will now commence!");
}

/**
 * Returns a formatted string of the player's hand using suit emojis.
 * Example: A♠️ | 10♦️ | K♥️ | 3♣️
 * @param {Player} player
 * @returns {string}
 */
getHandDisplay(player) {
    player.sortHand();
    return player.hand.map(card => card.code).join(' | ');
}


    // --- Bidding Logic ---

startBidding() {
    this.state = 'BIDDING'; // ✅ Enables bid button interactions
    this.isBiddingActive = true;
    this.bidsTaken = 0;

    const startingPlayer = this.players[this.currentPlayerIndex];

    this.publicAnnounce(`**${startingPlayer.username}** is the first player to bid.`);
    this.sendBidPrompt(startingPlayer);
}

sendBidPrompt(player) {
    this.publicAnnounce(`**It is Player ${player.username}'s turn to bid.**`);

    const instruction = "Enter your bid (a number from **1 to 13**, or **'Nil'**). Submit this in your direct message (DM) to me now.";
    this.privatePrompt(player.discordId, instruction);
}

/**
 * Handles a bid submitted privately by a player.
 */
processBid(playerId, rawBidValue) {
    if (!this.isBiddingActive) {
        this.privatePrompt(playerId, "The bidding phase is not currently active.");
        return false;
    }

    const currentPlayer = this.players[this.currentPlayerIndex];

    // Enforce Sequential Turn Order
    if (currentPlayer.discordId !== playerId) {
        this.privatePrompt(playerId, "It is not your turn to bid. Please wait for the public announcement.");
        return false;
    }

    const parsedBid = this.validateBid(rawBidValue);
    if (parsedBid === null) {
        this.privatePrompt(playerId, "Invalid bid. Please enter a number between 1 and 13, or 'Nil' (case-insensitive).");
        return false;
    }

    // Record the Bid
    const bidAmount = (parsedBid === 'NIL') ? 0 : parsedBid;
    currentPlayer.setBid(bidAmount);
    this.bidsTaken++;

    // Public Announcement
    const announcement = currentPlayer.isNil
        ? `**Player ${currentPlayer.username} bids NIL!**`
        : `**Player ${currentPlayer.username} bids ${currentPlayer.bid}.**`;

    this.publicAnnounce(announcement);

    // Advance Turn or End Bidding
    if (this.bidsTaken < this.players.length) {
        this.advanceTurn('bid');
    } else {
        this.endBidding();
    }

    return true;
}

validateBid(rawBidValue) {
    const value = rawBidValue.trim().toUpperCase();
    if (value === 'NIL') {
        return 'NIL';
    }
    const num = parseInt(value, 10);
    if (num >= 1 && num <= 13) {
        return num;
    }
    return null;
}

advanceTurn(phase) {
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    const nextPlayer = this.players[this.currentPlayerIndex];

    if (phase === 'bid') {
        this.sendBidPrompt(nextPlayer);
    } else if (phase === 'trick') {
        this.sendPlayCardPrompt(nextPlayer);
    }
}

endBidding() {
    this.isBiddingActive = false;

    const team1 = this.players.filter(p => p.team === 1);
    const team2 = this.players.filter(p => p.team === 2);

    const team1Bid = team1.reduce((sum, p) => sum + p.bid, 0);
    const team2Bid = team2.reduce((sum, p) => sum + p.bid, 0);

    this.publicAnnounce("\n--- Bidding Complete ---");
    this.publicAnnounce(`Team 1 (${team1.map(p => p.username).join(' & ')}): **${team1Bid}**`);
    this.publicAnnounce(`Team 2 (${team2.map(p => p.username).join(' & ')}): **${team2Bid}**`);
    this.publicAnnounce("The first trick will now begin!");

    // Transition to Trick Playing
    this.startTricks();
}
 /**
 * Handles a bid from a player via button interaction.
 * Returns structured data for interaction response.
 * @param {string} playerId - Discord ID of the player
 * @param {number} bidAmount - 0 for Nil, 1–13 otherwise
 * @returns {object} Result object with bidDisplay, error, biddingComplete, bidsRemaining
 */
tryPlaceBid(playerId, bidAmount) {
    if (!this.isBiddingActive || this.state !== 'BIDDING') {
        return { error: 'Bidding is not currently active.' };
    }

    const currentPlayer = this.players[this.currentPlayerIndex];

    if (currentPlayer.discordId !== playerId) {
        return { error: `It is not your turn to bid. Please wait for your turn.` };
    }

    if (typeof bidAmount !== 'number' || bidAmount < 0 || bidAmount > 13) {
        return { error: 'Invalid bid amount. Must be 0 (Nil) or between 1 and 13.' };
    }

    currentPlayer.setBid(bidAmount);
    this.bidsTaken++;

    const bidDisplay = bidAmount === 0 ? 'Nil' : bidAmount.toString();

    let biddingComplete = false;
    if (this.bidsTaken < this.players.length) {
        this.advanceTurn('bid');
    } else {
        biddingComplete = true;
        this.endBidding();
    }

    return {
        bidDisplay,
        error: null,
        biddingComplete,
        bidsRemaining: this.players.length - this.bidsTaken
    };
}   

/**
 * Returns a formatted string showing team scores and bids.
 * Useful for public announcements after bidding.
 */
getTeamScoreDisplay() {
    const team1 = this.players.filter(p => p.team === 1);
    const team2 = this.players.filter(p => p.team === 2);

    const team1Bid = team1.reduce((sum, p) => sum + p.bid, 0);
    const team2Bid = team2.reduce((sum, p) => sum + p.bid, 0);

    const team1Score = team1.reduce((sum, p) => sum + p.score, 0);
    const team2Score = team2.reduce((sum, p) => sum + p.score, 0);

    return `🟥 **Team 1** (${team1.map(p => p.username).join(' & ')}): Bid **${team1Bid}**, Score **${team1Score}**\n` +
           `🟦 **Team 2** (${team2.map(p => p.username).join(' & ')}): Bid **${team2Bid}**, Score **${team2Score}**`;
}
    // --- Trick Playing Logic ---

    startTricks() {
        this.isTrickActive = true; 
        
        // Reset state for the new trick
        this.currentTrick = [];
        this.trickSuit = null;  
        
        const leadingPlayer = this.players[this.currentPlayerIndex];
        this.publicAnnounce(`**${leadingPlayer.username} will lead the first trick!**`);
        
        this.sendPlayCardPrompt(leadingPlayer); 
    }

    /** Prompts a player to play a card, displaying the current trick and their hand. */
    sendPlayCardPrompt(player) {
        let trickDisplay = "No cards have been played yet.";
        let suitIndicator = '';

        if (this.currentTrick.length > 0) {
            const cardsPlayed = this.currentTrick.map(entry => 
                // FIX: Use player.username and card.display
                `${this.getPlayerById(entry.playerId).username} played **${entry.card.display}**` 
            ).join(', ');
            
            // ANNOUNCEMENT CLARITY CHANGE: Use the stored trickSuit code to look up the emoji
            const ledSuitCode = this.trickSuit; 
            const suitEmoji = Card.CARD_EMOJIS[ledSuitCode]; // Assuming Card.CARD_EMOJIS exists
            suitIndicator = ledSuitCode ? `(Led Suit: ${ledSuitCode}${suitEmoji})` : '';
            
            trickDisplay = `Current Trick ${suitIndicator}: ${cardsPlayed}`;
        }

        this.publicAnnounce(`**It is Player ${player.username}'s turn to play.**`);
        
        const handDisplay = this.getHandDisplay(player); // Use the utility method
        const instruction = [
            "--- Current Trick ---",
            trickDisplay,
            `Spades Broken: **${this.spadesBroken ? 'YES' : 'NO'}**`,
            "---------------------",
            `Your Hand: \`${handDisplay}\``,
            "Enter the code for the card you wish to play (e.g., 'AS', 'TC'). Submit this in your DM to me now."
        ].join('\n');

        // FIX: Use player.discordId for private prompt
        this.privatePrompt(player.discordId, instruction); 
    }

    /**
     * Handles a card played privately by a player, enforcing Spades rules.
     */
    processCardPlay(playerId, rawCard) {
        if (!this.isTrickActive) {
            this.privatePrompt(playerId, "The trick playing phase is not currently active.");
            return false;
        }

        const currentPlayer = this.players[this.currentPlayerIndex];
        const player = this.getPlayerById(playerId); // FIX: Uses getPlayerById

        if (!player) {
            this.privatePrompt(playerId, "You are not a registered player in this game.");
            return false;
        }
        
        // 1. Enforce Sequential Turn Order (FIX: Use discordId)
        if (currentPlayer.discordId !== playerId) {
            this.privatePrompt(playerId, "It is not your turn to play a card. Please wait for the public announcement.");
            return false;
        }

        // Non-destructive check for the card in hand
        const cardToCheck = this.peekCardInHand(player, rawCard);

        // 2. Validate Card Input and Existence in Hand
        if (!cardToCheck) {
            this.privatePrompt(playerId, 
                `Invalid card code ('${rawCard}'). Please ensure you have that card in your hand and use the format 'RS' (RankCode + SuitCode), e.g., 'AS' or 'TC'.\nYour Hand: \`${this.getHandDisplay(player)}\``
            );
            return false;
        }
        
        // --- Core Spades Rule Validation ---
        
        if (this.currentTrick.length === 0) {
            // Player is leading the trick
            const hasOnlySpades = player.hand.every(c => c.suitCode === 'S');

            // Rule: Cannot lead with Spades unless Spades are broken OR player is "spades-only"
            if (cardToCheck.suitCode === 'S' && !this.spadesBroken && !hasOnlySpades) {
                 this.privatePrompt(playerId, 
                     "You cannot lead with a Spade until Spades have been broken (a player has trumped a trick), unless your hand consists only of Spades. Please play a different suit."
                     );
                 return false;
            }

            // FIX: Use single-character suit code for consistency
            this.trickSuit = cardToCheck.suitCode; 
            
            // ANNOUNCEMENT CLARITY CHANGE: Use card.fullDisplay for lead
            this.publicAnnounce(`**${player.username} leads the trick with the ${cardToCheck.fullDisplay}**`);

        } else {
            // Player must follow suit if possible
            // FIX: Use single-character suit code for comparison
            const hasLedSuit = player.hand.some(c => c.suitCode === this.trickSuit); 
            
            // FIX: Use single-character suit code for comparison
            if (cardToCheck.suitCode !== this.trickSuit && hasLedSuit) { 
                // ANNOUNCEMENT CLARITY CHANGE: Use emoji for the led suit
                const ledSuitDisplay = Card.CARD_EMOJIS[this.trickSuit] || this.trickSuit; 
                this.privatePrompt(playerId, 
                    `You must follow suit and play a **${this.trickSuit}${ledSuitDisplay}** card if you have one. Please try again.`
                );
                return false;
            }
            
            // ANNOUNCEMENT CLARITY CHANGE: Use card.fullDisplay for play
            this.publicAnnounce(`${player.username} plays the ${cardToCheck.fullDisplay}`);
        }
        
        // --- End Spades Rule Validation ---
        
        // 3. Play the card (removes from hand and returns it)
        const playedCard = player.playCard(rawCard.trim().toUpperCase()); // Use Player.js method
        
        // This should never be null if cardToCheck was found, but defensively check:
        if (!playedCard) {
            this.privatePrompt(playerId, "Internal Error: Could not remove card from hand after validation.");
            return false;
        }

        this.currentTrick.push({ playerId: playerId, card: playedCard });
        
        // 4. Update Spades Broken status
        // A Spade breaks trumps if it's played on a non-Spade led trick AND the played card is a Spade.
        // FIX: Use single-character suit code ('S') for checks
        if (playedCard.suitCode === 'S' && this.trickSuit !== 'S' && !this.spadesBroken) {
            this.spadesBroken = true;
            this.publicAnnounce("♠️ **SPADES HAVE BEEN BROKEN!** ♠️");
        }

        // 5. Advance the Turn or End the Trick
        if (this.currentTrick.length === this.players.length) { // 4 players played
            this.evaluateTrick();
        } else {
            // Move to the next player in the circular queue
            this.advanceTurn('trick');
        }

        return true;
    }

    /**
     * Determines the winner of the current trick based on Spades rules.
     * REFACTORED: Uses a single reduce pass to apply all trick-winning rules (Spade > Led Suit).
     */
    getWinnerOfTrick() {
        const ledSuitCode = this.trickSuit;

        // Use reduce to find the winning entry based on Spades trick-winning rules
        return this.currentTrick.reduce((winningEntry, currentEntry) => {
            const winningCard = winningEntry.card;
            const currentCard = currentEntry.card;

            const isWinningCardSpade = winningCard.suitCode === 'S';
            const isCurrentCardSpade = currentCard.suitCode === 'S';

            // 1. If one card is a Spade and the other isn't, the Spade wins.
            if (isCurrentCardSpade && !isWinningCardSpade) {
                return currentEntry; // Current card trumps the winning card
            }
            if (isWinningCardSpade && !isCurrentCardSpade) {
                return winningEntry; // Winning card trumps the current card
            }

            // 2. If both are Spades, the higher Spade wins.
            if (isCurrentCardSpade && isWinningCardSpade) {
                return (currentCard.value > winningCard.value) ? currentEntry : winningEntry;
            }

            // 3. If neither is a Spade, check the led suit.
            const isWinningCardLedSuit = winningCard.suitCode === ledSuitCode;
            const isCurrentCardLedSuit = currentCard.suitCode === ledSuitCode;

            // Only cards of the led suit can win if no Spades were played.
            if (isCurrentCardLedSuit) {
                // If the winning card is NOT the led suit (and not a spade), it can't win, so the current card must win.
                if (!isWinningCardLedSuit) {
                    return currentEntry;
                }

                // If both are the led suit, the higher card wins.
                if (currentCard.value > winningCard.value) {
                    return currentEntry;
                }
            }
            
            // If the current card is not the led suit (and not a spade), the winner remains the winner.
            return winningEntry;
        }, this.currentTrick[0]);
    }

    /** Evaluates the four cards played and calls endTrick with the winner. */
    evaluateTrick() {
        const winningEntry = this.getWinnerOfTrick();
        this.endTrick(winningEntry.playerId);
    }

    /** * Ends a trick, updates the winner's score, and prepares for the next lead.
     * @param {string} winnerId - The ID of the player who won the trick.
     */
    endTrick(winnerId) {
        const winner = this.getPlayerById(winnerId);
        
        // 1. Update winner's tricks taken (FIX: Use tricksWon)
        if (winner) {
            winner.addTrick(); // Use the Player.js method
        }

        // 2. Announce the winner
        const winningCard = this.currentTrick.find(entry => entry.playerId === winnerId).card;
        // ANNOUNCEMENT CLARITY CHANGE: Use fullDisplay (e.g., Ace of Spades ♠️)
        this.publicAnnounce(
            `\n--- Trick Winner --- \n**${winner.username} wins the trick** with the ${winningCard.fullDisplay}!`
        );
        // FIX: Use winner.tricksWon
        this.publicAnnounce(`${winner.username} (Team ${winner.team}) now has **${winner.tricksWon}** tricks won in total this round.`);


        // 3. Check for end of round (13 tricks played)
        if (winner.hand.length === 0) {
            this.publicAnnounce("All tricks have been played! The round is over.");
            this.isTrickActive = false;
            this.endRound();
            return;
        }

        // 4. Reset state for the new trick and set the winner as the leader
        this.currentTrick = [];
        this.trickSuit = null;
        this.currentPlayerIndex = this.players.findIndex(p => p.discordId === winnerId); // FIX: Use discordId
        
        // 5. Start the next trick
        this.publicAnnounce(`\n**${winner.username} will lead the next trick!**`);
        this.sendPlayCardPrompt(winner);
    }

    // --- Scoring and Round Management ---
    
    /** Calculates and applies the bag penalty (10 bags = -100 points). */
    calculateAndApplyBags() {
        const teams = {};
        this.players.forEach(p => {
            teams[p.team] = teams[p.team] || { players: [] };
            teams[p.team].players.push(p);
        });

        for (const teamId in teams) {
            const teamData = teams[teamId];
            const totalBags = teamData.players.reduce((sum, p) => sum + p.bags, 0); // Bags are accumulated on players

            if (totalBags >= 10) {
                const bagPenalty = Math.floor(totalBags / 10) * 100;
                const remainingBags = totalBags % 10;
                
                // Apply the score adjustment and reset bag count for all players on the team
                teamData.players.forEach(p => {
                    p.score -= bagPenalty;
                    p.bags = 0; // Reset individual bag count
                });
                
                // Set the remaining bags back on the first player of the team for tracking
                teamData.players[0].bags = remainingBags;

                this.publicAnnounce(`⚠️ **Team ${teamId}** busted their bags! Penalty of **-${bagPenalty} points** applied. Remaining bags: ${remainingBags}.`);
            }
        }
    }
    
    /** Announces the current total scores for both teams. */
    announceTeamScores() {
        const team1Players = this.players.filter(p => p.team === 1);
        const team2Players = this.players.filter(p => p.team === 2);
        
        // Calculate scores (summing scores from both players, though they should be the same)
        const team1Score = team1Players.reduce((sum, p) => sum + p.score, 0) / 2;
        const team2Score = team2Players.reduce((sum, p) => sum + p.score, 0) / 2;
        
        // Calculate bags (summing bags from both players, only one should have non-zero)
        const team1Bags = team1Players.reduce((sum, p) => sum + p.bags, 0);
        const team2Bags = team2Players.reduce((sum, p) => sum + p.bags, 0);


        this.publicAnnounce("\n--- Game Scoreboard ---");
        this.publicAnnounce(`Team 1 (${team1Players.map(p => p.username).join(' & ')}): **${team1Score} points** (${team1Bags} bags)`);
        this.publicAnnounce(`Team 2 (${team2Players.map(p => p.username).join(' & ')}): **${team2Score} points** (${team2Bags} bags)`);

        return { team1Score, team2Score };
    }

    /** Checks if any team has reached the target score and ends the game. */
    checkGameEnd(scores) {
        // ... (Game end logic is fine)
        if (scores.team1Score >= this.targetScore || scores.team2Score >= this.targetScore) {
            const winningScore = Math.max(scores.team1Score, scores.team2Score);
            let winnerTeam = null;

            if (scores.team1Score === winningScore && scores.team2Score === winningScore) {
                 this.publicAnnounce(`The game ends in a tie! Both teams reached ${this.targetScore} points!`);
            } else if (scores.team1Score === winningScore) {
                winnerTeam = "Team 1";
            } else {
                winnerTeam = "Team 2";
            }

            if (winnerTeam) {
                this.publicAnnounce(`🏆 **GAME OVER! ${winnerTeam} wins with a score of ${winningScore} points!** 🏆`);
            }
            return true;
        }
        return false;
    }

    /** Calculates team scores based on their contract and tricks won. */
    endRound() {
        this.isTrickActive = false;
        this.publicAnnounce("\n--- Round Over: Final Scoring ---");
        
        const teams = {};
        this.players.forEach(p => {
            const teamId = p.team;
            teams[teamId] = teams[teamId] || { players: [], totalBid: 0, totalTricks: 0 };
            teams[teamId].players.push(p);
            // FIX: Use tricksWon
            teams[teamId].totalBid += p.bid;  
            teams[teamId].totalTricks += p.tricksWon; 
        });

        for (const teamId in teams) {
            const team = teams[teamId];
            let teamScoreChange = 0;
            let teamBags = 0;
            let teamPlayers = team.players;

            // 1. Handle NIL contracts first (Nil bids are scored individually)
            const nilPlayers = teamPlayers.filter(p => p.isNil);
            let totalNilTricksWon = 0; // FIX: Use tricksWon for tally

            nilPlayers.forEach(p => {
                if (p.tricksWon === 0) { // FIX: Use tricksWon
                    p.score += 100;
                    this.publicAnnounce(`✅ **${p.username}** (NIL) successfully made their bid! (+100 points)`);
                } else {
                    p.score -= 100;
                    this.publicAnnounce(`❌ **${p.username}** (NIL) failed their bid, taking ${p.tricksWon} trick(s)! (-100 points)`); // FIX: Use tricksWon
                }
                totalNilTricksWon += p.tricksWon; // FIX: Use tricksWon
            });

            // Standard bid is the sum of non-Nil player bids.
            const standardBid = team.totalBid;  
            // Standard tricks are total tricks minus the tricks taken by failed Nil bids.
            const standardTricks = team.totalTricks - totalNilTricksWon; 

            // 2. Handle STANDARD Team Contract
            if (standardTricks >= standardBid) {
                teamScoreChange = standardBid * 10;
                teamBags = standardTricks - standardBid;
                
                this.publicAnnounce(`✅ **Team ${teamId}** made contract of ${standardBid} (Tricks won: ${standardTricks}). (+${teamScoreChange} points, +${teamBags} bags).`);

            } else {
                // Failure (Set)
                teamScoreChange = -(standardBid * 10);
                teamBags = 0;
                this.publicAnnounce(`❌ **Team ${teamId}** was set! Failed contract of ${standardBid} (Tricks won: ${standardTricks}). (${teamScoreChange} points)`);
            }

            // 3. Apply standard contract score change and update total bags
            // We apply the score change to all players on the team, maintaining score consistency.
            teamPlayers.forEach(p => {
                p.score += teamScoreChange;
            });
            // We apply bags only to the first player in the team's array for central tracking
            teamPlayers[0].bags += teamBags;
        }

        // 4. Calculate and apply Bag Penalty for teams
        this.calculateAndApplyBags();

        // 5. Announce Team Totals
        const finalScores = this.announceTeamScores();
        
        // 6. Check for Game End
        if (this.checkGameEnd(finalScores)) {
            return;
        }
        
        // 7. Reset for next round
        this.startNextRound();
    }
    
    /** Starts the next round by rotating the dealer/leader and starting the deal/bid process. */
    startNextRound() {
        // Rotate the dealer/first bidder index (The first bidder of the next round is the person to the left
        // of the previous round's first bidder/leader)
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length; 
        
        this.publicAnnounce(`\n--- Starting New Round ---`);
        this.deck.reset();
        this.deck.shuffle();
        this.dealCards();
        this.startBidding();
    }
}

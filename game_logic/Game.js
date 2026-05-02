// --- Card Class ---
class Card {
    /** Static map for suit codes to emojis */
    static CARD_EMOJIS = {
        'S': '♠️', 
        'H': '♥️', 
        'D': '♦️', 
        'C': '♣️' 
    };

    /**
     * @param {string} suit - Suit code ('S', 'H', 'D', 'C').
     * @param {string} rank - Rank code ('A', 'K', 'Q', 'J', '10', '9', ..., '2').
     */
    constructor(suit, rank) {
        this.suit = suit; // 'S', 'H', 'D', 'C'
        this.rank = rank; // 'A', 'K', 'Q', 'J', '10', '9', ..., '2'
        this.value = Card.getValue(rank); // Numerical value for comparison
        // Display uses the rank and the static emoji map
        this.display = `${rank}${Card.CARD_EMOJIS[suit]}`; 
    }

    static getValue(rank) {
        switch (rank) {
            case 'A': return 14;
            case 'K': return 13;
            case 'Q': return 12;
            case 'J': return 11;
            case '10': return 10;
            default: return parseInt(rank);
        }
    }
}

// --- Player Class ---
class Player {
    constructor(id, username, guildId) {
        this.id = id;
        this.username = username;
        this.guildId = guildId;
        this.hand = []; // Array of Card objects
        this.bid = 0;   // 1-13, 14 for Nil
        this.tricks = 0;
        this.score = 0;
        this.bags = 0;
    }

    /**
     * Sorts hand by Suit (Spades, Hearts, Diamonds, Clubs) then Rank.
     */
    sortHand() {
        const suitOrder = { 'S': 4, 'H': 3, 'H': 2, 'D': 1 }; // Hearts is 3, Diamonds is 2
        this.hand.sort((a, b) => {
            if (a.suit !== b.suit) {
                return suitOrder[b.suit] - suitOrder[a.suit];
            }
            return b.value - a.value;
        });
    }

    addCard(card) {
        this.hand.push(card);
    }

    /**
     * Removes a card from the hand based on suit and rank.
     * @param {Card} cardToRemove - The card object to remove.
     */
    removeCard(cardToRemove) {
        // Find the index of the matching card
        const index = this.hand.findIndex(card => 
            card.suit === cardToRemove.suit && card.rank === cardToRemove.rank
        );
        
        if (index > -1) {
            this.hand.splice(index, 1);
            this.sortHand(); // Re-sort after playing a card
        }
    }

    /**
     * Generates a clean, grouped display of the player's hand.
     * @returns {string} Formatted hand display.
     */
    getHandDisplay() {
        // Use the same order as sortHand: S, H, D, C
        const orderedSuits = ['S', 'H', 'D', 'C'];
        const suits = orderedSuits.reduce((acc, suit) => {
            acc[suit] = [];
            return acc;
        }, {});

        this.hand.forEach(card => {
            suits[card.suit].push(card.rank);
        });

        let display = '';
        for (const suit of orderedSuits) {
            if (suits[suit].length > 0) {
                const suitIcon = Card.CARD_EMOJIS[suit];
                // Join the ranks and prefix with the emoji
                display += `**${suitIcon}** ${suits[suit].join(' ')}\n`;
            }
        }
        return display.trim() || 'No cards remaining.';
    }

    /**
     * Finds a card object in the player's hand based on input codes.
     * @param {string} suit - The suit code ('S', 'H', 'D', 'C').
     * @param {string} rank - The rank code ('A', 'K', '10', '2').
     * @returns {Card | undefined} The matching Card object or undefined.
     */
    getCardByCode(suit, rank) {
        return this.hand.find(card => card.suit === suit && card.rank === rank);
    }
}

// --- Game Class (Manager) ---
export default class Game { // Changed to ESM export
    constructor(channelId, users) {
        this.channelId = channelId;
        // Players array: [Team 1 Player 1, Team 2 Player 1, Team 1 Player 2, Team 2 Player 2]
        this.players = users.map(u => new Player(u.id, u.username, u.guildId));
        this.deck = [];
        this.state = 'INIT'; // INIT, BIDDING, PLAYING, ROUND_END, GAME_END
        this.currentRound = 1;
        this.dealerIndex = 0;
        this.currentPlayerIndex = 0; // Player to lead/bid next
        this.bidsCollected = 0;
        this.spadesBroken = false;
        this.trick = []; // Array of { player: Player, card: Card }
        this.teamScores = { team1: 0, team2: 0 }; // Team 1: P1 & P3, Team 2: P2 & P4
        this.maxScore = 500;
    }

    // --- Game Setup ---

    createDeck() {
        const suits = ['S', 'H', 'D', 'C'];
        const ranks = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];
        this.deck = [];
        for (const suit of suits) {
            for (const rank of ranks) {
                this.deck.push(new Card(suit, rank));
            }
        }
    }

    shuffleDeck() {
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        this.createDeck();
        this.shuffleDeck();
        
        // 13 cards per player
        for (let i = 0; i < 13; i++) {
            for (const player of this.players) {
                const card = this.deck.pop(); // Use pop() to deal from top
                if (card) {
                    player.addCard(card);
                }
            }
        }
        this.players.forEach(p => p.sortHand());
    }

    /**
     * Prepares the game state for a new round (dealing, resetting tricks/bids).
     */
    startRound() {
        this.dealCards();

        // Reset player state for the round
        this.players.forEach(p => {
            p.tricks = 0;
            p.bid = 0;
        });
        
        this.bidsCollected = 0;
        this.spadesBroken = false;
        this.trick = [];

        // Player to lead (and bid first) is the person to the left of the dealer
        this.currentPlayerIndex = (this.dealerIndex + 1) % this.players.length;
        this.state = 'BIDDING'; // Move to bidding phase
    }

    // --- Score Display ---

    getTeamScoreDisplay() {
        const display = [];
        // Team 1: P1 (index 0) and P3 (index 2)
        const team1Bags = this.players[0].bags + this.players[2].bags;
        const team1Tricks = this.players[0].tricks + this.players[2].tricks;
        const team1Bid = this.players[0].bid + this.players[2].bid; // Note: 14 for Nil here
        
        display.push(`**Team 1 (${this.players[0].username} & ${this.players[2].username})**`);
        display.push(`- Score: **${this.teamScores.team1}** | Bags: ${team1Bags}`);
        display.push(`- Bids: ${this.players[0].bid === 14 ? 'Nil' : this.players[0].bid} & ${this.players[2].bid === 14 ? 'Nil' : this.players[2].bid}`);
        display.push(`- Tricks Taken: ${team1Tricks}`);
        display.push('-------------------------');
        
        // Team 2: P2 (index 1) and P4 (index 3)
        const team2Bags = this.players[1].bags + this.players[3].bags;
        const team2Tricks = this.players[1].tricks + this.players[3].tricks;
        const team2Bid = this.players[1].bid + this.players[3].bid; // Note: 14 for Nil here
        
        display.push(`**Team 2 (${this.players[1].username} & ${this.players[3].username})**`);
        display.push(`- Score: **${this.teamScores.team2}** | Bags: ${team2Bags}`);
        display.push(`- Bids: ${this.players[1].bid === 14 ? 'Nil' : this.players[1].bid} & ${this.players[3].bid === 14 ? 'Nil' : this.players[3].bid}`);
        display.push(`- Tricks Taken: ${team2Tricks}`);

        return display.join('\n');
    }

    // --- Card Parsing and Validation ---
    
    /**
     * Parses card input (e.g., 'AS', '10C', 'D10') against game rules.
     * @param {Player} player - The player attempting to play the card.
     * @param {string} input - The raw card code input.
     * @returns {Card | {error: string}} The validated Card object or an error message object.
     */
    getCardFromInput(player, input) {
        const cleanInput = input.toUpperCase().trim();
        let suit = '';
        let rank = '';

        // 1. Check for 3-character inputs (e.g., 10D or D10)
        if (cleanInput.length === 3) {
            const possibleSuits = ['S', 'H', 'D', 'C'];
            
            // Case 1: Rank then Suit (e.g., 10D)
            if (cleanInput.startsWith('10') && possibleSuits.includes(cleanInput[2])) {
                rank = '10';
                suit = cleanInput[2];
            } 
            // Case 2: Suit then Rank (e.g., D10)
            else if (possibleSuits.includes(cleanInput[0]) && cleanInput.endsWith('10')) {
                suit = cleanInput[0];
                rank = '10';
            }
        } 
        
        // 2. Check for 2-character inputs (e.g., AS, C9, 9C)
        else if (cleanInput.length === 2) {
            // Ranks here are A, K, Q, J, 9..2
            const possibleRanks = ['A', 'K', 'Q', 'J', '9', '8', '7', '6', '5', '4', '3', '2'];
            const possibleSuits = ['S', 'H', 'D', 'C'];

            // Case 3: Rank then Suit (e.g., AS, 9D)
            if (possibleRanks.includes(cleanInput[0]) && possibleSuits.includes(cleanInput[1])) {
                rank = cleanInput[0];
                suit = cleanInput[1];
            } 
            // Case 4: Suit then Rank (e.g., SA, D9)
            else if (possibleSuits.includes(cleanInput[0]) && possibleRanks.includes(cleanInput[1])) {
                suit = cleanInput[0];
                rank = cleanInput[1];
            }
        }

        // If parsing failed
        if (!suit || !rank) {
            return { error: `Card format **${input}** is invalid or ambiguous. Please use Rank+Suit (e.g., 10D, AS) or Suit+Rank (e.g., D10, SA).` };
        }

        // Check if the card is in the player's hand
        const foundCard = player.getCardByCode(suit, rank);
        
        if (!foundCard) {
            return { error: `You do not have the card **${suit}${rank}** in your hand, or you used an incorrect rank/suit letter.` };
        }

        // --- Game Rule Validation ---

        const isLeading = this.trick.length === 0;
        const leadCard = isLeading ? null : this.trick[0].card;

        // Rule 1: Cannot lead spades unless they are broken or player only has spades
        if (isLeading && suit === 'S' && !this.spadesBroken) {
            // Check if player has any non-spade cards
            const hasNonSpade = player.hand.some(c => c.suit !== 'S');
            if (hasNonSpade) {
                return { error: 'Spades have not been broken. You cannot lead with a Spade unless you only have Spades left.' };
            }
        }
        
        // Rule 2: Must follow suit if possible
        if (!isLeading) {
            const followSuit = leadCard.suit;
            
            if (suit !== followSuit) {
                // Check if player has any cards of the leading suit
                const hasFollowSuit = player.hand.some(c => c.suit === followSuit);
                
                if (hasFollowSuit) {
                    return { error: `You must follow suit (${followSuit}) if you have a card of that suit. You played ${suit}.` };
                }
            }
        }

        // All checks passed. Return the Card object.
        return foundCard;
    }

    // --- Trick Winning Logic ---

    /**
     * Determines the winner of the current trick.
     * @returns {{winningPlayer: Player | null, winningCard: Card | null}} The winner and the winning card, or null if trick is incomplete.
     */
    determineTrickWinner() {
        if (this.trick.length !== 4) return { winningPlayer: null, winningCard: null };

        const leadSuit = this.trick[0].card.suit;
        let winningPlay = this.trick[0]; // Start with the first card played

        for (let i = 1; i < 4; i++) {
            const currentPlay = this.trick[i];
            const currentCard = currentPlay.card;
            const winningCard = winningPlay.card;

            // 1. Check if the current card trumps the winner (Spade trumps non-spade)
            if (currentCard.suit === 'S' && winningCard.suit !== 'S') {
                winningPlay = currentPlay;
            } 
            // 2. Both are spades, higher spade wins
            else if (currentCard.suit === 'S' && winningCard.suit === 'S') {
                if (currentCard.value > winningCard.value) {
                    winningPlay = currentPlay;
                }
            } 
            // 3. Both follow the lead suit, higher card wins
            else if (currentCard.suit === leadSuit && winningCard.suit === leadSuit) {
                if (currentCard.value > winningCard.value) {
                    winningPlay = currentPlay;
                }
            }
            // 4. If current card is off-suit and not a spade, it cannot win (no change to winningPlay)
        }

        // Check if the winning card was a spade, and if so, break spades for the round
        if (winningPlay.card.suit === 'S') {
            this.spadesBroken = true;
        }

        return { winningPlayer: winningPlay.player, winningCard: winningPlay.card };
    }

    // --- Scoring Logic ---

    /**
     * Calculates and updates team scores based on bids and tricks taken.
     * @returns {{roundSummary: string, isGameOver: boolean}} Summary text and game status.
     */
    calculateRoundScores() {
        let roundSummary = '';

        // Helper function for scoring a team
        const scoreTeam = (teamIndex) => {
            const p1 = this.players[teamIndex];
            const p2 = this.players[teamIndex + 2];
            const tricksTaken = p1.tricks + p2.tricks;
            
            // Bags state starts from the total bags they entered the round with
            let totalBags = p1.bags + p2.bags;
            let scoreDelta = 0;
            
            // Calculate the actual tricks required for the partnership bid
            let totalBid = 0;
            // Add bids, treating Nil (14) as 0 for the partnership total
            totalBid += (p1.bid === 14 ? 0 : p1.bid);
            totalBid += (p2.bid === 14 ? 0 : p2.bid);

            
            // Check for Nil bids (bid 14)
            const p1BidIsNil = p1.bid === 14;
            const p2BidIsNil = p2.bid === 14;
            
            if (p1BidIsNil && p2BidIsNil) { // Double Nil
                roundSummary += `\n**Team ${teamIndex + 1} Double Nil**\n`;
                if (p1.tricks === 0 && p2.tricks === 0) {
                    scoreDelta += 200; // Success
                    roundSummary += '✅ Both Nil bids succeeded (+200).\n';
                } else {
                    scoreDelta -= 200; // Failure
                    roundSummary += `❌ One or both Nil bids failed (-200). Tricks taken: ${p1.tricks} / ${p2.tricks}.\n`;
                }
                // No bags are counted for double Nil
            } else if (p1BidIsNil || p2BidIsNil) { // Single Nil
                const nilPlayer = p1BidIsNil ? p1 : p2;
                const partner = p1BidIsNil ? p2 : p1;
                
                roundSummary += `\n**Team ${teamIndex + 1} Single Nil**\n`;
                
                // Score Nil Player
                if (nilPlayer.tricks === 0) {
                    scoreDelta += 100;
                    roundSummary += `✅ ${nilPlayer.username}'s Nil succeeded (+100).\n`;
                } else {
                    scoreDelta -= 100;
                    roundSummary += `❌ ${nilPlayer.username}'s Nil failed (Took ${nilPlayer.tricks} tricks) (-100).\n`;
                    // Nil failure tricks are considered bags only for the Nil player
                    totalBags += nilPlayer.tricks; 
                }
                
                // Score Partner (Standard Bid)
                const tricksRequired = partner.bid;
                const partnerTricks = partner.tricks;
                
                if (partnerTricks >= tricksRequired) {
                    scoreDelta += tricksRequired * 10;
                    totalBags += partnerTricks - tricksRequired; // Bags for partner's overtricks
                    roundSummary += `✅ ${partner.username} made bid of ${tricksRequired} (Took ${partnerTricks}) (+${tricksRequired * 10}).\n`;
                } else {
                    scoreDelta -= tricksRequired * 10;
                    roundSummary += `❌ ${partner.username} missed bid of ${tricksRequired} (Took ${partnerTricks}) (-${tricksRequired * 10}).\n`;
                }
            } else {    
                // Standard Bids
                const tricksRequired = totalBid;
                if (tricksTaken >= tricksRequired) {
                    scoreDelta += tricksRequired * 10;
                    totalBags += tricksTaken - tricksRequired;
                    roundSummary += `✅ Team ${teamIndex + 1} made bid of ${tricksRequired} (Took ${tricksTaken}) (+${tricksRequired * 10}).\n`;
                } else {
                    scoreDelta -= tricksRequired * 10;
                    roundSummary += `❌ Team ${teamIndex + 1} missed bid of ${tricksRequired} (Took ${tricksTaken}) (-${tricksRequired * 10}).\n`;
                }
            }
            
            // Bags Penalty Logic
            // First, update player bags with the new total
            const bagsGained = totalBags - (p1.bags + p2.bags); 
            p1.bags += Math.floor(bagsGained / 2); // Split bags
            p2.bags += Math.ceil(bagsGained / 2);
            
            // Check for bag penalty using the updated total bags
            totalBags = p1.bags + p2.bags;
            if (totalBags >= 10) {
                scoreDelta -= 100;
                totalBags -= 10; // Reset bags
                p1.bags = Math.floor(totalBags / 2); // Distribute remaining bags
                p2.bags = Math.ceil(totalBags / 2);
                roundSummary += `💥 Bag Penalty! Team ${teamIndex + 1} hit 10 bags and lost 100 points. Bags reset to ${totalBags}.\n`;
            }

            // Update team score
            this.teamScores[`team${teamIndex + 1}`] += scoreDelta;
        };

        // Score Team 1 (index 0)
        scoreTeam(0);
        // Score Team 2 (index 1)
        scoreTeam(1);

        // Final score check
        const isGameOver = this.teamScores.team1 >= this.maxScore || this.teamScores.team2 >= this.maxScore || this.teamScores.team1 <= -200 || this.teamScores.team2 <= -200;

        roundSummary += '\n--- **NEW TOTAL SCORES** ---\n';
        roundSummary += `Team 1: **${this.teamScores.team1}**\n`;
        roundSummary += `Team 2: **${this.teamScores.team2}**\n`;
        
        return { roundSummary, isGameOver };
    }
    
    // --- Game End ---

    endGame() {
        let winnerMessage = '';
        if (this.teamScores.team1 > this.teamScores.team2) {
            winnerMessage = `Team 1 (${this.players[0].username} & ${this.players[2].username}) wins with **${this.teamScores.team1}** points!`;
        } else if (this.teamScores.team2 > this.teamScores.team1) {
            winnerMessage = `Team 2 (${this.players[1].username} & ${this.players[3].username}) wins with **${this.teamScores.team2}** points!`;
        } else {
            winnerMessage = `The game ended in a tie! Both teams scored **${this.teamScores.team1}** points.`;
        }
        return winnerMessage;
    }
}

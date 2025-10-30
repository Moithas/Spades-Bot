// game_logic/Deck.js
import { Card } from './Card.js'; // Uses NAMED IMPORT for Card

/**
 * Manages the deck of 52 playing cards.
 */
class Deck {
    constructor() {
        this.cards = [];
        this.reset();
    }

    reset() {
        this.cards = [];
        const rankCodes = Card.getRankCodes();
        const suitCodes = Card.getSuitCodes();
        
        for (const suitCode of suitCodes) {
            for (const rankCode of rankCodes) {
                // Creates a new Card instance using the imported class
                this.cards.push(new Card(rankCode, suitCode)); 
            }
        }
    }

    shuffle() {
        // Fisher-Yates shuffle algorithm
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal() {
        return this.cards.pop();
    }
}

// CRITICAL FIX: Provides the NAMED EXPORT 'Deck'
export { Deck };

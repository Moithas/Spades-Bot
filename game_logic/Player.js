// game_logic/Player.js

import { Card } from './Card.js';

/**
 * Represents a single player in the Spades game.
 */
class Player {
  constructor(discordId, username) {
    this.discordId = discordId;      // Unique Discord user ID
    this.username = username;        // Display name
    this.hand = [];                  // Array of Card objects
    this.bid = null;                 // Bid value (0 for NIL)
    this.isNil = false;              // Whether player bid NIL
    this.tricksTaken = 0;            // Tricks won this round
    this.score = 0;                  // Total score
    this.bags = 0;                   // Overtricks
    this.team = null;                // Team number (1 or 2)
    this.partner = null;             // Reference to partner Player
  }

  /**
   * Adds a card to the player's hand.
   * @param {Card} card
   */
  addCard(card) {
    this.hand.push(card);
  }

  /**
   * Sets the player's bid.
   * @param {number} bidAmount - 0 for NIL, 1–13 otherwise
   */
  setBid(bidAmount) {
    this.bid = bidAmount;
    this.isNil = bidAmount === 0;
  }

  /**
   * Resets player state for a new round.
   */
  resetForNewRound() {
    this.hand = [];
    this.bid = null;
    this.isNil = false;
    this.tricksTaken = 0;
  }

  /**
   * Finds a card in the player's hand by its code (e.g., 'AS').
   * @param {string} cardCode
   * @returns {Card | null}
   */
  getCard(cardCode) {
    return this.hand.find(card => card.code === cardCode.toUpperCase()) || null;
  }

  /**
   * Removes a card from the player's hand after it has been played.
   * @param {string} cardCode
   * @returns {Card | null}
   */
  playCard(cardCode) {
    const index = this.hand.findIndex(card => card.code === cardCode.toUpperCase());
    if (index > -1) {
      return this.hand.splice(index, 1)[0];
    }
    return null;
  }

  /**
   * Sorts the player's hand by suit and rank.
   */
  sortHand() {
    const suitOrder = { 'S': 4, 'H': 3, 'D': 2, 'C': 1 };

    this.hand.sort((a, b) => {
      const suitA = suitOrder[a.suitCode];
      const suitB = suitOrder[b.suitCode];
      if (suitA !== suitB) return suitB - suitA;

      return b.value - a.value;
    });
  }

  /**
   * Returns a formatted string of the player's hand using colorful suit emojis.
   * Example: ♠️ A 9 | ♥️ K 9 4 | ♦️ 10 2 | ♣️ A J 10 5 4 2
   * @returns {string}
   */
  getPrettyHand() {
    this.sortHand();

    const suitGroups = { 'S': [], 'H': [], 'D': [], 'C': [] };
    const suitEmojis = {
      'S': '♠️',
      'H': '♥️',
      'D': '♦️',
      'C': '♣️'
    };

    for (const card of this.hand) {
      suitGroups[card.suitCode].push(card.rankText);
    }

    return ['S', 'H', 'D', 'C']
      .map(suit => {
        const cards = suitGroups[suit];
        return cards.length ? `${suitEmojis[suit]} ${cards.join(' ')}` : null;
      })
      .filter(Boolean)
      .join(' | ');
  }
}

export { Player };

// game_logic/Card.js

// Define static mappings for card construction (for use in GameManager)
const SUITS_MAP = {
  'C': { name: 'Clubs', symbol: '♣️', color: 'black' },
  'D': { name: 'Diamonds', symbol: '♦️', color: 'red' },
  'H': { name: 'Hearts', symbol: '♥️', color: 'red' },
  'S': { name: 'Spades', symbol: '♠️', color: 'black' }
};

const RANKS_MAP = {
  '2': { name: 'Two', value: 2 }, '3': { name: 'Three', value: 3 }, '4': { name: 'Four', value: 4 },
  '5': { name: 'Five', value: 5 }, '6': { name: 'Six', value: 6 }, '7': { name: 'Seven', value: 7 },
  '8': { name: 'Eight', value: 8 }, '9': { name: 'Nine', value: 9 }, 'T': { name: 'Ten', value: 10 },
  'J': { name: 'Jack', value: 11 }, 'Q': { name: 'Queen', value: 12 }, 'K': { name: 'King', value: 13 },
  'A': { name: 'Ace', value: 14 }
};

export class Card {
  /**
   * @param {string} rankCode - Single character rank code (e.g., 'A', 'T').
   * @param {string} suitCode - Single character suit code (e.g., 'S', 'H').
   */
  constructor(rankCode, suitCode) {
    this.rankCode = rankCode;
    this.suitCode = suitCode;
    this.suit = SUITS_MAP[suitCode];     // Full suit object
    this.rank = RANKS_MAP[rankCode];     // Full rank object
    this.value = this.rank.value;

    // Display helpers
    this.symbol = this.suit.symbol;      // ♠️, ♥️, ♦️, ♣️
    this.rankText = rankCode === 'T' ? '10' : rankCode; // Show '10' instead of 'T'
    this.code = this.rankText + this.symbol; // Used for display like '10♠️'

    // Short display (e.g., 'AS', 'TC') for internal use
    this.shortDisplay = rankCode + suitCode;

    // Full display for announcements
    this.fullDisplay = `<span class="card-icon ${this.suit.color}">${this.rank.name} of ${this.symbol}</span>`;
  }

  /** Returns all available rank codes (e.g., ['A', 'K', ...]) */
  static getRankCodes() {
    return Object.keys(RANKS_MAP);
  }

  /** Returns all available suit codes (e.g., ['C', 'D', 'H', 'S']) */
  static getSuitCodes() {
    return Object.keys(SUITS_MAP);
  }
}
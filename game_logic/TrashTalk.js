/**
 * TrashTalk.js
 * AI personality and trash talk message generation
 */

export class TrashTalk {
  constructor() {
    // Trash talk categories with personality variations
    this.messages = {
      // When AI trumps a trick
      trumpPlay: {
        aggressive: [
          "♠️ Spades always win, baby!",
          "Trump card says NO 🚫",
          "Nice try, but spades > everything",
          "♠️ The trump train has no brakes!",
          "That's cute, here's a spade though",
          "Trumped! Better luck next time 😏"
        ],
        balanced: [
          "Had to play the spade ♠️",
          "Trump takes it!",
          "Spade wins this one",
          "♠️ Coming through",
          "Sorry, had to trump that"
        ],
        conservative: [
          "Spade played ♠️",
          "Trump card",
          "Spades win",
          "♠️"
        ]
      },

      // When AI plays an Ace to win
      acePlayed: {
        aggressive: [
          "Ace in the hole! 🎯",
          "A for Awesome, also for Ace 😎",
          "Top card takes the trick!",
          "That's why they call it an ACE 💪",
          "Ace high, spirits low (for you)",
          "The Ace always wins!"
        ],
        balanced: [
          "Ace takes it!",
          "High card wins 🎴",
          "Ace for the trick",
          "Top card!"
        ],
        conservative: [
          "Ace played",
          "High card",
          "Ace wins"
        ]
      },

      // When AI successfully makes Nil
      nilSuccess: {
        aggressive: [
          "NIL COMPLETE! Zero tricks, maximum respect 😎",
          "Nil and chill 🎯",
          "Called Nil, nailed Nil, that's just how I roll",
          "Zero tricks, 100 points, infinite swagger 💯",
          "That's how you Nil, folks!",
          "Nil mastery on display 🏆"
        ],
        balanced: [
          "Nil successful! 🎯",
          "Zero tricks as planned",
          "Nil bid complete!",
          "Made the Nil!",
          "Successful Nil 💯"
        ],
        conservative: [
          "Nil made",
          "Nil successful",
          "Zero tricks ✓"
        ]
      },

      // When AI fails Nil
      nilFailure: {
        aggressive: [
          "Well, that Nil didn't go to plan...",
          "Okay, that was embarrassing 😅",
          "Nil fail. We don't talk about this round.",
          "That trick shouldn't have been mine!",
          "Failed Nil. Moving on. Nothing to see here."
        ],
        balanced: [
          "Nil failed, unfortunate",
          "Didn't make the Nil",
          "That wasn't the plan",
          "Nil unsuccessful"
        ],
        conservative: [
          "Nil failed",
          "Missed Nil",
          "..."
        ]
      },

      // When opponents get set (fail their bid)
      opponentSet: {
        aggressive: [
          "SET! Better luck next hand 😏",
          "You got SET like a volleyball spike 🏐",
          "Math is hard: tricks needed > tricks taken = SET",
          "That's a SET for the history books!",
          "SET ALERT! 🚨",
          "Ouch, that's gonna hurt the score..."
        ],
        balanced: [
          "Set! Tough break",
          "Didn't make the bid",
          "That's a set",
          "Bid failed"
        ],
        conservative: [
          "Set",
          "Bid not made",
          "Unsuccessful bid"
        ]
      },

      // When opponent bags out (10 bags)
      bagOut: {
        aggressive: [
          "BAG OUT! 🎒 Those overtricks add up!",
          "10 bags = -100 points! That's gotta sting 😬",
          "Somebody's been collecting bags like groceries 🛍️",
          "Bag limit exceeded! Time to pay up 💰",
          "And THAT'S why you count your bags!",
          "Bagged and tagged! -100 points 📉"
        ],
        balanced: [
          "Bag out! -100 points",
          "10 bags reached",
          "That's a bag penalty",
          "Overtrick penalty applied"
        ],
        conservative: [
          "Bag out",
          "10 bags",
          "-100 points"
        ]
      },

      // When AI wins the game
      gameWin: {
        aggressive: [
          "GG EZ 😎 (just kidding, good game!)",
          "Victory! 🏆 That was fun!",
          "We take those! GG everyone",
          "Another W for the books 📖",
          "That's game! Well played, team!",
          "Champions! 🏆 Thanks for the game!"
        ],
        balanced: [
          "Game won! Good game everyone",
          "Victory! Well played all",
          "We won! Thanks for playing",
          "Good game, everyone!"
        ],
        conservative: [
          "Game won",
          "Victory",
          "Good game"
        ]
      },

      // When AI loses the game
      gameLoss: {
        aggressive: [
          "Alright, you got me this time 🤝",
          "Well played! Rematch?",
          "GG! That was competitive",
          "You win this round, but I'll be back!",
          "Respect! Well played 🎯"
        ],
        balanced: [
          "Good game, well played",
          "Nice win! Good game",
          "Well done, good game",
          "GG everyone"
        ],
        conservative: [
          "Good game",
          "Well played",
          "GG"
        ]
      },

      // When AI takes a trick with a high card in general
      bigCardWin: {
        aggressive: [
          "Royalty takes the throne! 👑",
          "My house! 👸",
          "High card, high score!",
          "Big card energy 💪",
          "That's MY trick!",
          "Face card for the win!"
        ],
        balanced: [
          "King wins!",
          "Queen takes it",
          "High card wins",
          "Trick won"
        ],
        conservative: [
          "King played",
          "Queen wins",
          "High card"
        ]
      },

      // When AI prevents opponent's Nil
      nilBusted: {
        aggressive: [
          "Nil DENIED! 🚫 Sorry not sorry 😏",
          "Breaking up that Nil attempt!",
          "No Nil for you! Come back, one year!",
          "Nil defense activated! 🛡️",
          "That Nil just got busted!",
          "Nil blocked! Better luck next time"
        ],
        balanced: [
          "Nil prevented",
          "Stopped the Nil",
          "Nil unsuccessful",
          "Nil blocked"
        ],
        conservative: [
          "Nil failed",
          "Nil stopped",
          "Blocked"
        ]
      },

      // When AI makes a risky play that works
      riskySuccess: {
        aggressive: [
          "Calculated risk = SUCCESS ✅",
          "High risk, high reward! 🎲",
          "That's how you gamble and WIN!",
          "Bold moves pay off 💰",
          "Risk it for the biscuit! 🍪",
          "Fortune favors the bold! 🎯"
        ],
        balanced: [
          "Risky play worked out!",
          "That paid off",
          "Good result",
          "Worked perfectly"
        ],
        conservative: [
          "Success",
          "Worked out",
          "Good play"
        ]
      },

      // When player wastes Ace on AI's low lead (2 or 3)
      aceOnLowLead: {
        aggressive: [
          "SO AGGRESSIVE! 😂",
          "Whoa there chief! That's an ACE on a deuce! 🤣",
          "My little card scared you THAT much? 💀",
          "AN ACE?! On my baby card?! I'm flattered 😏",
          "Okay Mr. Big Shot, wasting Aces on 2s now! 🎭",
          "That Ace didn't deserve this disrespect! 😱"
        ],
        balanced: [
          "That's one way to take it! 😅",
          "Big Ace on a small lead!",
          "Going all out I see",
          "Ace on a low card, interesting!"
        ],
        conservative: [
          "Ace on low lead",
          "Strong play",
          "Took it with Ace"
        ]
      }
    };

    // Cooldown tracking to prevent spam
    this.lastTrashTalkTime = {};
    this.messagesThisHand = {};
  }

  /**
   * Get a trash talk message based on context and personality
   * @param {string} playerName - AI player name
   * @param {string} category - Message category (trumpPlay, acePlayed, etc.)
   * @param {string} personality - AI personality (aggressive, balanced, conservative)
   * @param {string} frequency - How often to trash talk (low, medium, high)
   * @returns {string|null} - Message to send, or null if on cooldown
   */
  getMessage(playerName, category, personality = 'balanced', frequency = 'medium') {
    // Check if category exists
    if (!this.messages[category]) {
      console.warn(`Unknown trash talk category: ${category}`);
      return null;
    }

    // Initialize tracking for this player
    if (!this.messagesThisHand[playerName]) {
      this.messagesThisHand[playerName] = 0;
    }

    // Frequency limits per hand
    const limits = {
      low: 2,      // Max 2 messages per hand
      medium: 4,   // Max 4 messages per hand
      high: 8      // Max 8 messages per hand
    };

    const maxMessages = limits[frequency] || 4;

    // Check hand limit
    if (this.messagesThisHand[playerName] >= maxMessages) {
      return null;
    }

    // Check time-based cooldown (minimum 5 seconds between messages)
    const now = Date.now();
    const lastTime = this.lastTrashTalkTime[playerName] || 0;
    if (now - lastTime < 5000) {
      return null;
    }

    // Random chance based on frequency (except for major events like Nil/game end)
    const majorEvents = ['nilSuccess', 'nilFailure', 'gameWin', 'gameLoss', 'bagOut'];
    const isMajorEvent = majorEvents.includes(category);
    
    if (!isMajorEvent) {
      const chances = {
        low: 0.3,     // 30% chance to trash talk on minor events
        medium: 0.5,  // 50% chance
        high: 0.8     // 80% chance
      };
      
      const chance = chances[frequency] || 0.5;
      if (Math.random() > chance) {
        return null;
      }
    }

    // Get message array for this personality
    const messageArray = this.messages[category][personality];
    if (!messageArray || messageArray.length === 0) {
      return null;
    }

    // Select random message
    const message = messageArray[Math.floor(Math.random() * messageArray.length)];

    // Update tracking
    this.lastTrashTalkTime[playerName] = now;
    this.messagesThisHand[playerName]++;

    return message;
  }

  /**
   * Reset hand counters at the start of a new hand
   * @param {string} playerName - AI player name
   */
  resetHandCounters(playerName) {
    if (playerName) {
      this.messagesThisHand[playerName] = 0;
    } else {
      // Reset all players
      this.messagesThisHand = {};
    }
  }

  /**
   * Get personality type based on AI strategy
   * @param {string} aiType - AI type from AIPlayer
   * @returns {string} - Personality (aggressive, balanced, conservative)
   */
  getPersonalityFromAIType(aiType) {
    const mapping = {
      aggressive: 'aggressive',
      balanced: 'balanced',
      conservative: 'conservative',
      // Fallback
      default: 'balanced'
    };

    return mapping[aiType] || mapping.default;
  }

  /**
   * Get category-specific styling (color and emoji) for embeds
   * @param {string} category - Trash talk category
   * @returns {Object} - {color: string, emoji: string}
   */
  getCategoryStyling(category) {
    const styles = {
      // Per-trick events (blue/purple tones)
      trumpPlay: { color: '#9B59B6', emoji: '♠️' },      // Purple
      acePlayed: { color: '#3498DB', emoji: '🎯' },      // Blue
      bigCardWin: { color: '#5DADE2', emoji: '👑' },     // Light blue
      aceOnLowLead: { color: '#E91E63', emoji: '😂' },   // Pink
      
      // Nil events (green/red)
      nilSuccess: { color: '#2ECC71', emoji: '🎉' },     // Green
      nilFailure: { color: '#E74C3C', emoji: '😅' },     // Red
      nilBusted: { color: '#E67E22', emoji: '🚫' },      // Orange
      
      // Opponent failures (gold/orange)
      opponentSet: { color: '#F39C12', emoji: '😏' },    // Gold
      bagOut: { color: '#E67E22', emoji: '💥' },         // Orange
      
      // Game end (bright colors)
      gameWin: { color: '#FFD700', emoji: '🏆' },        // Gold
      gameLoss: { color: '#95A5A6', emoji: '🤝' },       // Gray
      
      // Special events
      riskySuccess: { color: '#1ABC9C', emoji: '🎲' },   // Teal
      
      // Default fallback
      default: { color: '#7289DA', emoji: '🤖' }         // Discord blue
    };

    return styles[category] || styles.default;
  }
}

// Singleton instance
export const trashTalk = new TrashTalk();

// constants.js

/**
 * Time delays and durations (all in milliseconds unless noted)
 * Using underscore separator for readability: 10_000 = 10,000 = 10 seconds
 */
export const TIMING = {
    // Bidding phase
    UNDO_BID_DELAY: 10_000,              // 10 seconds - time to undo bid before next player/end bidding
    AI_BID_DELAY: 10_000,                 // 10 seconds - delay before AI bids (allows human to undo)
    
    // Card play
    AI_PLAY_DELAY: 2_000,                 // 2 seconds - delay after human play before AI plays
    AI_LEAD_DELAY: 2_500,                 // 2.5 seconds - delay before AI leads next trick
    AI_DEBOUNCE: 900,                     // 0.9 seconds - minimum time between AI actions
    AUTO_PLAY_CHECK_DELAY: 300,           // 0.3 seconds - delay before scheduling next AI play
    
    // UI/UX
    DEALING_ANIMATION_DELAY: 1_500,       // 1.5 seconds - time to show dealing animation
    AI_THINKING_DISPLAY: 1_500,           // 1.5 seconds - how long to show "AI is thinking" message
    
    // Cleanup
    ENDED_GAME_CLEANUP_DELAY: 10 * 60_000,  // 10 minutes - when to remove ended games from memory
    CLEANUP_CHECK_INTERVAL: 5 * 60_000,     // 5 minutes - how often to check for cleanup
    CARD_LOCK_CLEANUP_INTERVAL: 60_000,     // 1 minute - clear card play locks
    
    // Limits (in seconds for user-facing settings)
    MAX_AUTO_PLAY_TIMER_SECONDS: 300,     // 5 minutes - max auto-play timer value
    MIN_AUTO_PLAY_TIMER_SECONDS: 0,       // 0 = disabled
};

/**
 * Score and game limits
 */
export const GAME_LIMITS = {
    MIN_TARGET_SCORE: 100,
    MAX_TARGET_SCORE: 1000,
    DEFAULT_TARGET_SCORE: 500,
    
    BLIND_NIL_SCORE_REQUIREMENT: 200,     // Points behind needed for Blind Nil eligibility
    BLIND_NIL_BONUS: 200,                  // Points gained/lost for Blind Nil
    NIL_BONUS: 100,                        // Points gained/lost for regular Nil
    
    BAG_PENALTY_THRESHOLD: 10,             // Bags before penalty
    BAG_PENALTY_POINTS: 100,               // Points lost for bag penalty
};

/**
 * Player and game size limits
 */
export const PLAYER_LIMITS = {
    CLASSIC_PLAYERS: 4,
    CUTTHROAT3_PLAYERS: 3,
    CUTTHROAT4_PLAYERS: 4,
    
    MIN_BID: 0,
    MAX_BID: 13,
    BLIND_NIL_BID: -1,
    
    CUTTHROAT3_CARDS_PER_PLAYER: 17,
    STANDARD_CARDS_PER_PLAYER: 13,
    CUTTHROAT3_TOTAL_TRICKS: 17,
    STANDARD_TOTAL_TRICKS: 13,
};

/**
 * Discord API settings
 */
export const DISCORD = {
    MAX_RETRIES: 2,
    RETRY_DELAY: 1_000,
    AUTOCOMPLETE_LIMIT: 25,               // Discord's autocomplete choice limit
};

/**
 * Card deck constants
 */
export const DECK = {
    STANDARD_DECK_SIZE: 52,
    CUTTHROAT3_DECK_SIZE: 51,             // 2 of Clubs removed
    REMOVED_CARD_RANK: '2',
    REMOVED_CARD_SUIT: 'C',
};

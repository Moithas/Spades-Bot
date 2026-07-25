// scripts/deal_practice_hands.js
// Deals random 13-card Spades hands and prints them grouped by suit, so a human
// expert can state their bid + reasoning. Used to reverse-engineer bidding heuristics.
// Usage: node scripts/deal_practice_hands.js [numHands] [seed]

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_LABEL = { S: '♠ Spades  ', H: '♥ Hearts  ', D: '♦ Diamonds', C: '♣ Clubs   ' };
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const DISPLAY = { T: '10' };

// Simple seedable PRNG (mulberry32) for reproducible deals.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const numHands = parseInt(process.argv[2], 10) || 8;
const seed = process.argv[3] !== undefined ? parseInt(process.argv[3], 10) : (Date.now() & 0xffffffff);
const rand = mulberry32(seed);

function buildDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
    return deck;
}

function shuffle(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function formatHand(cards) {
    const bySuit = { S: [], H: [], D: [], C: [] };
    for (const c of cards) bySuit[c.s].push(c.r);
    let out = '';
    for (const s of SUITS) {
        const ranks = bySuit[s].sort((a, b) => RANK_ORDER[b] - RANK_ORDER[a]);
        const shown = ranks.length ? ranks.map(r => DISPLAY[r] || r).join(' ') : '—';
        out += `  ${SUIT_LABEL[s]}: ${shown}   (${ranks.length})\n`;
    }
    return out;
}

console.log(`\n=== Practice Bidding Hands (seed ${seed}) ===`);
console.log(`For each hand, state your bid and the trick-by-trick reasoning.\n`);

for (let h = 0; h < numHands; h++) {
    const hand = shuffle(buildDeck()).slice(0, 13);
    console.log(`Hand ${h + 1}:`);
    process.stdout.write(formatHand(hand));
    console.log('');
}

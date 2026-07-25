// scripts/test_human_bid.js
// Validates a human-derived bidding heuristic against expert-labeled hands.
// Rules reverse-engineered from 16 hands bid by the bot owner (two batches).
// Run: node scripts/test_human_bid.js

const RANK_ORDER = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

// hand: array of { r, s }
function computeHumanBid(hand) {
    const bySuit = { S: [], H: [], D: [], C: [] };
    for (const c of hand) bySuit[c.s].push(RANK_ORDER[c.r]);
    for (const s of Object.keys(bySuit)) bySuit[s].sort((a, b) => b - a);

    const has = (suit, rank) => bySuit[suit].includes(RANK_ORDER[rank]);
    const detail = [];

    // 1. Side-suit Aces (+1) and protected Kings (+1 if suit length 2-5)
    let sideTricks = 0;
    for (const suit of ['H', 'D', 'C']) {
        const len = bySuit[suit].length;
        if (has(suit, 'A')) { sideTricks++; detail.push(`A${suit} +1`); }
        if (has(suit, 'K') && len >= 2 && len <= 5) { sideTricks++; detail.push(`K${suit} +1 (len ${len})`); }
    }

    // 2. Spade honors (solid sequence from the top)
    const hasAS = has('S', 'A');
    const hasKS = has('S', 'K');
    const hasQS = has('S', 'Q');
    const hasJS = has('S', 'J');
    const spadeCount = bySuit.S.length;
    let spadeTricks = 0;
    if (hasAS) { spadeTricks++; detail.push('AS +1'); }
    if (hasKS) { spadeTricks++; detail.push('KS +1'); }
    if (hasAS && hasKS && hasQS) { spadeTricks++; detail.push('QS +1'); }
    if (hasAS && hasKS && hasQS && hasJS) { spadeTricks++; detail.push('JS +1'); }

    // 3. Ruff tricks from short side suits (len <= 2), shortest first.
    //    want = 3 - len (singleton 2, doubleton 1, void 3).
    //    Global cap: spare trumps minus 1 reserve (the reserve doubles as the
    //    spade sacrificed to promote a bare KS).
    //    A King-headed short suit (has K, no A) only ruffs when trump is ample
    //    (hold AS, or 5+ spades) — otherwise the King is the trick, not a ruff.
    let spareTrumps = spadeCount - spadeTricks;
    let available = Math.max(0, spareTrumps - 1);
    const shortSuits = ['H', 'D', 'C']
        .map(s => ({ s, len: bySuit[s].length }))
        .filter(x => x.len <= 2)
        .sort((a, b) => a.len - b.len);
    let ruffs = 0;
    for (const { s, len } of shortSuits) {
        const suitHasK = has(s, 'K');
        const suitHasA = has(s, 'A');
        if (suitHasK && !suitHasA) {
            const ampleTrump = hasAS || spadeCount >= 5;
            if (!ampleTrump) { detail.push(`ruff ${s} skipped (bare K, thin trump)`); continue; }
        }
        const want = 3 - len;
        const take = Math.min(want, available);
        if (take > 0) { ruffs += take; available -= take; detail.push(`ruff ${s} +${take} (len ${len})`); }
    }

    const total = sideTricks + spadeTricks + ruffs;

    // 4. Nil suggestion: zero counted tricks and safe (low, short) spades
    const highestSpade = bySuit.S.length ? bySuit.S[0] : 0;
    const nil = total === 0 && spadeCount <= 3 && highestSpade <= RANK_ORDER['Q'];

    return { total, nil, detail };
}

// ---- Expert-labeled hands ----
function hand(spades, hearts, diamonds, clubs) {
    const mk = (ranks, s) => ranks.split(' ').filter(Boolean).map(r => ({ r: r === '10' ? 'T' : r, s }));
    return [...mk(spades, 'S'), ...mk(hearts, 'H'), ...mk(diamonds, 'D'), ...mk(clubs, 'C')];
}

const cases = [
    // Batch 1 (seed 42)
    { n: '1-1', hand: hand('8 4', 'A Q 3 2', 'J 10', 'A Q 10 6 4'), expect: 3 },
    { n: '1-2', hand: hand('3', 'J 10 9 7 6', 'Q 9 5 4 2', '9 4'), expect: 'Nil' },
    { n: '1-3', hand: hand('K', 'A 7 6 4', '8', 'Q J 10 9 8 5 4'), expect: 2 },
    { n: '1-4', hand: hand('10 8 7 4 2', '8 6', 'K 8 2', 'K 10 7'), expect: 3 },
    { n: '1-5', hand: hand('A J 7 4', '9', 'A K 9', '10 9 7 5 2'), expect: 5 },
    { n: '1-6', hand: hand('K 10 7', 'Q 3 2', 'K J 8 3 2', 'K 5'), expect: 3 },
    { n: '1-7', hand: hand('K 8 5 4 2', 'A 3', 'Q 10 3', 'J 9 4'), expect: 3 },
    { n: '1-8', hand: hand('A 10 4', 'A 6 5', '8 7', 'A 10 8 7 2'), expect: 4 },
    // Batch 2 (seed 7)
    { n: '2-1', hand: hand('J 10', 'Q 6 5', '9 5 2', 'K 10 8 3 2'), expect: 1 },
    { n: '2-2', hand: hand('J 7 5 4', '10 9 6 2', 'Q', 'Q 9 6 4'), expect: 2 },
    { n: '2-3', hand: hand('Q 9', 'A 8 7 6', 'A K Q 9 2', 'A 10'), expect: 5 },
    { n: '2-4', hand: hand('A 10 8 6 3 2', 'A 7', 'K 2', 'J 9 7'), expect: 5 },
    { n: '2-5', hand: hand('8 5 3 2', '10 4 2', 'A K J 8 4 3', ''), expect: 4 },
    { n: '2-6', hand: hand('A J 8 2', 'Q 6 3', 'K Q 8', 'K 7 5'), expect: 3 },
    { n: '2-7', hand: hand('J 8 6 3 2', 'Q 9 5 3 2', '6', 'A 3'), expect: 4 },
    { n: '2-8', hand: hand('K 7 6', '7 5', 'A 10 9 6 3', 'A J 2'), expect: 4 },
];

let pass = 0;
console.log('\n=== Human Bid Heuristic Validation (16 hands) ===\n');
for (const c of cases) {
    const { total, nil, detail } = computeHumanBid(c.hand);
    const got = nil ? 'Nil' : total;
    const ok = got === c.expect;
    if (ok) pass++;
    console.log(`Hand ${c.n}: expected ${c.expect}, got ${got}  ${ok ? '✅' : '❌'}`);
    console.log(`   ${detail.join(', ')}`);
}
console.log(`\n${pass}/${cases.length} hands matched.\n`);

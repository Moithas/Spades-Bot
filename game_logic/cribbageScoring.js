/**
 * Cribbage scoring helpers for hand counting and pegging.
 * All functions are pure and side-effect free.
 */

const FACE_PIP = 10;

const rankToOrder = (rankCode) => {
    switch ((rankCode || '').toUpperCase()) {
        case 'A': return 1;
        case '2': return 2;
        case '3': return 3;
        case '4': return 4;
        case '5': return 5;
        case '6': return 6;
        case '7': return 7;
        case '8': return 8;
        case '9': return 9;
        case 'T': return 10;
        case 'J': return 11;
        case 'Q': return 12;
        case 'K': return 13;
        default: return NaN;
    }
};

export const getPipValue = (card) => {
    if (!card || !card.rankCode) return 0;
    const rank = card.rankCode.toUpperCase();
    if (rank === 'A') return 1;
    if (rank === 'T' || rank === 'J' || rank === 'Q' || rank === 'K') return FACE_PIP;
    const parsed = parseInt(rank, 10);
    return Number.isFinite(parsed) ? parsed : 0;
};

const getAllSubsetSums = (values) => {
    const sums = [];
    const n = values.length;
    const maxMask = 1 << n;
    for (let mask = 1; mask < maxMask; mask++) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            if (mask & (1 << i)) sum += values[i];
        }
        sums.push(sum);
    }
    return sums;
};

export const scoreFifteens = (cards) => {
    const values = (cards || []).map(getPipValue);
    const fifteens = getAllSubsetSums(values).filter(sum => sum === 15).length;
    return fifteens * 2;
};

export const scorePairs = (cards) => {
    const counts = new Map();
    for (const card of cards || []) {
        const rank = card.rankCode;
        counts.set(rank, (counts.get(rank) || 0) + 1);
    }

    let points = 0;
    for (const count of counts.values()) {
        if (count >= 2) {
            points += (count * (count - 1) / 2) * 2;
        }
    }
    return points;
};

const isConsecutiveRun = (cardsSubset) => {
    const rankOrders = cardsSubset.map(c => rankToOrder(c.rankCode));
    if (rankOrders.some(v => !Number.isFinite(v))) return false;
    const uniq = new Set(rankOrders);
    if (uniq.size !== rankOrders.length) return false;
    const sorted = rankOrders.slice().sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return false;
    }
    return true;
};

export const scoreRuns = (cards) => {
    const list = cards || [];
    const n = list.length;
    if (n < 3) return 0;

    let maxLen = 0;
    let runCount = 0;
    const maxMask = 1 << n;

    for (let mask = 1; mask < maxMask; mask++) {
        const subset = [];
        for (let i = 0; i < n; i++) {
            if (mask & (1 << i)) subset.push(list[i]);
        }
        if (subset.length < 3) continue;
        if (!isConsecutiveRun(subset)) continue;

        if (subset.length > maxLen) {
            maxLen = subset.length;
            runCount = 1;
        } else if (subset.length === maxLen) {
            runCount++;
        }
    }

    return maxLen >= 3 ? runCount * maxLen : 0;
};

export const scoreFlush = (handCards, starterCard, isCrib = false) => {
    const hand = handCards || [];
    if (hand.length === 0) return 0;
    const suit = hand[0].suitCode;
    const allHandSameSuit = hand.every(c => c.suitCode === suit);
    if (!allHandSameSuit) return 0;

    const starterMatches = starterCard && starterCard.suitCode === suit;
    if (isCrib) return starterMatches ? hand.length + 1 : 0;
    return starterMatches ? hand.length + 1 : hand.length;
};

export const scoreNobs = (handCards, starterCard) => {
    if (!starterCard) return 0;
    const hasNobs = (handCards || []).some(
        c => c.rankCode === 'J' && c.suitCode === starterCard.suitCode
    );
    return hasNobs ? 1 : 0;
};

export const scoreShowHand = (handCards, starterCard, isCrib = false) => {
    const allCards = [...(handCards || []), starterCard].filter(Boolean);
    const breakdown = {
        fifteens: scoreFifteens(allCards),
        pairs: scorePairs(allCards),
        runs: scoreRuns(allCards),
        flush: scoreFlush(handCards, starterCard, isCrib),
        nobs: scoreNobs(handCards, starterCard),
    };
    const total = breakdown.fifteens + breakdown.pairs + breakdown.runs + breakdown.flush + breakdown.nobs;
    return { total, breakdown };
};

export const scorePegPairLike = (sequence) => {
    if (!sequence || sequence.length < 2) return 0;
    const last = sequence[sequence.length - 1].card.rankCode;
    let count = 1;
    for (let i = sequence.length - 2; i >= 0; i--) {
        if (sequence[i].card.rankCode === last) count++;
        else break;
    }
    if (count === 2) return 2;
    if (count === 3) return 6;
    if (count >= 4) return 12;
    return 0;
};

export const scorePegRun = (sequence) => {
    if (!sequence || sequence.length < 3) return 0;
    const maxLen = Math.min(7, sequence.length);
    for (let len = maxLen; len >= 3; len--) {
        const tail = sequence.slice(sequence.length - len).map(entry => entry.card);
        if (isConsecutiveRun(tail)) return len;
    }
    return 0;
};

export const scorePegPlay = (sequence, playedCard, runningTotal) => {
    const newTotal = runningTotal + getPipValue(playedCard);
    const updated = [...(sequence || []), { card: playedCard }];
    const reasons = [];
    let points = 0;

    if (newTotal === 15) {
        points += 2;
        reasons.push('15');
    }
    if (newTotal === 31) {
        points += 2;
        reasons.push('31');
    }

    const pairLike = scorePegPairLike(updated);
    if (pairLike > 0) {
        points += pairLike;
        reasons.push(`pair-${pairLike}`);
    }

    const run = scorePegRun(updated);
    if (run > 0) {
        points += run;
        reasons.push(`run-${run}`);
    }

    return { points, reasons, newTotal };
};

export const isLegalPegPlay = (card, runningTotal) => {
    return getPipValue(card) + runningTotal <= 31;
};

export const hasAnyLegalPegPlay = (hand, runningTotal) => {
    return (hand || []).some(card => isLegalPegPlay(card, runningTotal));
};


// scripts/test_futile_king.js
//
// Verifies the "King under a live Ace" handling (option C: probabilistic, not a hard ban)
// and its boundaries:
//  - Vulnerable King (Ace live, players yet to act): play it only if Monte Carlo says it
//    is likely to hold; otherwise duck and keep it.
//  - Do NOT protect the Queen (it sits under both A and K).
//  - Still win with the King when the Ace is gone or when we're last to act.
// Monte Carlo is stubbed per-test via `kingWinProb` for deterministic assertions.
//
// Run: node scripts/test_futile_king.js

import { AIPlayer } from '../game_logic/AIPlayer.js';

const VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'T':10,'J':11,'Q':12,'K':13,'A':14 };
const card = (rankCode, suitCode) => ({ rankCode, suitCode, value: VAL[rankCode] });
const teamOf = (seat) => (seat % 2 === 0 ? 1 : 2); // classic partners: 0&2 vs 1&3

// Build a 4-seat game where `me` (an AIPlayer) sits at `seat`, with `priorPlays` already
// on the table this trick and `playedExtra` cards also seen earlier this hand.
function setup({ seat, hand, priorPlays, playedExtra = [], kingWinProb }) {
    const players = [0, 1, 2, 3].map(i => ({
        id: `s${i}`, team: teamOf(i), bid: 0, tricks: 0, isNil: false, bags: 0, username: `S${i}`,
    }));

    const me = new AIPlayer(`s${seat}`, `S${seat}`);
    me.id = `s${seat}`;
    me.team = teamOf(seat);
    me.aiLevel = 'medium';
    me.bid = 5; me.tricks = 0; me.bags = 0; me.isNil = false;
    me.hand = hand.map(([r, s]) => card(r, s));
    if (typeof kingWinProb === 'number') me.monteCarloWinProbability = () => kingWinProb;
    players[seat] = me;

    const trick = priorPlays.map(([i, r, s]) => ({ player: players[i], card: card(r, s) }));
    me.playedCards = [
        ...priorPlays.map(([, r, s]) => ({ rankCode: r, suitCode: s, value: VAL[r] })),
        ...playedExtra.map(([r, s]) => ({ rankCode: r, suitCode: s, value: VAL[r] })),
    ];

    const game = { players, trick, spadesBroken: true, isCutthroat: () => false };
    const leadSuit = trick[0].card.suitCode;
    const legal = me.hand.some(c => c.suitCode === leadSuit)
        ? me.hand.filter(c => c.suitCode === leadSuit)
        : [...me.hand];
    return { me, game, legal };
}

let pass = 0, fail = 0;
function check(name, got, expect) {
    const label = `${got ? got.rankCode + got.suitCode : 'null'}`;
    const ok = got && (got.rankCode + got.suitCode) === expect;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: played ${label} (expected ${expect})`);
    ok ? pass++ : fail++;
}

// T1 — vulnerable King, MC says it likely LOSES (Ace behind) → DUCK the King.
{
    const { me, game, legal } = setup({
        seat: 2, hand: [['K','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H'],[1,'Q','H']], kingWinProb: 0.2,
    });
    check('Vulnerable King, low MC → duck King', me.selectFollowCard(game, legal, false, null), '4H');
}

// T2 (control) — Ace already played → King is boss (not vulnerable) → WIN with the King.
{
    const { me, game, legal } = setup({
        seat: 2, hand: [['K','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H'],[1,'Q','H']], playedExtra: [['A','H']], kingWinProb: 0.9,
    });
    check('Ace gone (King is boss) → win King', me.selectFollowCard(game, legal, false, null), 'KH');
}

// T3 (control) — last to act, Ace live → nothing behind us → WIN with the King.
{
    const { me, game, legal } = setup({
        seat: 3, hand: [['K','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H'],[1,'7','H'],[2,'Q','H']], kingWinProb: 0.9,
    });
    check('Last to act, Ace live → win King', me.selectFollowCard(game, legal, false, null), 'KH');
}

// T4 (point #2) — SEAT 2 (two players behind), vulnerable King, low MC → still DUCK.
{
    const { me, game, legal } = setup({
        seat: 1, hand: [['K','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H']], kingWinProb: 0.2,
    });
    check('Seat 2, vulnerable King, low MC → duck King', me.selectFollowCard(game, legal, false, null), '4H');
}

// T5 (point #1) — Queen is NOT protected: with A & K live behind, still play the Queen.
{
    const { me, game, legal } = setup({
        seat: 2, hand: [['Q','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H'],[1,'9','H']], kingWinProb: 0.9,
    });
    check('Queen not protected (A & K live) → play Queen', me.selectFollowCard(game, legal, false, null), 'QH');
}

// T6 (option C) — vulnerable King, but MC says it will likely HOLD (Ace not behind us) → PLAY the King.
{
    const { me, game, legal } = setup({
        seat: 2, hand: [['K','H'],['4','H'],['3','C']],
        priorPlays: [[0,'5','H'],[1,'Q','H']], kingWinProb: 0.8,
    });
    check('Vulnerable King, high MC → play King', me.selectFollowCard(game, legal, false, null), 'KH');
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);

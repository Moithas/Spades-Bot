// scripts/test_game_persistence.js
//
// Round-trips a mid-game GameManager through toSnapshot() -> JSON -> fromSnapshot() and
// asserts the important state (players, hands, bids, trick, scores, phase) survives intact.
//
// Run: node scripts/test_game_persistence.js

import GameManager from '../game_logic/GameManager.js';

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}

const noop = () => {};

// Build a classic 4-player game (2 human, 2 AI) and drive it into mid-trick PLAYING state.
const gm = new GameManager(noop, noop, 500, 'classic');
gm.channelId = 'chan-123';
gm.guildId = 'guild-9';
gm.hostId = 'u1';
gm.addPlayer({ id: 'u1', username: 'Alice' });
gm.addPlayer({ id: 'u2', username: 'Bob' });
gm.addAIPlayerWithLevel(null, 'hard');
gm.addAIPlayerWithLevel(null, 'medium');
// Assign teams (0&2 vs 1&3)
gm.players[0].team = 1; gm.players[1].team = 2; gm.players[2].team = 1; gm.players[3].team = 2;

await gm.startGame();          // deals + sets BIDDING
// Force bids + move to PLAYING deterministically
gm.players.forEach((p, i) => { p.bid = 3; p.isNil = false; p.isBlindNil = false; });
gm.state = 'PLAYING';
gm.spadesBroken = true;
gm.currentRound = 2;
gm.currentPlayerIndex = 2;
gm.dealerIndex = 1;
gm.players[0].score = 120; gm.players[0].bags = 3;
gm.players[2].tricks = 2;
// Put a couple of cards on the table as the current trick, from players' actual hands.
const c0 = gm.players[0].hand[0];
const c1 = gm.players[1].hand[0];
gm.trick = [
  { player: gm.players[0], card: c0 },
  { player: gm.players[1], card: c1 },
];
// Give the hard AI some seen cards.
gm.players[2].playedCards = [{ rankCode: '5', suitCode: 'H', value: 5, playedBy: 'u1' }];

// --- Round-trip through JSON ---
const snap = gm.toSnapshot();
const wire = JSON.parse(JSON.stringify(snap)); // simulate file write/read
const gm2 = GameManager.fromSnapshot(wire, { publicAnnounce: noop, privatePrompt: noop });

check('state preserved', gm2.state === 'PLAYING');
check('gameMode preserved', gm2.gameMode === 'classic');
check('channelId preserved', gm2.channelId === 'chan-123');
check('guildId preserved', gm2.guildId === 'guild-9');
check('hostId preserved', gm2.hostId === 'u1');
check('currentRound preserved', gm2.currentRound === 2);
check('currentPlayerIndex preserved', gm2.currentPlayerIndex === 2);
check('dealerIndex preserved', gm2.dealerIndex === 1);
check('spadesBroken preserved', gm2.spadesBroken === true);
check('player count preserved', gm2.players.length === 4);
check('player classes preserved (human vs AI)',
  gm2.players[0].isAI === false && gm2.players[2].isAI === true);
check('AIPlayer rebuilt as AIPlayer (has selectFollowCard)',
  typeof gm2.players[2].selectFollowCard === 'function');
check('AI level preserved', gm2.players[2].aiLevel === 'hard');
check('AI vulnerableKingHoldThreshold preserved',
  gm2.players[2].vulnerableKingHoldThreshold === gm.players[2].vulnerableKingHoldThreshold);
check('AI playedCards preserved', gm2.players[2].playedCards.length === 1
  && gm2.players[2].playedCards[0].rankCode === '5');
check('bids preserved', gm2.players[0].bid === 3);
check('score preserved', gm2.players[0].score === 120);
check('bags preserved', gm2.players[0].bags === 3);
check('tricks preserved', gm2.players[2].tricks === 2);
check('teams preserved', gm2.players[0].team === 1 && gm2.players[1].team === 2);
check('hand sizes preserved',
  gm2.players[0].hand.length === gm.players[0].hand.length);
check('hand cards are Card instances (have value)',
  typeof gm2.players[0].hand[0].value === 'number' && !!gm2.players[0].hand[0].suit);
check('trick length preserved', gm2.trick.length === 2);
check('trick card matches', gm2.trick[0].card.rankCode === c0.rankCode
  && gm2.trick[0].card.suitCode === c0.suitCode);
check('trick player relinked to instance', gm2.trick[0].player === gm2.players[0]);
check('options.targetScore preserved', gm2.options.targetScore === 500);
check('comms re-attached', gm2.publicAnnounce === noop && gm2.privatePrompt === noop);
check('spectatorView not carried over', gm2.spectatorView === null);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);

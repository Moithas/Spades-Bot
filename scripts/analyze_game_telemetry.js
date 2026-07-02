import { gameTelemetryStore } from '../stats/GameTelemetry.js';

const snapshot = gameTelemetryStore.getSnapshot();
const rounds = Array.isArray(snapshot.rounds) ? snapshot.rounds : [];
const games = Array.isArray(snapshot.games) ? snapshot.games : [];

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isHumanOnlyGame(game) {
  return Array.isArray(game.players) && game.players.length > 0 && game.players.every(player => !player.isAI);
}

function summarizePlayerRound(player) {
  const bid = asNumber(player.bid);
  const tricks = asNumber(player.tricks);
  return {
    name: player.username || 'unknown',
    isAI: !!player.isAI,
    aiLevel: player.aiLevel || 'human',
    bid,
    tricks,
    bidGap: tricks - bid,
    score: asNumber(player.score),
    bags: asNumber(player.bags),
    team: player.team ?? null
  };
}

function aggregate(roundList) {
  const totals = {
    rounds: roundList.length,
    players: 0,
    humanPlayers: 0,
    aiPlayers: 0,
    underbids: 0,
    overbids: 0,
    exactBids: 0,
    totalBidGap: 0,
    totalAbsBidGap: 0
  };

  const byDifficulty = new Map();
  const byGameMode = new Map();

  for (const round of roundList) {
    const players = Array.isArray(round.players) ? round.players : [];
    totals.players += players.length;

    const modeKey = round.gameMode || 'unknown';
    if (!byGameMode.has(modeKey)) {
      byGameMode.set(modeKey, { rounds: 0, players: 0, underbids: 0, overbids: 0, exactBids: 0, totalBidGap: 0 });
    }
    const modeBucket = byGameMode.get(modeKey);
    modeBucket.rounds += 1;

    for (const player of players) {
      const summary = summarizePlayerRound(player);
      totals.totalBidGap += summary.bidGap;
      totals.totalAbsBidGap += Math.abs(summary.bidGap);

      if (summary.isAI) {
        totals.aiPlayers += 1;
        if (!byDifficulty.has(summary.aiLevel)) {
          byDifficulty.set(summary.aiLevel, { players: 0, underbids: 0, overbids: 0, exactBids: 0, totalBidGap: 0 });
        }
        const diffBucket = byDifficulty.get(summary.aiLevel);
        diffBucket.players += 1;
        diffBucket.totalBidGap += summary.bidGap;

        if (summary.bidGap > 0) {
          totals.underbids += 1;
          diffBucket.underbids += 1;
          modeBucket.underbids += 1;
        } else if (summary.bidGap < 0) {
          totals.overbids += 1;
          diffBucket.overbids += 1;
          modeBucket.overbids += 1;
        } else {
          totals.exactBids += 1;
          diffBucket.exactBids += 1;
          modeBucket.exactBids += 1;
        }
      } else {
        totals.humanPlayers += 1;
      }

      modeBucket.players += 1;
      modeBucket.totalBidGap += summary.bidGap;
    }
  }

  return { totals, byDifficulty, byGameMode };
}

function formatPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function printRows(title, rows, columns) {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log('No data');
    return;
  }

  const widths = columns.map(col => {
    const maxWidth = Math.max(...rows.map(row => String(row[col.key]).length));
    return Math.max(col.label.length, maxWidth);
  });

  console.log(columns.map((col, index) => String(col.label).padEnd(widths[index])).join('  '));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));

  for (const row of rows) {
    console.log(columns.map((col, index) => String(row[col.key]).padEnd(widths[index])).join('  '));
  }
}

const humanRounds = rounds.filter(round => Array.isArray(round.players) && round.players.some(player => !player.isAI));
const aiRounds = rounds.filter(round => Array.isArray(round.players) && round.players.some(player => player.isAI));
const humanOnlyGames = games.filter(isHumanOnlyGame);
const aiMixedGames = games.filter(game => Array.isArray(game.players) && game.players.some(player => player.isAI));

const { totals, byDifficulty, byGameMode } = aggregate(rounds);

console.log('=== Game Telemetry Summary ===');
console.log(`Rounds stored: ${rounds.length}`);
console.log(`Games stored: ${games.length}`);
console.log(`Human-only games: ${humanOnlyGames.length}`);
console.log(`AI-involved games: ${aiMixedGames.length}`);
console.log(`Rounds with humans: ${humanRounds.length}`);
console.log(`Rounds with AI: ${aiRounds.length}`);
console.log(`Total player round records: ${totals.players}`);
console.log(`AI player round records: ${totals.aiPlayers}`);
console.log(`Human player round records: ${totals.humanPlayers}`);
console.log(`AI underbids: ${totals.underbids}`);
console.log(`AI overbids: ${totals.overbids}`);
console.log(`AI exact bids: ${totals.exactBids}`);
console.log(`Average bid gap (tricks - bid): ${(totals.players ? (totals.totalBidGap / totals.players).toFixed(2) : '0.00')}`);
console.log(`Average absolute bid gap: ${(totals.players ? (totals.totalAbsBidGap / totals.players).toFixed(2) : '0.00')}`);

const difficultyRows = [...byDifficulty.entries()].map(([aiLevel, stats]) => ({
  aiLevel,
  players: stats.players,
  underbids: stats.underbids,
  overbids: stats.overbids,
  exactBids: stats.exactBids,
  avgBidGap: stats.players ? (stats.totalBidGap / stats.players).toFixed(2) : '0.00',
  underbidRate: formatPercent(stats.underbids, stats.players)
})).sort((a, b) => b.players - a.players);

const modeRows = [...byGameMode.entries()].map(([mode, stats]) => ({
  mode,
  rounds: stats.rounds,
  players: stats.players,
  underbids: stats.underbids,
  overbids: stats.overbids,
  exactBids: stats.exactBids,
  avgBidGap: stats.players ? (stats.totalBidGap / stats.players).toFixed(2) : '0.00',
  underbidRate: formatPercent(stats.underbids, stats.players)
})).sort((a, b) => b.rounds - a.rounds);

printRows('By AI Difficulty', difficultyRows, [
  { key: 'aiLevel', label: 'ai_level' },
  { key: 'players', label: 'player_rounds' },
  { key: 'underbids', label: 'underbids' },
  { key: 'overbids', label: 'overbids' },
  { key: 'exactBids', label: 'exact' },
  { key: 'avgBidGap', label: 'avg_bid_gap' },
  { key: 'underbidRate', label: 'underbid_rate' }
]);

printRows('By Game Mode', modeRows, [
  { key: 'mode', label: 'mode' },
  { key: 'rounds', label: 'rounds' },
  { key: 'players', label: 'player_rounds' },
  { key: 'underbids', label: 'underbids' },
  { key: 'overbids', label: 'overbids' },
  { key: 'exactBids', label: 'exact' },
  { key: 'avgBidGap', label: 'avg_bid_gap' },
  { key: 'underbidRate', label: 'underbid_rate' }
]);

if (humanOnlyGames.length > 0) {
  const humanGameRows = humanOnlyGames.slice(-10).map(game => ({
    gameId: game.gameId,
    guildId: game.guildId || 'unknown',
    mode: game.gameMode,
    rounds: game.roundsPlayed,
    players: Array.isArray(game.players) ? game.players.length : 0,
    avgBidGap: game.playerSummary && game.playerSummary.length
      ? (game.playerSummary.reduce((sum, p) => sum + asNumber(p.bidGap), 0) / game.playerSummary.length).toFixed(2)
      : '0.00'
  }));

  printRows('Recent Human-Only Games', humanGameRows, [
    { key: 'gameId', label: 'gameId' },
    { key: 'guildId', label: 'guildId' },
    { key: 'mode', label: 'mode' },
    { key: 'rounds', label: 'rounds' },
    { key: 'players', label: 'players' },
    { key: 'avgBidGap', label: 'avg_bid_gap' }
  ]);
}

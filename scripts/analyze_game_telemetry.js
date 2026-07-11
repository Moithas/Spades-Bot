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

function phaseFromRound(roundNumber) {
  const round = asNumber(roundNumber);
  if (round <= 4) return 'early(1-4)';
  if (round <= 9) return 'mid(5-9)';
  return 'late(10+)';
}

function scoreStateFromDiff(diff) {
  if (!Number.isFinite(diff)) return 'unknown';
  if (diff >= 100) return 'leading_big';
  if (diff >= 25) return 'leading';
  if (diff > -25) return 'even';
  if (diff > -100) return 'trailing';
  return 'trailing_big';
}

function getTeamSummary(players, aiLevel) {
  const teamPlayers = players.filter(player => player.aiLevel === aiLevel);
  if (teamPlayers.length !== 2) return null;

  const bid = teamPlayers.reduce((sum, player) => sum + asNumber(player.bid), 0);
  const tricks = teamPlayers.reduce((sum, player) => sum + asNumber(player.tricks), 0);
  const deficits = teamPlayers.map(player => ({
    seat: player.seat ?? null,
    gap: asNumber(player.tricks) - asNumber(player.bid)
  }));

  return { bid, tricks, deficits };
}

function getTeamScoreSummary(players, aiLevel) {
  const teamPlayers = players.filter(player => player.aiLevel === aiLevel);
  if (teamPlayers.length !== 2) return null;
  return Math.max(...teamPlayers.map(player => asNumber(player.score)));
}

function analyzeHardVsMedium(roundList) {
  const phaseBuckets = new Map();
  const seatBuckets = new Map();
  const scoreBuckets = new Map();
  const positionBuckets = new Map();
  const recentGames = [];
  let roundsWithFinalTrickContext = 0;

  for (const round of roundList) {
    const players = Array.isArray(round.players) ? round.players : [];
    const aiPlayers = players.filter(player => player.isAI);
    const hardCount = aiPlayers.filter(player => player.aiLevel === 'hard').length;
    const mediumCount = aiPlayers.filter(player => player.aiLevel === 'medium').length;

    if (players.length !== 4 || aiPlayers.length !== 4 || hardCount !== 2 || mediumCount !== 2) {
      continue;
    }

    const hard = getTeamSummary(players, 'hard');
    const medium = getTeamSummary(players, 'medium');
    if (!hard || !medium) continue;

    if (hard.tricks >= hard.bid) {
      continue;
    }

    const shortfall = hard.bid - hard.tricks;
    if (shortfall !== 1) {
      continue;
    }

    const missingPlayers = hard.deficits.filter(item => item.gap < 0);
    if (missingPlayers.length !== 1) {
      continue;
    }

    const phase = phaseFromRound(round.round);
    const hardScore = getTeamScoreSummary(players, 'hard');
    const mediumScore = getTeamScoreSummary(players, 'medium');
    const scoreState = scoreStateFromDiff(hardScore - mediumScore);
    const seat = missingPlayers[0].seat ?? 'unknown';
    const finalTrickPlays = Array.isArray(round.finalTrick?.plays) ? round.finalTrick.plays : [];
    const missingPlay = finalTrickPlays.find(play => (play?.seat ?? null) === seat);
    const missingPosition = missingPlay ? `pos_${missingPlay.order}` : 'unknown';

    if (missingPlay) {
      roundsWithFinalTrickContext += 1;
    }

    if (!phaseBuckets.has(phase)) {
      phaseBuckets.set(phase, { rounds: 0, mediumAlsoSet: 0, hardBid: 0, mediumBid: 0, hardTricks: 0, mediumTricks: 0 });
    }
    const phaseBucket = phaseBuckets.get(phase);
    phaseBucket.rounds += 1;
    phaseBucket.mediumAlsoSet += medium.tricks < medium.bid ? 1 : 0;
    phaseBucket.hardBid += hard.bid;
    phaseBucket.mediumBid += medium.bid;
    phaseBucket.hardTricks += hard.tricks;
    phaseBucket.mediumTricks += medium.tricks;

    if (!seatBuckets.has(seat)) {
      seatBuckets.set(seat, { rounds: 0 });
    }
    seatBuckets.get(seat).rounds += 1;

    if (!scoreBuckets.has(scoreState)) {
      scoreBuckets.set(scoreState, { rounds: 0 });
    }
    scoreBuckets.get(scoreState).rounds += 1;

    if (!positionBuckets.has(missingPosition)) {
      positionBuckets.set(missingPosition, { rounds: 0 });
    }
    positionBuckets.get(missingPosition).rounds += 1;

    recentGames.push({
      gameId: round.gameId || 'unknown',
      roundNumber: round.round ?? 'unknown',
      phase,
      scoreState,
      missingSeat: seat,
      missingPosition,
      hardBid: hard.bid,
      hardTricks: hard.tricks,
      mediumBid: medium.bid,
      mediumTricks: medium.tricks
    });
  }

  const phaseRows = [...phaseBuckets.entries()].map(([phase, stats]) => ({
    phase,
    rounds: stats.rounds,
    mediumAlsoSetRate: formatPercent(stats.mediumAlsoSet, stats.rounds),
    hardBidAvg: stats.rounds ? (stats.hardBid / stats.rounds).toFixed(2) : '0.00',
    hardTricksAvg: stats.rounds ? (stats.hardTricks / stats.rounds).toFixed(2) : '0.00',
    mediumBidAvg: stats.rounds ? (stats.mediumBid / stats.rounds).toFixed(2) : '0.00',
    mediumTricksAvg: stats.rounds ? (stats.mediumTricks / stats.rounds).toFixed(2) : '0.00'
  })).sort((a, b) => b.rounds - a.rounds);

  const seatRows = [...seatBuckets.entries()].map(([seat, stats]) => ({
    seat: `seat_${seat}`,
    rounds: stats.rounds,
    share: formatPercent(stats.rounds, recentGames.length)
  })).sort((a, b) => b.rounds - a.rounds);

  const scoreRows = [...scoreBuckets.entries()].map(([scoreState, stats]) => ({
    scoreState,
    rounds: stats.rounds,
    share: formatPercent(stats.rounds, recentGames.length)
  })).sort((a, b) => b.rounds - a.rounds);

  const positionRows = [...positionBuckets.entries()].map(([position, stats]) => ({
    position,
    rounds: stats.rounds,
    share: formatPercent(stats.rounds, recentGames.length)
  })).sort((a, b) => b.rounds - a.rounds);

  const positionKnownRows = [...positionBuckets.entries()]
    .filter(([position]) => position !== 'unknown')
    .map(([position, stats]) => ({
      position,
      rounds: stats.rounds,
      share: formatPercent(stats.rounds, roundsWithFinalTrickContext)
    }))
    .sort((a, b) => b.rounds - a.rounds);

  const recentRows = recentGames.slice(-10);

  return {
    totalRounds: recentGames.length,
    roundsWithFinalTrickContext,
    phaseRows,
    seatRows,
    scoreRows,
    positionRows,
    positionKnownRows,
    recentRows
  };
}

const humanRounds = rounds.filter(round => Array.isArray(round.players) && round.players.some(player => !player.isAI));
const aiRounds = rounds.filter(round => Array.isArray(round.players) && round.players.some(player => player.isAI));
const humanOnlyGames = games.filter(isHumanOnlyGame);
const aiMixedGames = games.filter(game => Array.isArray(game.players) && game.players.some(player => player.isAI));
const hvsmBreakdown = analyzeHardVsMedium(rounds);

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

console.log(`\nHard one-trick-short / one-miss rounds vs medium: ${hvsmBreakdown.totalRounds}`);
console.log(`Final-trick position available: ${hvsmBreakdown.roundsWithFinalTrickContext} (${formatPercent(hvsmBreakdown.roundsWithFinalTrickContext, hvsmBreakdown.totalRounds)})`);

printRows('Hard Vs Medium One-Trick Miss By Phase', hvsmBreakdown.phaseRows, [
  { key: 'phase', label: 'phase' },
  { key: 'rounds', label: 'rounds' },
  { key: 'mediumAlsoSetRate', label: 'medium_also_set' },
  { key: 'hardBidAvg', label: 'hard_bid_avg' },
  { key: 'hardTricksAvg', label: 'hard_tricks_avg' },
  { key: 'mediumBidAvg', label: 'medium_bid_avg' },
  { key: 'mediumTricksAvg', label: 'medium_tricks_avg' }
]);

printRows('Hard Vs Medium One-Trick Miss By Seat', hvsmBreakdown.seatRows, [
  { key: 'seat', label: 'seat' },
  { key: 'rounds', label: 'rounds' },
  { key: 'share', label: 'share' }
]);

printRows('Hard Vs Medium One-Trick Miss By Score State', hvsmBreakdown.scoreRows, [
  { key: 'scoreState', label: 'score_state' },
  { key: 'rounds', label: 'rounds' },
  { key: 'share', label: 'share' }
]);

printRows('Hard Vs Medium One-Trick Miss By Final Trick Position', hvsmBreakdown.positionRows, [
  { key: 'position', label: 'position' },
  { key: 'rounds', label: 'rounds' },
  { key: 'share', label: 'share' }
]);

printRows('Hard Vs Medium Position (Context-Only)', hvsmBreakdown.positionKnownRows, [
  { key: 'position', label: 'position' },
  { key: 'rounds', label: 'rounds' },
  { key: 'share', label: 'share_known' }
]);

printRows('Recent Hard Vs Medium One-Trick Misses', hvsmBreakdown.recentRows, [
  { key: 'gameId', label: 'gameId' },
  { key: 'roundNumber', label: 'round' },
  { key: 'phase', label: 'phase' },
  { key: 'scoreState', label: 'score_state' },
  { key: 'missingSeat', label: 'missing_seat' },
  { key: 'missingPosition', label: 'missing_pos' },
  { key: 'hardBid', label: 'hard_bid' },
  { key: 'hardTricks', label: 'hard_tricks' },
  { key: 'mediumBid', label: 'medium_bid' },
  { key: 'mediumTricks', label: 'medium_tricks' }
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

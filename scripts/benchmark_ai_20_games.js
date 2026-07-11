import GameManager from '../game_logic/GameManager.js';

const games = Number.parseInt(process.argv[2] || '20', 10);
const targetScore = Number.parseInt(process.argv[3] || '333', 10);
const team1Difficulty = (process.argv[4] || 'hard').toLowerCase();
const team2Difficulty = (process.argv[5] || 'medium').toLowerCase();

const FAST_MODE = process.env.BENCHMARK_FAST !== '0';
const SILENT_LOGS = process.env.BENCHMARK_VERBOSE !== '1';
const JSON_MODE = process.env.BENCHMARK_JSON === '1';
const nativeSetTimeout = global.setTimeout;
const nativeDateNow = Date.now.bind(Date);

function parseProfileOverride(envName) {
  const raw = process.env[envName];
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${envName}: ${error.message}`);
  }
}

const team1ProfileOverride = parseProfileOverride('BENCHMARK_TEAM1_PROFILE_JSON');
const team2ProfileOverride = parseProfileOverride('BENCHMARK_TEAM2_PROFILE_JSON');

let restoreConsole = null;
let restoreTimer = null;
let restoreDateNow = null;

function emptyHandMetrics() {
  return {
    hands: 0,
    contractsMade: 0,
    sets: 0,
    bagsTaken: 0,
    bagPenalties: 0,
    nilSuccesses: 0,
    nilFails: 0,
    blindNilSuccesses: 0,
    blindNilFails: 0,
    score: 0,
    bags: 0
  };
}

function parseTeamScoreDisplay(teamScoreDisplay = '') {
  const team1Match = teamScoreDisplay.match(/Team 1.*?Score \*\*(-?\d+)\*\*.*?Bags \*\*(\d+)\*\*/s);
  const team2Match = teamScoreDisplay.match(/Team 2.*?Score \*\*(-?\d+)\*\*.*?Bags \*\*(\d+)\*\*/s);

  return {
    team1: {
      score: team1Match ? Number.parseInt(team1Match[1], 10) : 0,
      bags: team1Match ? Number.parseInt(team1Match[2], 10) : 0
    },
    team2: {
      score: team2Match ? Number.parseInt(team2Match[1], 10) : 0,
      bags: team2Match ? Number.parseInt(team2Match[2], 10) : 0
    }
  };
}

function parseRoundMetrics(roundSummary = '', teamScoreDisplay = '') {
  const metrics = {
    team1: emptyHandMetrics(),
    team2: emptyHandMetrics()
  };

  metrics.team1.hands = 1;
  metrics.team2.hands = 1;

  const lines = String(roundSummary)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    let match = line.match(/^✅ Team (1|2) made bid of \d+ \(\+[-\d]+ points, \+(\d+) bags\)$/);
    if (match) {
      const team = match[1] === '1' ? metrics.team1 : metrics.team2;
      team.contractsMade += 1;
      team.bagsTaken += Number.parseInt(match[2], 10);
      continue;
    }

    match = line.match(/^❌ Team (1|2) set! \(([-\d]+) points\)$/);
    if (match) {
      const team = match[1] === '1' ? metrics.team1 : metrics.team2;
      team.sets += 1;
      continue;
    }

    match = line.match(/^💥 Team (1|2) bag penalty!/);
    if (match) {
      const team = match[1] === '1' ? metrics.team1 : metrics.team2;
      team.bagPenalties += 1;
      continue;
    }

    match = line.match(/^[✅❌] (T[12]-[^ ]+) (made|failed) (Blind Nil|Nil)!/);
    if (match) {
      const team = match[1].startsWith('T1-') ? metrics.team1 : metrics.team2;
      const outcome = match[2];
      const nilType = match[3];
      if (outcome === 'made') {
        if (nilType === 'Blind Nil') team.blindNilSuccesses += 1;
        else team.nilSuccesses += 1;
      } else {
        if (nilType === 'Blind Nil') team.blindNilFails += 1;
        else team.nilFails += 1;
      }
    }
  }

  const scores = parseTeamScoreDisplay(teamScoreDisplay);
  metrics.team1.score = scores.team1.score;
  metrics.team1.bags = scores.team1.bags;
  metrics.team2.score = scores.team2.score;
  metrics.team2.bags = scores.team2.bags;

  return metrics;
}

function accumulateHandMetrics(rounds = []) {
  const total = {
    team1: emptyHandMetrics(),
    team2: emptyHandMetrics(),
    rounds
  };

  for (const round of rounds) {
    for (const teamKey of ['team1', 'team2']) {
      const source = round[teamKey] || emptyHandMetrics();
      const target = total[teamKey];
      for (const key of Object.keys(target)) {
        if (key === 'score' || key === 'bags') continue;
        target[key] += source[key] || 0;
      }
      target.score = source.score;
      target.bags = source.bags;
    }
  }

  return total;
}

if (SILENT_LOGS) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error
  };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  restoreConsole = () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  };
}

if (FAST_MODE) {
  const originalSetTimeout = global.setTimeout;
  const originalDateNow = Date.now;
  global.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, Math.min(1, ms || 0), ...args);
  Date.now = () => originalDateNow() * 1000;
  restoreTimer = () => {
    global.setTimeout = originalSetTimeout;
  };
  restoreDateNow = () => {
    Date.now = originalDateNow;
  };
}

function makeGameManager(target) {
  let resolveGame;
  let rejectGame;
  const done = new Promise((resolve, reject) => {
    resolveGame = resolve;
    rejectGame = reject;
  });

  let timeoutId = null;
  const roundEvents = [];

  const gm = new GameManager(
    async (payload) => {
      if (!payload || typeof payload !== 'object') return;

      if (payload.type === 'round_end') {
        roundEvents.push(parseRoundMetrics(payload.roundSummary, payload.teamScoreDisplay));
      }

      if (payload.type === 'game_over') {
        if (timeoutId) clearTimeout(timeoutId);
        resolveGame(payload);
      }
    },
    async () => {},
    target,
    'classic'
  );

  gm.options.trashTalk.enabled = false;
  gm.options.autoPlayLastTrick = true;

  timeoutId = nativeSetTimeout(() => {
    rejectGame(new Error('Benchmark game timed out before completion'));
  }, 120000);

  return { gm, done, roundEvents };
}

function summarizeGamePayload(payload, gameIndex, roundEvents = []) {
  const stats = Array.isArray(payload.gameStats) ? payload.gameStats : [];
  const team1Stats = stats.filter(s => typeof s.username === 'string' && s.username.startsWith('T1-'));
  const team2Stats = stats.filter(s => typeof s.username === 'string' && s.username.startsWith('T2-'));

  const summarizeTeam = (teamStats) => ({
    score: teamStats.length > 0 ? (teamStats[0].finalScore || 0) : 0,
    bags: teamStats.reduce((sum, s) => sum + (s.bags || 0), 0),
    nilBids: teamStats.reduce((sum, s) => sum + (s.nilBids || 0), 0),
    nilSuccesses: teamStats.reduce((sum, s) => sum + (s.nilSuccesses || 0), 0),
    blindNilBids: teamStats.reduce((sum, s) => sum + (s.blindNilBids || 0), 0),
    blindNilSuccesses: teamStats.reduce((sum, s) => sum + (s.blindNilSuccesses || 0), 0)
  });

  const team1 = summarizeTeam(team1Stats);
  const team2 = summarizeTeam(team2Stats);
  const handMetrics = accumulateHandMetrics(roundEvents);

  const handsPlayed = stats.length > 0 ? (stats[0].handsPlayed || 0) : 0;

  let winner = 'tie';
  if (team1.score > team2.score) winner = 'team1';
  if (team2.score > team1.score) winner = 'team2';

  return {
    game: gameIndex,
    team1,
    team2,
    handMetrics,
    handsPlayed,
    winner,
    margin: team1.score - team2.score
  };
}

async function runSingleGame(gameIndex) {
  const { gm, done, roundEvents } = makeGameManager(targetScore);

  const seats = [
    { name: `T1-A-${gameIndex}`, level: team1Difficulty },
    { name: `T2-A-${gameIndex}`, level: team2Difficulty },
    { name: `T1-B-${gameIndex}`, level: team1Difficulty },
    { name: `T2-B-${gameIndex}`, level: team2Difficulty }
  ];

  for (const seat of seats) {
    const added = gm.addAIPlayerWithLevel(seat.name, seat.level);
    if (added.error) {
      throw new Error(`Failed to add AI seat ${seat.name}: ${added.error}`);
    }

    const override = seat.name.startsWith('T1-') ? team1ProfileOverride : team2ProfileOverride;
    if (override && typeof added.player?.applyTuning === 'function') {
      added.player.applyTuning(override);
    }
  }

  await gm.startGame();
  const payload = await done;
  return summarizeGamePayload(payload, gameIndex, roundEvents);
}

async function main() {
  const start = nativeDateNow();
  const results = [];

  for (let i = 1; i <= games; i++) {
    const result = await runSingleGame(i);
    results.push(result);
  }

  const team1Wins = results.filter(r => r.winner === 'team1').length;
  const team2Wins = results.filter(r => r.winner === 'team2').length;
  const ties = results.filter(r => r.winner === 'tie').length;

  const avgHands = results.reduce((sum, r) => sum + r.handsPlayed, 0) / Math.max(1, results.length);
  const avgMargin = results.reduce((sum, r) => sum + r.margin, 0) / Math.max(1, results.length);
  const avgTeam1Score = results.reduce((sum, r) => sum + r.team1.score, 0) / Math.max(1, results.length);
  const avgTeam2Score = results.reduce((sum, r) => sum + r.team2.score, 0) / Math.max(1, results.length);

  if (restoreConsole) restoreConsole();

  const elapsedMs = nativeDateNow() - start;

  if (JSON_MODE) {
    console.log(JSON.stringify({
      games,
      targetScore,
      team1Difficulty,
      team2Difficulty,
      fastMode: FAST_MODE,
      team1Wins,
      team2Wins,
      ties,
      avgHands,
      avgMargin,
      avgTeam1Score,
      avgTeam2Score,
      elapsedMs,
      results
    }));

    if (restoreTimer) restoreTimer();
    if (restoreDateNow) restoreDateNow();
    return;
  }

  console.log('=== Spades AI Benchmark ===');
  console.log(`Games: ${games}`);
  console.log(`Target score: ${targetScore}`);
  console.log(`Team 1 difficulty: ${team1Difficulty}`);
  console.log(`Team 2 difficulty: ${team2Difficulty}`);
  console.log(`Fast mode: ${FAST_MODE ? 'ON' : 'OFF'}`);
  console.log(`Team 1 wins: ${team1Wins} (${((team1Wins / games) * 100).toFixed(1)}%)`);
  console.log(`Team 2 wins: ${team2Wins} (${((team2Wins / games) * 100).toFixed(1)}%)`);
  console.log(`Ties: ${ties}`);
  console.log(`Average hands per game: ${avgHands.toFixed(2)}`);
  console.log(`Average score margin (Team1-Team2): ${avgMargin.toFixed(2)}`);
  console.log(`Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`);

  if (restoreTimer) restoreTimer();
  if (restoreDateNow) restoreDateNow();
}

main()
  .catch((err) => {
    if (restoreConsole) restoreConsole();
    if (restoreTimer) restoreTimer();
    if (restoreDateNow) restoreDateNow();
    console.error('Benchmark failed:', err);
    process.exit(1);
  });

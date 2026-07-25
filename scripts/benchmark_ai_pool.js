import { execFileSync } from 'node:child_process';

const samples = Number.parseInt(process.argv[2] || '20', 10);
const targetScore = Number.parseInt(process.argv[3] || '333', 10);
const team1Difficulty = (process.argv[4] || 'hard').toLowerCase();
const team2Difficulty = (process.argv[5] || 'medium').toLowerCase();

const timeoutMs = Number.parseInt(process.argv[6] || '180000', 10);
const JSON_MODE = process.env.BENCHMARK_JSON === '1';

let team1Wins = 0;
let team2Wins = 0;
let ties = 0;
let completed = 0;
let timedOut = 0;
let totalHands = 0;
let totalMargin = 0;
let totalTeam1Score = 0;
let totalTeam2Score = 0;
const results = [];

function emptyHandMetrics() {
  return {
    hands: 0,
    contractsMade: 0,
    sets: 0,
    setsShort1: 0,
    setsShort2: 0,
    setsShort3plus: 0,
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

function mergeHandMetrics(target, source) {
  for (const key of Object.keys(target)) {
    if (key === 'score' || key === 'bags') continue;
    target[key] += source?.[key] || 0;
  }
  target.score = source?.score ?? target.score;
  target.bags = source?.bags ?? target.bags;
}

const handMetrics = {
  team1: emptyHandMetrics(),
  team2: emptyHandMetrics()
};

function logProgress(message) {
  if (!JSON_MODE) {
    console.log(message);
  }
}

const start = Date.now();

for (let i = 1; i <= samples; i++) {
  try {
    const output = execFileSync(
      process.execPath,
      ['scripts/benchmark_ai_20_games.js', '1', String(targetScore), team1Difficulty, team2Difficulty],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          BENCHMARK_FAST: process.env.BENCHMARK_FAST || '1',
          BENCHMARK_JSON: '1'
        }
      }
    );

    const parsed = JSON.parse(output);
    const game = parsed.results[0];

    completed++;
    results.push(game);
    totalHands += game.handsPlayed || 0;
    totalMargin += game.margin || 0;
    totalTeam1Score += game.team1?.score || 0;
    totalTeam2Score += game.team2?.score || 0;
    mergeHandMetrics(handMetrics.team1, game.handMetrics?.team1);
    mergeHandMetrics(handMetrics.team2, game.handMetrics?.team2);

    if (game.winner === 'team1') {
      team1Wins++;
      logProgress(`[${i}/${samples}] Team1 win`);
    } else if (game.winner === 'team2') {
      team2Wins++;
      logProgress(`[${i}/${samples}] Team2 win`);
    } else {
      ties++;
      logProgress(`[${i}/${samples}] Tie`);
    }
  } catch (err) {
    if (err && (err.killed || err.signal === 'SIGTERM')) {
      timedOut++;
      logProgress(`[${i}/${samples}] Timed out`);
      continue;
    }

    // If the child failed for other reasons, keep going but count as timed out/failed.
    timedOut++;
    logProgress(`[${i}/${samples}] Failed`);
  }
}

const elapsed = (Date.now() - start) / 1000;

const summary = {
  requestedSamples: samples,
  completed,
  timedOut,
  targetScore,
  team1Difficulty,
  team2Difficulty,
  team1Wins,
  team2Wins,
  ties,
  avgHands: completed > 0 ? totalHands / completed : 0,
  avgMargin: completed > 0 ? totalMargin / completed : 0,
  avgTeam1Score: completed > 0 ? totalTeam1Score / completed : 0,
  avgTeam2Score: completed > 0 ? totalTeam2Score / completed : 0,
  handMetrics,
  elapsedSeconds: elapsed,
  results
};

if (JSON_MODE) {
  console.log(JSON.stringify(summary));
  process.exit(0);
}

console.log('=== Spades AI Pooled Benchmark ===');
console.log(`Requested samples: ${samples}`);
console.log(`Completed: ${completed}`);
console.log(`Timed out/failed: ${timedOut}`);
console.log(`Target score: ${targetScore}`);
console.log(`Team 1 difficulty: ${team1Difficulty}`);
console.log(`Team 2 difficulty: ${team2Difficulty}`);
console.log(`Team 1 wins: ${team1Wins} (${completed > 0 ? ((team1Wins / completed) * 100).toFixed(1) : '0.0'}%)`);
console.log(`Team 2 wins: ${team2Wins} (${completed > 0 ? ((team2Wins / completed) * 100).toFixed(1) : '0.0'}%)`);
console.log(`Ties: ${ties}`);
console.log(`Average hands per game: ${summary.avgHands.toFixed(2)}`);
console.log(`Average score margin (Team1-Team2): ${summary.avgMargin.toFixed(2)}`);

const m1 = handMetrics.team1;
const m2 = handMetrics.team2;
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');
const per = (a, b) => (b > 0 ? (a / b).toFixed(2) : 'n/a');
console.log('--- Hand Metrics (contract accuracy & bags) ---');
console.log(`Team 1 (${team1Difficulty}): hands ${m1.hands} | contract-make ${pct(m1.contractsMade, m1.hands)} | sets ${m1.sets} | bags/hand ${per(m1.bagsTaken, m1.hands)} | bag penalties ${m1.bagPenalties} | nil ${m1.nilSuccesses}/${m1.nilSuccesses + m1.nilFails}`);
console.log(`Team 2 (${team2Difficulty}): hands ${m2.hands} | contract-make ${pct(m2.contractsMade, m2.hands)} | sets ${m2.sets} | bags/hand ${per(m2.bagsTaken, m2.hands)} | bag penalties ${m2.bagPenalties} | nil ${m2.nilSuccesses}/${m2.nilSuccesses + m2.nilFails}`);
console.log('--- Set Margin (how many tricks short when set) ---');
console.log(`Team 1 (${team1Difficulty}): total sets ${m1.sets} | short by 1: ${m1.setsShort1} (${pct(m1.setsShort1, m1.sets)}) | short by 2: ${m1.setsShort2} (${pct(m1.setsShort2, m1.sets)}) | short by 3+: ${m1.setsShort3plus} (${pct(m1.setsShort3plus, m1.sets)})`);
console.log(`Team 2 (${team2Difficulty}): total sets ${m2.sets} | short by 1: ${m2.setsShort1} (${pct(m2.setsShort1, m2.sets)}) | short by 2: ${m2.setsShort2} (${pct(m2.setsShort2, m2.sets)}) | short by 3+: ${m2.setsShort3plus} (${pct(m2.setsShort3plus, m2.sets)})`);
console.log(`Elapsed: ${elapsed.toFixed(2)}s`);

import { aiLearning } from '../stats/AILearning.js';
import {
  generateCandidatePool,
  normalizeProfile,
  runSymmetricBenchmark,
  scoreCandidatePerformance
} from './ai_training_lib.js';

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

const iterations = toInt(process.argv[2], 8);
const samplesPerSide = toInt(process.argv[3], 8);
const targetScore = toInt(process.argv[4], 333);
const timeoutMs = toInt(process.argv[5], 90000);
const candidatesPerIteration = toInt(process.argv[6], 6);
const confirmSamplesPerSide = toInt(process.argv[7], Math.max(12, samplesPerSide + 4));

const applyMode = hasFlag('--apply');
const jsonMode = hasFlag('--json');

const minWinRate = 0.55;
const minWinRateDelta = 0.03;
const minScoreDelta = 0.02;

function print(line) {
  if (!jsonMode) {
    console.log(line);
  }
}

const incumbent = normalizeProfile(aiLearning.getHardProfile());

const baseline = runSymmetricBenchmark({
  samplesPerSide,
  targetScore,
  candidateDifficulty: 'hard',
  opponentDifficulty: 'medium',
  candidateProfile: incumbent,
  timeoutMs
});

const baselineScore = scoreCandidatePerformance(baseline);
let best = null;

print('=== Hard vs Medium Coach ===');
print(`Mode: ${applyMode ? 'apply' : 'recommend'}`);
print(`Baseline win rate: ${(baseline.candidateWinRate * 100).toFixed(1)}%`);
print(`Baseline score: ${baselineScore.toFixed(3)}`);

for (let iteration = 1; iteration <= iterations; iteration++) {
  const pool = generateCandidatePool(incumbent, iteration, candidatesPerIteration);

  for (let index = 0; index < pool.length; index++) {
    const candidate = pool[index];
    const summary = runSymmetricBenchmark({
      samplesPerSide,
      targetScore,
      candidateDifficulty: 'hard',
      opponentDifficulty: 'medium',
      candidateProfile: candidate,
      timeoutMs
    });

    const score = scoreCandidatePerformance(summary);
    const scoreDelta = score - baselineScore;
    const winRateDelta = summary.candidateWinRate - baseline.candidateWinRate;

    const evaluation = {
      kind: 'medium-coach-candidate',
      iteration,
      candidateIndex: index + 1,
      baselineProfile: incumbent,
      baselineWinRate: baseline.candidateWinRate,
      baselineScore,
      candidate,
      summary,
      score,
      scoreDelta,
      winRateDelta,
      targetScore,
      samplesPerSide
    };

    aiLearning.recordEvaluation(evaluation);

    if (!best || score > best.score) {
      best = {
        ...evaluation
      };
    }

    print(
      `[${iteration}/${iterations}][${index + 1}/${pool.length}] ` +
      `win ${(summary.candidateWinRate * 100).toFixed(1)}% ` +
      `delta ${(winRateDelta * 100).toFixed(1)}pp ` +
      `score ${score.toFixed(3)}`
    );
  }
}

let confirmation = null;
let accepted = false;
let updatedProfile = null;

if (best) {
  const primaryGate =
    best.summary.candidateWinRate >= minWinRate &&
    best.winRateDelta >= minWinRateDelta &&
    best.scoreDelta >= minScoreDelta;

  if (primaryGate) {
    confirmation = runSymmetricBenchmark({
      samplesPerSide: confirmSamplesPerSide,
      targetScore,
      candidateDifficulty: 'hard',
      opponentDifficulty: 'medium',
      candidateProfile: best.candidate,
      timeoutMs
    });

    const confirmScore = scoreCandidatePerformance(confirmation);
    const confirmWinRateDelta = confirmation.candidateWinRate - baseline.candidateWinRate;
    accepted =
      confirmation.candidateWinRate >= minWinRate &&
      confirmWinRateDelta >= (minWinRateDelta - 0.005) &&
      (confirmScore - baselineScore) >= (minScoreDelta - 0.005);
  }

  if (accepted && applyMode) {
    updatedProfile = normalizeProfile(
      aiLearning.updateHardProfile(best.candidate, {
        source: 'medium-coach',
        learningGeneration: (incumbent.learningGeneration || 0) + 1
      })
    );
  }
}

const result = {
  mode: applyMode ? 'apply' : 'recommend',
  iterations,
  samplesPerSide,
  confirmSamplesPerSide,
  targetScore,
  baselineProfile: incumbent,
  baselineWinRate: baseline.candidateWinRate,
  baselineScore,
  bestCandidate: best ? {
    iteration: best.iteration,
    candidateIndex: best.candidateIndex,
    profile: best.candidate,
    winRate: best.summary.candidateWinRate,
    score: best.score,
    winRateDelta: best.winRateDelta,
    scoreDelta: best.scoreDelta
  } : null,
  confirmation: confirmation ? {
    winRate: confirmation.candidateWinRate,
    score: scoreCandidatePerformance(confirmation),
    wins: confirmation.candidateWins,
    losses: confirmation.opponentWins,
    ties: confirmation.ties
  } : null,
  accepted,
  applied: Boolean(updatedProfile),
  updatedProfile,
  thresholds: {
    minWinRate,
    minWinRateDelta,
    minScoreDelta
  }
};

aiLearning.recordSelfPlayRun({
  kind: 'medium-coach-run',
  ...result
});

if (jsonMode) {
  console.log(JSON.stringify(result));
} else {
  print('=== Coach Result ===');
  print(`Best candidate win rate: ${best ? (best.summary.candidateWinRate * 100).toFixed(1) : 'n/a'}%`);
  print(`Accepted: ${accepted ? 'yes' : 'no'}`);
  print(`Applied: ${updatedProfile ? 'yes' : 'no'}`);
  if (updatedProfile) {
    print(`Updated hard profile: ${JSON.stringify(updatedProfile)}`);
  } else if (best) {
    print(`Recommended profile: ${JSON.stringify(best.candidate)}`);
  }
}

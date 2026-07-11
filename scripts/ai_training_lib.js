import { execFileSync } from 'node:child_process';

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function getWinRate(summary, teamKey = 'team1') {
  const wins = teamKey === 'team2' ? summary.team2Wins : summary.team1Wins;
  return summary.completed > 0 ? wins / summary.completed : 0;
}

export function normalizeProfile(profile = {}) {
  return {
    trials: Math.max(50, Math.round(profile.trials ?? profile.monteCarloTrials ?? 1200)),
    riskAversion: round(clamp(profile.riskAversion ?? 0.38, 0.05, 0.98)),
    aggressiveness: round(clamp(profile.aggressiveness ?? 0.82, 0.05, 0.98)),
    nilBidThreshold: round(clamp(profile.nilBidThreshold ?? 0.82, 0.4, 0.98)),
    bidAdjustment: round(clamp(profile.bidAdjustment ?? 0, -1.5, 1.5))
  };
}

export function mutateProfile(baseProfile, intensity = 1) {
  const base = normalizeProfile(baseProfile);
  const trialStep = [0, 50, 100, 150][Math.floor(Math.random() * 4)] * intensity;
  const signed = () => (Math.random() < 0.5 ? -1 : 1);

  const candidate = {
    trials: Math.max(100, base.trials + signed() * trialStep),
    riskAversion: clamp(base.riskAversion + signed() * (0.015 + Math.random() * 0.035) * intensity, 0.08, 0.9),
    aggressiveness: clamp(base.aggressiveness + signed() * (0.015 + Math.random() * 0.04) * intensity, 0.15, 0.95),
    nilBidThreshold: clamp(base.nilBidThreshold + signed() * (0.005 + Math.random() * 0.025) * intensity, 0.55, 0.95),
    bidAdjustment: clamp(base.bidAdjustment + signed() * (0.05 + Math.random() * 0.15) * intensity, -0.75, 0.75)
  };

  return normalizeProfile(candidate);
}

export function generateCandidatePool(baseProfile, generation = 1, poolSize = 6) {
  const base = normalizeProfile(baseProfile);
  const intensity = generation <= 8 ? 1.35 : generation <= 20 ? 1.0 : 0.7;
  const pool = [];

  const archetypes = [
    {
      ...base,
      aggressiveness: clamp(base.aggressiveness + 0.08 * intensity, 0.15, 0.95),
      riskAversion: clamp(base.riskAversion - 0.06 * intensity, 0.08, 0.9),
      bidAdjustment: clamp(base.bidAdjustment + 0.15 * intensity, -0.75, 0.75)
    },
    {
      ...base,
      trials: base.trials + Math.round(200 * intensity),
      aggressiveness: clamp(base.aggressiveness + 0.03 * intensity, 0.15, 0.95),
      nilBidThreshold: clamp(base.nilBidThreshold + 0.02 * intensity, 0.55, 0.95)
    },
    {
      ...base,
      riskAversion: clamp(base.riskAversion - 0.03 * intensity, 0.08, 0.9),
      nilBidThreshold: clamp(base.nilBidThreshold - 0.03 * intensity, 0.55, 0.95),
      bidAdjustment: clamp(base.bidAdjustment + 0.08 * intensity, -0.75, 0.75)
    }
  ].map(normalizeProfile);

  for (const archetype of archetypes) {
    pool.push(archetype);
  }

  while (pool.length < poolSize) {
    pool.push(mutateProfile(base, intensity));
  }

  return pool;
}

export function aggregateHandMetrics(metrics = {}) {
  const team1 = metrics.team1 || {};
  const team2 = metrics.team2 || {};
  return {
    hands: team1.hands || 0,
    contractsMade: team1.contractsMade || 0,
    sets: team1.sets || 0,
    bagsTaken: team1.bagsTaken || 0,
    bagPenalties: team1.bagPenalties || 0,
    nilSuccesses: (team1.nilSuccesses || 0) + (team1.blindNilSuccesses || 0),
    nilFails: (team1.nilFails || 0) + (team1.blindNilFails || 0),
    opponentSets: team2.sets || 0,
    opponentBagPenalties: team2.bagPenalties || 0
  };
}

export function scoreCandidatePerformance(summary) {
  const hand = summary.candidateHandMetrics || aggregateHandMetrics(summary.forward?.handMetrics || summary.handMetrics || {});
  const setRate = hand.hands > 0 ? hand.sets / hand.hands : 0;
  const opponentSetRate = hand.hands > 0 ? hand.opponentSets / hand.hands : 0;
  const bagPenaltyRate = hand.hands > 0 ? hand.bagPenalties / hand.hands : 0;
  const nilFailRate = hand.hands > 0 ? hand.nilFails / hand.hands : 0;

  return (
    summary.candidateWinRate * 1.0 +
    (summary.avgCandidateMargin || 0) / 1200 +
    opponentSetRate * 0.18 -
    setRate * 0.22 -
    bagPenaltyRate * 0.08 -
    nilFailRate * 0.08
  );
}

export function runPooledBenchmark({
  samples = 20,
  targetScore = 333,
  team1Difficulty = 'hard',
  team2Difficulty = 'hard',
  team1Profile = null,
  team2Profile = null,
  timeoutMs = 180000
} = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    BENCHMARK_FAST: process.env.BENCHMARK_FAST || '1',
    BENCHMARK_JSON: '1'
  };

  if (team1Profile) {
    env.BENCHMARK_TEAM1_PROFILE_JSON = JSON.stringify(normalizeProfile(team1Profile));
  }
  if (team2Profile) {
    env.BENCHMARK_TEAM2_PROFILE_JSON = JSON.stringify(normalizeProfile(team2Profile));
  }

  const processTimeoutMs = Math.max(timeoutMs + (samples * 45000), timeoutMs + 90000);

  const output = execFileSync(
    process.execPath,
    ['scripts/benchmark_ai_pool.js', String(samples), String(targetScore), team1Difficulty, team2Difficulty, String(timeoutMs)],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
      timeout: processTimeoutMs
    }
  );

  return JSON.parse(output);
}

export function runSymmetricBenchmark({
  samplesPerSide = 10,
  targetScore = 333,
  candidateDifficulty = 'hard',
  opponentDifficulty = 'hard',
  candidateProfile = null,
  opponentProfile = null,
  timeoutMs = 180000
} = {}) {
  const forward = runPooledBenchmark({
    samples: samplesPerSide,
    targetScore,
    team1Difficulty: candidateDifficulty,
    team2Difficulty: opponentDifficulty,
    team1Profile: candidateProfile,
    team2Profile: opponentProfile,
    timeoutMs
  });

  const reverse = runPooledBenchmark({
    samples: samplesPerSide,
    targetScore,
    team1Difficulty: opponentDifficulty,
    team2Difficulty: candidateDifficulty,
    team1Profile: opponentProfile,
    team2Profile: candidateProfile,
    timeoutMs
  });

  const candidateWins = forward.team1Wins + reverse.team2Wins;
  const opponentWins = forward.team2Wins + reverse.team1Wins;
  const ties = forward.ties + reverse.ties;
  const completed = forward.completed + reverse.completed;

  const candidateMargins = [
    ...forward.results.map(r => r.margin),
    ...reverse.results.map(r => -r.margin)
  ];

  const candidateHands = [
    ...forward.results.map(r => r.handsPlayed || 0),
    ...reverse.results.map(r => r.handsPlayed || 0)
  ];

  const avgCandidateMargin = candidateMargins.length > 0
    ? candidateMargins.reduce((sum, value) => sum + value, 0) / candidateMargins.length
    : 0;

  const avgHands = candidateHands.length > 0
    ? candidateHands.reduce((sum, value) => sum + value, 0) / candidateHands.length
    : 0;

  const candidateHandMetrics = {
    hands: (forward.handMetrics?.team1?.hands || 0) + (reverse.handMetrics?.team2?.hands || 0),
    contractsMade: (forward.handMetrics?.team1?.contractsMade || 0) + (reverse.handMetrics?.team2?.contractsMade || 0),
    sets: (forward.handMetrics?.team1?.sets || 0) + (reverse.handMetrics?.team2?.sets || 0),
    bagsTaken: (forward.handMetrics?.team1?.bagsTaken || 0) + (reverse.handMetrics?.team2?.bagsTaken || 0),
    bagPenalties: (forward.handMetrics?.team1?.bagPenalties || 0) + (reverse.handMetrics?.team2?.bagPenalties || 0),
    nilSuccesses: ((forward.handMetrics?.team1?.nilSuccesses || 0) + (forward.handMetrics?.team1?.blindNilSuccesses || 0)) + ((reverse.handMetrics?.team2?.nilSuccesses || 0) + (reverse.handMetrics?.team2?.blindNilSuccesses || 0)),
    nilFails: ((forward.handMetrics?.team1?.nilFails || 0) + (forward.handMetrics?.team1?.blindNilFails || 0)) + ((reverse.handMetrics?.team2?.nilFails || 0) + (reverse.handMetrics?.team2?.blindNilFails || 0)),
    opponentSets: (forward.handMetrics?.team2?.sets || 0) + (reverse.handMetrics?.team1?.sets || 0),
    opponentBagPenalties: (forward.handMetrics?.team2?.bagPenalties || 0) + (reverse.handMetrics?.team1?.bagPenalties || 0)
  };

  return {
    samplesPerSide,
    targetScore,
    candidateDifficulty,
    opponentDifficulty,
    completed,
    candidateWins,
    opponentWins,
    ties,
    candidateWinRate: completed > 0 ? candidateWins / completed : 0,
    avgCandidateMargin,
    avgHands,
    candidateHandMetrics,
    handMetrics: {
      team1: forward.handMetrics?.team1,
      team2: forward.handMetrics?.team2,
      reverseTeam1: reverse.handMetrics?.team1,
      reverseTeam2: reverse.handMetrics?.team2
    },
    forward,
    reverse
  };
}

import { aiLearning } from '../stats/AILearning.js';
import { generateCandidatePool, normalizeProfile, runSymmetricBenchmark, scoreCandidatePerformance } from './ai_training_lib.js';

const iterations = Number.parseInt(process.argv[2] || '40', 10);
const selfPlaySamples = Number.parseInt(process.argv[3] || '8', 10);
const targetScore = Number.parseInt(process.argv[4] || '333', 10);
const mediumSamples = Number.parseInt(process.argv[5] || '8', 10);
const timeoutMs = Number.parseInt(process.argv[6] || '180000', 10);
const finalSamples = Number.parseInt(process.argv[7] || '4', 10);
const candidatesPerIteration = Number.parseInt(process.argv[8] || '6', 10);
const mediumProbeSamples = Math.max(mediumSamples, 8);
const promotionValidationSamples = Math.max(mediumSamples + 4, 10);
const effectiveTimeoutMs = Math.min(timeoutMs, 90000);

let incumbent = normalizeProfile(aiLearning.getHardProfile());
let incumbentVsMedium = runSymmetricBenchmark({
  samplesPerSide: mediumSamples,
  targetScore,
  candidateDifficulty: 'hard',
  opponentDifficulty: 'medium',
  candidateProfile: incumbent,
  timeoutMs: effectiveTimeoutMs
});

aiLearning.recordSelfPlayRun({
  kind: 'training-baseline',
  targetScore,
  selfPlaySamples,
  mediumSamples,
  incumbent,
  incumbentVsMedium
});

console.log('=== Hard AI Training ===');
console.log(`Starting profile: ${JSON.stringify(incumbent)}`);
console.log(`Baseline hard vs medium: ${(incumbentVsMedium.candidateWinRate * 100).toFixed(1)}%`);

for (let iteration = 1; iteration <= iterations; iteration++) {
  const pool = generateCandidatePool(incumbent, iteration, candidatesPerIteration);
  let best = null;

  for (let index = 0; index < pool.length; index++) {
    const candidate = pool[index];
    const selfPlaySummary = runSymmetricBenchmark({
      samplesPerSide: selfPlaySamples,
      targetScore,
      candidateDifficulty: 'hard',
      opponentDifficulty: 'hard',
      candidateProfile: candidate,
      opponentProfile: incumbent,
      timeoutMs: effectiveTimeoutMs
    });

    const selfPlayScore = scoreCandidatePerformance(selfPlaySummary);
    const shouldProbeMedium = selfPlaySummary.candidateWinRate >= 0.52 || selfPlayScore >= 0.56;
    let candidateVsMedium = null;
    let mediumScore = -Infinity;

    if (shouldProbeMedium) {
      candidateVsMedium = runSymmetricBenchmark({
        samplesPerSide: mediumProbeSamples,
        targetScore,
        candidateDifficulty: 'hard',
        opponentDifficulty: 'medium',
        candidateProfile: candidate,
        timeoutMs: effectiveTimeoutMs
      });
      mediumScore = scoreCandidatePerformance(candidateVsMedium);
    }

    const combinedScore = selfPlayScore * 0.45 + mediumScore * 0.55;
    const evaluation = {
      kind: 'training-candidate',
      iteration,
      candidateIndex: index + 1,
      incumbent,
      candidate,
      selfPlaySummary,
      candidateVsMedium,
      selfPlayScore,
      mediumScore,
      combinedScore,
      mediumProbeSamples
    };

    aiLearning.recordEvaluation(evaluation);

    if (!best || combinedScore > best.combinedScore) {
      best = { ...evaluation };
    }

    console.log(
      `[${iteration}/${iterations}][${index + 1}/${pool.length}] self ${(selfPlaySummary.candidateWinRate * 100).toFixed(1)}%` +
      `${candidateVsMedium ? ` | medium ${(candidateVsMedium.candidateWinRate * 100).toFixed(1)}%` : ''}` +
      ` | score ${combinedScore.toFixed(3)}`
    );
  }

  const incumbentMediumScore = scoreCandidatePerformance(incumbentVsMedium);
  const incumbentCombinedScore = incumbentMediumScore * 0.55 + 0.5 * 0.45;
  const passesPrimaryGate = !!best &&
    !!best.candidateVsMedium &&
    best.selfPlaySummary.candidateWinRate >= 0.52 &&
    best.candidateVsMedium.candidateWinRate >= 0.55 &&
    best.candidateVsMedium.candidateWinRate >= (incumbentVsMedium.candidateWinRate + 0.03) &&
    best.mediumScore >= (incumbentMediumScore + 0.02) &&
    best.combinedScore >= (incumbentCombinedScore + 0.02);

  let promotionValidation = null;
  let accepted = false;

  if (passesPrimaryGate) {
    promotionValidation = runSymmetricBenchmark({
      samplesPerSide: promotionValidationSamples,
      targetScore,
      candidateDifficulty: 'hard',
      opponentDifficulty: 'medium',
      candidateProfile: best.candidate,
      timeoutMs: effectiveTimeoutMs
    });

    const confirmWinRate = promotionValidation.candidateWinRate;
    const requiredConfirmWinRate = Math.max(0.55, incumbentVsMedium.candidateWinRate + 0.02);
    accepted = confirmWinRate >= requiredConfirmWinRate;
  }

  console.log(
    `[${iteration}/${iterations}] best self ${(best.selfPlaySummary.candidateWinRate * 100).toFixed(1)}%` +
    ` | best medium ${best.candidateVsMedium ? (best.candidateVsMedium.candidateWinRate * 100).toFixed(1) : 'n/a'}%` +
    `${promotionValidation ? ` | confirm ${(promotionValidation.candidateWinRate * 100).toFixed(1)}%` : ''}` +
    ` | ${accepted ? 'PROMOTED' : 'rejected'}`
  );

  if (accepted) {
    const updated = aiLearning.updateHardProfile(best.candidate, {
      source: 'self-play-training',
      learningGeneration: (incumbent.learningGeneration || 0) + 1
    });

    incumbent = normalizeProfile(updated);
    incumbentVsMedium = promotionValidation || best.candidateVsMedium;

    aiLearning.recordSelfPlayRun({
      kind: 'promotion',
      iteration,
      targetScore,
      selfPlaySamples,
      mediumSamples,
      mediumProbeSamples,
      promotionValidationSamples,
      hardProfile: incumbent,
      selfPlaySummary: best.selfPlaySummary,
      candidateVsMedium: best.candidateVsMedium,
      promotionValidation,
      combinedScore: best.combinedScore
    });
  }
}

const finalMirror = runSymmetricBenchmark({
  samplesPerSide: Math.max(selfPlaySamples, finalSamples),
  targetScore,
  candidateDifficulty: 'hard',
  opponentDifficulty: 'hard',
  candidateProfile: incumbent,
  opponentProfile: incumbent,
  timeoutMs: effectiveTimeoutMs
});

const finalVsMedium = runSymmetricBenchmark({
  samplesPerSide: Math.max(mediumSamples, finalSamples),
  targetScore,
  candidateDifficulty: 'hard',
  opponentDifficulty: 'medium',
  candidateProfile: incumbent,
  timeoutMs: effectiveTimeoutMs
});

aiLearning.recordSelfPlayRun({
  kind: 'training-session-complete',
  iterations,
  targetScore,
  selfPlaySamples,
  mediumSamples,
  finalProfile: incumbent,
  finalMirror,
  finalVsMedium
});

console.log('=== Training Complete ===');
console.log(`Final profile: ${JSON.stringify(incumbent)}`);
console.log(`Final hard vs medium: ${(finalVsMedium.candidateWinRate * 100).toFixed(1)}%`);
console.log(`Final hard mirror sanity: ${(finalMirror.candidateWinRate * 100).toFixed(1)}%`);

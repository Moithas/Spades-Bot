import { aiLearning } from '../stats/AILearning.js';
import { normalizeProfile, runSymmetricBenchmark } from './ai_training_lib.js';

const samples = Number.parseInt(process.argv[2] || '20', 10);
const targetScore = Number.parseInt(process.argv[3] || '333', 10);
const timeoutMs = Number.parseInt(process.argv[4] || '180000', 10);

const hardProfile = normalizeProfile(aiLearning.getHardProfile());
const summary = runSymmetricBenchmark({
  samplesPerSide: samples,
  targetScore,
  candidateDifficulty: 'hard',
  opponentDifficulty: 'hard',
  candidateProfile: hardProfile,
  opponentProfile: hardProfile,
  timeoutMs
});

aiLearning.recordSelfPlayRun({
  kind: 'self-play-collection',
  samples,
  targetScore,
  hardProfile,
  summary
});

console.log('=== Hard Self-Play Collection ===');
console.log(`Samples per side: ${samples}`);
console.log(`Target score: ${targetScore}`);
console.log(`Candidate wins: ${summary.candidateWins}`);
console.log(`Opponent wins: ${summary.opponentWins}`);
console.log(`Ties: ${summary.ties}`);
console.log(`Average hands: ${summary.avgHands.toFixed(2)}`);
console.log(`Average candidate margin: ${summary.avgCandidateMargin.toFixed(2)}`);
console.log(`Symmetric win rate: ${(summary.candidateWinRate * 100).toFixed(1)}%`);

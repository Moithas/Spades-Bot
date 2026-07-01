import { aiHardTelemetryStore } from '../stats/AIHardTelemetry.js';

const snapshot = aiHardTelemetryStore.getSnapshot();
const rounds = snapshot.rounds || [];
const games = snapshot.games || [];

const lastRound = rounds[rounds.length - 1] || null;
const lastGame = games[games.length - 1] || null;

function sumBy(arr, key) {
  return arr.reduce((acc, item) => acc + (Number(item[key]) || 0), 0);
}

const totalOpportunities = sumBy(rounds.map(r => r.stats || {}), 'opportunities');
const totalLeadPlays = sumBy(rounds.map(r => r.stats || {}), 'leadPressurePlays');
const totalFollowCaptures = sumBy(rounds.map(r => r.stats || {}), 'followPressureCaptures');

console.log('=== Hard Set-Pressure Telemetry ===');
console.log(`Rounds stored: ${rounds.length}`);
console.log(`Games stored: ${games.length}`);
console.log(`Total opportunities: ${totalOpportunities}`);
console.log(`Total lead pressure plays: ${totalLeadPlays}`);
console.log(`Total follow pressure captures: ${totalFollowCaptures}`);

if (lastRound) {
  console.log('\n--- Last round record ---');
  console.log(`timestamp: ${lastRound.timestamp}`);
  console.log(`gameId: ${lastRound.gameId}`);
  console.log(`round: ${lastRound.round}`);
  console.log(`ai: ${lastRound.aiUsername} (team ${lastRound.aiTeam})`);
  console.log(`stats: ${JSON.stringify(lastRound.stats)}`);
}

if (lastGame) {
  console.log('\n--- Last game aggregate ---');
  console.log(`timestamp: ${lastGame.timestamp}`);
  console.log(`gameId: ${lastGame.gameId}`);
  console.log(`mode: ${lastGame.gameMode}`);
  console.log(`targetScore: ${lastGame.targetScore}`);
  console.log(`roundsPlayed: ${lastGame.roundsPlayed}`);
  console.log(`hardTotals: ${JSON.stringify(lastGame.hardTotals)}`);
}

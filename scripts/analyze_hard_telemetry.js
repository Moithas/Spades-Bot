import { aiHardTelemetryStore } from '../stats/AIHardTelemetry.js';

const snapshot = aiHardTelemetryStore.getSnapshot();
const rounds = Array.isArray(snapshot.rounds) ? snapshot.rounds : [];

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bucketBidGap(gap) {
  if (gap <= -3) return '<=-3';
  if (gap === -2) return '-2';
  if (gap === -1) return '-1';
  if (gap === 0) return '0';
  if (gap === 1) return '+1';
  if (gap === 2) return '+2';
  return '>=+3';
}

function bucketScoreState(diff) {
  if (!Number.isFinite(diff)) return 'unknown';
  if (diff >= 100) return 'leading_big';
  if (diff >= 25) return 'leading';
  if (diff > -25) return 'even';
  if (diff > -100) return 'trailing';
  return 'trailing_big';
}

function incrementGroup(map, key, stats) {
  if (!map.has(key)) {
    map.set(key, {
      rounds: 0,
      opportunities: 0,
      leadPressurePlays: 0,
      followPressureCaptures: 0,
      contractMet: 0,
      contractMissed: 0,
      contractOver: 0
    });
  }

  const item = map.get(key);
  item.rounds += 1;
  item.opportunities += asNumber(stats.opportunities);
  item.leadPressurePlays += asNumber(stats.leadPressurePlays);
  item.followPressureCaptures += asNumber(stats.followPressureCaptures);

  const bid = asNumber(stats.bid);
  const tricks = asNumber(stats.tricks);
  if (tricks > bid) item.contractOver += 1;
  else if (tricks === bid) item.contractMet += 1;
  else item.contractMissed += 1;
}

function toPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function printTable(title, rows, columns) {
  console.log(`\n=== ${title} ===`);
  if (rows.length === 0) {
    console.log('No data');
    return;
  }

  const widths = columns.map(col => {
    const maxData = Math.max(...rows.map(r => String(r[col.key]).length));
    return Math.max(col.label.length, maxData);
  });

  const header = columns
    .map((col, i) => String(col.label).padEnd(widths[i]))
    .join('  ');
  console.log(header);
  console.log(widths.map(w => '-'.repeat(w)).join('  '));

  for (const row of rows) {
    console.log(columns.map((col, i) => String(row[col.key]).padEnd(widths[i])).join('  '));
  }
}

const normalizedRounds = rounds.map(r => {
  const stats = r.stats || {};
  const bidGap = Number.isFinite(asNumber(r.bidGap, NaN))
    ? asNumber(r.bidGap, NaN)
    : (asNumber(stats.tricks) - asNumber(stats.bid));

  const scoreDiff = Number.isFinite(asNumber(r.scoreDiff, NaN))
    ? asNumber(r.scoreDiff, NaN)
    : NaN;

  return {
    ...r,
    stats,
    seat: r.seat || 'unknown',
    bidGap,
    bidGapBucket: r.bidGapBucket || bucketBidGap(bidGap),
    scoreState: r.scoreState || bucketScoreState(scoreDiff)
  };
});

const bySeat = new Map();
const byScoreState = new Map();
const byBidGap = new Map();

for (const round of normalizedRounds) {
  const stats = round.stats;
  incrementGroup(bySeat, `seat_${round.seat}`, stats);
  incrementGroup(byScoreState, round.scoreState, stats);
  incrementGroup(byBidGap, round.bidGapBucket, stats);
}

function mapToRows(groupMap, labelField) {
  return [...groupMap.entries()]
    .map(([key, value]) => {
      const pressureActions = value.leadPressurePlays + value.followPressureCaptures;
      return {
        [labelField]: key,
        rounds: value.rounds,
        opps: value.opportunities,
        lead: value.leadPressurePlays,
        follow: value.followPressureCaptures,
        pressureActionRate: toPercent(pressureActions, value.opportunities),
        contractMissRate: toPercent(value.contractMissed, value.rounds)
      };
    })
    .sort((a, b) => b.rounds - a.rounds);
}

const seatRows = mapToRows(bySeat, 'seat');
const scoreRows = mapToRows(byScoreState, 'scoreState');

const bidGapOrder = ['<=-3', '-2', '-1', '0', '+1', '+2', '>=+3'];
const bidRows = mapToRows(byBidGap, 'bidGapBucket').sort(
  (a, b) => bidGapOrder.indexOf(a.bidGapBucket) - bidGapOrder.indexOf(b.bidGapBucket)
);

const totalOpportunities = normalizedRounds.reduce((sum, r) => sum + asNumber(r.stats.opportunities), 0);
const totalLead = normalizedRounds.reduce((sum, r) => sum + asNumber(r.stats.leadPressurePlays), 0);
const totalFollow = normalizedRounds.reduce((sum, r) => sum + asNumber(r.stats.followPressureCaptures), 0);

console.log('=== Hard Telemetry Deep Analysis ===');
console.log(`Rounds analyzed: ${normalizedRounds.length}`);
console.log(`Games stored: ${(snapshot.games || []).length}`);
console.log(`Total opportunities: ${totalOpportunities}`);
console.log(`Total lead pressure plays: ${totalLead}`);
console.log(`Total follow pressure captures: ${totalFollow}`);

printTable('By Seat', seatRows, [
  { key: 'seat', label: 'seat' },
  { key: 'rounds', label: 'rounds' },
  { key: 'opps', label: 'opps' },
  { key: 'lead', label: 'lead' },
  { key: 'follow', label: 'follow' },
  { key: 'pressureActionRate', label: 'pressure_action_rate' },
  { key: 'contractMissRate', label: 'contract_miss_rate' }
]);

printTable('By Score State', scoreRows, [
  { key: 'scoreState', label: 'score_state' },
  { key: 'rounds', label: 'rounds' },
  { key: 'opps', label: 'opps' },
  { key: 'lead', label: 'lead' },
  { key: 'follow', label: 'follow' },
  { key: 'pressureActionRate', label: 'pressure_action_rate' },
  { key: 'contractMissRate', label: 'contract_miss_rate' }
]);

printTable('By Bid Gap', bidRows, [
  { key: 'bidGapBucket', label: 'bid_gap' },
  { key: 'rounds', label: 'rounds' },
  { key: 'opps', label: 'opps' },
  { key: 'lead', label: 'lead' },
  { key: 'follow', label: 'follow' },
  { key: 'pressureActionRate', label: 'pressure_action_rate' },
  { key: 'contractMissRate', label: 'contract_miss_rate' }
]);

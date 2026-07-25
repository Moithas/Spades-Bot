// Temporary analysis of human-vs-bot games from droplet telemetry.
import fs from 'node:fs';

const d = JSON.parse(fs.readFileSync('./stats/gameTelemetry.droplet.json', 'utf8').replace(/^\uFEFF/, ''));
const rounds = d.rounds || [];
const games = d.games || [];

console.log('Total rounds:', rounds.length, '| games:', games.length);

// Mixed = at least one human and one AI
const mixed = rounds.filter(r => (r.humanPlayerCount || 0) > 0 && (r.aiPlayerCount || 0) > 0);
console.log('Human+AI rounds:', mixed.length);

const byMode = {};
for (const r of mixed) byMode[r.gameMode || 'unknown'] = (byMode[r.gameMode || 'unknown'] || 0) + 1;
console.log('By mode:', JSON.stringify(byMode));

// Focus on classic mixed rounds
const classic = mixed.filter(r => (r.gameMode || 'classic') === 'classic');
console.log('\n=== CLASSIC human+AI rounds:', classic.length, '===');

// Per-player analysis: bots vs humans
function bucket() {
  return { rounds: 0, underbids: 0, exact: 0, overbids: 0, totalBidGap: 0, totalBid: 0, totalTricks: 0,
           nilBids: 0, nilMade: 0, sumOvertricks: 0 };
}
const bots = bucket();
const humans = bucket();

for (const r of classic) {
  for (const p of (r.players || [])) {
    const b = p.isAI ? bots : humans;
    b.rounds++;
    const bid = p.bid ?? 0;
    const tricks = p.tricks ?? 0;
    const gap = tricks - bid;
    b.totalBid += bid;
    b.totalTricks += tricks;
    b.totalBidGap += gap;
    if (p.nilBid && !p.blindNilBid) {
      b.nilBids++;
      if (tricks === 0) b.nilMade++;
    } else {
      if (gap < 0) b.underbids++;      // set (didn't make bid)
      else if (gap === 0) b.exact++;
      else { b.overbids++; b.sumOvertricks += gap; } // overtricks => bags
    }
  }
}

function report(name, b) {
  const nonNil = b.underbids + b.exact + b.overbids;
  console.log(`\n--- ${name} (player-rounds: ${b.rounds}) ---`);
  console.log(`  set(under bid): ${b.underbids} (${(100*b.underbids/nonNil).toFixed(1)}%)`);
  console.log(`  exact:          ${b.exact} (${(100*b.exact/nonNil).toFixed(1)}%)`);
  console.log(`  overtrick(bags):${b.overbids} (${(100*b.overbids/nonNil).toFixed(1)}%)`);
  console.log(`  avg bidGap (tricks-bid): ${(b.totalBidGap/b.rounds).toFixed(2)}`);
  console.log(`  avg bid: ${(b.totalBid/b.rounds).toFixed(2)} | avg tricks: ${(b.totalTricks/b.rounds).toFixed(2)}`);
  console.log(`  total overtricks(bags) generated: ${b.sumOvertricks} (avg ${(b.sumOvertricks/b.rounds).toFixed(2)}/round)`);
  console.log(`  nil bids: ${b.nilBids}, made: ${b.nilMade}${b.nilBids?' ('+(100*b.nilMade/b.nilBids).toFixed(1)+'%)':''}`);
}
report('BOTS (AI)', bots);
report('HUMANS', humans);

// Split bots by difficulty
console.log('\n=== BOTS by difficulty ===');
const byLevel = {};
for (const r of classic) for (const p of (r.players||[])) {
  if (!p.isAI) continue;
  const lvl = p.aiLevel || 'unknown';
  byLevel[lvl] = byLevel[lvl] || bucket();
  const b = byLevel[lvl];
  b.rounds++;
  const bid = p.bid ?? 0, tricks = p.tricks ?? 0, gap = tricks - bid;
  b.totalBid += bid; b.totalTricks += tricks; b.totalBidGap += gap;
  if (p.nilBid && !p.blindNilBid) { b.nilBids++; if (tricks===0) b.nilMade++; }
  else { if (gap<0) b.underbids++; else if (gap===0) b.exact++; else { b.overbids++; b.sumOvertricks+=gap; } }
}
for (const [lvl, b] of Object.entries(byLevel)) report('AI-' + lvl, b);

// Model: if each bot had bid +1 higher, how many would still make contract vs get set?
console.log('\n=== "Bid +1 higher" counterfactual (bots, non-nil) ===');
let stillMake = 0, wouldSet = 0, bagsAvoided = 0, totalNonNil = 0;
for (const r of classic) for (const p of (r.players||[])) {
  if (!p.isAI || (p.nilBid && !p.blindNilBid)) continue;
  totalNonNil++;
  const bid = (p.bid??0) + 1, tricks = p.tricks??0;
  if (tricks >= bid) { stillMake++; bagsAvoided += 1; } // one fewer overtrick becomes contracted
  else wouldSet++;
}
console.log(`non-nil bot rounds: ${totalNonNil}`);
console.log(`  bid+1 still makes: ${stillMake} (${(100*stillMake/totalNonNil).toFixed(1)}%)`);
console.log(`  bid+1 would set:   ${wouldSet} (${(100*wouldSet/totalNonNil).toFixed(1)}%)`);
console.log(`  (individual-bid model; team contracts pool bids so real set risk is lower)`);

// Bag accumulation per game (max bags observed per team-ish via player bags field)
console.log('\n=== Bag accumulation (bots) ===');
// bags field is per-player snapshot; look at distribution of overtricks per bot round
const overDist = {};
for (const r of classic) for (const p of (r.players||[])) {
  if (!p.isAI) continue;
  const gap = (p.tricks??0)-(p.bid??0);
  if (gap>0) overDist[gap]=(overDist[gap]||0)+1;
}
console.log('bot overtricks-per-round distribution:', JSON.stringify(overDist));

// Partner-nil scenarios: rounds where a bot had a partner on nil
console.log('\n=== Partner-nil scenarios (classic mixed) ===');
let nilRoundsWithBotPartner = 0;
for (const r of classic) {
  const players = r.players || [];
  const nilPlayers = players.filter(p => p.nilBid && !p.blindNilBid);
  for (const np of nilPlayers) {
    // partner = same team, different seat
    const partner = players.find(p => p.team === np.team && p.seat !== np.seat);
    if (partner && partner.isAI) {
      nilRoundsWithBotPartner++;
    }
  }
}
console.log('nil bids whose partner was a BOT (bot had chance to protect):', nilRoundsWithBotPartner);

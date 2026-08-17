// scripts/inspect_saved_games.js
// Prints a summary of stats/activeGames.json (persisted in-progress games).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(__dirname, '..', 'stats', 'activeGames.json');
try {
  const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const games = Object.values(d.games || {});
  console.log(`updatedAt: ${d.updatedAt}`);
  console.log(`saved games: ${games.length}`);
  for (const s of games) {
    const players = (s.players || []).map(p => `${p.username}${p.isAI ? '(AI)' : ''}[bid=${p.bid},tricks=${p.tricks}]`).join(', ');
    console.log(`- channel=${s.channelId} mode=${s.gameMode} state=${s.state} round=${s.currentRound} curIdx=${s.currentPlayerIndex} trickCards=${(s.trick || []).length}`);
    console.log(`  players: ${players}`);
  }
} catch (e) {
  console.error('inspect failed:', e.message);
  process.exit(1);
}

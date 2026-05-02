// view_global_stats.js - View aggregate statistics across all players
import fs from 'fs';

const STATS_FILE = './stats/playerData.json';

try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
    
    // Filter out metadata
    const players = Object.entries(data).filter(([key]) => key !== '_comment');
    
    // Aggregate stats
    let totalPlayers = players.length;
    let totalClassicGames = 0;
    let totalCutthroat3Games = 0;
    let totalCutthroat4Games = 0;
    let totalHands = 0;
    let totalNilBids = 0;
    let totalNilSuccesses = 0;
    let totalBlindNilBids = 0;
    let totalBlindNilSuccesses = 0;
    
    // Track active players (played in last 7 days)
    const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let activePlayers = 0;
    
    // Top players
    let topWinners = [];
    
    players.forEach(([id, player]) => {
        const stats = player.stats;
        if (!stats) return;
        
        // Classic mode
        if (stats.classic) {
            totalClassicGames += stats.classic.gamesPlayed || 0;
            totalHands += stats.classic.handsPlayed || 0;
            totalNilBids += stats.classic.nilBids || 0;
            totalNilSuccesses += stats.classic.nilSuccesses || 0;
            totalBlindNilBids += stats.classic.blindNilBids || 0;
            totalBlindNilSuccesses += stats.classic.blindNilSuccesses || 0;
        }
        
        // Cutthroat 3
        if (stats.cutthroat3) {
            totalCutthroat3Games += stats.cutthroat3.gamesPlayed || 0;
            totalHands += stats.cutthroat3.handsPlayed || 0;
            totalNilBids += stats.cutthroat3.nilBids || 0;
            totalNilSuccesses += stats.cutthroat3.nilSuccesses || 0;
        }
        
        // Cutthroat 4
        if (stats.cutthroat4) {
            totalCutthroat4Games += stats.cutthroat4.gamesPlayed || 0;
            totalHands += stats.cutthroat4.handsPlayed || 0;
        }
        
        // Check if active
        if (stats.lastPlayed) {
            const lastPlayed = new Date(stats.lastPlayed).getTime();
            if (lastPlayed > oneWeekAgo) {
                activePlayers++;
            }
        }
        
        // Calculate total wins for leaderboard
        const totalWins = (stats.classic?.gamesWon || 0) + 
                          (stats.cutthroat3?.gamesWon || 0) + 
                          (stats.cutthroat4?.gamesWon || 0);
        const totalGames = (stats.classic?.gamesPlayed || 0) + 
                           (stats.cutthroat3?.gamesPlayed || 0) + 
                           (stats.cutthroat4?.gamesPlayed || 0);
        
        if (totalGames > 0) {
            topWinners.push({
                username: player.username,
                wins: totalWins,
                games: totalGames,
                winRate: ((totalWins / totalGames) * 100).toFixed(1)
            });
        }
    });
    
    // Sort top winners
    topWinners.sort((a, b) => b.wins - a.wins);
    
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║           ♠️  SPADES BOT - GLOBAL STATISTICS  ♠️              ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  📊 Total Players:           ${String(totalPlayers).padStart(6)}                        ║`);
    console.log(`║  🟢 Active (last 7 days):    ${String(activePlayers).padStart(6)}                        ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                       GAMES PLAYED                           ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  🎴 Classic (4P Teams):      ${String(totalClassicGames).padStart(6)}                        ║`);
    console.log(`║  ⚔️  Cutthroat (3P):          ${String(totalCutthroat3Games).padStart(6)}                        ║`);
    console.log(`║  🎯 Cutthroat (4P):          ${String(totalCutthroat4Games).padStart(6)}                        ║`);
    console.log(`║  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                         ║`);
    console.log(`║  📈 Total Games:             ${String(totalClassicGames + totalCutthroat3Games + totalCutthroat4Games).padStart(6)}                        ║`);
    console.log(`║  🃏 Total Hands:             ${String(totalHands).padStart(6)}                        ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                       NIL STATISTICS                         ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  🎯 Nil Bids:                ${String(totalNilBids).padStart(6)}                        ║`);
    console.log(`║  ✅ Nil Successes:           ${String(totalNilSuccesses).padStart(6)} (${totalNilBids > 0 ? ((totalNilSuccesses/totalNilBids)*100).toFixed(1) : 0}%)                  ║`);
    console.log(`║  🎲 Blind Nil Bids:          ${String(totalBlindNilBids).padStart(6)}                        ║`);
    console.log(`║  ✅ Blind Nil Successes:     ${String(totalBlindNilSuccesses).padStart(6)} (${totalBlindNilBids > 0 ? ((totalBlindNilSuccesses/totalBlindNilBids)*100).toFixed(1) : 0}%)                  ║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log('║                     TOP 10 PLAYERS (by wins)                 ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    
    topWinners.slice(0, 10).forEach((player, index) => {
        const rank = `${index + 1}.`.padEnd(3);
        const name = player.username.substring(0, 15).padEnd(15);
        const wins = String(player.wins).padStart(3);
        const games = String(player.games).padStart(3);
        const rate = `${player.winRate}%`.padStart(6);
        console.log(`║  ${rank} ${name}  Wins: ${wins}/${games}  (${rate})          ║`);
    });
    
    console.log('╚══════════════════════════════════════════════════════════════╝\n');
    
} catch (err) {
    console.error('Error reading stats file:', err.message);
    console.log('\nMake sure you have the latest playerData.json from the server:');
    console.log('scp root@167.71.250.95:/root/spades-bot/stats/playerData.json ./stats/');
}

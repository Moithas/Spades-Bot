const fs = require('fs');

let content = fs.readFileSync('c:/Users/Brian/spades-bot/index.js', 'utf8');

// Fix corrupted emojis in setEmoji calls
content = content.replace(/\.setEmoji\('�'\)/g, (match, offset) => {
    // Check context around the match to determine which emoji to use
    const before = content.substring(Math.max(0, offset - 200), offset);
    
    if (before.includes('join_team') && before.includes(':1')) {
        return ".setEmoji('🟦')";
    } else if (before.includes('join_team') && before.includes(':2')) {
        return ".setEmoji('🟥')";
    }
    return match;
});

fs.writeFileSync('c:/Users/Brian/spades-bot/index.js', content, 'utf8');
console.log('Fixed button emojis!');

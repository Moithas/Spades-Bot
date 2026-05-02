// Test script to generate sample deck theme images
import { renderHand } from './game_logic/CardRenderer.js';
import fs from 'fs';

// Create fake card objects for all 4 aces
const aces = [
    { rankCode: 'A', suitCode: 'S', value: 14 }, // Ace of Spades
    { rankCode: 'A', suitCode: 'H', value: 14 }, // Ace of Hearts
    { rankCode: 'A', suitCode: 'C', value: 14 }, // Ace of Clubs
    { rankCode: 'A', suitCode: 'D', value: 14 }, // Ace of Diamonds
];

// Generate Classic theme
const classicBuffer = renderHand(aces, false, 'classic');
fs.writeFileSync('sample_classic.png', classicBuffer);
console.log('✅ Generated sample_classic.png');

// Generate Neon theme
const neonBuffer = renderHand(aces, false, 'neon');
fs.writeFileSync('sample_neon.png', neonBuffer);
console.log('✅ Generated sample_neon.png');

console.log('\n🎴 Sample images generated! Check sample_classic.png and sample_neon.png');

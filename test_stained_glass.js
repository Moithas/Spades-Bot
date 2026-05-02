import { createCanvas } from 'canvas';
import fs from 'fs';

// Stained glass theme - transparent suit symbols showing colorful geometric pattern beneath
const suits = [
    { 
        symbol: '♠', 
        name: 'Spades',
        patternColors: ['#4169E1', '#1E90FF', '#00BFFF', '#87CEEB', '#5F9EA0'], // Blues
        accentColor: '#FFD700' // Gold accent
    },
    { 
        symbol: '♥', 
        name: 'Hearts',
        patternColors: ['#DC143C', '#FF6347', '#FF4500', '#FF8C00', '#FFA500'], // Reds/oranges
        accentColor: '#FFD700' // Gold accent
    },
    { 
        symbol: '♦', 
        name: 'Diamonds',
        patternColors: ['#FFD700', '#FFA500', '#FF8C00', '#DAA520', '#B8860B'], // Golds
        accentColor: '#DC143C' // Red accent
    },
    { 
        symbol: '♣', 
        name: 'Clubs',
        patternColors: ['#228B22', '#32CD32', '#3CB371', '#2E8B57', '#20B2AA'], // Greens
        accentColor: '#4169E1' // Blue accent
    }
];

const fullCanvas = createCanvas(102 * 4 + 30, 142 + 20);
const fullCtx = fullCanvas.getContext('2d');

// Dark background
fullCtx.fillStyle = '#1a1a1a';
fullCtx.fillRect(0, 0, fullCanvas.width, fullCanvas.height);

suits.forEach((suit, index) => {
    const offsetX = index * (102 + 10) + 10;
    const offsetY = 10;
    
    fullCtx.save();
    fullCtx.translate(offsetX, offsetY);
    
    // Base glass background - light cream/white
    fullCtx.fillStyle = '#f5f5dc';
    fullCtx.fillRect(0, 0, 102, 142);
    
    // Draw intricate geometric pattern beneath (will show through transparent suit)
    const drawGeometricPattern = () => {
        // Create radial segments like rose window
        const centerX = 51;
        const centerY = 71;
        const segments = 12;
        const radius = 38; // Reduced further from 42 to make more room
        
        for (let i = 0; i < segments; i++) {
            const angle1 = (i / segments) * Math.PI * 2;
            const angle2 = ((i + 1) / segments) * Math.PI * 2;
            const colorIndex = i % suit.patternColors.length;
            
            // Draw triangular segment
            fullCtx.fillStyle = suit.patternColors[colorIndex];
            fullCtx.beginPath();
            fullCtx.moveTo(centerX, centerY);
            fullCtx.lineTo(centerX + Math.cos(angle1) * radius, centerY + Math.sin(angle1) * radius);
            fullCtx.lineTo(centerX + Math.cos(angle2) * radius, centerY + Math.sin(angle2) * radius);
            fullCtx.closePath();
            fullCtx.fill();
            
            // Lead lines
            fullCtx.strokeStyle = '#2a2a2a';
            fullCtx.lineWidth = 2;
            fullCtx.stroke();
            
            // Inner circle segments
            const innerRadius = 20; // Reduced from 22
            fullCtx.fillStyle = suit.patternColors[(colorIndex + 2) % suit.patternColors.length];
            fullCtx.beginPath();
            fullCtx.moveTo(centerX, centerY);
            fullCtx.lineTo(centerX + Math.cos(angle1) * innerRadius, centerY + Math.sin(angle1) * innerRadius);
            fullCtx.lineTo(centerX + Math.cos(angle2) * innerRadius, centerY + Math.sin(angle2) * innerRadius);
            fullCtx.closePath();
            fullCtx.fill();
            fullCtx.stroke();
        }
    };
    
    drawGeometricPattern();
    
    // Ornate border frame
    fullCtx.strokeStyle = '#8b7355';
    fullCtx.lineWidth = 4;
    fullCtx.strokeRect(2, 2, 98, 138);
    
    fullCtx.strokeStyle = '#d4a574';
    fullCtx.lineWidth = 2;
    fullCtx.strokeRect(5, 5, 92, 132);
    
    // Now draw the suit symbol as a "window" - cut out that shows pattern beneath
    // We'll use destination-out to create transparency, then redraw with semi-transparency
    
    // Top left rank (solid)
    fullCtx.fillStyle = '#2a2a2a';
    fullCtx.font = 'bold 24px Georgia, serif';
    fullCtx.textAlign = 'left';
    fullCtx.textBaseline = 'top';
    fullCtx.fillText('A', 6, 6);
    
    // Top left suit (solid, not transparent, centered under rank)
    fullCtx.fillStyle = '#2a2a2a';
    fullCtx.font = 'bold 22px Arial';
    fullCtx.textAlign = 'center'; // Center it
    fullCtx.fillText(suit.symbol, 16, 27); // Centered approximately under 'A'
    
    // Large center suit - like stained glass window showing colorful pattern
    fullCtx.font = 'bold 64px Arial';
    fullCtx.textAlign = 'center';
    fullCtx.textBaseline = 'middle';
    
    // Draw semi-transparent dark outline for depth
    fullCtx.globalAlpha = 0.25;
    fullCtx.fillStyle = '#000000';
    fullCtx.fillText(suit.symbol, 51, 68); // Moved up from 71 to 68
    
    // Dark lead outline
    fullCtx.globalAlpha = 1;
    fullCtx.strokeStyle = '#1a1a1a';
    fullCtx.lineWidth = 3;
    fullCtx.strokeText(suit.symbol, 51, 68);
    
    // Add subtle glow
    fullCtx.shadowColor = suit.accentColor;
    fullCtx.shadowBlur = 15;
    fullCtx.strokeText(suit.symbol, 51, 68);
    fullCtx.shadowBlur = 0;
    
    // Bottom right (rotated)
    fullCtx.save();
    fullCtx.translate(102 - 6, 142 - 6);
    fullCtx.rotate(Math.PI);
    fullCtx.font = 'bold 24px Georgia, serif';
    fullCtx.fillStyle = '#2a2a2a';
    fullCtx.textAlign = 'left';
    fullCtx.textBaseline = 'top';
    fullCtx.fillText('A', 0, 0);
    
    fullCtx.fillStyle = '#2a2a2a';
    fullCtx.font = 'bold 22px Arial';
    fullCtx.textAlign = 'center'; // Center it
    fullCtx.fillText(suit.symbol, 10, 21); // Centered approximately under 'A'
    fullCtx.restore();
    
    fullCtx.restore();
});

const buffer = fullCanvas.toBuffer('image/png');
fs.writeFileSync('stained_glass_sample.png', buffer);
console.log('✅ Stained glass aces saved to stained_glass_sample.png');

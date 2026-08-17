// game_logic/CardRenderer.js

import { createCanvas, loadImage, Image } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// --- Image-based (artwork) deck themes ---------------------------------------------------
// Some premium decks are full artwork (52 sliced card PNGs + a back image) rather than
// procedurally drawn. Their faces are preloaded once (synchronous decode) at module load and
// drawn at their native aspect ratio in the hand / trick / single-card renderers.
const __cardRendererDir = path.dirname(fileURLToPath(import.meta.url));
const THEMES_ASSET_ROOT = path.join(__cardRendererDir, '..', 'assets', 'themes');
const IMAGE_THEME_CONFIG = {
    alien: { dir: 'Alien' },
};
const IMAGE_THEMES = new Set(Object.keys(IMAGE_THEME_CONFIG));
const _imageRanks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
const _imageSuits = ['S', 'H', 'D', 'C'];
const _imageThemeFaces = new Map(); // theme -> Map<code, Image>
const _imageThemeBacks = new Map(); // theme -> Image

function _loadImageSync(p) {
    try {
        const img = new Image();
        img.src = fs.readFileSync(p);
        return img;
    } catch (e) {
        return null;
    }
}

function _preloadImageThemes() {
    for (const [theme, cfg] of Object.entries(IMAGE_THEME_CONFIG)) {
        try {
            const cardsDir = path.join(THEMES_ASSET_ROOT, cfg.dir, 'cards');
            const faces = new Map();
            for (const s of _imageSuits) {
                for (const r of _imageRanks) {
                    const code = r + s;
                    const img = _loadImageSync(path.join(cardsDir, `${code}.png`));
                    if (img) faces.set(code, img);
                }
            }
            _imageThemeFaces.set(theme, faces);
            const back = _loadImageSync(path.join(THEMES_ASSET_ROOT, cfg.dir, 'back.png'));
            if (back) _imageThemeBacks.set(theme, back);
        } catch (e) {
            // Missing assets → theme silently falls back to procedural rendering.
        }
    }
}
_preloadImageThemes();

/** True if `theme` is an artwork deck with its face images loaded. */
export function isImageTheme(theme) {
    return IMAGE_THEMES.has(theme) && _imageThemeFaces.has(theme) && _imageThemeFaces.get(theme).size > 0;
}
function _getImageFace(theme, rankCode, suitCode) {
    const m = _imageThemeFaces.get(theme);
    if (!m) return null;
    return m.get(`${rankCode}${suitCode}`) || null;
}
function _imageThemeAspect(theme) {
    const m = _imageThemeFaces.get(theme);
    const first = m && m.values().next().value;
    return first ? first.width / first.height : (102 / 143);
}

/** Draw an image clipped to a rounded rectangle (hides the art's square black corners). */
function _drawRoundedImage(ctx, img, x, y, w, h, radius) {
    const r = radius != null ? radius : Math.round(Math.min(w, h) * 0.09);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
}

// Render sizes for artwork decks (larger than the 102x143 procedural cards so the baked
// rank/suit pips stay readable).
const IMAGE_HAND_HEIGHT = 170;
const IMAGE_TRICK_HEIGHT = 140;

/** Compose an overlapped hand from an artwork theme's card images. Large hands (e.g. the
 *  17-card cutthroat hand) wrap into multiple rows so each card — and its baked rank/suit
 *  pip — stays large enough to read instead of being crushed into one long strip. */
function _renderImageHand(sortedCards, deckTheme) {
    const n = sortedCards.length;
    const cardHeight = IMAGE_HAND_HEIGHT;
    const aspect = _imageThemeAspect(deckTheme);
    const cardWidth = Math.round(cardHeight * aspect);
    const overlap = Math.round(cardWidth * 0.5);
    const rowGap = 12;

    // Split into balanced rows, at most ~9 cards per row.
    const maxPerRow = 9;
    const rows = Math.max(1, Math.ceil(n / maxPerRow));
    const perRow = Math.ceil(n / rows);
    const groups = [];
    for (let i = 0; i < n; i += perRow) groups.push(sortedCards.slice(i, i + perRow));

    const rowWidth = (g) => cardWidth + overlap * Math.max(0, g.length - 1);
    const totalWidth = Math.max(cardWidth, ...groups.map(rowWidth));
    const totalHeight = groups.length * cardHeight + rowGap * (groups.length - 1);

    const canvas = createCanvas(totalWidth, totalHeight);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, totalWidth, totalHeight);
    groups.forEach((g, ri) => {
        const y = ri * (cardHeight + rowGap);
        g.forEach((card, ci) => {
            const img = _getImageFace(deckTheme, card.rankCode, card.suitCode);
            const x = ci * overlap;
            if (img) _drawRoundedImage(ctx, img, x, y, cardWidth, cardHeight);
        });
    });
    return canvas.toBuffer('image/png');
}

/** Compose a side-by-side trick from an artwork theme's card images. */
function _renderImageTrick(cards, deckTheme) {
    const norm = cards.map(c => {
        if (!c) return {};
        if (c.rankCode || c.suitCode) return { rankCode: c.rankCode, suitCode: c.suitCode };
        if (c.card) return { rankCode: c.card.rankCode, suitCode: c.card.suitCode };
        return { rankCode: c.rank, suitCode: c.suit };
    });
    const cardHeight = IMAGE_TRICK_HEIGHT;
    const aspect = _imageThemeAspect(deckTheme);
    const cardWidth = Math.round(cardHeight * aspect);
    const spacing = 8;
    const totalWidth = (cardWidth * norm.length) + spacing * Math.max(0, norm.length - 1);
    const canvas = createCanvas(totalWidth, cardHeight);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, totalWidth, cardHeight);
    norm.forEach((card, i) => {
        const img = _getImageFace(deckTheme, card.rankCode, card.suitCode);
        const x = i * (cardWidth + spacing);
        if (img) _drawRoundedImage(ctx, img, x, 0, cardWidth, cardHeight);
    });
    return canvas.toBuffer('image/png');
}

/**
 * Deck theme definitions for custom card face styling
 */
const DECK_THEMES = {
    classic: {
        background: { start: '#FFFFFF', end: '#F8F9FA' },
        border: '#2C3E50',
        innerBorder: '#BDC3C7',
        font: 'Arial, sans-serif',
        faceFont: 'Georgia, serif',
        shadows: true
    },
    
    steampunk: {
        background: { start: '#D4A574', end: '#8B6F47' }, // Brass/copper tones
        border: '#4A3728',
        innerBorder: '#B8956A',
        font: '"Times New Roman", serif',
        faceFont: '"Times New Roman", serif',
        shadows: true,
        texture: 'gears'
    },
    
    minimalist: {
        background: { start: '#FFFFFF', end: '#FFFFFF' }, // Pure white
        border: '#000000',
        innerBorder: 'none',
        font: 'Arial, sans-serif',
        faceFont: 'Arial, sans-serif',
        shadows: false,
        simple: true
    },
    
    neon: {
        background: { start: '#0a0a0a', end: '#1a1a1a' }, // Dark background
        border: '#00ffff',
        innerBorder: '#ff00ff',
        font: 'Arial, sans-serif',
        faceFont: 'Arial, sans-serif',
        shadows: false,
        glow: true
    },
    
    medieval: {
        background: { start: '#F5E6D3', end: '#E8D5B7' }, // Parchment
        border: '#5C4033',
        innerBorder: '#8B7355',
        font: '"Palatino Linotype", serif',
        faceFont: '"Palatino Linotype", serif',
        shadows: true,
        ornate: true
    },
    
    holographic: {
        background: { 
            type: 'rainbow',
            colors: ['#FF00FF', '#00FFFF', '#FFFF00', '#00FF00', '#FF00FF', '#00FFFF']
        },
        border: '#C0C0C0',
        innerBorder: '#E8E8E8',
        font: 'Arial, sans-serif',
        faceFont: 'Arial, sans-serif',
        shadows: false,
        shimmer: true,
        suitGradients: {
            'S': {
                stops: [
                    [0, '#00FFFF'], [0.25, '#0080FF'], [0.5, '#8000FF'], 
                    [0.75, '#FF00C0'], [1, '#00FFFF']
                ],
                glow: '#00FFFF'
            },
            'H': {
                stops: [
                    [0, '#FFB6C1'], [0.1, '#FFD700'], [0.3, '#FF1493'], 
                    [0.5, '#FF00C0'], [0.7, '#9400D3'], [0.85, '#6A0DAD'], [1, '#FF1493']
                ],
                glow: '#FF00C0'
            },
            'D': {
                stops: [
                    [0, '#FFFF00'], [0.25, '#FFD700'], [0.5, '#FF8C00'], 
                    [0.75, '#FF4500'], [1, '#FFFF00']
                ],
                glow: '#FFD700'
            },
            'C': {
                stops: [
                    [0, '#00FF00'], [0.25, '#00CC66'], [0.5, '#009999'], 
                    [0.75, '#006666'], [1, '#00FF00']
                ],
                glow: '#00FF00'
            }
        }
    },
    
    cosmic: {
        background: { type: 'cosmic' }, // Deep space with stars and nebulae
        border: '#4169E1',
        innerBorder: '#9370DB',
        font: 'Arial, sans-serif',
        faceFont: 'Arial, sans-serif',
        shadows: false,
        cosmic: true,
        suitGradients: {
            'S': {
                stops: [
                    [0, '#E0FFFF'], [0.2, '#00CED1'], [0.4, '#4169E1'], 
                    [0.6, '#8A2BE2'], [0.8, '#9370DB'], [1, '#E0FFFF']
                ],
                glow: '#00CED1'
            },
            'H': {
                stops: [
                    [0, '#FFE4E1'], [0.2, '#FF69B4'], [0.4, '#FF1493'], 
                    [0.6, '#C71585'], [0.8, '#8B008B'], [1, '#FFE4E1']
                ],
                glow: '#FF1493'
            },
            'D': {
                stops: [
                    [0, '#FFFACD'], [0.2, '#FFD700'], [0.4, '#FFA500'], 
                    [0.6, '#FF8C00'], [0.8, '#FF4500'], [1, '#FFFACD']
                ],
                glow: '#FFD700'
            },
            'C': {
                stops: [
                    [0, '#E0FFE0'], [0.2, '#00FF7F'], [0.4, '#00FA9A'], 
                    [0.6, '#3CB371'], [0.8, '#2E8B57'], [1, '#E0FFE0']
                ],
                glow: '#00FF7F'
            }
        }
    },
    
    cyberpunk: {
        background: { type: 'cyberpunk' }, // Tech patterns with neon
        border: 'neon', // Will be suit-specific
        innerBorder: 'none',
        font: '"Courier New", monospace',
        faceFont: '"Courier New", monospace',
        shadows: false,
        cyberpunk: true,
        neonColors: {
            'S': '#00ffff', // Cyan
            'H': '#ff0080', // Hot pink
            'D': '#ffff00', // Yellow
            'C': '#00ff00'  // Lime
        },
        glitchColors: {
            'S': ['#00ffff', '#0080ff', '#00ff80', '#ff00ff'],
            'H': ['#ff0080', '#ff00ff', '#ff0040', '#ff4080'],
            'D': ['#ffff00', '#ffcc00', '#ff8800', '#ffaa00'],
            'C': ['#00ff00', '#00ff80', '#80ff00', '#00ffaa']
        },
        bgGradients: {
            'S': { start: '#0a0a0a', end: '#1a1a2e' },
            'H': { start: '#0a0a0a', end: '#2e1a1a' },
            'D': { start: '#0a0a0a', end: '#2e2a1a' },
            'C': { start: '#0a0a0a', end: '#1a2e1a' }
        }
    },
    
    christmas: {
        background: { type: 'christmas' }, // Frosted icy winter theme
        border: '#87CEEB', // Sky blue ice
        innerBorder: '#B0E0E6', // Powder blue
        font: 'Georgia, serif',
        faceFont: 'Georgia, serif',
        shadows: false,
        christmas: true,
        suitGradients: {
            'S': {
                stops: [
                    [0, '#E0FFFF'], [0.2, '#87CEEB'], [0.4, '#5DADE2'], 
                    [0.6, '#3498DB'], [0.8, '#2980B9'], [1, '#E0FFFF']
                ],
                glow: '#87CEEB'
            },
            'H': {
                stops: [
                    [0, '#D0D0D0'], [0.15, '#A8A8A8'], [0.35, '#808080'], 
                    [0.5, '#606060'], [0.65, '#808080'], [0.85, '#A8A8A8'], [1, '#D0D0D0']
                ],
                glow: '#A0A0A0'
            },
            'D': {
                stops: [
                    [0, '#C8C8C8'], [0.15, '#A0A0A0'], [0.35, '#787878'], 
                    [0.5, '#585858'], [0.65, '#787878'], [0.85, '#A0A0A0'], [1, '#C8C8C8']
                ],
                glow: '#909090'
            },
            'C': {
                stops: [
                    [0, '#E0FFFF'], [0.2, '#7EC8E3'], [0.4, '#5DADE2'], 
                    [0.6, '#3498DB'], [0.8, '#2E86C1'], [1, '#E0FFFF']
                ],
                glow: '#7EC8E3'
            }
        },
        suitColors: {
            'S': '#4A90B8', // Darker icy blue for spades
            'H': '#707070', // Darker silver for hearts
            'D': '#606060', // Darker silver for diamonds
            'C': '#5B9BD5'  // Darker icy blue for clubs
        }
    }
};

/**
 * Draw steampunk-themed decorations (gears, rivets, patina)
 */
function drawSteampunkTexture(ctx, x, y, width, height) {
    // Add brass rivets along edges (avoiding corners where card values are)
    ctx.save();
    ctx.fillStyle = '#4A3728';
    const rivetPositions = [
        [x + width / 2, y + 8], // Top center
        [x + width / 2, y + height - 8], // Bottom center
        [x + 8, y + height / 2], // Left center
        [x + width - 8, y + height / 2]  // Right center
    ];
    
    rivetPositions.forEach(([rx, ry]) => {
        // Outer rivet
        ctx.beginPath();
        ctx.arc(rx, ry, 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner highlight
        ctx.fillStyle = '#B8956A';
        ctx.beginPath();
        ctx.arc(rx - 1, ry - 1, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#4A3728';
    });
    
    // Add subtle gear pattern in center-right area (away from corners)
    ctx.strokeStyle = 'rgba(74, 55, 40, 0.2)';
    ctx.lineWidth = 1.5;
    
    const gearX = x + width - 25;
    const gearY = y + height - 25;
    const gearRadius = 10;
    const teeth = 8;
    
    ctx.beginPath();
    for (let i = 0; i < teeth; i++) {
        const angle = (i / teeth) * Math.PI * 2;
        const toothAngle = angle + (Math.PI / teeth) / 2;
        const outerX = gearX + Math.cos(angle) * gearRadius;
        const outerY = gearY + Math.sin(angle) * gearRadius;
        const toothX = gearX + Math.cos(toothAngle) * (gearRadius + 3);
        const toothY = gearY + Math.sin(toothAngle) * (gearRadius + 3);
        
        if (i === 0) {
            ctx.moveTo(outerX, outerY);
        } else {
            ctx.lineTo(outerX, outerY);
        }
        ctx.lineTo(toothX, toothY);
    }
    ctx.closePath();
    ctx.stroke();
    
    // Center gear hole
    ctx.beginPath();
    ctx.arc(gearX, gearY, 3, 0, Math.PI * 2);
    ctx.stroke();
    
    // Add patina effect (aged spots)
    ctx.fillStyle = 'rgba(139, 111, 71, 0.15)';
    const seed = Math.floor((x + y) * 100); // Deterministic randomness based on position
    for (let i = 0; i < 12; i++) {
        const px = x + ((seed + i * 37) % 100) / 100 * width;
        const py = y + ((seed + i * 73) % 100) / 100 * height;
        const size = 3 + ((seed + i * 19) % 5);
        ctx.beginPath();
        ctx.arc(px, py, size, 0, Math.PI * 2);
        ctx.fill();
    }
    
    ctx.restore();
}

/**
 * Apply neon glow effect to suit symbols
 */
function applyNeonGlow(ctx, suitCode) {
    const glowColors = {
        'S': '#00ffff', // Cyan
        'H': '#ff0080', // Hot pink
        'D': '#00ff00', // Lime
        'C': '#ffff00'  // Yellow
    };
    
    const glowColor = glowColors[suitCode] || '#00ffff';
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 15;
}

/**
 * Draw medieval-themed ornamental decorations
 */
function drawMedievalOrnaments(ctx, x, y, width, height) {
    ctx.save();
    ctx.strokeStyle = '#5C4033';
    ctx.lineWidth = 1;
    
    // Decorative flourishes on edges (avoiding corners where card values are)
    const offset = 35; // Distance from corners
    
    // Top edge flourish
    ctx.beginPath();
    ctx.moveTo(x + width / 2 - 10, y + 8);
    ctx.quadraticCurveTo(x + width / 2, y + 5, x + width / 2 + 10, y + 8);
    ctx.stroke();
    
    // Bottom edge flourish
    ctx.beginPath();
    ctx.moveTo(x + width / 2 - 10, y + height - 8);
    ctx.quadraticCurveTo(x + width / 2, y + height - 5, x + width / 2 + 10, y + height - 8);
    ctx.stroke();
    
    // Left edge flourish
    ctx.beginPath();
    ctx.moveTo(x + 8, y + height / 2 - 10);
    ctx.quadraticCurveTo(x + 5, y + height / 2, x + 8, y + height / 2 + 10);
    ctx.stroke();
    
    // Right edge flourish
    ctx.beginPath();
    ctx.moveTo(x + width - 8, y + height / 2 - 10);
    ctx.quadraticCurveTo(x + width - 5, y + height / 2, x + width - 8, y + height / 2 + 10);
    ctx.stroke();
    
    // Add parchment texture
    ctx.fillStyle = 'rgba(92, 64, 51, 0.05)';
    const seed = Math.floor((x + y) * 100);
    for (let i = 0; i < 20; i++) {
        const px = x + ((seed + i * 41) % 100) / 100 * width;
        const py = y + ((seed + i * 67) % 100) / 100 * height;
        const lineWidth = 0.3 + ((seed + i * 13) % 3) * 0.1;
        const lineLength = 5 + ((seed + i * 23) % 10);
        
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + lineLength, py);
        ctx.stroke();
    }
    
    ctx.restore();
}

/**
 * Draw holographic shimmer lines and background
 */
function drawHolographicBackground(ctx, x, y, width, height) {
    ctx.save();
    
    // Iridescent rainbow gradient background
    const gradient = ctx.createLinearGradient(x, y, x + width, y + height);
    gradient.addColorStop(0, '#FF00FF');
    gradient.addColorStop(0.2, '#00FFFF');
    gradient.addColorStop(0.4, '#FFFF00');
    gradient.addColorStop(0.6, '#00FF00');
    gradient.addColorStop(0.8, '#FF00FF');
    gradient.addColorStop(1, '#00FFFF');
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, width, height);
    
    // Semi-transparent white overlay for readability
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.fillRect(x + 5, y + 5, width - 10, height - 10);
    
    // Shimmer lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 10; i++) {
        ctx.beginPath();
        const yPos = y + 15 + i * 12;
        ctx.moveTo(x + 10, yPos);
        ctx.lineTo(x + width - 10, yPos + 20);
        ctx.stroke();
    }
    
    ctx.restore();
}

/**
 * Apply holographic gradient to suit symbol
 */
function applyHolographicGradient(ctx, suitCode, x, y) {
    const theme = DECK_THEMES.holographic;
    const suitGradient = theme.suitGradients[suitCode];
    
    if (!suitGradient) return null;
    
    const gradient = ctx.createRadialGradient(x, y - 6, 5, x, y + 4, 45);
    suitGradient.stops.forEach(([stop, color]) => {
        gradient.addColorStop(stop, color);
    });
    
    return { gradient, glow: suitGradient.glow };
}

/**
 * Apply frosted icy gradient to suit symbol (for Christmas/Frosted theme)
 */
function applyFrostedGradient(ctx, suitCode, x, y) {
    const theme = DECK_THEMES.christmas;
    const suitGradient = theme.suitGradients[suitCode];
    
    if (!suitGradient) return null;
    
    const gradient = ctx.createRadialGradient(x, y - 6, 5, x, y + 4, 45);
    suitGradient.stops.forEach(([stop, color]) => {
        gradient.addColorStop(stop, color);
    });
    
    return { gradient, glow: suitGradient.glow };
}

/**
 * Draw cosmic deep space background with stars and nebulae
 */
function drawCosmicBackground(ctx, x, y, width, height) {
    ctx.save();
    
    // Deep space gradient (purple to black)
    // Leave left margin to preserve glow from previous card
    const bgGradient = ctx.createRadialGradient(x + width/2, y + height/2, 20, x + width/2, y + height/2, 100);
    bgGradient.addColorStop(0, '#1a0033');
    bgGradient.addColorStop(0.5, '#0a001a');
    bgGradient.addColorStop(1, '#000000');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(x + 6, y, width - 6, height);
    
    // Purple nebula
    const nebula1 = ctx.createRadialGradient(x + 20, y + 30, 0, x + 20, y + 30, 40);
    nebula1.addColorStop(0, 'rgba(138, 43, 226, 0.3)');
    nebula1.addColorStop(0.5, 'rgba(75, 0, 130, 0.2)');
    nebula1.addColorStop(1, 'rgba(75, 0, 130, 0)');
    ctx.fillStyle = nebula1;
    ctx.fillRect(x + 6, y, 60, 60);
    
    // Blue nebula
    const nebula2 = ctx.createRadialGradient(x + 80, y + 100, 0, x + 80, y + 100, 50);
    nebula2.addColorStop(0, 'rgba(65, 105, 225, 0.3)');
    nebula2.addColorStop(0.5, 'rgba(0, 191, 255, 0.2)');
    nebula2.addColorStop(1, 'rgba(0, 191, 255, 0)');
    ctx.fillStyle = nebula2;
    ctx.fillRect(x + 40, y + 60, 62, 82);
    
    // Fully opaque overlay for readability (prevent bleed-through)
    // Leave a small margin on the left to not cover previous card's glow
    ctx.fillStyle = 'rgba(10, 0, 30, 0.95)';
    ctx.fillRect(x + 6, y, width - 6, height);
    
    // Star field (drawn on top of overlay so they're visible)
    ctx.fillStyle = '#FFFFFF';
    const starPositions = [
        [15, 20], [80, 25], [30, 45], [90, 55], [20, 70], 
        [70, 80], [45, 95], [85, 110], [25, 120], [60, 130],
        [40, 30], [10, 90], [95, 40], [50, 15], [75, 125]
    ];
    
    starPositions.forEach(([sx, sy]) => {
        const size = 0.5 + Math.random() * 1.5;
        ctx.beginPath();
        ctx.arc(x + sx, y + sy, size, 0, Math.PI * 2);
        ctx.fill();
    });
    
    ctx.restore();
}

/**
 * Draw Frosted icy winter background
 */
function drawChristmasBackground(ctx, x, y, width, height) {
    ctx.save();
    
    // Icy blue-white gradient background - smooth and clean
    const bgGradient = ctx.createLinearGradient(x, y, x + width, y + height);
    bgGradient.addColorStop(0, '#E8F4F8'); // Very light ice
    bgGradient.addColorStop(0.3, '#D4E9F0'); // Light frost
    bgGradient.addColorStop(0.6, '#C5DDE8'); // Soft ice blue
    bgGradient.addColorStop(1, '#B8D4E3'); // Slightly deeper ice
    ctx.fillStyle = bgGradient;
    ctx.fillRect(x + 6, y, width - 6, height);
    
    ctx.restore();
}

/**
 * Draw a large decorative snowflake (for behind center glyph)
 */
function drawLargeSnowflake(ctx, x, y, size) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'; // White, subtle
    ctx.lineWidth = 1.5;
    
    // Draw 6 main arms
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        const armLen = size;
        
        // Main arm
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * armLen, y + Math.sin(angle) * armLen);
        ctx.stroke();
        
        // Branches at 1/3 of the arm
        const branch1X = x + Math.cos(angle) * armLen * 0.4;
        const branch1Y = y + Math.sin(angle) * armLen * 0.4;
        const branchLen1 = armLen * 0.3;
        
        ctx.beginPath();
        ctx.moveTo(branch1X, branch1Y);
        ctx.lineTo(branch1X + Math.cos(angle + 0.6) * branchLen1, branch1Y + Math.sin(angle + 0.6) * branchLen1);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(branch1X, branch1Y);
        ctx.lineTo(branch1X + Math.cos(angle - 0.6) * branchLen1, branch1Y + Math.sin(angle - 0.6) * branchLen1);
        ctx.stroke();
        
        // Branches at 2/3 of the arm
        const branch2X = x + Math.cos(angle) * armLen * 0.7;
        const branch2Y = y + Math.sin(angle) * armLen * 0.7;
        const branchLen2 = armLen * 0.25;
        
        ctx.beginPath();
        ctx.moveTo(branch2X, branch2Y);
        ctx.lineTo(branch2X + Math.cos(angle + 0.5) * branchLen2, branch2Y + Math.sin(angle + 0.5) * branchLen2);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(branch2X, branch2Y);
        ctx.lineTo(branch2X + Math.cos(angle - 0.5) * branchLen2, branch2Y + Math.sin(angle - 0.5) * branchLen2);
        ctx.stroke();
    }
    
    ctx.restore();
}

/**
 * Draw a simple snowflake
 */
function drawSnowflake(ctx, x, y, size) {
    ctx.save();
    // Use a soft blue-white that contrasts with the icy background
    ctx.strokeStyle = 'rgba(100, 149, 237, 0.5)'; // Cornflower blue, semi-transparent
    ctx.lineWidth = 1;
    
    // Draw 6 lines radiating from center
    for (let i = 0; i < 6; i++) {
        const angle = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * size * 3, y + Math.sin(angle) * size * 3);
        ctx.stroke();
        
        // Small branches on each arm
        const branchLen = size * 1.5;
        const midX = x + Math.cos(angle) * size * 1.5;
        const midY = y + Math.sin(angle) * size * 1.5;
        
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        ctx.lineTo(midX + Math.cos(angle + 0.5) * branchLen, midY + Math.sin(angle + 0.5) * branchLen);
        ctx.stroke();
        
        ctx.beginPath();
        ctx.moveTo(midX, midY);
        ctx.lineTo(midX + Math.cos(angle - 0.5) * branchLen, midY + Math.sin(angle - 0.5) * branchLen);
        ctx.stroke();
    }
    
    ctx.restore();
}

/**
 * Draw holly leaves and berries decoration
 */
function drawHollyDecoration(ctx, x, y, scale) {
    ctx.save();
    
    // Holly leaves (dark green)
    ctx.fillStyle = '#228B22';
    
    // Left leaf
    ctx.beginPath();
    ctx.ellipse(x - 4 * scale, y + 2 * scale, 6 * scale, 3 * scale, -0.5, 0, Math.PI * 2);
    ctx.fill();
    
    // Right leaf
    ctx.beginPath();
    ctx.ellipse(x + 4 * scale, y + 2 * scale, 6 * scale, 3 * scale, 0.5, 0, Math.PI * 2);
    ctx.fill();
    
    // Holly berries (red)
    ctx.fillStyle = '#C41E3A';
    ctx.beginPath();
    ctx.arc(x, y, 2.5 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - 3 * scale, y - 2 * scale, 2 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + 3 * scale, y - 2 * scale, 2 * scale, 0, Math.PI * 2);
    ctx.fill();
    
    // Berry highlights
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(x - 1, y - 1, 1 * scale, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore();
}

/**
 * Apply cosmic gradient to suit symbol
 */
function applyCosmicGradient(ctx, suitCode, x, y) {
    const theme = DECK_THEMES.cosmic;
    const suitGradient = theme.suitGradients[suitCode];
    
    if (!suitGradient) return null;
    
    const gradient = ctx.createRadialGradient(x, y - 6, 5, x, y + 4, 45);
    suitGradient.stops.forEach(([stop, color]) => {
        gradient.addColorStop(stop, color);
    });
    
    return { gradient, glow: suitGradient.glow };
}

/**
 * Draw cyberpunk hexagon tech pattern
 */
function drawHexagonPattern(ctx, x, y, width, height, neonColor) {
    ctx.save();
    ctx.strokeStyle = neonColor + '20';
    ctx.lineWidth = 1;
    const hexSize = 8;
    
    for (let row = 0; row < 20; row++) {
        for (let col = 0; col < 8; col++) {
            const hx = x + col * hexSize * 1.8 + (row % 2) * hexSize * 0.9;
            const hy = y + row * hexSize * 1.5;
            
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const angle = (Math.PI / 3) * i;
                const px = hx + hexSize * Math.cos(angle);
                const py = hy + hexSize * Math.sin(angle);
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
            ctx.stroke();
        }
    }
    ctx.restore();
}

/**
 * Draw circuit board traces and nodes
 */
function drawCircuitTraces(ctx, x, y, width, height, neonColor) {
    ctx.save();
    ctx.strokeStyle = neonColor + '30';
    ctx.lineWidth = 1.5;
    
    // Horizontal traces
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 30);
    ctx.lineTo(x + 40, y + 30);
    ctx.lineTo(x + 45, y + 35);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x + 60, y + 50);
    ctx.lineTo(x + 92, y + 50);
    ctx.lineTo(x + 92, y + 60);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x + 10, y + 110);
    ctx.lineTo(x + 35, y + 110);
    ctx.lineTo(x + 40, y + 105);
    ctx.stroke();
    
    // Vertical traces
    ctx.beginPath();
    ctx.moveTo(x + 20, y + 60);
    ctx.lineTo(x + 20, y + 85);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(x + 80, y + 20);
    ctx.lineTo(x + 80, y + 40);
    ctx.stroke();
    
    // Circuit nodes
    ctx.fillStyle = neonColor + '60';
    const nodes = [[40, 30], [45, 35], [92, 50], [35, 110], [20, 60], [80, 20]];
    nodes.forEach(([nx, ny]) => {
        ctx.beginPath();
        ctx.arc(x + nx, y + ny, 2, 0, Math.PI * 2);
        ctx.fill();
    });
    
    // Data stream lines
    ctx.strokeStyle = neonColor + '15';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let dx = 15; dx < width; dx += 20) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y);
        ctx.lineTo(x + dx, y + height);
        ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
}

/**
 * Draw tech corner brackets
 */
function drawTechBrackets(ctx, x, y, width, height, neonColor) {
    ctx.save();
    ctx.strokeStyle = neonColor;
    ctx.lineWidth = 2;
    ctx.shadowColor = neonColor;
    ctx.shadowBlur = 8;
    
    // Top-left
    ctx.beginPath();
    ctx.moveTo(x + 3, y + 15);
    ctx.lineTo(x + 3, y + 3);
    ctx.lineTo(x + 15, y + 3);
    ctx.stroke();
    
    // Top-right
    ctx.beginPath();
    ctx.moveTo(x + width - 15, y + 3);
    ctx.lineTo(x + width - 3, y + 3);
    ctx.lineTo(x + width - 3, y + 15);
    ctx.stroke();
    
    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(x + 3, y + height - 15);
    ctx.lineTo(x + 3, y + height - 3);
    ctx.lineTo(x + 15, y + height - 3);
    ctx.stroke();
    
    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(x + width - 3, y + height - 15);
    ctx.lineTo(x + width - 3, y + height - 3);
    ctx.lineTo(x + width - 15, y + height - 3);
    ctx.stroke();
    
    ctx.restore();
}

/**
 * Return corner suit colors when a special override is needed.
 * This helper only enforces the holographic corner color convention
 * (black for spades/clubs, red for hearts/diamonds). For other themes
 * it returns null so existing per-theme logic remains unchanged.
 */
function getCornerSuitColors(deckTheme = 'classic', colorBlindMode = false) {
    if (colorBlindMode) {
        return {
            'S': '#1a1a1a',
            'H': '#C41E3A',
            'D': '#0066CC',
            'C': '#1B7F37'
        };
    }

    if (deckTheme === 'holographic') {
        return {
            'S': '#000000',
            'H': '#C41E3A',
            'D': '#C41E3A',
            'C': '#000000'
        };
    }

    return null;
}

/**
 * Generates a PNG image of a card back (face-down card)
 * @param {string} theme - Card back theme/color ('blue', 'red', 'green', 'classic', 'christmas')
 * @returns {Buffer} PNG image buffer
 */
export function renderCardBack(theme = 'blue') {
    const width = 102;
    const height = 143;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Handle Christmas/Frosted theme specially
    if (theme === 'christmas') {
        // Icy blue gradient background
        const bgGradient = ctx.createLinearGradient(0, 0, width, height);
        bgGradient.addColorStop(0, '#E8F4F8');
        bgGradient.addColorStop(0.3, '#D4E9F0');
        bgGradient.addColorStop(0.6, '#C5DDE8');
        bgGradient.addColorStop(1, '#B8D4E3');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(0, 0, width, height);
        
        // Ice blue outer border
        ctx.strokeStyle = '#87CEEB';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(2, 2, width - 4, height - 4);
        
        // Powder blue inner border
        ctx.strokeStyle = '#B0E0E6';
        ctx.lineWidth = 1;
        ctx.strokeRect(8, 8, width - 16, height - 16);
        
        // Draw large decorative snowflake in center
        ctx.save();
        ctx.strokeStyle = 'rgba(135, 206, 235, 0.7)';
        ctx.lineWidth = 2;
        
        const centerX = width / 2;
        const centerY = height / 2;
        const armLength = 40;
        
        // Draw 6 main arms with branches
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            
            // Main arm
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(centerX + Math.cos(angle) * armLength, centerY + Math.sin(angle) * armLength);
            ctx.stroke();
            
            // Branches at 1/3 of the arm
            const branch1X = centerX + Math.cos(angle) * armLength * 0.4;
            const branch1Y = centerY + Math.sin(angle) * armLength * 0.4;
            const branchLen1 = armLength * 0.35;
            
            ctx.beginPath();
            ctx.moveTo(branch1X, branch1Y);
            ctx.lineTo(branch1X + Math.cos(angle + 0.6) * branchLen1, branch1Y + Math.sin(angle + 0.6) * branchLen1);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(branch1X, branch1Y);
            ctx.lineTo(branch1X + Math.cos(angle - 0.6) * branchLen1, branch1Y + Math.sin(angle - 0.6) * branchLen1);
            ctx.stroke();
            
            // Branches at 2/3 of the arm
            const branch2X = centerX + Math.cos(angle) * armLength * 0.7;
            const branch2Y = centerY + Math.sin(angle) * armLength * 0.7;
            const branchLen2 = armLength * 0.28;
            
            ctx.beginPath();
            ctx.moveTo(branch2X, branch2Y);
            ctx.lineTo(branch2X + Math.cos(angle + 0.5) * branchLen2, branch2Y + Math.sin(angle + 0.5) * branchLen2);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(branch2X, branch2Y);
            ctx.lineTo(branch2X + Math.cos(angle - 0.5) * branchLen2, branch2Y + Math.sin(angle - 0.5) * branchLen2);
            ctx.stroke();
        }
        
        // Inner circle accent
        ctx.strokeStyle = 'rgba(135, 206, 235, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(centerX, centerY, 12, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.restore();
        
        return canvas.toBuffer('image/png');
    }

    // Background color based on theme
    const themes = {
        'blue': { bg: '#1E3A8A', pattern: '#3B82F6' },
        'red': { bg: '#7F1D1D', pattern: '#DC2626' },
        'green': { bg: '#14532D', pattern: '#16A34A' },
        'classic': { bg: '#1F2937', pattern: '#6B7280' }
    };

    const selectedTheme = themes[theme] || themes['blue'];

    // Card background
    ctx.fillStyle = selectedTheme.bg;
    ctx.fillRect(0, 0, width, height);

    // Card border
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, width - 4, height - 4);

    // Inner decorative border
    ctx.strokeStyle = selectedTheme.pattern;
    ctx.lineWidth = 1;
    ctx.strokeRect(8, 8, width - 16, height - 16);

    // Draw diagonal pattern
    ctx.strokeStyle = selectedTheme.pattern;
    ctx.lineWidth = 2;
    
    for (let i = -height; i < width; i += 15) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + height, height);
        ctx.stroke();
    }

    // Draw center design (diamond/circle pattern)
    ctx.fillStyle = selectedTheme.pattern;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, 20, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = selectedTheme.bg;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, 12, 0, Math.PI * 2);
    ctx.fill();

    return canvas.toBuffer('image/png');
}

/**
 * Generates a PNG image of a playing card
 * @param {string} rankCode - Single character rank code (e.g., 'A', 'T', 'K')
 * @param {string} suitCode - Single character suit code (e.g., 'S', 'H', 'D', 'C')
 * @param {boolean} colorBlindMode - Use color blind friendly suit colors
 * @param {string} deckTheme - Theme to apply ('classic', 'steampunk', 'minimalist', 'neon', 'medieval')
 * @returns {Buffer} PNG image buffer
 */
export function renderCard(rankCode, suitCode, colorBlindMode = false, deckTheme = 'classic') {
    // Artwork (image) decks: draw the preloaded card image at its native aspect.
    if (isImageTheme(deckTheme)) {
        const img = _getImageFace(deckTheme, rankCode, suitCode);
        if (img) {
            const cardHeight = IMAGE_HAND_HEIGHT;
            const cardWidth = Math.round(cardHeight * (img.width / img.height));
            const canvas = createCanvas(cardWidth, cardHeight);
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, cardWidth, cardHeight);
            _drawRoundedImage(ctx, img, 0, 0, cardWidth, cardHeight);
            return canvas.toBuffer('image/png');
        }
    }
    const theme = DECK_THEMES[deckTheme] || DECK_THEMES.classic;
    const width = 102;
    const height = 143;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Apply themed background
    if (deckTheme === 'holographic') {
        // Use holographic rainbow background
        drawHolographicBackground(ctx, 0, 0, width, height);
    } else if (deckTheme === 'cosmic') {
        // Use cosmic deep space background
        drawCosmicBackground(ctx, 0, 0, width, height);
    } else if (deckTheme === 'cyberpunk') {
        // Use cyberpunk dark gradient with suit-specific tint
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const suitGradient = cyberpunkTheme.bgGradients[suitCode];
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, suitGradient.start);
        gradient.addColorStop(1, suitGradient.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
        
        // Add hexagon pattern overlay
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        drawHexagonPattern(ctx, 0, 0, width, height, neonColor);
        
        // Add circuit traces
        drawCircuitTraces(ctx, 0, 0, width, height, neonColor);
        
        // Add tech corner brackets
        drawTechBrackets(ctx, 0, 0, width, height, neonColor);
    } else if (deckTheme === 'christmas') {
        // Use Christmas festive background
        drawChristmasBackground(ctx, 0, 0, width, height);
    } else {
        // Standard gradient background
        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, theme.background.start);
        gradient.addColorStop(1, theme.background.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }

    // Add subtle inner shadow for depth (if theme supports it)
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
    }

    // Card border with themed color
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 2.5;
    
    // Add glowing border for cosmic theme
    if (deckTheme === 'cosmic') {
        ctx.shadowColor = theme.border;
        ctx.shadowBlur = 10;
    }
    
    ctx.strokeRect(2, 2, width - 4, height - 4);
    
    // Inner decorative border (if theme supports it)
    if (theme.innerBorder && theme.innerBorder !== 'none') {
        ctx.strokeStyle = theme.innerBorder;
        ctx.lineWidth = 0.8;
        
        // Add inner glow for cosmic theme
        if (deckTheme === 'cosmic') {
            ctx.shadowColor = theme.innerBorder;
            ctx.shadowBlur = 5;
        }
        
        ctx.strokeRect(5, 5, width - 10, height - 10);
    }

    // Reset shadow for text
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Apply theme-specific decorations
    if (deckTheme === 'steampunk') {
        drawSteampunkTexture(ctx, 0, 0, width, height);
    } else if (deckTheme === 'medieval') {
        drawMedievalOrnaments(ctx, 0, 0, width, height);
    }

    // Determine suit symbol and color
    const suitSymbols = {
        'S': '♠',
        'H': '♥',
        'D': '♦',
        'C': '♣'
    };

    // Suit colors - adjust for neon theme
    let suitColors;
    if (deckTheme === 'neon') {
        suitColors = {
            'S': '#00ffff',  // Cyan
            'H': '#ff0080',  // Hot pink
            'D': '#00ff00',  // Lime
            'C': '#ffff00'   // Yellow
        };
    } else if (colorBlindMode) {
        suitColors = {
            'S': '#1a1a1a',      // Darker black
            'H': '#C41E3A',      // Rich red
            'D': '#0066CC',      // Deep blue
            'C': '#1B7F37'       // Rich green
        };
    } else {
        suitColors = {
            'S': '#1a1a1a',      // Darker black
            'H': '#C41E3A',      // Rich red  
            'D': '#C41E3A',      // Rich red
            'C': '#1a1a1a'       // Darker black
        };
    }

    // Allow holographic / color-blind overrides for corner colors
    const cornerOverride = typeof getCornerSuitColors === 'function' ? getCornerSuitColors(deckTheme, colorBlindMode) : null;
    if (cornerOverride) {
        suitColors = cornerOverride;
    }

    const suit = suitSymbols[suitCode] || suitCode;
    const color = suitColors[suitCode] || '#000000';

    // Compute a single corner fill color (and optional glow) so top-left and bottom-right match
    let cornerFill = color;
    let cornerGlow = null;
    if (deckTheme === 'cosmic') {
        const cd = applyCosmicGradient(ctx, suitCode, 20, 50);
        if (cd) {
            cornerFill = cd.glow;
            cornerGlow = cd.glow;
        }
    }

    // Check if this is a face card
    const isFaceCard = ['J', 'Q', 'K'].includes(rankCode);

    // Display rank (convert 'T' to '10')
    const displayRank = rankCode === 'T' ? '10' : rankCode;

    // Apply neon glow if theme requires it
    if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    } else if (deckTheme === 'cyberpunk') {
        applyCyberpunkGlow(ctx, suitCode);
    }

    // Draw rank in top-left corner with themed font
    ctx.fillStyle = color;
    const fontSize = isFaceCard ? 30 : 28;
    const fontFamily = isFaceCard ? theme.faceFont : theme.font;
    ctx.font = 'bold ' + fontSize + 'px ' + fontFamily;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // Draw glow layer first (stronger for double-digit)
    ctx.save();
    let glowColor = 'rgba(0,0,0,0.22)';
    let glowBlur = 12;
    let mainColor = color;
    let mainFont = 'bold ' + fontSize + 'px ' + fontFamily;
    if (deckTheme === 'cosmic') {
        glowColor = '#7fdfff';
        glowBlur = 15;
        mainColor = '#E0E0E0';
    } else if (deckTheme === 'cyberpunk') {
        // The glow and text are handled by applyCyberpunkGlow
        mainColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        mainFont = 'bold ' + fontSize + 'px ' + DECK_THEMES.cyberpunk.font;
    } else if (deckTheme === 'christmas') {
        // Use Christmas theme suit colors for better visibility
        mainColor = DECK_THEMES.christmas.suitColors[suitCode];
        glowColor = 'rgba(0,0,0,0.5)'; // Stronger shadow for contrast
        glowBlur = 8;
    }
    // Draw glow with slightly larger font (handled by helper for cyberpunk)
    if (deckTheme !== 'cyberpunk') {
        ctx.font = mainFont.replace(/(\d+)px/, (m, p1) => (parseInt(p1) + 4) + 'px');
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
        ctx.fillStyle = mainColor;
        ctx.fillText(displayRank, 9, 9);
        ctx.restore();
        // Draw solid text on top (no blur)
        ctx.save();
        ctx.globalAlpha = 1.0; // Ensure no transparency for text
        ctx.font = mainFont;
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.fillStyle = mainColor;
        ctx.fillText(displayRank, 9, 9);
        // Add subtle outline for contrast
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.strokeText(displayRank, 9, 9);
        ctx.restore();
    }
// Helper for cyberpunk rank text glow, modeled after applyNeonGlow
function applyCyberpunkGlow(ctx, suitCode) {
    const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
    // Convert hex to rgb for rgba()
    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
        const num = parseInt(hex, 16);
        return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
    }
    const [r, g, b] = hexToRgb(neonColor);
    ctx.save();
    // Glow layer
    ctx.font = ctx.font.replace(/(\d+)px/, (m, p1) => (parseInt(p1) + 4) + 'px');
    ctx.shadowColor = `rgba(${r},${g},${b},0.85)`;
    ctx.shadowBlur = 15;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillText(displayRank, 9, 9);
    ctx.restore();
    // Solid text layer
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.font = ctx.font.replace(/(\d+)px/, (m, p1) => (parseInt(p1) - 4) + 'px');
    ctx.fillText(displayRank, 9, 9);
    // Outline
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.strokeText(displayRank, 9, 9);
    ctx.restore();
}
    
    // Draw digital markers for cyberpunk
    if (deckTheme === 'cyberpunk') {
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        ctx.fillStyle = neonColor + '60';
        for (let i = 0; i < 3; i++) {
            ctx.fillRect(width - 10, 10 + i * 8, 3, 5);
        }
    }

    // Draw suit in top-left corner (below rank) with themed font and glow
    ctx.font = `26px ${theme.font}`;
    const shouldGlow = (color === '#C41E3A' || color === '#0066CC' || color === '#1B7F37' || deckTheme === 'neon');
    
    // Apply cosmic gradient+glow for corner suits so they match center art
    if (deckTheme === 'cosmic') {
        const cosmicCorner = applyCosmicGradient(ctx, suitCode, 20, 50);
        if (cosmicCorner) {
            ctx.fillStyle = cosmicCorner.gradient;
            ctx.shadowColor = cosmicCorner.glow;
            ctx.shadowBlur = 8;
        }
    } else if (deckTheme === 'cyberpunk') {
        // Use neon color for corner suit
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
    } else if (deckTheme === 'christmas') {
        // Use Christmas suit colors for top-left
        ctx.fillStyle = DECK_THEMES.christmas.suitColors[suitCode];
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
    } else {
        ctx.shadowColor = shouldGlow ? `${color}40` : 'transparent';
        ctx.shadowBlur = 3;
    }
    
    ctx.fillText(suit, 9, 38);

    // Draw large centered suit symbol with enhanced styling
    ctx.font = `64px ${theme.font}`;
    
    // Apply cosmic gradient if cosmic theme
    if (deckTheme === 'cosmic') {
        const cosmicData = applyCosmicGradient(ctx, suitCode, width / 2, height / 2);
        if (cosmicData) {
            ctx.font = `72px ${theme.font}`;
            ctx.shadowColor = cosmicData.glow;
            ctx.shadowBlur = 20;
            ctx.fillStyle = cosmicData.gradient;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(suit, width / 2, height / 2);
            
            // Add sharp outline
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#000033';
            ctx.lineWidth = 2;
            ctx.strokeText(suit, width / 2, height / 2);
        }
    } else if (deckTheme === 'cyberpunk') {
        // Multi-layer neon glow effect
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        const glitchColors = cyberpunkTheme.glitchColors[suitCode];
        
        ctx.font = `70px ${theme.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        // Layer 1: Outer glow
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 25;
        ctx.fillStyle = neonColor + '40';
        ctx.fillText(suit, width / 2, height / 2);
        
        // Layer 2: Mid glow
        ctx.shadowBlur = 15;
        ctx.fillStyle = neonColor + '70';
        ctx.fillText(suit, width / 2, height / 2);
        
        // Layer 3: Core bright
        ctx.shadowBlur = 8;
        ctx.fillStyle = neonColor;
        ctx.fillText(suit, width / 2, height / 2);
        
        // Glitch chromatic aberration effect
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = glitchColors[0];
        ctx.fillText(suit, width / 2 - 2, height / 2 - 1);
        ctx.fillStyle = glitchColors[1];
        ctx.fillText(suit, width / 2 + 2, height / 2 + 1);
        ctx.globalAlpha = 1.0;
    } else if (deckTheme === 'christmas') {
        // Frosted theme - holographic-style icy gradient
        // Draw large snowflake behind the glyph
        drawLargeSnowflake(ctx, width / 2, height / 2, 35);
        
        const frostedData = applyFrostedGradient(ctx, suitCode, width / 2, height / 2);
        if (frostedData) {
            ctx.font = `58px ${theme.font}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Apply icy glow
            ctx.shadowColor = frostedData.glow;
            ctx.shadowBlur = 15;
            ctx.fillStyle = frostedData.gradient;
            ctx.fillText(suit, width / 2, height / 2);
            
            // Add crisp white outline for frost effect
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.strokeText(suit, width / 2, height / 2);
        }
    } else {
        if (theme.shadows) {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.08)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
        } else if (deckTheme === 'neon') {
            applyNeonGlow(ctx, suitCode);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(suit, width / 2, height / 2);

        // Add subtle glow to center suit
        if (shouldGlow && theme.shadows) {
            ctx.shadowColor = `${color}25`;
            ctx.shadowBlur = 8;
            ctx.fillText(suit, width / 2, height / 2);
        }
    }

    // Draw rank in bottom-right corner (upside down)
    ctx.save();
    ctx.translate(width - 9, height - 9);
    ctx.rotate(Math.PI);
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    } else if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    }
    
    // Ensure bottom-right rank uses the same color as top-left rank
    let bottomRightRankColor = cornerFill;
    if (deckTheme === 'cyberpunk') {
        bottomRightRankColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        applyCyberpunkGlow(ctx, suitCode);
    } else if (deckTheme === 'christmas') {
        bottomRightRankColor = DECK_THEMES.christmas.suitColors[suitCode];
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 8;
    } else if (deckTheme === 'cosmic' && cornerGlow) {
        ctx.shadowColor = cornerGlow;
        ctx.shadowBlur = 8;
    }
    ctx.fillStyle = bottomRightRankColor;
    
    ctx.font = isFaceCard ? `bold 30px ${theme.faceFont}` : `bold 28px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(displayRank, 0, 0);

    // Draw suit in bottom-right corner (upside down, below rank)
    ctx.font = `26px ${theme.font}`;
    
    // Apply cosmic gradient+glow for bottom corner suit so it matches top-left
    if (deckTheme === 'cosmic') {
        const cosmicData = applyCosmicGradient(ctx, suitCode, width - 20, height - 50);
        if (cosmicData) {
            ctx.fillStyle = cosmicData.gradient;
            ctx.shadowColor = cosmicData.glow;
            ctx.shadowBlur = 8;
        } else {
            ctx.shadowColor = shouldGlow ? `${color}40` : 'transparent';
            ctx.shadowBlur = 3;
        }
    } else if (deckTheme === 'christmas') {
        // Use Christmas suit colors for bottom-right
        ctx.fillStyle = DECK_THEMES.christmas.suitColors[suitCode];
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
    } else {
        ctx.shadowColor = shouldGlow ? `${color}40` : 'transparent';
        ctx.shadowBlur = 3;
    }
    
    ctx.fillText(suit, 0, 32);
    ctx.restore();

    // Add face card embellishments (unless minimalist theme)
    if (isFaceCard && !theme.simple) {
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = color + '20'; // Very transparent
        ctx.lineWidth = 1;
        
        // Decorative corners
        const cornerSize = 15;
        
        // Top-left corner decoration
        ctx.beginPath();
        ctx.moveTo(12, 12);
        ctx.lineTo(12 + cornerSize, 12);
        ctx.moveTo(12, 12);
        ctx.lineTo(12, 12 + cornerSize);
        ctx.stroke();
        
        // Bottom-right corner decoration (needs to account for rotation)
        ctx.save();
        ctx.translate(width - 12, height - 12);
        ctx.rotate(Math.PI);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(cornerSize, 0);
        ctx.moveTo(0, 0);
        ctx.lineTo(0, cornerSize);
        ctx.stroke();
        ctx.restore();
    }

    return canvas.toBuffer('image/png');
}

/**
 * Generates an image showing a full hand of cards
 * @param {Array} cards - Array of card objects with rankCode and suitCode
 * @param {boolean} colorBlindMode - Whether to use color blind friendly colors
 * @param {string} deckTheme - Theme to apply to cards
 * @returns {Buffer} PNG image buffer
 */
export function renderHand(cards, colorBlindMode = false, deckTheme = 'classic') {
    if (!cards || cards.length === 0) {
        // Return a small placeholder image if no cards
        const canvas = createCanvas(200, 50);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = '#000000';
        ctx.font = '20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No cards', 100, 25);
        return canvas.toBuffer('image/png');
    }

    // Sort cards: Spades, Hearts, Clubs, Diamonds (to separate red suits)
    const suitOrder = { 'S': 1, 'H': 2, 'C': 3, 'D': 4 };
    const sortedCards = [...cards].sort((a, b) => {
        if (a.suitCode !== b.suitCode) {
            return suitOrder[a.suitCode] - suitOrder[b.suitCode];
        }
        return b.value - a.value; // Higher cards first
    });

    // Artwork (image) decks compose from preloaded card images at their native aspect.
    if (isImageTheme(deckTheme)) {
        return _renderImageHand(sortedCards, deckTheme);
    }

    // Reduced card dimensions by 15%
    const cardWidth = 102; // Was 120
    const cardHeight = 143; // Was 168
    const overlap = 34; // Was 40, reduced by 15%
    const totalWidth = cardWidth + (overlap * (sortedCards.length - 1));
    const canvas = createCanvas(totalWidth, cardHeight);
    const ctx = canvas.getContext('2d');

    // Transparent background
    ctx.clearRect(0, 0, totalWidth, cardHeight);

    // Draw each card with overlap
    sortedCards.forEach((card, index) => {
        const x = index * overlap;
        drawCardOnCanvas(ctx, card.rankCode, card.suitCode, x, 0, colorBlindMode, deckTheme);
    });

    return canvas.toBuffer('image/png');
}

/**
 * Helper function to draw a card directly on a canvas context with enhanced styling
 */
function drawCardOnCanvas(ctx, rankCode, suitCode, x, y, colorBlindMode = false, deckTheme = 'classic') {
    const theme = DECK_THEMES[deckTheme] || DECK_THEMES.classic;
    const width = 102;
    const height = 143;

    // Apply themed background
    if (deckTheme === 'holographic') {
        // Use holographic rainbow background
        drawHolographicBackground(ctx, x, y, width, height);
    } else if (deckTheme === 'cosmic') {
        // Use cosmic deep space background
        drawCosmicBackground(ctx, x, y, width, height);
    } else if (deckTheme === 'cyberpunk') {
        // Use cyberpunk dark gradient with suit-specific tint
        // First draw a fully opaque base across the ENTIRE card to prevent transparency bleed
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(x, y, width, height);
        
        // Then add the suit-specific gradient on top (with left margin to preserve previous card's glow)
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const suitGradient = cyberpunkTheme.bgGradients[suitCode];
        const gradient = ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, suitGradient.start);
        gradient.addColorStop(1, suitGradient.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(x + 6, y, width - 6, height);
        
        // Add hexagon pattern overlay
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        drawHexagonPattern(ctx, x + 6, y, width - 6, height, neonColor);
        
        // Add circuit traces
        drawCircuitTraces(ctx, x + 6, y, width - 6, height, neonColor);
        
        // Add tech corner brackets
        drawTechBrackets(ctx, x, y, width, height, neonColor);
    } else if (deckTheme === 'christmas') {
        // Use Christmas festive background
        drawChristmasBackground(ctx, x, y, width, height);
    } else {
        // Standard gradient background
        const gradient = ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, theme.background.start);
        gradient.addColorStop(1, theme.background.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, width, height);
    }

    // Add subtle inner shadow for depth (if theme supports it)
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
    }

    // Card border with themed color - always draw consistently
    ctx.save();
    ctx.strokeStyle = theme.border;
    // Make cosmic borders thicker and brighter for better visibility
    if (deckTheme === 'cosmic') {
        ctx.strokeStyle = '#6495ED'; // Brighter cornflower blue
        ctx.lineWidth = 3;
    } else {
        ctx.lineWidth = 2.5;
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeRect(x + 2, y + 2, width - 4, height - 4);
    
    // Inner decorative border (if theme supports it)
    if (theme.innerBorder && theme.innerBorder !== 'none') {
        if (deckTheme === 'cosmic') {
            ctx.strokeStyle = '#BA55D3'; // Brighter medium orchid
            ctx.lineWidth = 1;
        } else {
            ctx.strokeStyle = theme.innerBorder;
            ctx.lineWidth = 0.8;
        }
        ctx.strokeRect(x + 5, y + 5, width - 10, height - 10);
    }
    ctx.restore();

    // Reset shadow for text
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Apply theme-specific decorations
    if (deckTheme === 'steampunk') {
        drawSteampunkTexture(ctx, x, y, width, height);
    } else if (deckTheme === 'medieval') {
        drawMedievalOrnaments(ctx, x, y, width, height);
    }

    // Suit symbols and colors
    const suitSymbols = {
        'S': '♠',
        'H': '♥',
        'D': '♦',
        'C': '♣'
    };

    // Suit colors - adjust for neon theme
    let suitColors;
    if (deckTheme === 'neon') {
        suitColors = {
            'S': '#00ffff',  // Cyan
            'H': '#ff0080',  // Hot pink
            'D': '#00ff00',  // Lime
            'C': '#ffff00'   // Yellow
        };
    } else if (colorBlindMode) {
        suitColors = {
            'S': '#1a1a1a',      // Darker black
            'H': '#C41E3A',      // Rich red
            'D': '#0066CC',      // Deep blue
            'C': '#1B7F37'       // Rich green
        };
    } else if (deckTheme === 'christmas') {
        suitColors = {
            'S': '#3A7CA5',      // Darker icy blue for spades
            'H': '#808080',      // Silver for hearts
            'D': '#909090',      // Light silver for diamonds
            'C': '#4A90B8'       // Darker icy blue for clubs
        };
    } else {
        suitColors = {
            'S': '#1a1a1a',      // Darker black
            'H': '#C41E3A',      // Rich red  
            'D': '#C41E3A',      // Rich red
            'C': '#1a1a1a'       // Darker black
        };
    }

    const suit = suitSymbols[suitCode] || suitCode;
    const color = suitColors[suitCode] || '#000000';
    const displayRank = rankCode === 'T' ? '10' : rankCode;

    

    // Check if this is a face card
    const isFaceCard = ['J', 'Q', 'K'].includes(rankCode);

    // Apply neon glow if theme requires it
    if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    }

    // Draw rank in top-left with themed font
    ctx.fillStyle = color;
    ctx.font = isFaceCard ? `bold 30px ${theme.faceFont}` : `bold 28px ${theme.font}`;
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }
    
    // Light text color and glow for cosmic theme
    if (deckTheme === 'cosmic') {
        ctx.fillStyle = '#E0E0E0';
        ctx.shadowColor = '#7fdfff';
        ctx.shadowBlur = 8;
    }
    
    // Use monospace font and neon color for cyberpunk
    if (deckTheme === 'cyberpunk') {
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        const fontSize = isFaceCard ? 30 : 28;
        ctx.font = 'bold ' + fontSize + 'px ' + cyberpunkTheme.font;
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 8;
    }
    
    ctx.textAlign = 'left';;
    ctx.textBaseline = 'top';
    ctx.fillText(displayRank, x + 9, y + 9);
    
    // Draw digital markers for cyberpunk
    if (deckTheme === 'cyberpunk') {
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        ctx.fillStyle = neonColor + '60';
        for (let i = 0; i < 3; i++) {
            ctx.fillRect(x + width - 10, y + 10 + i * 8, 3, 5);
        }
    }

    // Draw suit in top-left
    ctx.font = `26px ${theme.font}`;
    const shouldGlow = (color === '#C41E3A' || color === '#0066CC' || color === '#1B7F37' || deckTheme === 'neon');
    
    // Apply cosmic gradient+glow for top-left corner suit so it matches center art
    if (deckTheme === 'cosmic') {
        const cosmicData = applyCosmicGradient(ctx, suitCode, x + 20, y + 50);
        ctx.fillStyle = cosmicData ? cosmicData.gradient : color;
        ctx.shadowColor = cosmicData ? cosmicData.glow : '#7fdfff';
        ctx.shadowBlur = 8;
    } else if (deckTheme === 'cyberpunk') {
        // Use neon color for corner suit
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
    } else if (deckTheme === 'christmas') {
        // Apply frosted gradient to top-left suit
        const frostedData = applyFrostedGradient(ctx, suitCode, x + 20, y + 50);
        if (frostedData) {
            ctx.fillStyle = frostedData.gradient;
            ctx.shadowColor = frostedData.glow;
            ctx.shadowBlur = 6;
        }
    } else {
        ctx.shadowColor = shouldGlow ? `${color}40` : 'transparent';
        ctx.shadowBlur = 3;
    }
    
    ctx.fillText(suit, x + 9, y + 38);

    // Draw large centered suit with enhanced styling
    ctx.save();
    ctx.font = `72px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Apply holographic gradient if holographic theme
    if (deckTheme === 'holographic') {
        const holoData = applyHolographicGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (holoData) {
            ctx.shadowColor = holoData.glow;
            ctx.shadowBlur = 20;
            ctx.fillStyle = holoData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            
            // Add sharp outline
            ctx.shadowBlur = 0;
            if (suitCode === 'S' || suitCode === 'C') {
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = '#8B0000';
                ctx.lineWidth = 3;
                ctx.strokeText(suit, x + width / 2, y + height / 2);
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 1.5;
            }
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        }
    } else if (deckTheme === 'cosmic') {
        // Apply cosmic gradient
        const cosmicData = applyCosmicGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (cosmicData) {
            ctx.shadowColor = cosmicData.glow;
            ctx.shadowBlur = 20;
            ctx.fillStyle = cosmicData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            
            // Add sharp outline
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#000033';
            ctx.lineWidth = 2;
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        }
    } else if (deckTheme === 'cyberpunk') {
        // Multi-layer neon glow effect
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        const glitchColors = cyberpunkTheme.glitchColors[suitCode];
        
        ctx.font = `70px ${theme.font}`;
        
        // Layer 1: Outer glow
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 25;
        ctx.fillStyle = neonColor + '40';
        ctx.fillText(suit, x + width / 2, y + height / 2);
        
        // Layer 2: Mid glow
        ctx.shadowBlur = 15;
        ctx.fillStyle = neonColor + '70';
        ctx.fillText(suit, x + width / 2, y + height / 2);
        
        // Layer 3: Core bright
        ctx.shadowBlur = 8;
        ctx.fillStyle = neonColor;
        ctx.fillText(suit, x + width / 2, y + height / 2);
        
        // Glitch chromatic aberration effect
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = glitchColors[0];
        ctx.fillText(suit, x + width / 2 - 2, y + height / 2 - 1);
        ctx.fillStyle = glitchColors[1];
        ctx.fillText(suit, x + width / 2 + 2, y + height / 2 + 1);
        ctx.globalAlpha = 1.0;
    } else if (deckTheme === 'christmas') {
        // Frosted theme - holographic-style icy gradient
        // Draw large snowflake behind the glyph
        drawLargeSnowflake(ctx, x + width / 2, y + height / 2, 32);
        
        const frostedData = applyFrostedGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (frostedData) {
            ctx.font = `56px ${theme.font}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Apply icy glow
            ctx.shadowColor = frostedData.glow;
            ctx.shadowBlur = 12;
            ctx.fillStyle = frostedData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            
            // Add crisp white outline for frost effect
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        }
    } else {
        // Standard rendering
        ctx.font = `64px ${theme.font}`;
        ctx.fillStyle = color;
        if (theme.shadows) {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.08)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
        } else if (deckTheme === 'neon') {
            applyNeonGlow(ctx, suitCode);
        }
        ctx.fillText(suit, x + width / 2, y + height / 2);

        // Add subtle glow to center suit
        if (shouldGlow && theme.shadows) {
            ctx.shadowColor = `${color}25`;
            ctx.shadowBlur = 8;
            ctx.fillText(suit, x + width / 2, y + height / 2);
        }
    }
    ctx.restore();

    // Draw rank in bottom-right (upside down)
    ctx.save();
    ctx.translate(x + width - 9, y + height - 9);
    ctx.rotate(Math.PI);
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.15)';
        ctx.shadowBlur = 2;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    } else if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    }
    
    // Set rank color based on theme to match top-left
    if (deckTheme === 'cosmic') {
        ctx.fillStyle = '#E0E0E0';
        ctx.shadowColor = '#7fdfff';
        ctx.shadowBlur = 8;
    } else if (deckTheme === 'cyberpunk') {
        // Use neon color for bottom-right rank to match top-left
        const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 8;
        ctx.font = isFaceCard ? `bold 30px ${DECK_THEMES.cyberpunk.font}` : `bold 28px ${DECK_THEMES.cyberpunk.font}`;
    } else if (deckTheme === 'christmas') {
        // Use Christmas suit colors for bottom-right rank
        ctx.fillStyle = DECK_THEMES.christmas.suitColors[suitCode];
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 8;
    } else {
        // Use flat color for rank (not gradient) for readability
        ctx.fillStyle = color;
    }
    
    if (deckTheme !== 'cyberpunk') {
        ctx.font = isFaceCard ? `bold 30px ${theme.faceFont}` : `bold 28px ${theme.font}`;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(displayRank, 0, 0);

    // Draw suit in bottom-right (upside down)
    ctx.font = `26px ${theme.font}`;
    
    // Ensure bottom-right uses the same corner gradient & glow as top-left
    if (deckTheme === 'cosmic') {
        const cosmicData = applyCosmicGradient(ctx, suitCode, x + width - 20, y + height - 50);
        ctx.fillStyle = cosmicData ? cosmicData.gradient : color;
        ctx.shadowColor = cosmicData ? cosmicData.glow : '#7fdfff';
        ctx.shadowBlur = 8;
    } else if (deckTheme === 'cyberpunk') {
        // Use neon color for bottom-right suit to match top-left
        const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        ctx.fillStyle = neonColor;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
    } else if (deckTheme === 'christmas') {
        // Apply frosted gradient to bottom-right suit
        const frostedData = applyFrostedGradient(ctx, suitCode, 15, 35);
        if (frostedData) {
            ctx.fillStyle = frostedData.gradient;
            ctx.shadowColor = frostedData.glow;
            ctx.shadowBlur = 6;
        }
    } else {
        ctx.fillStyle = color;
        ctx.shadowColor = shouldGlow ? `${color}40` : 'transparent';
        ctx.shadowBlur = 3;
    }
    
    ctx.fillText(suit, 0, 26);
    ctx.restore();

    // Add face card embellishments (unless minimalist theme)
    if (isFaceCard && !theme.simple) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = color + '20'; // Very transparent
        ctx.lineWidth = 1;
        
        // Decorative corners
        const cornerSize = 15;
        
        // Top-left corner decoration
        ctx.beginPath();
        ctx.moveTo(x + 12, y + 12);
        ctx.lineTo(x + 12 + cornerSize, y + 12);
        ctx.moveTo(x + 12, y + 12);
        ctx.lineTo(x + 12, y + 12 + cornerSize);
        ctx.stroke();
        
        // Bottom-right corner decoration
        ctx.save();
        ctx.translate(x + width - 12, y + height - 12);
        ctx.rotate(Math.PI);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(cornerSize, 0);
        ctx.moveTo(0, 0);
        ctx.lineTo(0, cornerSize);
        ctx.stroke();
        ctx.restore();
        
        ctx.restore();
    }
    
    // Reset state after face cards to ensure next card's bleed-through works
    if (isFaceCard) {
        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation = 'source-over';
        ctx.beginPath(); // Clear any lingering path
    }
}

/**
 * Generates a single card image suitable for Discord attachment
 * @param {object} card - Card object with rankCode and suitCode
 * @param {boolean} colorBlindMode - Whether to use color blind friendly colors
 * @param {string} deckTheme - Theme to apply to the card
 * @returns {Buffer} PNG image buffer
 */
export function renderSingleCard(card, colorBlindMode = false, deckTheme = 'classic') {
    return renderCard(card.rankCode, card.suitCode, colorBlindMode, deckTheme);
}

/**
 * Generates a composite image of multiple cards side-by-side (for showing a trick)
 * @param {Array} cards - Array of card objects with rankCode and suitCode
 * @param {string} deckTheme - Theme to apply to cards
 * @returns {Buffer} PNG image buffer
 */
export function renderTrickCards(cards, deckTheme = 'classic') {
    if (!cards || cards.length === 0) {
        // Return a small placeholder if no cards
        const canvas = createCanvas(200, 50);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#F0F0F0';
        ctx.fillRect(0, 0, 200, 50);
        ctx.fillStyle = '#666666';
        ctx.font = '20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('No cards played', 100, 25);
        return canvas.toBuffer('image/png');
    }

    // Artwork (image) decks compose from preloaded card images at their native aspect.
    if (isImageTheme(deckTheme)) {
        return _renderImageTrick(cards, deckTheme);
    }

    // Reduce card size by 25% from the standard size (102 * 0.75 = 76.5, 143 * 0.75 = 107.25)
    const cardWidth = 77;   // Rounded 76.5
    const cardHeight = 107; // Rounded 107.25
    const spacing = 8; // Slightly reduced spacing too
    const totalWidth = (cardWidth * cards.length) + (spacing * (cards.length - 1));
    const canvas = createCanvas(totalWidth, cardHeight);
    const ctx = canvas.getContext('2d');

    // Transparent background
    ctx.clearRect(0, 0, totalWidth, cardHeight);

    // Draw each card side-by-side with spacing
    // Normalize card input to support multiple shapes used elsewhere in the codebase
    function normalizeCardInput(item) {
        // Possible shapes:
        // { rankCode, suitCode }
        // { rank, suit }
        // { code: 'AS' }
        // { card: { rankCode, suitCode } }
        if (!item) return { rankCode: undefined, suitCode: undefined };
        if (item.rankCode || item.suitCode) {
            return { rankCode: item.rankCode, suitCode: item.suitCode };
        }
        if (item.rank || item.suit) {
            return { rankCode: item.rank || item.rankCode, suitCode: item.suit || item.suitCode };
        }
        if (item.code && typeof item.code === 'string') {
            const code = item.code.toUpperCase();
            if (code.length >= 2) {
                const suit = code.slice(-1);
                const rank = code.slice(0, -1);
                const rankMap = { '10': 'T' };
                return { rankCode: rankMap[rank] || rank, suitCode: suit };
            }
        }
        if (item.card && typeof item.card === 'object') {
            return normalizeCardInput(item.card);
        }
        // Fallback: try common keys
        return { rankCode: item.R || item.r || item.rankCode, suitCode: item.S || item.s || item.suitCode };
    }

    const normalized = cards.map(normalizeCardInput);
    normalized.forEach((card, index) => {
        const x = index * (cardWidth + spacing);
        drawTrickCardOnCanvas(ctx, card.rankCode, card.suitCode, x, 0, cardWidth, cardHeight, deckTheme);
    });

    return canvas.toBuffer('image/png');
}

/**
 * Helper function to draw a smaller card for tricks (25% smaller than standard) with enhanced styling
 */
function drawTrickCardOnCanvas(ctx, rankCode, suitCode, x, y, width, height, deckTheme = 'classic') {
    const theme = DECK_THEMES[deckTheme] || DECK_THEMES.classic;
    
    // Apply themed background with theme-specific logic
    if (deckTheme === 'holographic') {
        drawHolographicBackground(ctx, x, y, width, height);
    } else if (deckTheme === 'cosmic') {
        drawCosmicBackground(ctx, x, y, width, height);
    } else if (deckTheme === 'cyberpunk') {
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const suitGradient = cyberpunkTheme.bgGradients[suitCode];
        const gradient = ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, suitGradient.start);
        gradient.addColorStop(1, suitGradient.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, width, height);
        // Add hexagon pattern overlay
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        drawHexagonPattern(ctx, x, y, width, height, neonColor);
        // Add circuit traces
        drawCircuitTraces(ctx, x, y, width, height, neonColor);
        // Add tech corner brackets
        drawTechBrackets(ctx, x, y, width, height, neonColor);
    } else if (deckTheme === 'christmas') {
        // Use Christmas festive background
        drawChristmasBackground(ctx, x, y, width, height);
    } else {
        const gradient = ctx.createLinearGradient(x, y, x, y + height);
        gradient.addColorStop(0, theme.background.start);
        gradient.addColorStop(1, theme.background.end);
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, width, height);
    }

    // Add subtle shadow (if theme supports it)
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.1)';
        ctx.shadowBlur = 3;
        ctx.shadowOffsetX = 1;
        ctx.shadowOffsetY = 1;
    }

    // Card border with themed color
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1.5, y + 1.5, width - 3, height - 3);

    // Inner decorative border (if theme supports it)
    if (theme.innerBorder && theme.innerBorder !== 'none') {
        ctx.strokeStyle = theme.innerBorder;
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x + 4, y + 4, width - 8, height - 8);
    }

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Apply theme-specific decorations (scaled down for trick cards)
    if (deckTheme === 'steampunk') {
        drawSteampunkTexture(ctx, x, y, width, height);
    } else if (deckTheme === 'medieval') {
        drawMedievalOrnaments(ctx, x, y, width, height);
    }

    // Suit symbols and colors
    const suitSymbols = {
        'S': '♠',
        'H': '♥',
        'D': '♦',
        'C': '♣'
    };

    // Suit colors - match hand rendering for special themes
    let suitColors;
    if (deckTheme === 'neon') {
        // Match hand rendering neon colors exactly for consistency
        suitColors = {
            'S': '#00ffff',  // Cyan
            'H': '#ff0080',  // Hot pink
            'D': '#00ff00',  // Lime
            'C': '#ffff00'   // Yellow
        };
    } else if (deckTheme === 'cyberpunk') {
        suitColors = {
            'S': DECK_THEMES.cyberpunk.neonColors['S'],
            'H': DECK_THEMES.cyberpunk.neonColors['H'],
            'D': DECK_THEMES.cyberpunk.neonColors['D'],
            'C': DECK_THEMES.cyberpunk.neonColors['C']
        };
    } else if (deckTheme === 'holographic') {
        suitColors = {
            'S': '#00e6ff', // Holo blue
            'H': '#ff00e6', // Holo magenta
            'D': '#ffe600', // Holo yellow
            'C': '#00ffb3'  // Holo green
        };
    } else if (deckTheme === 'cosmic') {
        suitColors = {
            'S': '#7fdfff',
            'H': '#ff7fdc',
            'D': '#ffe97f',
            'C': '#7fffbe'
        };
    } else if (deckTheme === 'christmas') {
        suitColors = {
            'S': '#3A7CA5',  // Darker icy blue for spades
            'H': '#808080',  // Silver for hearts
            'D': '#909090',  // Light silver for diamonds
            'C': '#4A90B8'   // Darker icy blue for clubs
        };
    } else {
        suitColors = {
            'S': '#1a1a1a',
            'H': '#C41E3A',
            'D': '#C41E3A',
            'C': '#1a1a1a'
        };
    }

    // Apply corner color helper override for holographic (or color-blind)
    const cornerOverride = typeof getCornerSuitColors === 'function' ? getCornerSuitColors(deckTheme, false) : null;
    if (cornerOverride) {
        suitColors = cornerOverride;
    }

    const suit = suitSymbols[suitCode] || suitCode;
    const color = suitColors[suitCode] || '#000000';
    const displayRank = rankCode === 'T' ? '10' : rankCode;

    // Check if this is a face card
    const isFaceCard = ['J', 'Q', 'K'].includes(rankCode);

    // Apply neon glow if theme requires it
    if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    }

    // Scale font sizes by 0.75 and use themed fonts
    // Compute corner fill & glow so top-left and bottom-right match
    let cornerFill = color;
    let cornerGlow = null;
    let frostedCornerData = null;
    // If holographic/corner override exists, it was already applied to `color`
    if (deckTheme === 'cosmic') {
        const cd = applyCosmicGradient(ctx, suitCode, x + 20, y + 50);
        if (cd) {
            cornerFill = cd.glow;
            cornerGlow = cd.glow;
        }
    } else if (deckTheme === 'christmas') {
        frostedCornerData = applyFrostedGradient(ctx, suitCode, x + 20, y + 30);
        if (frostedCornerData) {
            cornerFill = frostedCornerData.gradient;  // For suit glyphs only
            cornerGlow = frostedCornerData.glow;
        }
    }

    // Draw rank in top-left
    // For cosmic theme the rank should be light for readability (match hand rendering)
    // For christmas theme, use flat color for rank readability
    ctx.save();
    const rankFill = (deckTheme === 'cosmic') ? '#E0E0E0' : (deckTheme === 'christmas') ? color : cornerFill;
    ctx.fillStyle = rankFill;
    ctx.font = isFaceCard ? `bold 22px ${theme.faceFont}` : `bold 21px ${theme.font}`;
    if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
        ctx.shadowBlur = 1.5;
        ctx.shadowOffsetX = 0.8;
        ctx.shadowOffsetY = 0.8;
    }
    // Add cosmic glow to rank - reduce blur for wider text (10, face cards)
    if (deckTheme === 'cosmic') {
        // Disable glow for wider characters to prevent border overlap
        const isWideRank = (displayRank === '10' || isFaceCard);
        if (!isWideRank) {
            ctx.shadowColor = '#7fdfff';
            ctx.shadowBlur = 5;
        }
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    } else if (deckTheme === 'cyberpunk') {
        // Apply cyberpunk neon glow to rank
        const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(displayRank, x + 9, y + 9);
    ctx.restore();

    // Draw suit in top-left using same corner fill (rank kept as separate color)
    ctx.save();
    ctx.font = `19px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // Reset all shadow properties to ensure consistent positioning across suits
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    if (deckTheme === 'cosmic') {
        ctx.shadowColor = cornerGlow || '#7fdfff';
        ctx.shadowBlur = 5;
    } else if (deckTheme === 'cyberpunk') {
        // Apply cyberpunk neon glow to suit
        const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
    } else if (deckTheme === 'christmas' && frostedCornerData) {
        // Apply frosted gradient to top-left suit
        ctx.shadowColor = frostedCornerData.glow;
        ctx.shadowBlur = 4;
    } else {
        ctx.shadowColor = cornerGlow ? cornerGlow : ( (color === '#C41E3A' || deckTheme === 'neon') ? `${color}40` : 'transparent');
        ctx.shadowBlur = cornerGlow ? 6 : 2;
    }
    ctx.fillStyle = cornerFill;
    // Uniform position for all cards
    ctx.fillText(suit, x + 9, y + 30);
    ctx.restore();

    // Draw large centered suit with styling - try to match hand rendering (use gradients/glow for special themes)
    ctx.font = `48px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const shouldGlow = (color === '#C41E3A' || deckTheme === 'neon');

    if (deckTheme === 'holographic') {
        const holoData = applyHolographicGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (holoData) {
            ctx.shadowColor = holoData.glow;
            ctx.shadowBlur = 12;
            ctx.fillStyle = holoData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            ctx.shadowBlur = 0;
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.5;
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        } else {
            ctx.fillStyle = color;
            ctx.fillText(suit, x + width / 2, y + height / 2);
        }
    } else if (deckTheme === 'cosmic') {
        // Use cosmic gradient for center suit like hand rendering but scaled
        ctx.save();
        const cosmicData = applyCosmicGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (cosmicData) {
            ctx.shadowColor = cosmicData.glow;
            ctx.shadowBlur = 12;
            ctx.fillStyle = cosmicData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
            ctx.strokeStyle = '#000033';
            ctx.lineWidth = 1.2;
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        } else {
            ctx.fillStyle = color;
            ctx.fillText(suit, x + width / 2, y + height / 2);
        }
        ctx.restore();
    } else if (deckTheme === 'cyberpunk') {
        // Multi-layer neon glow effect scaled down for trick cards
        const cyberpunkTheme = DECK_THEMES.cyberpunk;
        const neonColor = cyberpunkTheme.neonColors[suitCode];
        ctx.font = `48px ${theme.font}`;
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 18;
        ctx.fillStyle = neonColor + '70';
        ctx.fillText(suit, x + width / 2, y + height / 2);
        ctx.shadowBlur = 8;
        ctx.fillStyle = neonColor + '80';
        ctx.fillText(suit, x + width / 2, y + height / 2);
        ctx.shadowBlur = 4;
        ctx.fillStyle = neonColor;
        ctx.fillText(suit, x + width / 2, y + height / 2);
        ctx.shadowBlur = 0;
        // subtle chromatic aberration
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = cyberpunkTheme.glitchColors[suitCode][0];
        ctx.fillText(suit, x + width / 2 - 1, y + height / 2 - 0.5);
        ctx.fillStyle = cyberpunkTheme.glitchColors[suitCode][1];
        ctx.fillText(suit, x + width / 2 + 1, y + height / 2 + 0.5);
        ctx.globalAlpha = 1.0;
    } else if (deckTheme === 'christmas') {
        // Frosted theme - holographic-style icy gradient (scaled for trick cards)
        // Draw large snowflake behind the glyph (scaled down)
        drawLargeSnowflake(ctx, x + width / 2, y + height / 2, 24);
        
        const frostedData = applyFrostedGradient(ctx, suitCode, x + width / 2, y + height / 2);
        if (frostedData) {
            ctx.font = `42px ${theme.font}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Apply icy glow
            ctx.shadowColor = frostedData.glow;
            ctx.shadowBlur = 12;
            ctx.fillStyle = frostedData.gradient;
            ctx.fillText(suit, x + width / 2, y + height / 2);
            
            // Add crisp white outline for frost effect
            ctx.shadowBlur = 0;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1;
            ctx.strokeText(suit, x + width / 2, y + height / 2);
        }
    } else {
        // Standard rendering and neon fallback
        if (theme.shadows) {
            ctx.shadowColor = 'rgba(0, 0, 0, 0.06)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 1.5;
            ctx.shadowOffsetY = 1.5;
        } else if (deckTheme === 'neon') {
            applyNeonGlow(ctx, suitCode);
        }
        ctx.fillStyle = color;
        ctx.fillText(suit, x + width / 2, y + height / 2);

        // Add subtle glow to center suit when appropriate
        if (shouldGlow && theme.shadows) {
            ctx.shadowColor = `${color}25`;
            ctx.shadowBlur = 6;
            ctx.fillText(suit, x + width / 2, y + height / 2);
        }
    }

    // Draw rank in bottom-right (upside down)
    ctx.save();
    ctx.translate(x + width - 7, y + height - 6);
    ctx.rotate(Math.PI);
    ctx.font = isFaceCard ? `bold 22px ${theme.faceFont}` : `bold 21px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = rankFill || color;
    
    // Set glow for rank based on theme
    if (deckTheme === 'cosmic') {
        // Disable glow for wider characters to prevent border overlap
        const isWideRank = (displayRank === '10' || isFaceCard);
        if (!isWideRank) {
            ctx.shadowColor = '#7fdfff';
            ctx.shadowBlur = 5;
        }
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    } else if (theme.shadows) {
        ctx.shadowColor = 'rgba(0, 0, 0, 0.12)';
        ctx.shadowBlur = 1.5;
        ctx.shadowOffsetX = 0.8;
        ctx.shadowOffsetY = 0.8;
    } else if (deckTheme === 'neon') {
        applyNeonGlow(ctx, suitCode);
    }
    ctx.fillText(displayRank, 0, 0);

    // Draw suit in bottom-right (upside down)
    ctx.font = `19px ${theme.font}`;
    // Ensure we use the correct color for this card's suit
    const bottomRightColor = (deckTheme === 'cyberpunk') ? DECK_THEMES.cyberpunk.neonColors[suitCode] : (cornerFill || color);
    if (deckTheme === 'cosmic') {
        // Disable glow on bottom-right suit to prevent border overlap
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    } else if (deckTheme === 'cyberpunk') {
        // Apply cyberpunk neon glow to bottom-right suit
        const neonColor = DECK_THEMES.cyberpunk.neonColors[suitCode];
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    } else if (deckTheme === 'christmas' && frostedCornerData) {
        // Apply frosted gradient to bottom-right suit
        ctx.shadowColor = frostedCornerData.glow;
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    } else {
        ctx.shadowColor = cornerGlow ? cornerGlow : ( (color === '#C41E3A' || deckTheme === 'neon') ? `${color}40` : 'transparent');
        ctx.shadowBlur = cornerGlow ? 6 : 2;
    }
    ctx.fillStyle = (deckTheme === 'christmas' && frostedCornerData) ? cornerFill : bottomRightColor;
    ctx.fillText(suit, 0, 22);
    ctx.restore();

    // Add face card embellishments (scaled down, unless minimalist theme or cosmic theme)
    if (isFaceCard && !theme.simple && deckTheme !== 'cosmic') {
        ctx.shadowColor = 'transparent';
        ctx.strokeStyle = color + '20';
        ctx.lineWidth = 0.8;
        
        const cornerSize = 11;
        
        // Top-left corner decoration
        ctx.beginPath();
        ctx.moveTo(x + 9, y + 9);
        ctx.lineTo(x + 9 + cornerSize, y + 9);
        ctx.moveTo(x + 9, y + 9);
        ctx.lineTo(x + 9, y + 9 + cornerSize);
        ctx.stroke();
        
        // Bottom-right corner decoration
        ctx.save();
        ctx.translate(x + width - 9, y + height - 9);
        ctx.rotate(Math.PI);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(cornerSize, 0);
        ctx.moveTo(0, 0);
        ctx.lineTo(0, cornerSize);
        ctx.stroke();
        ctx.restore();
    }
}

/**
 * Generates an image showing multiple card backs (for dealing animation or Blind Nil)
 * @param {number} count - Number of card backs to show
 * @param {string} theme - Card back theme
 * @returns {Buffer} PNG image buffer
 */
/** Fan `count` copies of an artwork deck's back image. */
function _renderImageBacks(count, deckTheme) {
    const back = _imageThemeBacks.get(deckTheme);
    const cardHeight = IMAGE_HAND_HEIGHT;
    const cardWidth = Math.round(cardHeight * (back.width / back.height));
    const overlap = Math.round(cardWidth * 0.46);
    const totalWidth = cardWidth + overlap * Math.max(0, count - 1);
    const canvas = createCanvas(totalWidth, cardHeight);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, totalWidth, cardHeight);
    for (let i = 0; i < count; i++) {
        _drawRoundedImage(ctx, back, i * overlap, 0, cardWidth, cardHeight);
    }
    return canvas.toBuffer('image/png');
}

export function renderCardBacks(count, theme = 'blue', deckTheme = null) {
    // Artwork decks use their own back image (fanned) when one is loaded.
    if (deckTheme && _imageThemeBacks.has(deckTheme)) {
        return _renderImageBacks(count, deckTheme);
    }
    const cardWidth = 102;
    const cardHeight = 143;
    const overlap = 34; // Same overlap as hand rendering
    const totalWidth = cardWidth + (overlap * (count - 1));
    const canvas = createCanvas(totalWidth, cardHeight);
    const ctx = canvas.getContext('2d');

    // Transparent background
    ctx.clearRect(0, 0, totalWidth, cardHeight);

    // Draw each card back with overlap
    for (let i = 0; i < count; i++) {
        const x = i * overlap;
        drawCardBackOnCanvas(ctx, x, 0, cardWidth, cardHeight, theme);
    }

    return canvas.toBuffer('image/png');
}

/**
 * Helper function to draw a card back on a canvas with enhanced styling
 */
function drawCardBackOnCanvas(ctx, x, y, width, height, theme = 'blue') {
    // Handle Christmas/Frosted theme specially
    if (theme === 'christmas') {
        // Icy blue gradient background
        const bgGradient = ctx.createLinearGradient(x, y, x + width, y + height);
        bgGradient.addColorStop(0, '#E8F4F8');
        bgGradient.addColorStop(0.3, '#D4E9F0');
        bgGradient.addColorStop(0.6, '#C5DDE8');
        bgGradient.addColorStop(1, '#B8D4E3');
        ctx.fillStyle = bgGradient;
        ctx.fillRect(x, y, width, height);
        
        // Ice blue outer border
        ctx.strokeStyle = '#87CEEB';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(x + 2, y + 2, width - 4, height - 4);
        
        // Powder blue inner border
        ctx.strokeStyle = '#B0E0E6';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 8, y + 8, width - 16, height - 16);
        
        // Draw large decorative snowflake in center
        ctx.save();
        ctx.strokeStyle = 'rgba(135, 206, 235, 0.7)';
        ctx.lineWidth = 2;
        
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        const armLength = 40;
        
        // Draw 6 main arms with branches
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            
            // Main arm
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(centerX + Math.cos(angle) * armLength, centerY + Math.sin(angle) * armLength);
            ctx.stroke();
            
            // Branches at 1/3 of the arm
            const branch1X = centerX + Math.cos(angle) * armLength * 0.4;
            const branch1Y = centerY + Math.sin(angle) * armLength * 0.4;
            const branchLen1 = armLength * 0.35;
            
            ctx.beginPath();
            ctx.moveTo(branch1X, branch1Y);
            ctx.lineTo(branch1X + Math.cos(angle + 0.6) * branchLen1, branch1Y + Math.sin(angle + 0.6) * branchLen1);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(branch1X, branch1Y);
            ctx.lineTo(branch1X + Math.cos(angle - 0.6) * branchLen1, branch1Y + Math.sin(angle - 0.6) * branchLen1);
            ctx.stroke();
            
            // Branches at 2/3 of the arm
            const branch2X = centerX + Math.cos(angle) * armLength * 0.7;
            const branch2Y = centerY + Math.sin(angle) * armLength * 0.7;
            const branchLen2 = armLength * 0.28;
            
            ctx.beginPath();
            ctx.moveTo(branch2X, branch2Y);
            ctx.lineTo(branch2X + Math.cos(angle + 0.5) * branchLen2, branch2Y + Math.sin(angle + 0.5) * branchLen2);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.moveTo(branch2X, branch2Y);
            ctx.lineTo(branch2X + Math.cos(angle - 0.5) * branchLen2, branch2Y + Math.sin(angle - 0.5) * branchLen2);
            ctx.stroke();
        }
        
        // Inner circle accent
        ctx.strokeStyle = 'rgba(135, 206, 235, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(centerX, centerY, 12, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.restore();
        return; // Early return for Christmas theme
    }

    const themes = {
        'blue': { 
            gradStart: '#1E3A8A', 
            gradEnd: '#2563EB',
            pattern: '#3B82F6', 
            accent: '#60A5FA',
            center: '#93C5FD'
        },
        'red': { 
            gradStart: '#7F1D1D', 
            gradEnd: '#DC2626',
            pattern: '#EF4444', 
            accent: '#F87171',
            center: '#FCA5A5'
        },
        'green': { 
            gradStart: '#14532D', 
            gradEnd: '#16A34A',
            pattern: '#22C55E', 
            accent: '#4ADE80',
            center: '#86EFAC'
        },
        'purple': { 
            gradStart: '#581C87', 
            gradEnd: '#B026FF',
            pattern: '#C084FC', 
            accent: '#D8B4FE',
            center: '#E9D5FF'
        },
        'classic': { 
            gradStart: '#1F2937', 
            gradEnd: '#374151',
            pattern: '#4B5563', 
            accent: '#6B7280',
            center: '#9CA3AF'
        }
    };

    const colors = themes[theme] || themes['blue'];

    // Enhanced card background with gradient
    const bgGradient = ctx.createLinearGradient(x, y, x + width, y + height);
    bgGradient.addColorStop(0, colors.gradStart);
    bgGradient.addColorStop(1, colors.gradEnd);
    ctx.fillStyle = bgGradient;
    ctx.fillRect(x, y, width, height);

    // Add subtle shadow for depth
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;

    // Card border with enhanced styling
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(x + 2, y + 2, width - 4, height - 4);
    
    // Inner decorative border
    ctx.strokeStyle = colors.accent + '80';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(x + 6, y + 6, width - 12, height - 12);

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Enhanced decorative pattern - diamond lattice
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    ctx.strokeStyle = colors.pattern + '60';
    ctx.lineWidth = 2.5;
    for (let j = -height; j < width; j += 12) {
        ctx.beginPath();
        ctx.moveTo(x + j, y);
        ctx.lineTo(x + j + height, y + height);
        ctx.stroke();
    }

    // Opposite diagonal for lattice effect
    ctx.strokeStyle = colors.pattern + '40';
    ctx.lineWidth = 2;
    for (let j = 0; j < width + height; j += 12) {
        ctx.beginPath();
        ctx.moveTo(x + j, y + height);
        ctx.lineTo(x + j - height, y);
        ctx.stroke();
    }

    // Add shimmer accent lines
    ctx.strokeStyle = colors.accent + '80';
    ctx.lineWidth = 1;
    for (let j = -height + 6; j < width; j += 24) {
        ctx.beginPath();
        ctx.moveTo(x + j, y);
        ctx.lineTo(x + j + height, y + height);
        ctx.stroke();
    }

    ctx.restore();

    // Enhanced center decorative element with gradient
    const centerGradient = ctx.createRadialGradient(
        x + width / 2, y + height / 2, 0,
        x + width / 2, y + height / 2, 30
    );
    centerGradient.addColorStop(0, colors.center + 'CC');
    centerGradient.addColorStop(0.7, colors.pattern + 'AA');
    centerGradient.addColorStop(1, colors.gradStart + '99');

    // Outer ring with glow
    ctx.shadowColor = colors.accent;
    ctx.shadowBlur = 6;
    ctx.fillStyle = centerGradient;
    ctx.beginPath();
    ctx.arc(x + width / 2, y + height / 2, 28, 0, Math.PI * 2);
    ctx.fill();

    // Inner circle
    ctx.shadowBlur = 3;
    ctx.fillStyle = colors.gradStart;
    ctx.beginPath();
    ctx.arc(x + width / 2, y + height / 2, 22, 0, Math.PI * 2);
    ctx.fill();

    // Center dot with highlight
    ctx.shadowBlur = 0;
    ctx.fillStyle = colors.center;
    ctx.beginPath();
    ctx.arc(x + width / 2, y + height / 2, 8, 0, Math.PI * 2);
    ctx.fill();

    // Decorative corner elements
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = colors.accent + '60';
    
    // Top-left corner
    ctx.beginPath();
    ctx.arc(x + 15, y + 15, 5, 0, Math.PI * 2);
    ctx.fill();
    
    // Top-right corner
    ctx.beginPath();
    ctx.arc(x + width - 15, y + 15, 5, 0, Math.PI * 2);
    ctx.fill();
    
    // Bottom-left corner
    ctx.beginPath();
    ctx.arc(x + 15, y + height - 15, 5, 0, Math.PI * 2);
    ctx.fill();
    
    // Bottom-right corner
    ctx.beginPath();
    ctx.arc(x + width - 15, y + height - 15, 5, 0, Math.PI * 2);
    ctx.fill();
}
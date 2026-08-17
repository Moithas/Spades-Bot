// scripts/slice_deck_sheet.js
//
// Slices a 13x4 deck sprite sheet (rows: Spades, Hearts, Diamonds, Clubs; cols: A..K) into
// 52 individual card PNGs. The sheet has black margins + gutters between cards, so instead of
// assuming an even grid we AUTO-DETECT each card's bounds by projecting luminance: gutters are
// ~black columns/rows, cards are bright. Works even for dark cards because each column/row band
// spans bright content from the other suits/ranks.
//
// Usage: node scripts/slice_deck_sheet.js <themeDir>   (default: assets/themes/Alien)

import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';

const THEME_DIR = process.argv[2] || './assets/themes/Alien';
const SHEET = path.join(THEME_DIR, 'sheet.png');
const OUT = path.join(THEME_DIR, 'cards');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K']; // columns
const SUITS = ['S', 'H', 'D', 'C']; // rows, top -> bottom
const THRESH = 40;   // luminance (0-255) above which a pixel counts as "card content"
const DETECT_SCALE = 0.25; // detect on a downscaled copy for speed/memory; crop from full res

const sheet = await loadImage(SHEET);
const FW = sheet.width, FH = sheet.height;
console.log(`sheet: ${FW} x ${FH}`);

const dw = Math.round(FW * DETECT_SCALE), dh = Math.round(FH * DETECT_SCALE);
const dc = createCanvas(dw, dh);
const dctx = dc.getContext('2d');
dctx.drawImage(sheet, 0, 0, dw, dh);
const { data } = dctx.getImageData(0, 0, dw, dh);
const lum = (x, y) => { const i = (y * dw + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };

const colMax = new Array(dw).fill(0);
for (let x = 0; x < dw; x++) { let m = 0; for (let y = 0; y < dh; y++) { const l = lum(x, y); if (l > m) m = l; } colMax[x] = m; }
const rowMax = new Array(dh).fill(0);
for (let y = 0; y < dh; y++) { let m = 0; for (let x = 0; x < dw; x++) { const l = lum(x, y); if (l > m) m = l; } rowMax[y] = m; }

function bands(arr, minLen) {
  const b = [];
  let start = -1;
  for (let i = 0; i < arr.length; i++) {
    const on = arr[i] > THRESH;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) { b.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) b.push([start, arr.length - 1]);
  return b.filter(([a, z]) => (z - a + 1) >= minLen);
}

const colBands = bands(colMax, (dw / 13) * 0.4);
const rowBands = bands(rowMax, (dh / 4) * 0.4);

console.log(`detected columns: ${colBands.length} (want 13), rows: ${rowBands.length} (want 4)`);
console.log('col widths (scaled px):', colBands.map(([a, z]) => z - a + 1).join(', '));
console.log('row heights (scaled px):', rowBands.map(([a, z]) => z - a + 1).join(', '));

if (colBands.length !== 13 || rowBands.length !== 4) {
  console.error('❌ Grid detection did not find exactly 13x4. Adjust THRESH and retry.');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const inv = 1 / DETECT_SCALE;
let count = 0;
const ratios = [];
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 13; c++) {
    const [cs, ce] = colBands[c];
    const [rs, re] = rowBands[r];
    const sx = Math.round(cs * inv), sy = Math.round(rs * inv);
    const sw = Math.round((ce - cs + 1) * inv), sh = Math.round((re - rs + 1) * inv);
    const cc = createCanvas(sw, sh);
    cc.getContext('2d').drawImage(sheet, sx, sy, sw, sh, 0, 0, sw, sh);
    const code = RANKS[c] + SUITS[r];
    fs.writeFileSync(path.join(OUT, `${code}.png`), cc.toBuffer('image/png'));
    ratios.push(sw / sh);
    count++;
  }
}
const minR = Math.min(...ratios).toFixed(3), maxR = Math.max(...ratios).toFixed(3);
console.log(`✅ wrote ${count} cards to ${OUT}`);
console.log(`card aspect ratios: ${minR} .. ${maxR} (5:7 = 0.714)`);

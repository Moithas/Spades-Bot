// scripts/preview_alien_hand.js
// Composes a sample overlapped "hand" from the sliced Alien cards so we can judge the look
// before wiring it into the renderer. Writes assets/themes/Alien/_hand_preview.png.
import { createCanvas, Image } from 'canvas';
import fs from 'fs';
import path from 'path';

const DIR = './assets/themes/Alien/cards';
const loadSync = (p) => { const i = new Image(); i.src = fs.readFileSync(p); return i; };

// A representative sample hand.
const codes = ['AS', 'KS', 'QS', '9S', 'AH', 'TH', '3H', 'KD', '7D', 'JC', '4C'];
const imgs = codes.map(c => loadSync(path.join(DIR, `${c}.png`)));

const cardHeight = 220;
const aspect = imgs[0].width / imgs[0].height;
const cardWidth = Math.round(cardHeight * aspect);
const overlap = Math.round(cardWidth * 0.46); // how much of each card peeks out
const totalWidth = cardWidth + overlap * (imgs.length - 1);

const canvas = createCanvas(totalWidth, cardHeight);
const ctx = canvas.getContext('2d');
// Simulate Discord dark background
ctx.fillStyle = '#313338';
ctx.fillRect(0, 0, totalWidth, cardHeight);

imgs.forEach((img, i) => {
  const x = i * overlap;
  ctx.drawImage(img, x, 0, cardWidth, cardHeight);
});

fs.writeFileSync('./assets/themes/Alien/_hand_preview.png', canvas.toBuffer('image/png'));
console.log(`hand preview: ${totalWidth} x ${cardHeight} (card ${cardWidth}x${cardHeight}, aspect ${aspect.toFixed(3)})`);

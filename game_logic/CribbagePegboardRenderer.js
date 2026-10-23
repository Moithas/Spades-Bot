import { createCanvas } from 'canvas';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const playerPalette = ['#3b82f6', '#a855f7', '#10b981', '#f97316'];

const drawRoundedRect = (ctx, x, y, width, height, radius, fillStyle) => {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
};

const drawLane = (ctx, lane, laneY, trackLeft, trackRight, targetScore) => {
    const width = trackRight - trackLeft;
    const dots = 31;
    const skunkValue = targetScore - 30;
    const skunkX = trackLeft + (clamp(skunkValue, 0, targetScore) / targetScore) * width;

    drawRoundedRect(ctx, trackLeft - 12, laneY - 16, width + 24, 40, 14, '#f4e6c8');

    ctx.strokeStyle = '#8b5a2b';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(skunkX, laneY - 12);
    ctx.lineTo(skunkX, laneY + 20);
    ctx.stroke();

    for (let i = 0; i < dots; i++) {
        const x = trackLeft + (i / (dots - 1)) * width;
        ctx.beginPath();
        ctx.arc(x, laneY + 2, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#b08968';
        ctx.fill();
    }
};

const drawPegPair = (ctx, score, color, laneY, trackLeft, trackRight, targetScore) => {
    const trackWidth = trackRight - trackLeft;
    const currentScore = clamp(score, 0, targetScore);
    const currentX = trackLeft + (currentScore / targetScore) * trackWidth;

    const trailingDistance = Math.min(18, Math.max(6, trackWidth * 0.04));
    const previousScore = Math.max(0, currentScore - Math.min(10, Math.max(4, score > 0 ? score * 0.08 : 0)));
    const previousX = trackLeft + (clamp(previousScore, 0, targetScore) / targetScore) * trackWidth;

    ctx.beginPath();
    ctx.arc(previousX, laneY + 2, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#1f2937';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(currentX, laneY + 2, 9, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#111827';
    ctx.stroke();

    const rearShift = Math.min(10, trailingDistance * 0.6);
    const shadowX = Math.max(trackLeft, currentX - rearShift);
    ctx.beginPath();
    ctx.arc(shadowX, laneY + 2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(17,24,39,0.18)';
    ctx.fill();
};

/**
 * Render a cribbage pegboard as a PNG buffer.
 * @param {object} game - CribbageManager instance
 * @returns {Buffer}
 */
export const renderCribbagePegboard = (game) => {
    const lanes = game.gameMode === 'partners4' ? 2 : game.players.length;
    const width = 1100;
    const laneHeight = 62;
    const topPad = 70;
    const bottomPad = 40;
    const height = topPad + bottomPad + laneHeight * Math.max(lanes, 1);

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, width, height);

    drawRoundedRect(ctx, 18, 14, width - 36, height - 28, 20, '#d6b98a');
    drawRoundedRect(ctx, 28, 24, width - 56, height - 48, 16, '#e8d5b2');

    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 28px Sans';
    ctx.fillText('Cribbage Pegboard', 50, 60);

    const trackLeft = 280;
    const trackRight = width - 80;
    ctx.font = 'bold 16px Sans';
    ctx.fillText('0', trackLeft - 6, 88);
    ctx.fillText(String(game.targetScore), trackRight - 16, 88);
    const skunk = game.targetScore - 30;
    const skunkX = trackLeft + (clamp(skunk, 0, game.targetScore) / game.targetScore) * (trackRight - trackLeft);
    ctx.fillText(`Skunk ${skunk}`, skunkX - 36, 88);

    const laneEntries = [];
    if (game.gameMode === 'partners4') {
        const team1 = game.players.filter(p => p.team === 1);
        const team2 = game.players.filter(p => p.team === 2);
        laneEntries.push({
            label: `Team 1 (${team1.map(p => p.username).join(' + ') || 'n/a'})`,
            score: team1[0]?.score || 0,
            color: '#2563eb',
        });
        laneEntries.push({
            label: `Team 2 (${team2.map(p => p.username).join(' + ') || 'n/a'})`,
            score: team2[0]?.score || 0,
            color: '#dc2626',
        });
    } else {
        for (let i = 0; i < game.players.length; i++) {
            const p = game.players[i];
            laneEntries.push({
                label: p.username,
                score: p.score,
                color: playerPalette[i % playerPalette.length],
            });
        }
    }

    ctx.font = 'bold 18px Sans';
    laneEntries.forEach((entry, index) => {
        const laneY = topPad + index * laneHeight + 10;
        drawLane(ctx, index, laneY, trackLeft, trackRight, game.targetScore);

        ctx.fillStyle = '#111827';
        ctx.fillText(entry.label, 50, laneY + 8);
        ctx.font = 'bold 17px Sans';
        ctx.fillStyle = '#374151';
        ctx.fillText(`${entry.score}`, 220, laneY + 8);
        ctx.font = 'bold 18px Sans';

        drawPegPair(ctx, entry.score, entry.color, laneY, trackLeft, trackRight, game.targetScore);
    });

    return canvas.toBuffer('image/png');
};


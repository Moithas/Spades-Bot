import { Deck } from './Deck.js';
import { Card } from './Card.js';
import {
    scoreShowHand,
    scorePegPlay,
    hasAnyLegalPegPlay,
    isLegalPegPlay,
    getPipValue,
} from './cribbageScoring.js';

const GAME_MODES = {
    classic2: {
        label: 'Classic (2 Players)',
        maxPlayers: 2,
        handSize: 6,
        discardCount: 2,
        extraCribCardsFromDeck: 0,
        teams: false,
    },
    cutthroat3: {
        label: 'Cutthroat (3 Players)',
        maxPlayers: 3,
        handSize: 5,
        discardCount: 1,
        extraCribCardsFromDeck: 1,
        teams: false,
    },
    partners4: {
        label: 'Partners (4 Players)',
        maxPlayers: 4,
        handSize: 5,
        discardCount: 1,
        extraCribCardsFromDeck: 0,
        teams: true,
    },
    individual4: {
        label: 'Individual (4 Players)',
        maxPlayers: 4,
        handSize: 5,
        discardCount: 1,
        extraCribCardsFromDeck: 0,
        teams: false,
    },
};

const normalizeRank = (rankToken) => {
    const r = (rankToken || '').toUpperCase();
    if (r === '10') return 'T';
    return r;
};

const parseCardCode = (code) => {
    if (!code || typeof code !== 'string') return null;
    const cleaned = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length < 2 || cleaned.length > 3) return null;

    const suitCode = cleaned.slice(-1);
    const rankRaw = cleaned.slice(0, -1);
    const rankCode = normalizeRank(rankRaw);

    if (!['S', 'H', 'D', 'C'].includes(suitCode)) return null;
    if (!['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'].includes(rankCode)) return null;

    return { rankCode, suitCode };
};

const cardToText = (card) => {
    if (!card) return '??';
    const rank = card.rankCode === 'T' ? '10' : card.rankCode;
    return `${rank}${card.symbol || card.suit?.symbol || card.suitCode}`;
};

const cardToJSON = (card) => card ? { rankCode: card.rankCode, suitCode: card.suitCode } : null;
const cardFromJSON = (json) => {
    if (!json || !json.rankCode || !json.suitCode) return null;
    return new Card(json.rankCode, json.suitCode);
};

const createPlayer = ({
    id,
    username,
    isAI = false,
    preferences = {
        colorBlindMode: false,
        cardBackTheme: 'blue',
        deckTheme: 'classic',
    }
}) => ({
    id,
    discordId: id,
    username,
    isAI: !!isAI,
    preferences,
    hand: [],
    score: 0,
    team: null,
});

export default class CribbageManager {
    constructor(publicAnnounce, privatePrompt, { gameMode = 'classic2', targetScore = 121 } = {}) {
        if (!GAME_MODES[gameMode]) {
            throw new Error(`Unknown cribbage mode: ${gameMode}`);
        }
        this.config = GAME_MODES[gameMode];
        this.gameMode = gameMode;
        this.targetScore = targetScore;
        this.publicAnnounce = publicAnnounce;
        this.privatePrompt = privatePrompt;

        this.deck = new Deck();
        this.players = [];
        this.hostId = null;
        this.channelId = null;
        this.state = 'LOBBY';
        this.isGameActive = false;
        this.handNumber = 1;
        this.dealerIndex = 0;
        this.currentPlayerIndex = 0;

        this.crib = [];
        this.starterCard = null;
        this.showHands = new Map();
        this.discardedPlayers = new Set();

        this.pegSequence = [];
        this.runningTotal = 0;
        this.passedPlayers = new Set();
        this.lastCardPlayerIndex = null;
    }

    toSnapshot() {
        return {
            snapshotType: 'cribbage',
            gameMode: this.gameMode,
            targetScore: this.targetScore,
            hostId: this.hostId,
            channelId: this.channelId,
            state: this.state,
            isGameActive: this.isGameActive,
            handNumber: this.handNumber,
            dealerIndex: this.dealerIndex,
            currentPlayerIndex: this.currentPlayerIndex,
            players: this.players.map(p => ({
                id: p.id,
                discordId: p.discordId,
                username: p.username,
                isAI: p.isAI,
                preferences: p.preferences || null,
                score: p.score,
                team: p.team,
                hand: p.hand.map(cardToJSON),
            })),
            crib: this.crib.map(cardToJSON),
            starterCard: cardToJSON(this.starterCard),
            showHands: Array.from(this.showHands.entries()).map(([pid, cards]) => [pid, cards.map(cardToJSON)]),
            discardedPlayers: Array.from(this.discardedPlayers),
            deckCards: (this.deck.cards || []).map(cardToJSON),
            pegSequence: this.pegSequence.map(entry => ({ playerIndex: entry.playerIndex, card: cardToJSON(entry.card) })),
            runningTotal: this.runningTotal,
            passedPlayers: Array.from(this.passedPlayers),
            lastCardPlayerIndex: this.lastCardPlayerIndex,
        };
    }

    static fromSnapshot(snap, { publicAnnounce, privatePrompt } = {}) {
        if (!snap || (snap.snapshotType && snap.snapshotType !== 'cribbage')) {
            throw new Error('Invalid cribbage snapshot.');
        }
        const gm = new CribbageManager(publicAnnounce, privatePrompt, {
            gameMode: snap.gameMode || 'classic2',
            targetScore: snap.targetScore || 121,
        });
        gm.hostId = snap.hostId || null;
        gm.channelId = snap.channelId || null;
        gm.state = snap.state || 'LOBBY';
        gm.isGameActive = !!snap.isGameActive;
        gm.handNumber = snap.handNumber || 1;
        gm.dealerIndex = snap.dealerIndex || 0;
        gm.currentPlayerIndex = snap.currentPlayerIndex || 0;
        gm.players = (snap.players || []).map(p => ({
            id: p.id,
            discordId: p.discordId || p.id,
            username: p.username,
            isAI: !!p.isAI,
            preferences: p.preferences || {
                colorBlindMode: false,
                cardBackTheme: 'blue',
                deckTheme: 'classic',
            },
            score: p.score || 0,
            team: p.team || null,
            hand: (p.hand || []).map(cardFromJSON).filter(Boolean),
        }));
        gm.crib = (snap.crib || []).map(cardFromJSON).filter(Boolean);
        gm.starterCard = cardFromJSON(snap.starterCard);
        gm.showHands = new Map(
            (snap.showHands || []).map(([pid, cards]) => [pid, (cards || []).map(cardFromJSON).filter(Boolean)])
        );
        gm.discardedPlayers = new Set(snap.discardedPlayers || []);
        gm.deck.cards = (snap.deckCards || []).map(cardFromJSON).filter(Boolean);
        gm.pegSequence = (snap.pegSequence || [])
            .map(entry => ({ playerIndex: entry.playerIndex, card: cardFromJSON(entry.card) }))
            .filter(entry => entry.card);
        gm.runningTotal = snap.runningTotal || 0;
        gm.passedPlayers = new Set(snap.passedPlayers || []);
        gm.lastCardPlayerIndex = snap.lastCardPlayerIndex ?? null;
        gm.assignTeams();
        return gm;
    }

    _scoreToTrackPosition(score, width = 30) {
        const clamped = Math.max(0, Math.min(this.targetScore, score || 0));
        return Math.round((clamped / this.targetScore) * width);
    }

    _renderPegTrack(score, marker = '🔹', width = 30) {
        const pos = this._scoreToTrackPosition(score, width);
        const skunkPos = this._scoreToTrackPosition(this.targetScore - 30, width);
        let out = '';
        for (let i = 0; i <= width; i++) {
            if (i === pos) out += marker;
            else if (i === skunkPos) out += '│';
            else out += '·';
        }
        return out;
    }

    getPegboardDisplay() {
        const lines = ['🧷 **Pegboard**', `_Target ${this.targetScore} • Skunk line at ${this.targetScore - 30}_`];
        if (this.players.length === 0) {
            lines.push('No players yet.');
            return lines.join('\n');
        }

        if (this.gameMode === 'partners4') {
            const team1Score = this.players.find(p => p.team === 1)?.score || 0;
            const team2Score = this.players.find(p => p.team === 2)?.score || 0;
            lines.push(`Team 1 (${team1Score}): ${this._renderPegTrack(team1Score, '🔵')}`);
            lines.push(`Team 2 (${team2Score}): ${this._renderPegTrack(team2Score, '🔴')}`);
            return lines.join('\n');
        }

        const markers = ['🔵', '🟣', '🟢', '🟠'];
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            const marker = markers[i % markers.length];
            lines.push(`${p.username} (${p.score}): ${this._renderPegTrack(p.score, marker)}`);
        }
        return lines.join('\n');
    }

    static getGameModes() {
        return GAME_MODES;
    }

    getMaxPlayers() {
        return this.config.maxPlayers;
    }

    isLobbyFull() {
        return this.players.length >= this.getMaxPlayers();
    }

    getPlayerById(playerId) {
        return this.players.find(p => p.discordId === playerId || p.id === playerId);
    }

    addPlayer(playerDetails) {
        if (this.state !== 'LOBBY') return { error: 'Game already started.' };
        if (this.isLobbyFull()) return { error: 'Lobby is already full.' };
        if (this.getPlayerById(playerDetails.id)) return { error: 'Player already joined.' };

        const player = createPlayer({
            id: playerDetails.id,
            username: playerDetails.username,
            isAI: false,
            preferences: playerDetails.preferences
        });
        this.players.push(player);
        if (!this.hostId) this.hostId = player.id;
        this.assignTeams();
        return { success: true, player };
    }

    addAIPlayer(name = null) {
        if (this.state !== 'LOBBY') return { error: 'Game already started.' };
        if (this.isLobbyFull()) return { error: 'Lobby is already full.' };
        const aiNumber = this.players.filter(p => p.isAI).length + 1;
        const aiId = `cribbage-ai-${Date.now()}-${aiNumber}`;
        const player = createPlayer({
            id: aiId,
            username: name || `Cribbage AI ${aiNumber}`,
            isAI: true,
            preferences: {
                colorBlindMode: false,
                cardBackTheme: 'blue',
                deckTheme: 'classic',
            },
        });
        this.players.push(player);
        this.assignTeams();
        return { success: true, player };
    }

    assignTeams() {
        if (this.gameMode !== 'partners4') {
            this.players.forEach(p => { p.team = null; });
            return;
        }
        this.players.forEach((p, idx) => {
            p.team = idx % 2 === 0 ? 1 : 2;
        });
    }

    nextPlayerIndex(index) {
        return (index + 1) % this.players.length;
    }

    getActiveScore(playerIndex) {
        const player = this.players[playerIndex];
        if (!player) return 0;
        if (this.gameMode !== 'partners4') return player.score;
        const teamPlayers = this.players.filter(p => p.team === player.team);
        return teamPlayers[0]?.score || 0;
    }

    awardPoints(playerIndex, points) {
        if (!Number.isFinite(points) || points <= 0) return;
        const player = this.players[playerIndex];
        if (!player) return;

        if (this.gameMode === 'partners4') {
            for (const teammate of this.players.filter(p => p.team === player.team)) {
                teammate.score += points;
            }
            return;
        }

        player.score += points;
    }

    getHandTextForPlayer(playerId) {
        const player = this.getPlayerById(playerId);
        if (!player) return null;
        return player.hand
            .slice()
            .sort((a, b) => b.value - a.value)
            .map(cardToText)
            .join(' ');
    }

    getStatusSummary() {
        const lines = [];
        lines.push(`Mode: **${this.config.label}**`);
        lines.push(`State: **${this.state}**`);
        lines.push(`Hand: **${this.handNumber}**`);
        if (this.players.length > 0) {
            lines.push(`Dealer: **${this.players[this.dealerIndex].username}**`);
        }
        if (this.state === 'PEGGING') {
            lines.push(`Peg total: **${this.runningTotal}**`);
            lines.push(`Turn: **${this.players[this.currentPlayerIndex]?.username || 'n/a'}**`);
            const seq = this.pegSequence.map(e => cardToText(e.card)).join(' ');
            lines.push(`Peg cards: ${seq || 'None'}`);
        }
        lines.push('Scores:');
        if (this.gameMode === 'partners4') {
            const team1 = this.players.find(p => p.team === 1)?.score || 0;
            const team2 = this.players.find(p => p.team === 2)?.score || 0;
            lines.push(`• Team 1: **${team1}**`);
            lines.push(`• Team 2: **${team2}**`);
        } else {
            for (const p of this.players) lines.push(`• ${p.username}: **${p.score}**`);
        }
        lines.push('');
        lines.push(this.getPegboardDisplay());
        return lines.join('\n');
    }

    async startGame() {
        if (this.state !== 'LOBBY') return { error: 'Game already started.' };
        if (!this.isLobbyFull()) return { error: `Need ${this.getMaxPlayers()} players to start.` };
        this.isGameActive = true;
        this.state = 'DEALING';
        return this.startRound();
    }

    async startRound() {
        this.state = 'DEALING';
        this.crib = [];
        this.starterCard = null;
        this.showHands = new Map();
        this.discardedPlayers.clear();
        this.pegSequence = [];
        this.runningTotal = 0;
        this.passedPlayers.clear();
        this.lastCardPlayerIndex = null;

        this.deck.reset();
        this.deck.shuffle();

        for (const p of this.players) {
            p.hand = [];
        }

        for (let i = 0; i < this.config.handSize; i++) {
            for (const player of this.players) {
                const card = this.deck.deal();
                if (card) player.hand.push(card);
            }
        }

        this.state = 'DISCARD';
        if (this.publicAnnounce) {
            const dealer = this.players[this.dealerIndex];
            await this.publicAnnounce(
                `🎴 **Cribbage Hand ${this.handNumber}**\nDealer: **${dealer.username}**\n` +
                `All players discard **${this.config.discardCount}** card(s) using \`/cribbage discard\`.`
            );
        }
        await this.processAITurnsIfNeeded();
        return { success: true };
    }

    collectDiscard(playerId, cardCodes) {
        if (this.state !== 'DISCARD') return { error: 'Not in discard phase.' };
        const player = this.getPlayerById(playerId);
        if (!player) return { error: 'You are not a player in this game.' };
        if (this.discardedPlayers.has(player.id)) return { error: 'You already discarded for this hand.' };

        const expected = this.config.discardCount;
        const tokens = (cardCodes || '')
            .split(/[\s,]+/)
            .map(s => s.trim())
            .filter(Boolean);
        if (tokens.length !== expected) {
            return { error: `You must provide exactly ${expected} card code(s).` };
        }

        const selected = [];
        const usedIndexes = new Set();
        for (const token of tokens) {
            const parsed = parseCardCode(token);
            if (!parsed) return { error: `Invalid card code: ${token}` };

            const idx = player.hand.findIndex((c, handIdx) =>
                !usedIndexes.has(handIdx) &&
                c.rankCode === parsed.rankCode &&
                c.suitCode === parsed.suitCode
            );
            if (idx === -1) return { error: `Card not in hand: ${token}` };
            usedIndexes.add(idx);
            selected.push(player.hand[idx]);
        }

        player.hand = player.hand.filter((_, idx) => !usedIndexes.has(idx));
        this.crib.push(...selected);
        this.discardedPlayers.add(player.id);
        return { success: true, selected };
    }

    allDiscardsIn() {
        return this.discardedPlayers.size === this.players.length;
    }

    cutStarter() {
        this.starterCard = this.deck.deal();
        if (!this.starterCard) return { error: 'Deck had no starter card available.' };

        const dealer = this.players[this.dealerIndex];
        if (this.starterCard.rankCode === 'J') {
            this.awardPoints(this.dealerIndex, 2);
            return { starterCard: this.starterCard, heelsAwarded: dealer.username };
        }
        return { starterCard: this.starterCard, heelsAwarded: null };
    }

    startPegging() {
        this.state = 'PEGGING';
        this.pegSequence = [];
        this.runningTotal = 0;
        this.passedPlayers.clear();
        this.lastCardPlayerIndex = null;
        this.currentPlayerIndex = this.nextPlayerIndex(this.dealerIndex);
    }

    getLegalPegCardsForIndex(playerIndex) {
        const player = this.players[playerIndex];
        if (!player) return [];
        return player.hand.filter(card => isLegalPegPlay(card, this.runningTotal));
    }

    getLegalPegCards(playerId) {
        const idx = this.players.findIndex(p => p.id === playerId || p.discordId === playerId);
        if (idx === -1) return [];
        return this.getLegalPegCardsForIndex(idx);
    }

    playPegCard(playerId, cardCode) {
        if (this.state !== 'PEGGING') return { error: 'Not in pegging phase.' };

        const playerIndex = this.players.findIndex(p => p.id === playerId || p.discordId === playerId);
        if (playerIndex === -1) return { error: 'You are not a player in this game.' };
        if (playerIndex !== this.currentPlayerIndex) return { error: 'It is not your turn.' };

        const parsed = parseCardCode(cardCode);
        if (!parsed) return { error: `Invalid card code: ${cardCode}` };

        const player = this.players[playerIndex];
        const handIndex = player.hand.findIndex(c => c.rankCode === parsed.rankCode && c.suitCode === parsed.suitCode);
        if (handIndex === -1) return { error: 'Card is not in your hand.' };
        const card = player.hand[handIndex];

        if (!isLegalPegPlay(card, this.runningTotal)) {
            return { error: `Cannot play ${cardToText(card)} because it would exceed 31.` };
        }

        player.hand.splice(handIndex, 1);

        const pegResult = scorePegPlay(this.pegSequence, card, this.runningTotal);
        this.runningTotal = pegResult.newTotal;
        this.pegSequence.push({ playerIndex, card });
        this.lastCardPlayerIndex = playerIndex;
        this.passedPlayers.delete(playerIndex);

        if (pegResult.points > 0) {
            this.awardPoints(playerIndex, pegResult.points);
        }

        const events = [];
        if (pegResult.points > 0) {
            events.push(`${this.players[playerIndex].username} scores ${pegResult.points} (${pegResult.reasons.join(', ')})`);
        }

        if (this.runningTotal === 31) {
            events.push('Count reached 31, new count starts.');
            this.resetPegSegmentFrom(playerIndex);
        } else {
            this.advancePegTurnAfterPlay();
        }

        const finished = this.isPeggingFinished();
        if (finished) {
            const finalEvent = this.finishPeggingIfComplete();
            if (finalEvent) events.push(finalEvent);
        }

        return { success: true, card, points: pegResult.points, events, finished: this.isPeggingFinished() };
    }

    declareGo(playerId) {
        if (this.state !== 'PEGGING') return { error: 'Not in pegging phase.' };
        const playerIndex = this.players.findIndex(p => p.id === playerId || p.discordId === playerId);
        if (playerIndex === -1) return { error: 'You are not a player in this game.' };
        if (playerIndex !== this.currentPlayerIndex) return { error: 'It is not your turn.' };

        const player = this.players[playerIndex];
        if (hasAnyLegalPegPlay(player.hand, this.runningTotal)) {
            return { error: 'You still have a legal card to play; you cannot call Go.' };
        }

        this.passedPlayers.add(playerIndex);
        const events = [`${player.username} says "Go".`];
        this.advancePegTurnAfterGo();
        const finished = this.isPeggingFinished();
        if (finished) {
            const finalEvent = this.finishPeggingIfComplete();
            if (finalEvent) events.push(finalEvent);
        }
        return { success: true, events, finished: this.isPeggingFinished() };
    }

    resetPegSegmentFrom(playerIndex) {
        this.pegSequence = [];
        this.runningTotal = 0;
        this.passedPlayers.clear();
        this.currentPlayerIndex = this.findNextPlayerWithCards(playerIndex);
    }

    findNextPlayerWithCards(fromIndex) {
        for (let step = 1; step <= this.players.length; step++) {
            const idx = (fromIndex + step) % this.players.length;
            if (this.players[idx].hand.length > 0) return idx;
        }
        return fromIndex;
    }

    advancePegTurnAfterPlay() {
        const nextIndex = this.nextPlayerIndex(this.currentPlayerIndex);
        const found = this.findNextEligiblePegPlayer(nextIndex);
        if (found === -1) {
            if (this.lastCardPlayerIndex !== null && this.runningTotal !== 31) {
                this.awardPoints(this.lastCardPlayerIndex, 1);
            }
            this.resetPegSegmentFrom(this.lastCardPlayerIndex ?? this.currentPlayerIndex);
            return;
        }
        this.currentPlayerIndex = found;
    }

    advancePegTurnAfterGo() {
        const nextIndex = this.nextPlayerIndex(this.currentPlayerIndex);
        const found = this.findNextEligiblePegPlayer(nextIndex);
        if (found === -1) {
            if (this.lastCardPlayerIndex !== null && this.runningTotal !== 31) {
                this.awardPoints(this.lastCardPlayerIndex, 1);
            }
            this.resetPegSegmentFrom(this.lastCardPlayerIndex ?? this.currentPlayerIndex);
            return;
        }
        this.currentPlayerIndex = found;
    }

    findNextEligiblePegPlayer(startIndex) {
        for (let step = 0; step < this.players.length; step++) {
            const idx = (startIndex + step) % this.players.length;
            const player = this.players[idx];
            if (player.hand.length === 0) continue;
            if (this.passedPlayers.has(idx)) continue;
            if (!hasAnyLegalPegPlay(player.hand, this.runningTotal)) continue;
            return idx;
        }
        return -1;
    }

    isPeggingFinished() {
        return this.players.every(p => p.hand.length === 0);
    }

    finishPeggingIfComplete() {
        if (!this.isPeggingFinished()) return null;
        if (this.runningTotal > 0 && this.lastCardPlayerIndex !== null && this.runningTotal !== 31) {
            this.awardPoints(this.lastCardPlayerIndex, 1);
            this.runningTotal = 0;
            return `${this.players[this.lastCardPlayerIndex].username} scores 1 for last card.`;
        }
        this.runningTotal = 0;
        return null;
    }

    scoreHandsAndCrib() {
        const events = [];
        const orderedIndexes = [];

        let idx = this.nextPlayerIndex(this.dealerIndex);
        for (let i = 0; i < this.players.length; i++) {
            orderedIndexes.push(idx);
            idx = this.nextPlayerIndex(idx);
        }

        for (const playerIndex of orderedIndexes) {
            const player = this.players[playerIndex];
            const handCards = this.showHands.get(player.id) || [];
            const scored = scoreShowHand(handCards, this.starterCard, false);
            if (scored.total > 0) {
                this.awardPoints(playerIndex, scored.total);
            }
            events.push(`🧮 ${player.username} hand scores **${scored.total}**`);
        }

        const dealer = this.players[this.dealerIndex];
        const cribScore = scoreShowHand(this.crib, this.starterCard, true);
        if (cribScore.total > 0) {
            this.awardPoints(this.dealerIndex, cribScore.total);
        }
        events.push(`🗃️ ${dealer.username}'s crib scores **${cribScore.total}**`);
        return events;
    }

    checkGameOver() {
        if (this.gameMode === 'partners4') {
            const team1 = this.players.find(p => p.team === 1)?.score || 0;
            const team2 = this.players.find(p => p.team === 2)?.score || 0;
            if (team1 >= this.targetScore || team2 >= this.targetScore) {
                return {
                    over: true,
                    winnerText: team1 >= team2 ? `Team 1 wins ${team1}-${team2}` : `Team 2 wins ${team2}-${team1}`,
                };
            }
            return { over: false };
        }

        const winner = this.players
            .slice()
            .sort((a, b) => b.score - a.score)
            .find(p => p.score >= this.targetScore);
        if (!winner) return { over: false };
        return { over: true, winnerText: `${winner.username} wins with ${winner.score} points` };
    }

    async finalizeHandAndAdvance() {
        this.state = 'SHOW';
        const scoringEvents = this.scoreHandsAndCrib();
        const gameOver = this.checkGameOver();

        if (this.publicAnnounce) {
            const starter = cardToText(this.starterCard);
            const message = [
                `📌 **Starter:** ${starter}`,
                ...scoringEvents,
                '',
                this.getStatusSummary(),
            ].join('\n');
            await this.publicAnnounce(message);
        }

        if (gameOver.over) {
            this.state = 'GAME_OVER';
            this.isGameActive = false;
            if (this.publicAnnounce) {
                await this.publicAnnounce(`🏁 **Game Over** — ${gameOver.winnerText}`);
            }
            return { finished: true };
        }

        this.dealerIndex = this.nextPlayerIndex(this.dealerIndex);
        this.handNumber += 1;
        await this.startRound();
        return { finished: false };
    }

    chooseAIDiscardCards(playerIndex) {
        const player = this.players[playerIndex];
        const sorted = player.hand
            .slice()
            .sort((a, b) => getPipValue(a) - getPipValue(b) || a.value - b.value);
        return sorted.slice(0, this.config.discardCount);
    }

    chooseAIPegCard(playerIndex) {
        const legal = this.getLegalPegCardsForIndex(playerIndex);
        if (legal.length === 0) return null;

        let best = legal[0];
        let bestScore = -Infinity;
        for (const card of legal) {
            const result = scorePegPlay(this.pegSequence, card, this.runningTotal);
            const heuristic = result.points * 100 - getPipValue(card);
            if (heuristic > bestScore) {
                best = card;
                bestScore = heuristic;
            }
        }
        return best;
    }

    async processAITurnsIfNeeded() {
        let guard = 0;
        while (guard < 200) {
            guard++;
            if (this.state === 'DISCARD') {
                const aiNeedingDiscard = this.players.find(p => p.isAI && !this.discardedPlayers.has(p.id));
                if (!aiNeedingDiscard) break;
                const aiIndex = this.players.findIndex(p => p.id === aiNeedingDiscard.id);
                const picks = this.chooseAIDiscardCards(aiIndex).map(c => `${c.rankCode}${c.suitCode}`);
                this.collectDiscard(aiNeedingDiscard.id, picks.join(' '));
                if (this.publicAnnounce) {
                    await this.publicAnnounce(`🤖 **${aiNeedingDiscard.username}** discarded to the crib.`);
                }
                if (this.allDiscardsIn()) {
                    for (let i = 0; i < this.config.extraCribCardsFromDeck; i++) {
                        const extra = this.deck.deal();
                        if (extra) this.crib.push(extra);
                    }

                    this.showHands = new Map(this.players.map(p => [p.id, p.hand.slice()]));
                    const cut = this.cutStarter();
                    this.startPegging();
                    if (this.publicAnnounce) {
                        const heelText = cut.heelsAwarded ? `\n🂫 His heels: ${cut.heelsAwarded} scores 2.` : '';
                        await this.publicAnnounce(`🔪 Starter cut: **${cardToText(cut.starterCard)}**${heelText}`);
                    }
                }
                continue;
            }

            if (this.state === 'PEGGING') {
                const player = this.players[this.currentPlayerIndex];
                if (!player || !player.isAI) break;
                const selected = this.chooseAIPegCard(this.currentPlayerIndex);
                if (!selected) {
                    const goResult = this.declareGo(player.id);
                    if (goResult.error) break;
                    if (this.publicAnnounce) {
                        await this.publicAnnounce(`🤖 **${player.username}** says "Go".`);
                    }
                } else {
                    const playResult = this.playPegCard(player.id, `${selected.rankCode}${selected.suitCode}`);
                    if (playResult.error) break;
                    if (this.publicAnnounce) {
                        await this.publicAnnounce(`🤖 **${player.username}** plays **${cardToText(selected)}** (count ${this.runningTotal}).`);
                    }
                }

                if (this.isPeggingFinished()) {
                    await this.finalizeHandAndAdvance();
                    continue;
                }
                continue;
            }

            break;
        }
    }
}

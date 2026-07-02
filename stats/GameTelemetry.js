import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TELEMETRY_FILE = path.join(__dirname, 'gameTelemetry.json');

const MAX_ROUNDS = 20000;
const MAX_GAMES = 5000;

const DEFAULT_DATA = {
  version: 1,
  updatedAt: null,
  rounds: [],
  games: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class GameTelemetryStore {
  constructor() {
    this.data = clone(DEFAULT_DATA);
    this.loadSync();
  }

  loadSync() {
    try {
      if (!fs.existsSync(TELEMETRY_FILE)) {
        this.saveSync();
        return;
      }

      const raw = fs.readFileSync(TELEMETRY_FILE, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      this.data = {
        ...clone(DEFAULT_DATA),
        ...parsed,
        rounds: Array.isArray(parsed.rounds) ? parsed.rounds : [],
        games: Array.isArray(parsed.games) ? parsed.games : []
      };
    } catch (error) {
      logger.error('Failed to load game telemetry store:', error);
      this.data = clone(DEFAULT_DATA);
    }
  }

  saveSync() {
    try {
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.error('Failed to save game telemetry store:', error);
    }
  }

  recordRound(entry) {
    this.data.rounds.push({
      timestamp: new Date().toISOString(),
      ...entry
    });

    if (this.data.rounds.length > MAX_ROUNDS) {
      this.data.rounds = this.data.rounds.slice(-MAX_ROUNDS);
    }

    this.saveSync();
  }

  recordGame(entry) {
    this.data.games.push({
      timestamp: new Date().toISOString(),
      ...entry
    });

    if (this.data.games.length > MAX_GAMES) {
      this.data.games = this.data.games.slice(-MAX_GAMES);
    }

    this.saveSync();
  }

  getSnapshot() {
    return clone(this.data);
  }
}

export const gameTelemetryStore = new GameTelemetryStore();
export { TELEMETRY_FILE };

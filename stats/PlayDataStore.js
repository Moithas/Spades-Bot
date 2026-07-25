// stats/PlayDataStore.js
//
// Dedicated capture store for imitation-learning data from games that include humans.
// Records, per completed round: game mode, each player's dealt hand (reconstructed
// from the trick history) + bid + tricks + nil, and the full trick-by-trick play
// sequence. This is the state->action data needed to later learn from how (strong)
// humans bid and play. Kept separate from gameTelemetry to avoid bloating it, and
// every record is tagged with gameMode so classic (2v2) and cutthroat data never mix.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLAY_DATA_FILE = path.join(__dirname, 'humanPlayData.json');

const MAX_ROUNDS = 20000;

const DEFAULT_DATA = {
  version: 1,
  updatedAt: null,
  rounds: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class PlayDataStore {
  constructor() {
    this.data = clone(DEFAULT_DATA);
    this.loadSync();
  }

  loadSync() {
    try {
      if (!fs.existsSync(PLAY_DATA_FILE)) {
        this.saveSync();
        return;
      }
      const raw = fs.readFileSync(PLAY_DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      this.data = {
        ...clone(DEFAULT_DATA),
        ...parsed,
        rounds: Array.isArray(parsed.rounds) ? parsed.rounds : []
      };
    } catch (error) {
      logger.error('Failed to load play data store:', error);
      this.data = clone(DEFAULT_DATA);
    }
  }

  saveSync() {
    try {
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(PLAY_DATA_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.error('Failed to save play data store:', error);
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

  getSnapshot() {
    return clone(this.data);
  }
}

export const playDataStore = new PlayDataStore();
export { PLAY_DATA_FILE };

// stats/GameStateStore.js
//
// Persists in-progress games so they survive a process restart (deploys / crashes).
// Live games otherwise exist only in the in-memory `activeGames` map in index.js, which a
// `pm2 restart` wipes. This store keeps a channelId -> GameManager snapshot map in a single
// JSON file. Writes are debounced (games mutate on every card). Snapshots are produced by
// GameManager.toSnapshot() and rebuilt by GameManager.fromSnapshot() on boot.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_FILE = path.join(__dirname, 'activeGames.json');
const SAVE_DEBOUNCE_MS = 1000;

const DEFAULT_DATA = { version: 1, updatedAt: null, games: {} };

export class GameStateStore {
  constructor() {
    this.data = { ...DEFAULT_DATA, games: {} };
    this._dirty = false;
    this._timer = null;
    this.loadSync();
  }

  loadSync() {
    try {
      if (!fs.existsSync(STORE_FILE)) return;
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      this.data = {
        version: 1,
        updatedAt: parsed.updatedAt || null,
        games: parsed.games && typeof parsed.games === 'object' ? parsed.games : {},
      };
    } catch (error) {
      logger.error('Failed to load game state store:', error);
      this.data = { ...DEFAULT_DATA, games: {} };
    }
  }

  saveNow() {
    try {
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(STORE_FILE, JSON.stringify(this.data), 'utf8');
      this._dirty = false;
    } catch (error) {
      logger.error('Failed to save game state store:', error);
    }
  }

  saveSoon() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /** Store/replace a game's snapshot (debounced write). */
  put(channelId, snapshot) {
    if (!channelId || !snapshot) return;
    this.data.games[channelId] = snapshot;
    this.saveSoon();
  }

  /** Remove a game's snapshot (e.g. on game over). */
  remove(channelId) {
    if (channelId && this.data.games[channelId]) {
      delete this.data.games[channelId];
      this.saveSoon();
    }
  }

  /** All persisted snapshots as a plain { channelId: snapshot } map. */
  getAll() {
    return this.data.games || {};
  }

  has(channelId) {
    return !!(this.data.games && this.data.games[channelId]);
  }
}

export const gameStateStore = new GameStateStore();
export { STORE_FILE };

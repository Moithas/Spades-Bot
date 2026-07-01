import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEARNING_FILE = path.join(__dirname, 'aiLearningProfile.json');

const DEFAULT_PROFILE = {
  version: 1,
  updatedAt: null,
  hardProfile: {
    trials: 1200,
    riskAversion: 0.38,
    aggressiveness: 0.82,
    nilBidThreshold: 0.82,
    bidAdjustment: 0,
    learningGeneration: 0,
    source: 'default'
  },
  selfPlayHistory: [],
  evaluations: []
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AILearning {
  constructor() {
    this.data = clone(DEFAULT_PROFILE);
    this.loadSync();
  }

  loadSync() {
    try {
      if (!fs.existsSync(LEARNING_FILE)) {
        this.saveSync();
        return;
      }

      const raw = fs.readFileSync(LEARNING_FILE, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      this.data = {
        ...clone(DEFAULT_PROFILE),
        ...parsed,
        hardProfile: {
          ...clone(DEFAULT_PROFILE).hardProfile,
          ...(parsed.hardProfile || {})
        },
        selfPlayHistory: Array.isArray(parsed.selfPlayHistory) ? parsed.selfPlayHistory : [],
        evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : []
      };
    } catch (error) {
      logger.error('❌ Failed to load AI learning profile:', error);
      this.data = clone(DEFAULT_PROFILE);
    }
  }

  saveSync() {
    try {
      this.data.updatedAt = new Date().toISOString();
      fs.writeFileSync(LEARNING_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      logger.error('❌ Failed to save AI learning profile:', error);
    }
  }

  getHardProfile() {
    return {
      ...clone(DEFAULT_PROFILE).hardProfile,
      ...(this.data.hardProfile || {})
    };
  }

  updateHardProfile(profile, metadata = {}) {
    const current = this.getHardProfile();
    const generation = typeof metadata.learningGeneration === 'number'
      ? metadata.learningGeneration
      : (current.learningGeneration || 0) + 1;

    this.data.hardProfile = {
      ...current,
      ...profile,
      learningGeneration: generation,
      source: metadata.source || 'self-play'
    };

    this.saveSync();
    return this.getHardProfile();
  }

  recordEvaluation(entry) {
    this.data.evaluations.push({
      timestamp: new Date().toISOString(),
      ...entry
    });

    if (this.data.evaluations.length > 500) {
      this.data.evaluations = this.data.evaluations.slice(-500);
    }

    this.saveSync();
  }

  recordSelfPlayRun(entry) {
    this.data.selfPlayHistory.push({
      timestamp: new Date().toISOString(),
      ...entry
    });

    if (this.data.selfPlayHistory.length > 500) {
      this.data.selfPlayHistory = this.data.selfPlayHistory.slice(-500);
    }

    this.saveSync();
  }
}

export const aiLearning = new AILearning();
export { LEARNING_FILE };

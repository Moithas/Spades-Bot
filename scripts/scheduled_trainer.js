// scripts/scheduled_trainer.js
//
// Hands-off scheduled self-play trainer. Runs a bounded training session using the
// existing evolutionary trainer (train_hard_ai.js), which only promotes a new hard
// profile if it passes strict validation gates. The live bot hot-reloads the profile
// (see stats/AILearning.js maybeReload) at the next game, so no restart is needed.
//
// Designed to run on a schedule (e.g. weekly, low-traffic hours) via pm2 cron:
//   pm2 start scripts/scheduled_trainer.js --name spades-trainer \
//       --no-autorestart --cron-restart "0 4 * * 0"
//
// Safety: lock file prevents overlap, hard runtime cap, low process priority, and a
// timestamped audit log at stats/trainer.log.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROFILE_FILE = path.join(ROOT, 'stats', 'aiLearningProfile.json');
const LOG_FILE = path.join(ROOT, 'stats', 'trainer.log');
const LOCK_FILE = path.join(ROOT, 'stats', '.trainer.lock');

// Conservative, bounded training args:
// iterations selfPlaySamples targetScore mediumSamples timeoutMs finalSamples candidatesPerIteration
const TRAIN_ARGS = ['scripts/train_hard_ai.js', '2', '6', '333', '6', '90000', '6', '3'];
const MAX_RUNTIME_MS = 2.5 * 60 * 60 * 1000; // safety cap
const LOCK_STALE_MS = 6 * 60 * 60 * 1000;    // treat a lock older than this as stale

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* ignore */ }
  process.stdout.write(line);
}

function readProfile() {
  try {
    const raw = fs.readFileSync(PROFILE_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw).hardProfile || null;
  } catch {
    return null;
  }
}

function cleanup() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// --- Acquire lock (skip if another run is active) ---
try {
  if (fs.existsSync(LOCK_FILE)) {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (age < LOCK_STALE_MS) {
      log('Trainer already running (lock present). Skipping this run.');
      process.exit(0);
    }
    log('Stale lock found; overriding.');
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
} catch (e) {
  log(`Failed to acquire lock: ${e.message}`);
  process.exit(0);
}

const before = readProfile();
log(`=== Scheduled training start === before=${JSON.stringify(before)}`);

const child = spawn(process.execPath, TRAIN_ARGS, {
  cwd: ROOT,
  env: { ...process.env, BENCHMARK_FAST: '1' }
});

// Lower priority so training yields CPU to the live bot (best effort; Linux/macOS).
try { os.setPriority(child.pid, 15); } catch { /* not supported / not permitted */ }

let output = '';
child.stdout.on('data', d => { output += d.toString(); });
child.stderr.on('data', d => { output += d.toString(); });

const killTimer = setTimeout(() => {
  log('Max runtime exceeded; terminating training run.');
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
}, MAX_RUNTIME_MS);

child.on('exit', (code) => {
  clearTimeout(killTimer);
  const after = readProfile();
  const beforeGen = before?.learningGeneration ?? 0;
  const afterGen = after?.learningGeneration ?? 0;
  const promoted = afterGen > beforeGen;
  const finalLine = (output.match(/Final hard vs medium:.*/g) || []).pop() || 'n/a';
  log(`Training exited code=${code}. promoted=${promoted} (gen ${beforeGen}->${afterGen}). ${finalLine}`);
  if (promoted) log(`New profile=${JSON.stringify(after)}`);
  log('=== Scheduled training end ===');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

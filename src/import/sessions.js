// File-backed wizard session store. Same shape as CoinHub's — sessions
// at data/import-sessions/{uuid}.json so the multi-step flow survives
// container restarts. Older than 6h get swept on every read.

import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = resolve(__dirname, '../../data/import-sessions');
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

mkdirSync(SESSION_DIR, { recursive: true });

function pathFor(sid) {
  if (!/^[a-zA-Z0-9-]+$/.test(sid)) throw new Error('invalid session id');
  return join(SESSION_DIR, `${sid}.json`);
}

export function createSession(payload) {
  const sid = randomUUID();
  writeFileSync(pathFor(sid), JSON.stringify({ createdAt: Date.now(), ...payload }));
  sweep();
  return sid;
}

export function readSession(sid) {
  try {
    return JSON.parse(readFileSync(pathFor(sid), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function updateSession(sid, patch) {
  const cur = readSession(sid);
  if (!cur) throw new Error('session not found');
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  writeFileSync(pathFor(sid), JSON.stringify(next));
  return next;
}

export function deleteSession(sid) {
  try { unlinkSync(pathFor(sid)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function sweep() {
  const now = Date.now();
  for (const name of readdirSync(SESSION_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const full = join(SESSION_DIR, name);
      if (now - statSync(full).mtimeMs > SESSION_TTL_MS) unlinkSync(full);
    } catch { /* ignore */ }
  }
}

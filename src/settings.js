// Tiny key/value cache over the `settings` table. Reads are warm
// (60-second TTL) so every page render doesn't hit the DB; writes
// invalidate the cache so changes via /admin/settings show up
// immediately.

import { pool } from './db.js';

const TTL_MS = 60_000;
let cache = null;
let cacheLoadedAt = 0;

async function load() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']));
  cacheLoadedAt = Date.now();
  return cache;
}

export async function getAll() {
  if (!cache || Date.now() - cacheLoadedAt > TTL_MS) {
    await load();
  }
  return cache;
}

export async function get(key, fallback = '') {
  const all = await getAll();
  return all[key] ?? fallback;
}

export async function update(patch) {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [key, value],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  cache = null;
}

/**
 * Express middleware that exposes settings to every view as `res.locals.settings`.
 * Templates (header, footer, etc.) read from there without re-fetching.
 */
export function settingsMiddleware() {
  return async (_req, res, next) => {
    try {
      res.locals.settings = await getAll();
      next();
    } catch (e) {
      next(e);
    }
  };
}

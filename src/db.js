// Single shared pg pool. Importers re-use this so we don't spin up a
// new connection per request.

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

export const pool = new Pool({ connectionString: url });

pool.on('error', (err) => {
  console.error('[pg pool]', err);
});

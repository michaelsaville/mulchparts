// Idempotent schema migrator. Re-running is safe: every CREATE is
// guarded with IF NOT EXISTS, and seed inserts use ON CONFLICT DO
// NOTHING so manual edits to settings don't get clobbered.

import pg from 'pg';
import 'dotenv/config';

const { Client } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS manufacturers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS machine_models (
  id              SERIAL PRIMARY KEY,
  manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manufacturer_id, name)
);

CREATE TABLE IF NOT EXISTS parts (
  id                SERIAL PRIMARY KEY,
  machine_model_id  INTEGER NOT NULL REFERENCES machine_models(id) ON DELETE CASCADE,
  part_name         TEXT NOT NULL,
  description       TEXT,
  -- Vendor part number when supplied. Inconsistent across vendors per
  -- the user — when present we dedupe on it, when absent we fall back
  -- to (manufacturer + model + name + description).
  part_number       TEXT,
  photo_filename    TEXT,
  internal_notes    TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS parts_model_idx ON parts(machine_model_id);
CREATE INDEX IF NOT EXISTS parts_part_number_idx ON parts(part_number) WHERE part_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_active_idx ON parts(is_active) WHERE is_active = TRUE;

-- Quote requests submitted via the public form. Status starts at NEW;
-- admins flip to RESPONDED / CLOSED as they work the queue. Email
-- delivery is the primary channel — this table is the audit log.
CREATE TABLE IF NOT EXISTS quote_requests (
  id              SERIAL PRIMARY KEY,
  part_id         INTEGER REFERENCES parts(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT,
  company         TEXT,
  quantity        TEXT,
  message         TEXT,
  status          TEXT NOT NULL DEFAULT 'NEW',
  ip              TEXT,
  user_agent      TEXT,
  email_sent_at   TIMESTAMPTZ,
  email_error     TEXT,
  ntfy_sent_at    TIMESTAMPTZ,
  ntfy_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Additive on existing deployments: idempotent ALTER for the ntfy fields
-- (ADD COLUMN IF NOT EXISTS is Postgres-native and leaves rows alone).
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ntfy_sent_at TIMESTAMPTZ;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS ntfy_error TEXT;
CREATE INDEX IF NOT EXISTS quote_requests_status_idx ON quote_requests(status);
CREATE INDEX IF NOT EXISTS quote_requests_created_idx ON quote_requests(created_at DESC);

-- Single-row settings table. key/value text pairs let admins change
-- destination email, SMTP creds, footer copy, etc. without a redeploy.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

// Seed only the KEYS — values default to empty so the admin must fill
// them in via /admin/settings before the contact form will deliver.
const SEED_SETTINGS = [
  ['destination_email',   '',                       'Where quote-request emails are delivered (one address)'],
  ['reply_to_email',      '',                       'Reply-To header on outbound emails (optional, defaults to sender)'],
  ['smtp_host',           'smtpout.secureserver.net', 'GoDaddy 365 SMTP host'],
  ['smtp_port',           '587',                    'SMTP port (587 STARTTLS or 465 implicit TLS)'],
  ['smtp_secure',         'false',                  '"true" for port 465 implicit TLS, "false" for STARTTLS on 587'],
  ['smtp_user',           '',                       'SMTP login (typically the From address)'],
  ['smtp_password',       '',                       'SMTP password — write-only; never echoed back to the form'],
  ['from_email',          '',                       'From: address on outbound mail (must match SMTP-authorized sender)'],
  ['from_name',           'Mulchparts Quote Desk',  'Display name on outbound mail'],
  ['business_name',       'MinFab Mulch Parts',     'Brand name shown in header / footer'],
  ['business_address',    '356 Waxler Rd, Keyser, WV 26726', 'Physical address shown in footer'],
  ['business_phone',      '(304) 788-5855',         'Primary phone shown in header / footer'],
  ['business_hours',      'Mon–Fri 6 am – 10 pm',   'Operating hours shown in footer'],
  ['business_email',      'info@mulchparts.com',    'Public-facing contact email shown in footer'],
  ['hero_headline',       'American-made parts for mulch grinders & wood waste machinery', 'H1 on the homepage'],
  ['hero_subhead',        'Browse the catalog, request a quote, and our team will follow up with specs and pricing tailored to your machine.', 'Subhead under the H1'],
  // Default to the in-docker URL so publishing works the moment the
  // stack comes up — no dependency on the public DNS / cert being live.
  // The PUBLIC URL (https://mulchparts-ntfy.pcc2k.com) is what phones
  // use to subscribe; admins are pointed at it from the settings UI.
  ['ntfy_url',            'http://ntfy:80', 'Internal URL the app posts to (default http://ntfy:80 inside docker)'],
  // Topic name is seeded with a random suffix per-deploy so the topic
  // isn't trivially guessable from the public URL alone. Override here
  // or via the admin settings page.
  ['ntfy_topic',          `mulchparts-quotes-${Math.random().toString(36).slice(2, 10)}`, 'Topic name on the ntfy server (keep hard to guess if anonymous)'],
  ['ntfy_token',          '',                       'Optional Bearer token if the topic is access-controlled — leave blank for anonymous'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set — copy .env.example to .env');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    console.log('Applying schema…');
    await client.query(SCHEMA);

    console.log('Seeding settings keys (existing values preserved)…');
    for (const [key, value, _hint] of SEED_SETTINGS) {
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
    }

    await client.query('COMMIT');
    console.log('Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

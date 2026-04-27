// Mulchparts — quote-only parts catalog.
//
// Public side: browse parts, request a quote (form → email + DB log).
// Admin side: parts CRUD, quote-requests inbox, import wizard, settings.
//
// Mounted as a single Express app on PORT (defaults to 3000 in the
// container; nginx on the host reverse-proxies https://mulchparts.pcc2k.com
// → port 3007 → container :3000).

import express from 'express';
import compression from 'compression';
import basicAuth from 'express-basic-auth';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { pool } from './db.js';
import { settingsMiddleware, get as getSetting } from './settings.js';
import { sendQuoteEmail } from './mailer.js';
import { sendQuoteNotification } from './notifier.js';
import { createAdminRouter } from './admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';

const app = express();
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use('/public', express.static(PUBLIC_DIR, { maxAge: '7d' }));
app.use('/uploads', express.static(UPLOADS_DIR, { maxAge: '7d' }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Settings drive the header / footer / hero copy on every page.
app.use(settingsMiddleware());

// ─── Public routes ──────────────────────────────────────────────────

app.get('/', async (_req, res, next) => {
  try {
    const [{ rows: counts }, { rows: manufacturers }] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM parts WHERE is_active) AS parts,
          (SELECT COUNT(*)::int FROM machine_models) AS models,
          (SELECT COUNT(DISTINCT manufacturer_id)::int FROM machine_models) AS manufacturers
      `),
      pool.query(`
        SELECT m.id, m.name,
               COUNT(DISTINCT mm.id)::int AS model_count,
               COUNT(p.id)::int AS part_count
        FROM manufacturers m
        LEFT JOIN machine_models mm ON mm.manufacturer_id = m.id
        LEFT JOIN parts p ON p.machine_model_id = mm.id AND p.is_active
        GROUP BY m.id, m.name
        HAVING COUNT(p.id) > 0
        ORDER BY m.name
      `),
    ]);
    res.render('home', {
      title: 'Mulchparts — American-made grinder parts',
      counts: counts[0],
      manufacturers,
    });
  } catch (e) { next(e); }
});

app.get('/parts', async (req, res, next) => {
  const manufacturerId = req.query.manufacturer
    ? parseInt(req.query.manufacturer, 10)
    : null;
  const modelId = req.query.model ? parseInt(req.query.model, 10) : null;
  const q = (req.query.q || '').toString().trim();
  try {
    const [{ rows: manufacturers }, { rows: models }, { rows: parts }] =
      await Promise.all([
        pool.query(`
          SELECT m.id, m.name FROM manufacturers m
          WHERE EXISTS (
            SELECT 1 FROM machine_models mm
            JOIN parts p ON p.machine_model_id = mm.id AND p.is_active
            WHERE mm.manufacturer_id = m.id
          )
          ORDER BY m.name
        `),
        manufacturerId
          ? pool.query(
              `SELECT id, name FROM machine_models
               WHERE manufacturer_id = $1
               ORDER BY name`,
              [manufacturerId],
            )
          : Promise.resolve({ rows: [] }),
        pool.query(
          `
          SELECT p.id, p.part_name, p.description, p.part_number, p.photo_filename,
                 mm.name AS machine_model, m.name AS manufacturer,
                 m.id AS manufacturer_id, mm.id AS machine_model_id
          FROM parts p
          JOIN machine_models mm ON mm.id = p.machine_model_id
          JOIN manufacturers m ON m.id = mm.manufacturer_id
          WHERE p.is_active
            AND ($1::int IS NULL OR m.id = $1::int)
            AND ($2::int IS NULL OR mm.id = $2::int)
            AND ($3::text = ''
                 OR p.part_name ILIKE '%' || $3 || '%'
                 OR p.description ILIKE '%' || $3 || '%'
                 OR p.part_number ILIKE '%' || $3 || '%')
          ORDER BY m.name, mm.name, p.sort_order, p.part_name
          LIMIT 500
        `,
          [manufacturerId, modelId, q],
        ),
      ]);
    res.render('parts_list', {
      title: 'Parts catalog',
      manufacturers,
      models,
      parts,
      filter: { manufacturerId, modelId, q },
    });
  } catch (e) { next(e); }
});

app.get('/parts/:id', async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.sendStatus(400);
  try {
    const { rows } = await pool.query(
      `
      SELECT p.*, mm.name AS machine_model, m.name AS manufacturer,
             m.id AS manufacturer_id, mm.id AS machine_model_id
      FROM parts p
      JOIN machine_models mm ON mm.id = p.machine_model_id
      JOIN manufacturers m ON m.id = mm.manufacturer_id
      WHERE p.id = $1 AND p.is_active
    `,
      [id],
    );
    if (!rows[0]) return res.sendStatus(404);
    res.render('part_detail', { title: rows[0].part_name, part: rows[0] });
  } catch (e) { next(e); }
});

// /quote is the universal contact form. With ?partId=N it pre-fills
// the part. The same URL serves both the rendered form (GET) and the
// post-submit thank-you (POST → render quote_sent).
app.get('/quote', async (req, res, next) => {
  const partId = req.query.partId ? parseInt(req.query.partId, 10) : null;
  try {
    let part = null;
    if (partId) {
      const { rows } = await pool.query(
        `
        SELECT p.id, p.part_name, p.description, p.part_number,
               mm.name AS machine_model, m.name AS manufacturer
        FROM parts p
        JOIN machine_models mm ON mm.id = p.machine_model_id
        JOIN manufacturers m ON m.id = mm.manufacturer_id
        WHERE p.id = $1 AND p.is_active
      `,
        [partId],
      );
      part = rows[0] ?? null;
    }
    res.render('quote_form', {
      title: part ? `Request a quote — ${part.part_name}` : 'Contact us',
      part,
      values: {},
      error: null,
    });
  } catch (e) { next(e); }
});

app.post('/quote', async (req, res, next) => {
  const partId = req.body.part_id ? parseInt(req.body.part_id, 10) : null;
  const values = {
    customer_name: (req.body.customer_name || '').trim(),
    email: (req.body.email || '').trim(),
    phone: (req.body.phone || '').trim() || null,
    company: (req.body.company || '').trim() || null,
    quantity: (req.body.quantity || '').trim() || null,
    message: (req.body.message || '').trim() || null,
  };

  if (!values.customer_name || !values.email) {
    return renderForm(res, partId, values, 'Name and email are required.');
  }
  // Honeypot — bots fill out invisible "website" field; humans don't.
  if (req.body.website) {
    return res.render('quote_sent', { title: 'Thanks' });
  }

  try {
    let part = null;
    if (partId) {
      const { rows } = await pool.query(
        `
        SELECT p.id, p.part_name, p.description, p.part_number,
               mm.name AS machine_model, m.name AS manufacturer
        FROM parts p
        JOIN machine_models mm ON mm.id = p.machine_model_id
        JOIN manufacturers m ON m.id = mm.manufacturer_id
        WHERE p.id = $1
      `,
        [partId],
      );
      part = rows[0] ?? null;
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || null;
    const userAgent = req.headers['user-agent'] || null;

    const { rows: created } = await pool.query(
      `INSERT INTO quote_requests
         (part_id, customer_name, email, phone, company, quantity, message, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        partId, values.customer_name, values.email, values.phone,
        values.company, values.quantity, values.message, ip, userAgent,
      ],
    );
    const requestId = created[0].id;

    // Try to email; if it fails, log the error against the request but
    // still show the customer the success page — they shouldn't have
    // to retype because of an SMTP issue on our side. Admin sees the
    // failure in the inbox.
    const baseUrl = (await getSetting('public_base_url')) || process.env.PUBLIC_BASE_URL || '';
    const partUrl = part && baseUrl ? `${baseUrl.replace(/\/$/, '')}/parts/${part.id}` : null;
    const adminUrl = baseUrl
      ? `${baseUrl.replace(/\/$/, '')}/admin/requests/${requestId}`
      : null;

    // Email + push run in parallel — neither blocks the customer's
    // thank-you, neither failure suppresses the other.
    const fanout = await Promise.all([
      sendQuoteEmail({ request: { ...values, id: requestId }, part, partUrl, adminUrl })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
      sendQuoteNotification({ request: { ...values, id: requestId }, part, partUrl, adminUrl }),
    ]);
    const [emailRes, ntfyRes] = fanout;
    if (emailRes.ok) {
      await pool.query(
        `UPDATE quote_requests SET email_sent_at = NOW(), email_error = NULL WHERE id = $1`,
        [requestId],
      );
    } else {
      console.error('[quote] email send failed', emailRes.error);
      await pool.query(
        `UPDATE quote_requests SET email_error = $2 WHERE id = $1`,
        [requestId, String(emailRes.error).slice(0, 500)],
      );
    }
    if (ntfyRes.ok) {
      await pool.query(
        `UPDATE quote_requests SET ntfy_sent_at = NOW(), ntfy_error = NULL WHERE id = $1`,
        [requestId],
      );
    } else if (!ntfyRes.skipped) {
      console.error('[quote] ntfy send failed', ntfyRes.error);
      await pool.query(
        `UPDATE quote_requests SET ntfy_error = $2 WHERE id = $1`,
        [requestId, String(ntfyRes.error).slice(0, 500)],
      );
    }

    res.render('quote_sent', { title: 'Thanks — we\'ll be in touch' });
  } catch (e) { next(e); }
});

async function renderForm(res, partId, values, error) {
  let part = null;
  if (partId) {
    const { rows } = await pool.query(
      `
      SELECT p.id, p.part_name, p.description, p.part_number,
             mm.name AS machine_model, m.name AS manufacturer
      FROM parts p
      JOIN machine_models mm ON mm.id = p.machine_model_id
      JOIN manufacturers m ON m.id = mm.manufacturer_id
      WHERE p.id = $1
    `,
      [partId],
    );
    part = rows[0] ?? null;
  }
  res.status(400).render('quote_form', {
    title: 'Contact us',
    part,
    values,
    error,
  });
}

app.get('/contact', (_req, res) => res.redirect('/quote'));

// ─── Admin (Basic Auth) ────────────────────────────────────────────

// Build the admin user table. Two formats are supported:
//
//   MULCHPARTS_ADMIN_USERS=user1:pass1,user2:pass2     (preferred — multi-user)
//   MULCHPARTS_ADMIN_USER=...  + MULCHPARTS_ADMIN_PASSWORD=...   (legacy single)
//
// The multi-user form wins when set; the singular pair is kept for backward
// compatibility with the original .env from initial deploy. Note the simple
// parser splits on first ":" only, so passwords may contain ":". Passwords
// with literal "," need to be set via the JSON form (TODO if ever needed).
const adminUsers = {};
if (process.env.MULCHPARTS_ADMIN_USERS) {
  for (const entry of process.env.MULCHPARTS_ADMIN_USERS.split(',')) {
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const user = entry.slice(0, idx).trim();
    const pass = entry.slice(idx + 1);
    if (user && pass) adminUsers[user] = pass;
  }
}
if (Object.keys(adminUsers).length === 0) {
  const adminUser = process.env.MULCHPARTS_ADMIN_USER || 'admin';
  const adminPassword = process.env.MULCHPARTS_ADMIN_PASSWORD;
  if (adminPassword) adminUsers[adminUser] = adminPassword;
}
if (Object.keys(adminUsers).length === 0) {
  console.error(
    'No admin credentials — set MULCHPARTS_ADMIN_USERS=user1:pass1,user2:pass2',
  );
  process.exit(1);
}
console.log(`admin users loaded: ${Object.keys(adminUsers).join(', ')}`);

app.use(
  '/admin',
  basicAuth({
    users: adminUsers,
    challenge: true,
    realm: 'Mulchparts Admin',
  }),
  createAdminRouter(pool, UPLOADS_DIR),
);

// ─── Errors ────────────────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).send('Internal Server Error');
});

const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`mulchparts listening on :${port}`));

// Admin router. Mounted at /admin in src/server.js, behind Basic Auth
// (which is in turn behind the company VPN — defense in depth).
//
// Owns:
//   /admin                    — dashboard
//   /admin/parts              — list + add + edit + delete + photo upload
//   /admin/requests           — inbox of public quote-requests, mark status
//   /admin/settings           — destination email, SMTP creds, footer copy
//   /admin/import/*           — wizard router (separate file)

import express from 'express';
import multer from 'multer';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { update as updateSettings } from './settings.js';
import { createWizardRouter } from './import/wizard.js';

const VALID_REQUEST_STATUSES = new Set(['NEW', 'RESPONDED', 'CLOSED']);
const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

export function createAdminRouter(pool, uploadsDir) {
  const router = express.Router();

  mkdirSync(uploadsDir, { recursive: true });
  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: uploadsDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, `${randomUUID()}${PHOTO_EXTS.has(ext) ? ext : '.bin'}`);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB photo cap
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!PHOTO_EXTS.has(ext)) return cb(new Error('Photo must be jpg/png/webp/gif'));
      cb(null, true);
    },
  });

  // ─── Dashboard ─────────────────────────────────────────────────────
  router.get('/', async (_req, res, next) => {
    try {
      const [{ rows: counts }, { rows: recent }] = await Promise.all([
        pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM parts) AS parts,
            (SELECT COUNT(*)::int FROM parts WHERE is_active) AS parts_active,
            (SELECT COUNT(*)::int FROM machine_models) AS models,
            (SELECT COUNT(*)::int FROM manufacturers) AS manufacturers,
            (SELECT COUNT(*)::int FROM quote_requests WHERE status = 'NEW') AS new_requests,
            (SELECT COUNT(*)::int FROM quote_requests) AS total_requests
        `),
        pool.query(`
          SELECT qr.id, qr.customer_name, qr.email, qr.status, qr.created_at,
                 qr.email_error,
                 p.part_name, m.name AS manufacturer
          FROM quote_requests qr
          LEFT JOIN parts p ON p.id = qr.part_id
          LEFT JOIN machine_models mm ON mm.id = p.machine_model_id
          LEFT JOIN manufacturers m ON m.id = mm.manufacturer_id
          ORDER BY qr.created_at DESC
          LIMIT 10
        `),
      ]);
      res.render('admin/dashboard', {
        title: 'Admin · Dashboard',
        active: 'dashboard',
        counts: counts[0],
        recent,
      });
    } catch (e) { next(e); }
  });

  // ─── Parts list + filter ───────────────────────────────────────────
  router.get('/parts', async (req, res, next) => {
    const q = (req.query.q || '').toString().trim();
    const manufacturerId = req.query.manufacturer
      ? parseInt(req.query.manufacturer, 10)
      : null;
    try {
      const [{ rows: manufacturers }, { rows: parts }] = await Promise.all([
        pool.query(`SELECT id, name FROM manufacturers ORDER BY name`),
        pool.query(
          `
          SELECT p.id, p.part_name, p.description, p.part_number, p.is_active,
                 p.photo_filename, mm.name AS machine_model, m.name AS manufacturer
          FROM parts p
          JOIN machine_models mm ON mm.id = p.machine_model_id
          JOIN manufacturers m ON m.id = mm.manufacturer_id
          WHERE ($1::int IS NULL OR m.id = $1::int)
            AND ($2::text = ''
                 OR p.part_name ILIKE '%' || $2 || '%'
                 OR p.description ILIKE '%' || $2 || '%'
                 OR p.part_number ILIKE '%' || $2 || '%')
          ORDER BY m.name, mm.name, p.part_name
          LIMIT 500
        `,
          [manufacturerId, q],
        ),
      ]);
      res.render('admin/parts_list', {
        title: 'Admin · Parts',
        active: 'parts',
        manufacturers,
        parts,
        filter: { q, manufacturerId },
      });
    } catch (e) { next(e); }
  });

  router.get('/parts/new', async (_req, res, next) => {
    try {
      const { rows: manufacturers } = await pool.query(
        `SELECT m.id, m.name,
                COALESCE(json_agg(json_build_object('id', mm.id, 'name', mm.name) ORDER BY mm.name) FILTER (WHERE mm.id IS NOT NULL), '[]') AS models
         FROM manufacturers m
         LEFT JOIN machine_models mm ON mm.manufacturer_id = m.id
         GROUP BY m.id, m.name
         ORDER BY m.name`,
      );
      res.render('admin/part_form', {
        title: 'Admin · New part',
        active: 'parts',
        part: null,
        manufacturers,
        error: null,
      });
    } catch (e) { next(e); }
  });

  router.get('/parts/:id/edit', async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    try {
      const [{ rows: parts }, { rows: manufacturers }] = await Promise.all([
        pool.query(
          `SELECT p.*, mm.manufacturer_id FROM parts p
           JOIN machine_models mm ON mm.id = p.machine_model_id
           WHERE p.id = $1`,
          [id],
        ),
        pool.query(
          `SELECT m.id, m.name,
                  COALESCE(json_agg(json_build_object('id', mm.id, 'name', mm.name) ORDER BY mm.name) FILTER (WHERE mm.id IS NOT NULL), '[]') AS models
           FROM manufacturers m
           LEFT JOIN machine_models mm ON mm.manufacturer_id = m.id
           GROUP BY m.id, m.name
           ORDER BY m.name`,
        ),
      ]);
      if (!parts[0]) return res.sendStatus(404);
      res.render('admin/part_form', {
        title: 'Admin · Edit part',
        active: 'parts',
        part: parts[0],
        manufacturers,
        error: null,
      });
    } catch (e) { next(e); }
  });

  // POST /admin/parts — create OR update.
  // The form posts both new-part fields (manufacturer_name + model_name)
  // AND existing-part fields (manufacturer_id + machine_model_id) — we
  // pick whichever the form submits.
  router.post('/parts', photoUpload.single('photo'), async (req, res, next) => {
    const id = req.body.id ? parseInt(req.body.id, 10) : null;
    const partName = (req.body.part_name || '').trim();
    const description = (req.body.description || '').trim() || null;
    const partNumber = (req.body.part_number || '').trim() || null;
    const internalNotes = (req.body.internal_notes || '').trim() || null;
    const isActive = req.body.is_active === 'on' || req.body.is_active === '1';

    if (!partName) {
      // Re-render with error — don't drop the user's typing.
      return res.status(400).send('part_name is required');
    }

    try {
      // Resolve machine model — either existing id or "create on the fly"
      // by name pair.
      let machineModelId = req.body.machine_model_id
        ? parseInt(req.body.machine_model_id, 10)
        : null;
      if (!machineModelId) {
        const manufacturerName = (req.body.manufacturer_name || '').trim();
        const modelName = (req.body.machine_model_name || '').trim();
        if (!manufacturerName || !modelName) {
          return res.status(400).send('Pick or name a manufacturer + model');
        }
        machineModelId = await ensureMachineModel(
          pool,
          manufacturerName,
          modelName,
        );
      }

      let photoFilename = null;
      if (req.file) photoFilename = req.file.filename;

      if (id) {
        // Update — if a new photo arrived, replace the old one and
        // delete the file. If no new photo, keep the existing reference.
        const { rows: existing } = await pool.query(
          'SELECT photo_filename FROM parts WHERE id = $1',
          [id],
        );
        const finalPhoto = photoFilename ?? existing[0]?.photo_filename ?? null;
        await pool.query(
          `UPDATE parts SET
             machine_model_id = $2,
             part_name = $3,
             description = $4,
             part_number = $5,
             internal_notes = $6,
             is_active = $7,
             photo_filename = $8,
             updated_at = NOW()
           WHERE id = $1`,
          [
            id, machineModelId, partName, description, partNumber,
            internalNotes, isActive, finalPhoto,
          ],
        );
        if (photoFilename && existing[0]?.photo_filename) {
          // Best-effort cleanup of the orphaned photo file.
          try { unlinkSync(path.join(uploadsDir, existing[0].photo_filename)); } catch {}
        }
        return res.redirect(`/admin/parts/${id}/edit`);
      }

      const { rows: created } = await pool.query(
        `INSERT INTO parts
           (machine_model_id, part_name, description, part_number,
            internal_notes, photo_filename, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          machineModelId, partName, description, partNumber,
          internalNotes, photoFilename, isActive,
        ],
      );
      res.redirect(`/admin/parts/${created[0].id}/edit`);
    } catch (e) { next(e); }
  });

  router.post('/parts/:id/delete', async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows: existing } = await pool.query(
        'SELECT photo_filename FROM parts WHERE id = $1',
        [id],
      );
      await pool.query('DELETE FROM parts WHERE id = $1', [id]);
      if (existing[0]?.photo_filename) {
        try { unlinkSync(path.join(uploadsDir, existing[0].photo_filename)); } catch {}
      }
      res.redirect('/admin/parts');
    } catch (e) { next(e); }
  });

  // ─── Quote requests inbox ──────────────────────────────────────────
  router.get('/requests', async (req, res, next) => {
    const status = req.query.status || '';
    try {
      const { rows } = await pool.query(
        `
        SELECT qr.*, p.part_name, mm.name AS machine_model, m.name AS manufacturer
        FROM quote_requests qr
        LEFT JOIN parts p ON p.id = qr.part_id
        LEFT JOIN machine_models mm ON mm.id = p.machine_model_id
        LEFT JOIN manufacturers m ON m.id = mm.manufacturer_id
        WHERE ($1::text = '' OR qr.status = $1)
        ORDER BY qr.created_at DESC
        LIMIT 200
      `,
        [status],
      );
      res.render('admin/requests_list', {
        title: 'Admin · Quote requests',
        active: 'requests',
        requests: rows,
        statusFilter: status,
      });
    } catch (e) { next(e); }
  });

  router.get('/requests/:id', async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    try {
      const { rows } = await pool.query(
        `
        SELECT qr.*, p.id AS part_id, p.part_name, p.description AS part_description,
               p.part_number, mm.name AS machine_model, m.name AS manufacturer
        FROM quote_requests qr
        LEFT JOIN parts p ON p.id = qr.part_id
        LEFT JOIN machine_models mm ON mm.id = p.machine_model_id
        LEFT JOIN manufacturers m ON m.id = mm.manufacturer_id
        WHERE qr.id = $1
      `,
        [id],
      );
      if (!rows[0]) return res.sendStatus(404);
      res.render('admin/request_detail', {
        title: `Admin · Request #${id}`,
        active: 'requests',
        request: rows[0],
      });
    } catch (e) { next(e); }
  });

  router.post('/requests/:id/status', async (req, res, next) => {
    const id = parseInt(req.params.id, 10);
    const status = req.body.status;
    if (!VALID_REQUEST_STATUSES.has(status)) return res.sendStatus(400);
    try {
      await pool.query(
        'UPDATE quote_requests SET status = $2 WHERE id = $1',
        [id, status],
      );
      res.redirect(`/admin/requests/${id}`);
    } catch (e) { next(e); }
  });

  // ─── Settings ──────────────────────────────────────────────────────
  router.get('/settings', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        'SELECT key, value FROM settings ORDER BY key',
      );
      res.render('admin/settings', {
        title: 'Admin · Settings',
        active: 'settings',
        settings: Object.fromEntries(rows.map((r) => [r.key, r.value ?? ''])),
        saved: req.query.saved === '1',
      });
    } catch (e) { next(e); }
  });

  router.post('/settings', async (req, res, next) => {
    try {
      const patch = {};
      // Secret-shaped fields preserve their existing value when the
      // form is submitted blank — admins shouldn't have to retype a
      // password / token on every save. Explicit non-blank input wins.
      const PRESERVE_IF_BLANK = new Set(['smtp_password', 'ntfy_token']);
      for (const [k, v] of Object.entries(req.body)) {
        if (PRESERVE_IF_BLANK.has(k) && (!v || v.trim() === '')) continue;
        patch[k] = (v || '').trim();
      }
      await updateSettings(patch);
      res.redirect('/admin/settings?saved=1');
    } catch (e) { next(e); }
  });

  // ─── Import wizard (mounted under /admin/import) ───────────────────
  router.use('/import', createWizardRouter(pool));

  return router;
}

// Helper: find-or-create manufacturer + model by name. Used by the
// part form's "type a new manufacturer + model" path so admins don't
// have to bounce out to a separate "manage manufacturers" page.
async function ensureMachineModel(pool, manufacturerName, modelName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: mfg } = await client.query(
      `INSERT INTO manufacturers (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [manufacturerName],
    );
    const { rows: mdl } = await client.query(
      `INSERT INTO machine_models (manufacturer_id, name) VALUES ($1, $2)
       ON CONFLICT (manufacturer_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [mfg[0].id, modelName],
    );
    await client.query('COMMIT');
    return mdl[0].id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export { ensureMachineModel };

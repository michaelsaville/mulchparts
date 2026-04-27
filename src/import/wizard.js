// Import wizard. Five steps:
//   1. POST  /admin/import                — file upload, parse, create session
//   2. GET   /admin/import/:sid/pick-sheet (multi-sheet only)
//   3. POST  /admin/import/:sid/pick-sheet
//   4. GET/POST /admin/import/:sid/map    — column-mapping form
//   5. GET   /admin/import/:sid/preview   — dedup decisions
//   6. POST  /admin/import/:sid/commit    — execute insert / update
//   7. GET   /admin/import/:sid/done      — results
//
// Per-duplicate resolutions:
//   skip       — re-entry of same row, ignore
//   subpart    — same name but distinct part variant, insert as new
//   update     — same part, refresh description / part_number / notes

import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import {
  TARGET_FIELDS,
  autoDetectMapping,
  forwardFill,
  projectRow,
  dedupKey,
} from './normalizers.js';
import {
  createSession,
  readSession,
  updateSession,
  deleteSession,
} from './sessions.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls|csv)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Upload must be .xlsx / .xlsm / .xls / .csv'));
    cb(null, true);
  },
});

const VALID_RES = new Set(['skip', 'subpart', 'update']);

export function createWizardRouter(pool) {
  const router = express.Router();

  // ─── Step 1: upload ────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    res.render('admin/import_upload', {
      title: 'Admin · Import',
      active: 'import',
      error: null,
    });
  });

  router.post('/', upload.single('file'), (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).render('admin/import_upload', {
          title: 'Admin · Import',
          active: 'import',
          error: 'Pick a file first.',
        });
      }
      const wb = XLSX.read(req.file.buffer, { cellDates: true, type: 'buffer' });
      if (wb.SheetNames.length === 0) {
        return res.status(400).render('admin/import_upload', {
          title: 'Admin · Import',
          active: 'import',
          error: 'No sheets found in that file.',
        });
      }

      const sheets = wb.SheetNames.map((name) => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
          defval: null,
          raw: true,
        });
        return { name, rows, rowCount: rows.length };
      });

      if (sheets.length === 1) {
        const only = sheets[0];
        if (only.rowCount === 0) {
          return res.status(400).render('admin/import_upload', {
            title: 'Admin · Import',
            active: 'import',
            error: 'The sheet has no data rows.',
          });
        }
        const sid = createSession({
          filename: req.file.originalname,
          sheetName: only.name,
          headers: Object.keys(only.rows[0]),
          rows: only.rows,
          rowCount: only.rowCount,
        });
        return res.redirect(`/admin/import/${sid}/map`);
      }

      const sid = createSession({ filename: req.file.originalname, sheets });
      res.redirect(`/admin/import/${sid}/pick-sheet`);
    } catch (e) {
      next(e);
    }
  });

  // ─── Step 1.5: pick sheet (multi-sheet workbooks) ──────────────────
  router.get('/:sid/pick-sheet', (req, res) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');
    if (!sess.sheets) return res.redirect(`/admin/import/${req.params.sid}/map`);
    res.render('admin/import_pick_sheet', {
      title: 'Admin · Pick sheet',
      active: 'import',
      sid: req.params.sid,
      filename: sess.filename,
      sheets: sess.sheets.map((s) => ({
        name: s.name,
        rowCount: s.rowCount,
        sample: s.rows[0] ?? null,
      })),
      error: null,
    });
  });

  router.post('/:sid/pick-sheet', (req, res) => {
    const sess = readSession(req.params.sid);
    if (!sess?.sheets) return res.redirect('/admin/import');
    const chosen = sess.sheets.find((s) => s.name === req.body.sheet);
    if (!chosen || chosen.rowCount === 0) {
      return res.status(400).render('admin/import_pick_sheet', {
        title: 'Admin · Pick sheet',
        active: 'import',
        sid: req.params.sid,
        filename: sess.filename,
        sheets: sess.sheets.map((s) => ({
          name: s.name,
          rowCount: s.rowCount,
          sample: s.rows[0] ?? null,
        })),
        error: chosen ? `Sheet "${chosen.name}" has no rows.` : 'Pick a sheet.',
      });
    }
    updateSession(req.params.sid, {
      sheetName: chosen.name,
      headers: Object.keys(chosen.rows[0]),
      rows: chosen.rows,
      rowCount: chosen.rowCount,
      sheets: undefined,
    });
    res.redirect(`/admin/import/${req.params.sid}/map`);
  });

  // ─── Step 2: column mapping ────────────────────────────────────────
  router.get('/:sid/map', (req, res) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');
    const mapping = sess.mapping ?? autoDetectMapping(sess.headers);
    res.render('admin/import_map', {
      title: 'Admin · Map columns',
      active: 'import',
      sid: req.params.sid,
      filename: sess.filename,
      sheetName: sess.sheetName,
      rowCount: sess.rowCount,
      headers: sess.headers,
      sample: sess.rows.slice(0, 5),
      mapping,
      targets: TARGET_FIELDS,
      error: null,
    });
  });

  router.post('/:sid/map', (req, res) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');

    const submitted = req.body.map || {};
    const validTargets = new Set(TARGET_FIELDS.map((t) => t.key));
    const mapping = {};
    for (const header of sess.headers) {
      const target = submitted[header];
      mapping[header] = target && validTargets.has(target) ? target : null;
    }

    const usedTargets = new Set(Object.values(mapping).filter(Boolean));
    const missing = TARGET_FIELDS.filter(
      (t) => t.required && !usedTargets.has(t.key),
    );
    if (missing.length > 0) {
      return res.status(400).render('admin/import_map', {
        title: 'Admin · Map columns',
        active: 'import',
        sid: req.params.sid,
        filename: sess.filename,
        sheetName: sess.sheetName,
        rowCount: sess.rowCount,
        headers: sess.headers,
        sample: sess.rows.slice(0, 5),
        mapping,
        targets: TARGET_FIELDS,
        error: `Map a column to: ${missing.map((t) => t.label).join(', ')}`,
      });
    }

    updateSession(req.params.sid, { mapping });
    res.redirect(`/admin/import/${req.params.sid}/preview`);
  });

  // ─── Step 3: preview ──────────────────────────────────────────────
  router.get('/:sid/preview', async (req, res, next) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');
    if (!sess.mapping) return res.redirect(`/admin/import/${req.params.sid}/map`);

    try {
      const filled = forwardFill(sess.rows, sess.mapping);
      const projected = filled.map((row, idx) => {
        const { normalized, issues } = projectRow(row, sess.mapping);
        return {
          idx,
          sheetRow: idx + 2, // +1 for 0→1, +1 for header row
          normalized,
          issues,
          key: issues.length === 0 ? dedupKey(normalized) : null,
        };
      });

      const valid = projected.filter((p) => p.issues.length === 0);
      const invalid = projected.filter((p) => p.issues.length > 0);

      // Look up existing parts that match by part_number OR by the
      // normalized concat key. We compute the concat-key in SQL using
      // lower(trim(...)) so dedup matches the normalizer exactly.
      const partNumbers = valid
        .map((p) => p.normalized.part_number)
        .filter(Boolean);
      const concatKeys = valid
        .filter((p) => !p.normalized.part_number)
        .map((p) => p.key.replace(/^pn:/, ''));

      const existingByKey = new Map();
      if (partNumbers.length > 0 || concatKeys.length > 0) {
        const { rows } = await pool.query(
          `
          SELECT p.id, p.part_number,
                 lower(m.name) AS mfg_lc,
                 lower(mm.name) AS model_lc,
                 lower(p.part_name) AS name_lc,
                 lower(coalesce(p.description, '')) AS desc_lc
          FROM parts p
          JOIN machine_models mm ON mm.id = p.machine_model_id
          JOIN manufacturers m ON m.id = mm.manufacturer_id
          WHERE ($1::text[] IS NULL OR lower(p.part_number) = ANY($1))
             OR (
               p.part_number IS NULL
               AND lower(m.name) || '|' || lower(mm.name) || '|' ||
                   lower(p.part_name) || '|' || lower(coalesce(p.description, '')) = ANY($2)
             )
        `,
          [
            partNumbers.length > 0 ? partNumbers.map((p) => p.toLowerCase()) : null,
            concatKeys,
          ],
        );
        for (const r of rows) {
          if (r.part_number) {
            existingByKey.set(`pn:${r.part_number.toLowerCase()}`, r.id);
          }
          existingByKey.set(
            [r.mfg_lc, r.model_lc, r.name_lc, r.desc_lc].join('|'),
            r.id,
          );
        }
      }

      // Annotate dupes
      for (const p of valid) {
        p.existingId = existingByKey.get(p.key) ?? null;
      }
      const fresh = valid.filter((p) => !p.existingId);
      const dupes = valid.filter((p) => p.existingId);

      res.render('admin/import_preview', {
        title: 'Admin · Preview import',
        active: 'import',
        sid: req.params.sid,
        filename: sess.filename,
        rowCount: sess.rowCount,
        counts: {
          fresh: fresh.length,
          dupes: dupes.length,
          invalid: invalid.length,
        },
        fresh: fresh.slice(0, 30),
        dupes,
        invalid: invalid.slice(0, 30),
      });
    } catch (e) { next(e); }
  });

  // ─── Step 4: commit ───────────────────────────────────────────────
  router.post('/:sid/commit', async (req, res, next) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');
    if (!sess.mapping) return res.redirect(`/admin/import/${req.params.sid}/map`);

    const defaultRes = VALID_RES.has(req.body.default_resolution)
      ? req.body.default_resolution
      : 'skip';
    const perRow = req.body.dupe || {};

    try {
      const filled = forwardFill(sess.rows, sess.mapping);
      const projected = filled.map((row, idx) => {
        const { normalized, issues } = projectRow(row, sess.mapping);
        return {
          idx,
          sheetRow: idx + 2,
          normalized,
          issues,
          key: issues.length === 0 ? dedupKey(normalized) : null,
        };
      });
      const valid = projected.filter((p) => p.issues.length === 0);

      // Same lookup as the preview endpoint, repeated here so the
      // commit is self-contained and the user can refresh /preview
      // arbitrarily without it going stale.
      const partNumbers = valid.map((p) => p.normalized.part_number).filter(Boolean);
      const concatKeys = valid
        .filter((p) => !p.normalized.part_number)
        .map((p) => p.key.replace(/^pn:/, ''));
      const existingByKey = new Map();
      if (partNumbers.length > 0 || concatKeys.length > 0) {
        const { rows } = await pool.query(
          `
          SELECT p.id, p.part_number,
                 lower(m.name) AS mfg_lc, lower(mm.name) AS model_lc,
                 lower(p.part_name) AS name_lc,
                 lower(coalesce(p.description, '')) AS desc_lc
          FROM parts p
          JOIN machine_models mm ON mm.id = p.machine_model_id
          JOIN manufacturers m ON m.id = mm.manufacturer_id
          WHERE ($1::text[] IS NULL OR lower(p.part_number) = ANY($1))
             OR (
               p.part_number IS NULL
               AND lower(m.name) || '|' || lower(mm.name) || '|' ||
                   lower(p.part_name) || '|' || lower(coalesce(p.description, '')) = ANY($2)
             )
        `,
          [
            partNumbers.length > 0 ? partNumbers.map((p) => p.toLowerCase()) : null,
            concatKeys,
          ],
        );
        for (const r of rows) {
          if (r.part_number) {
            existingByKey.set(`pn:${r.part_number.toLowerCase()}`, r.id);
          }
          existingByKey.set([r.mfg_lc, r.model_lc, r.name_lc, r.desc_lc].join('|'), r.id);
        }
      }

      const summary = {
        inserted: 0,
        subparts: 0,
        updated: 0,
        skipped: 0,
        invalid: projected.length - valid.length,
      };

      // Run the import inside a single transaction. Manufacturer +
      // machine_model lookups happen inside that transaction so a
      // batch with 50 new parts on a brand-new manufacturer doesn't
      // create 50 manufacturer rows.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const mfgCache = new Map();   // name → id
        const modelCache = new Map(); // mfgId|modelName → id

        for (const p of valid) {
          const n = p.normalized;
          const existingId = existingByKey.get(p.key);

          let resolution;
          if (existingId) {
            resolution = VALID_RES.has(perRow[String(p.idx)])
              ? perRow[String(p.idx)]
              : defaultRes;
          } else {
            resolution = 'insert';
          }

          if (resolution === 'skip') { summary.skipped++; continue; }

          // Resolve manufacturer + model id (find-or-create).
          let mfgId = mfgCache.get(n.manufacturer);
          if (!mfgId) {
            const r = await client.query(
              `INSERT INTO manufacturers (name) VALUES ($1)
               ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [n.manufacturer],
            );
            mfgId = r.rows[0].id;
            mfgCache.set(n.manufacturer, mfgId);
          }
          const modelKey = `${mfgId}|${n.machine_model}`;
          let modelId = modelCache.get(modelKey);
          if (!modelId) {
            const r = await client.query(
              `INSERT INTO machine_models (manufacturer_id, name) VALUES ($1, $2)
               ON CONFLICT (manufacturer_id, name) DO UPDATE SET name = EXCLUDED.name
               RETURNING id`,
              [mfgId, n.machine_model],
            );
            modelId = r.rows[0].id;
            modelCache.set(modelKey, modelId);
          }

          if (resolution === 'update' && existingId) {
            await client.query(
              `UPDATE parts SET
                 machine_model_id = $2,
                 part_name        = $3,
                 description      = COALESCE($4, description),
                 part_number      = COALESCE($5, part_number),
                 internal_notes   = COALESCE($6, internal_notes),
                 updated_at       = NOW()
               WHERE id = $1`,
              [existingId, modelId, n.part_name, n.description, n.part_number, n.internal_notes],
            );
            summary.updated++;
            continue;
          }

          // Both 'insert' (no existing) and 'subpart' (existing but
          // explicitly distinct) take the same INSERT path.
          await client.query(
            `INSERT INTO parts
               (machine_model_id, part_name, description, part_number, internal_notes)
             VALUES ($1, $2, $3, $4, $5)`,
            [modelId, n.part_name, n.description, n.part_number, n.internal_notes],
          );
          if (existingId) summary.subparts++;
          else summary.inserted++;
        }

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
        return next(e);
      }
      client.release();

      updateSession(req.params.sid, { summary, rows: undefined, sheets: undefined });
      res.redirect(`/admin/import/${req.params.sid}/done`);
    } catch (e) { next(e); }
  });

  // ─── Step 5: done ─────────────────────────────────────────────────
  router.get('/:sid/done', (req, res) => {
    const sess = readSession(req.params.sid);
    if (!sess) return res.redirect('/admin/import');
    res.render('admin/import_done', {
      title: 'Admin · Import complete',
      active: 'import',
      sid: req.params.sid,
      filename: sess.filename,
      summary: sess.summary ?? {
        inserted: 0, subparts: 0, updated: 0, skipped: 0, invalid: 0,
      },
    });
  });

  router.post('/:sid/cancel', (req, res) => {
    deleteSession(req.params.sid);
    res.redirect('/admin');
  });

  return router;
}

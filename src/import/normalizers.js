// Header auto-detection + per-row projection for the import wizard.
// Vendor spreadsheets use wildly inconsistent column naming, so the
// wizard always shows mappings the user can override — this just
// makes the first guess as accurate as possible.

export const TARGET_FIELDS = [
  { key: 'manufacturer',   label: 'Manufacturer',     required: true },
  { key: 'machine_model',  label: 'Machine model',    required: true },
  { key: 'part_name',      label: 'Part name',        required: true },
  { key: 'description',    label: 'Description',      required: false },
  { key: 'part_number',    label: 'Part number',      required: false },
  { key: 'internal_notes', label: 'Internal notes',   required: false },
];

const HEADER_HINTS = {
  manufacturer:   ['manufacturer', 'mfg', 'mfr', 'oem', 'brand', 'make', 'vendor'],
  machine_model:  ['machinemodel', 'model', 'machine', 'unit', 'machinetype'],
  part_name:      ['partname', 'item', 'itemname', 'name', 'product', 'productname'],
  description:    ['description', 'desc', 'details', 'specs', 'spec', 'specification', 'notes'],
  part_number:    ['partnumber', 'partno', 'part', 'pn', 'partid', 'sku', 'oempartnumber', 'number'],
  internal_notes: ['internalnotes', 'comment', 'comments', 'remarks', 'memo'],
};

function normalizeHeader(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Auto-detect the best target field for each header. Each target is
 * matched at most once — the first header that wins gets it; other
 * candidates stay unmapped so the user can override.
 */
export function autoDetectMapping(headers) {
  const used = new Set();
  const out = {};
  for (const header of headers) {
    const norm = normalizeHeader(header);
    let chosen = null;
    for (const [target, hints] of Object.entries(HEADER_HINTS)) {
      if (used.has(target)) continue;
      if (hints.includes(norm)) { chosen = target; break; }
      if (hints.some((h) => norm.includes(h) && h.length >= 3)) {
        chosen = target;
        break;
      }
    }
    if (chosen) used.add(chosen);
    out[header] = chosen;
  }
  return out;
}

/**
 * Forward-fill blank Manufacturer + Machine Model cells from the row
 * above. Vendor spreadsheets routinely group rows visually by leaving
 * the manufacturer / model blank on continuation lines — without this
 * step every-but-first row would be marked invalid.
 */
export function forwardFill(rows, mapping) {
  // Reverse mapping → list of headers that target manufacturer/model.
  const mfgHeader = Object.entries(mapping).find(
    ([, t]) => t === 'manufacturer',
  )?.[0];
  const mdlHeader = Object.entries(mapping).find(
    ([, t]) => t === 'machine_model',
  )?.[0];
  if (!mfgHeader && !mdlHeader) return rows;

  let lastMfg = null;
  let lastMdl = null;
  return rows.map((row) => {
    const r = { ...row };
    if (mfgHeader) {
      const v = r[mfgHeader];
      if (v == null || String(v).trim() === '') {
        if (lastMfg != null) r[mfgHeader] = lastMfg;
      } else {
        lastMfg = v;
      }
    }
    if (mdlHeader) {
      const v = r[mdlHeader];
      if (v == null || String(v).trim() === '') {
        if (lastMdl != null) r[mdlHeader] = lastMdl;
      } else {
        lastMdl = v;
      }
    }
    return r;
  });
}

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * Apply the mapping to a row + collect issues. Returns
 * `{ normalized, issues }`. `normalized` always has all six target
 * keys (some may be null); `issues` lists why a row is unimportable.
 */
export function projectRow(row, mapping) {
  const targetToHeader = {};
  for (const [header, target] of Object.entries(mapping)) {
    if (target) targetToHeader[target] = header;
  }
  const get = (target) => {
    const h = targetToHeader[target];
    return h ? row[h] : null;
  };

  const normalized = {
    manufacturer:   trimOrNull(get('manufacturer')),
    machine_model:  trimOrNull(get('machine_model')),
    part_name:      trimOrNull(get('part_name')),
    description:    trimOrNull(get('description')),
    part_number:    trimOrNull(get('part_number')),
    internal_notes: trimOrNull(get('internal_notes')),
  };

  const issues = [];
  if (!normalized.manufacturer) issues.push('missing manufacturer');
  if (!normalized.machine_model) issues.push('missing machine model');
  if (!normalized.part_name) issues.push('missing part name');

  return { normalized, issues };
}

/**
 * Dedup key for a row. Uses part_number when present (case-insensitive,
 * trimmed). Falls back to a normalized concat of manufacturer + model +
 * name + description when no part number exists.
 */
export function dedupKey(n) {
  if (n.part_number) {
    return `pn:${n.part_number.toLowerCase()}`;
  }
  return [
    n.manufacturer || '',
    n.machine_model || '',
    n.part_name || '',
    n.description || '',
  ]
    .map((s) => s.toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
}

# Mulchparts

Quote-only parts catalog for **MinFab Mulch Parts**. Customers browse parts
and submit a contact form per part — there is **no shopping cart, no
prices, no add-to-cart**. Every quote runs through a technician.

Mounted at `mulchparts.pcc2k.com`. Public catalog is open. `/admin` is
behind Basic Auth and is expected to live on the company VPN as well
(defense in depth).

## Stack

- Node 20 + Express 4 + EJS
- Postgres 16
- nodemailer (SMTP creds in DB settings, not env)
- multer (xlsx + photo uploads)
- Single Docker image, named volumes for `pgdata` + `uploads`
- Sessions for the multi-step import wizard live on disk under
  `/app/data/import-sessions` with a 6-hour TTL

## Quickstart

```bash
cp .env.example .env       # set POSTGRES_PASSWORD + MULCHPARTS_ADMIN_PASSWORD
docker compose up -d --build
docker compose exec app node scripts/migrate.js
open http://localhost:3007            # public site
open http://localhost:3007/admin      # admin panel (Basic Auth)
```

After first boot:

1. Sign in to `/admin/settings` and fill in:
   - **Destination email** — where quote requests are delivered
   - **SMTP host / user / password / from** — GoDaddy 365 SMTP works:
     `smtp_host: smtpout.secureserver.net`, `port: 587`, secure off
   - **Business info** — phone / address / hours show in the public footer
2. Drop your first vendor spreadsheet via `/admin/import`. The wizard
   walks: upload → pick sheet → map columns (auto-detected) → preview
   with per-row dedup decisions → commit.

## Schema

```
manufacturers     id, name UNIQUE
machine_models    id, manufacturer_id, name, UNIQUE(manufacturer_id, name)
parts             id, machine_model_id, part_name, description,
                  part_number nullable, photo_filename, internal_notes,
                  is_active, sort_order, created_at, updated_at
quote_requests    id, part_id?, customer_name, email, phone, company,
                  quantity, message, status, ip, user_agent,
                  email_sent_at, email_error, created_at
settings          key PRIMARY KEY, value, updated_at
```

Migrations are idempotent — re-running `node scripts/migrate.js` is
safe; existing settings values are preserved.

## Import wizard — duplicate detection

When the wizard finds an existing part with the same dedup key, it
prompts per-row with three resolutions:

- **Skip** — re-entry of an existing part (do nothing)
- **Sub-part** — same name but different specs / fitment / material
  (insert as a new part — the typical resolution when a vendor sheet
  has dozens of variants under the same name)
- **Update** — same part, refresh description / part # / notes

Dedup key:

- If `part_number` is present → match by part_number (case-insensitive)
- Otherwise → match by `(manufacturer + machine_model + part_name + description)`

Vendor spreadsheets routinely leave the manufacturer / model column
blank on continuation rows; the wizard forward-fills these from the
row above so they're not flagged invalid.

## Layout

```
src/
  server.js              ← Express setup + public routes
  admin.js               ← /admin router (parts, requests, settings)
  db.js                  ← shared pg pool
  settings.js            ← DB-backed key/value with 60s read cache
  mailer.js              ← nodemailer build-from-settings + sendQuoteEmail
  import/
    normalizers.js       ← header auto-detect, projectRow, dedup key
    sessions.js          ← file-backed wizard sessions (6h TTL)
    wizard.js            ← /admin/import/* router
  views/                 ← EJS templates (public + admin/*)
  public/style.css       ← single stylesheet, dark navy + burnt-orange palette
scripts/
  migrate.js             ← schema + seed settings
data/
  sample/                ← seed xlsx from the original repo (untouched)
  import-sessions/       ← runtime wizard sessions (gitignored)
uploads/                 ← part photos (Docker volume in prod, gitignored locally)
```

## Deployment notes

- Container listens on `:3000`; compose binds host `:3009`.
- nginx on the PCC2K box should reverse-proxy
  `https://mulchparts.pcc2k.com` → `127.0.0.1:3009`.
- Bind-mount nothing for `/app/uploads` — the Docker named volume
  `mulchparts_uploads` survives container rebuilds.
- VPN gating belongs at the WireGuard / Tailscale layer in front of
  `/admin/*`. Public catalog stays open.

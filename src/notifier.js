// Push notifications via ntfy. Settings-driven so the operator can
// rotate URL / topic / token without a redeploy. Fire-and-forget — a
// down ntfy server should never block a customer's quote submission.
//
// The publish URL inside docker-compose is the sibling container at
// `http://ntfy:80`; settings stores the public URL (which works too,
// just adds a hop through nginx). Either is valid.

import { getAll } from './settings.js';

export async function sendQuoteNotification({ request, part, partUrl, adminUrl }) {
  const s = await getAll();
  const baseUrl = (s.ntfy_url || '').trim().replace(/\/+$/, '');
  const topic = (s.ntfy_topic || '').trim();
  if (!baseUrl || !topic) {
    // Notifications are optional — empty config means "off."
    return { ok: false, skipped: true, reason: 'ntfy not configured' };
  }
  const url = `${baseUrl}/${encodeURIComponent(topic)}`;

  const partLine = part
    ? `${part.manufacturer ?? ''} ${part.machine_model ?? ''} — ${part.part_name}`
        .replace(/\s+/g, ' ')
        .trim()
    : 'General contact';

  const title = `Quote: ${request.customer_name}`;
  const body = [
    partLine,
    request.company ? `Company: ${request.company}` : null,
    request.email,
    request.phone ?? null,
    request.quantity ? `Qty: ${request.quantity}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': title,
    'Tags': 'wrench,bell',
    'Priority': '4', // high — it's a sales lead
  };
  if (adminUrl) headers['Click'] = adminUrl;
  if (s.ntfy_token) headers['Authorization'] = `Bearer ${s.ntfy_token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `ntfy ${res.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

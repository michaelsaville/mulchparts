// Settings-driven SMTP sender. Builds a nodemailer transport on demand
// from the values in /admin/settings — no env-var SMTP config so
// admins can change vendors / passwords without redeploying.
//
// `sendQuoteEmail` is the only outbound the public site does today.
// It's intentionally chatty: full part details + customer info, plus a
// deep link to /admin/requests/:id so the operator can act fast.

import nodemailer from 'nodemailer';
import { getAll } from './settings.js';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildTransport() {
  const s = await getAll();
  if (!s.smtp_host || !s.smtp_user || !s.smtp_password) {
    throw new Error(
      'SMTP not configured — fill in smtp_host / smtp_user / smtp_password under /admin/settings',
    );
  }
  const port = parseInt(s.smtp_port || '587', 10);
  const secure = String(s.smtp_secure || '').toLowerCase() === 'true';
  return nodemailer.createTransport({
    host: s.smtp_host,
    port,
    secure,
    auth: { user: s.smtp_user, pass: s.smtp_password },
  });
}

export async function sendQuoteEmail({ request, part, partUrl, adminUrl }) {
  const s = await getAll();
  const to = s.destination_email;
  if (!to) {
    throw new Error(
      'destination_email not set — add it under /admin/settings before the form will deliver',
    );
  }
  const transport = await buildTransport();
  const fromAddress = s.from_email || s.smtp_user;
  const fromName = s.from_name || s.business_name || 'Mulchparts';

  const partLine = part
    ? `${part.manufacturer ?? ''} ${part.machine_model ?? ''} — ${part.part_name}`
        .replace(/\s+/g, ' ')
        .trim()
    : 'General contact (no specific part)';

  const subject = part
    ? `Quote request: ${partLine}`
    : `Contact form: ${request.customer_name}`;

  const text = [
    `New quote request from ${request.customer_name}`,
    '',
    `Part:        ${partLine}`,
    part?.part_number ? `Part #:      ${part.part_number}` : null,
    part?.description ? `Description: ${part.description}` : null,
    '',
    `Customer:    ${request.customer_name}`,
    `Email:       ${request.email}`,
    request.phone ? `Phone:       ${request.phone}` : null,
    request.company ? `Company:     ${request.company}` : null,
    request.quantity ? `Quantity:    ${request.quantity}` : null,
    '',
    'Message:',
    request.message || '(no message)',
    '',
    partUrl ? `Public part page: ${partUrl}` : null,
    adminUrl ? `Open in admin:    ${adminUrl}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');

  const html = `
<!doctype html>
<html><body style="font-family: -apple-system, Segoe UI, sans-serif; font-size: 14px; color: #111; max-width: 560px; margin: 0 auto; padding: 16px;">
  <h2 style="color: #1e3a8a; margin: 0 0 12px;">New quote request</h2>

  <table style="border-collapse: collapse; width: 100%; margin: 0 0 16px;">
    <tr><td style="color:#666;padding:4px 8px 4px 0;width:130px;">Part</td><td style="padding:4px 0">${escapeHtml(partLine)}</td></tr>
    ${part?.part_number ? `<tr><td style="color:#666;padding:4px 8px 4px 0;">Part #</td><td style="padding:4px 0;font-family:monospace">${escapeHtml(part.part_number)}</td></tr>` : ''}
    ${part?.description ? `<tr><td style="color:#666;padding:4px 8px 4px 0;vertical-align:top">Description</td><td style="padding:4px 0">${escapeHtml(part.description)}</td></tr>` : ''}
  </table>

  <h3 style="margin: 18px 0 6px; color: #333;">Customer</h3>
  <table style="border-collapse: collapse; width: 100%; margin: 0 0 16px;">
    <tr><td style="color:#666;padding:4px 8px 4px 0;width:130px;">Name</td><td style="padding:4px 0"><strong>${escapeHtml(request.customer_name)}</strong></td></tr>
    <tr><td style="color:#666;padding:4px 8px 4px 0;">Email</td><td style="padding:4px 0"><a href="mailto:${escapeHtml(request.email)}">${escapeHtml(request.email)}</a></td></tr>
    ${request.phone ? `<tr><td style="color:#666;padding:4px 8px 4px 0;">Phone</td><td style="padding:4px 0"><a href="tel:${escapeHtml(request.phone)}">${escapeHtml(request.phone)}</a></td></tr>` : ''}
    ${request.company ? `<tr><td style="color:#666;padding:4px 8px 4px 0;">Company</td><td style="padding:4px 0">${escapeHtml(request.company)}</td></tr>` : ''}
    ${request.quantity ? `<tr><td style="color:#666;padding:4px 8px 4px 0;">Quantity</td><td style="padding:4px 0">${escapeHtml(request.quantity)}</td></tr>` : ''}
  </table>

  ${request.message ? `<h3 style="margin: 18px 0 6px; color: #333;">Message</h3><p style="white-space: pre-wrap; background: #f5f5f5; padding: 12px; border-radius: 6px;">${escapeHtml(request.message)}</p>` : ''}

  <p style="margin-top: 20px; font-size: 12px; color: #999;">
    ${adminUrl ? `<a href="${escapeHtml(adminUrl)}" style="color: #1e3a8a;">Open in admin →</a>` : ''}
  </p>
</body></html>
  `.trim();

  const replyTo = s.reply_to_email || request.email;

  await transport.sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to,
    replyTo,
    subject,
    text,
    html,
  });
}

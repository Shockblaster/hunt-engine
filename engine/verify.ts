// Mechanical lead checks, so the verifier agent only spends judgement on the unclear cases.
// Weights follow agents/verifier.md: phone 0.35, email 0.2, listing 0.2, website 0.15, name 0.1; warn counts half;
// a failed phone or listing caps confidence at 0.4.
// Small practices often have no website or email. Those checks are then left out of the score rather than counted
// against them, and a valid phone on an open listing with real reviews puts them in the 'listing-checked' band:
// delivered and counted, but shown apart from verified rows because the phone has a single source.
import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './db.ts';
import { logActivity } from './db.ts';
import { collectSite } from './collect.ts';
import { emailSyntax, hasMx, normalizePhone } from './normalize.ts';

type Result = 'pass' | 'warn' | 'fail';
const W: Record<string, number> = { phone: 0.35, email: 0.2, listing: 0.2, website: 0.15, name: 0.1 };
const V: Record<Result, number> = { pass: 1, warn: 0.5, fail: 0 };
export const SMALL_MIN_REVIEWS = 3;
export const LISTING_CHECKED = 'listing-checked';

export function withTag(tags: unknown, tag: string, on: boolean): string | null {
  const list = String(tags ?? '').split(',').map((t) => t.trim()).filter((t) => t && t !== tag);
  if (on) list.push(tag);
  return list.length ? list.join(',') : null;
}

export function score(checks: Record<string, Result>): number {
  let total = 0, weight = 0;
  for (const [k, w] of Object.entries(W)) {
    const r = checks[k];
    if (!r) continue;
    total += w * V[r];
    weight += w;
  }
  let c = weight ? total / weight : 0;
  if (checks.phone === 'fail' || checks.listing === 'fail') c = Math.min(c, 0.4);
  return Math.round(c * 100) / 100;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// noWebsite re-checks only leads without a website, leaving the verifier's hand-set scores on the others alone.
export async function verifyLeads(db: DatabaseSync, opts: { campaign: string; all?: boolean; noWebsite?: boolean; concurrency?: number; agent?: string }): Promise<Row> {
  const rows = db.prepare(`SELECT p.*, o.name AS org_name, o.website, o.phone_e164 AS org_phone, o.sector, o.notes AS org_notes, o.reviews
    FROM people p LEFT JOIN organizations o ON o.id = p.organization_id
    WHERE p.campaign = ? AND p.opt_out = 0 AND ifnull(p.tags,'') NOT LIKE '%duplicate-of%' AND ifnull(p.tags,'') NOT LIKE '%not-target%' ${opts.noWebsite ? "AND ifnull(o.website,'') = ''" : opts.all ? '' : 'AND p.confidence IS NULL'}`).all(opts.campaign) as Row[];
  const record = db.prepare('INSERT INTO verifications (ref_table, ref_id, field, method, result, detail) VALUES (\'people\', ?, ?, ?, ?, ?)');
  const results = await pool(rows, opts.concurrency ?? 6, async (p) => {
    const checks: Record<string, Result> = {};
    const notes: string[] = [];
    const add = (field: string, method: string, result: Result, detail: string) => { checks[field] = result; record.run(Number(p.id), field, method, result, detail); };
    // Recorded for the person to see, but not scored: a missing website or email says nothing against a small practice.
    const log = (field: string, method: string, detail: string) => record.run(Number(p.id), field, method, 'warn', `${detail} (not scored)`);

    // Phone: valid format, then whether the business's own website shows the same number.
    const ph = p.phone_e164 ? normalizePhone(String(p.phone_e164)) : null;
    let site: Row | null = null;
    if (p.website) site = await collectSite(db, String(p.website), String(p.org_name ?? p.name)).catch(() => null);
    const sitePhones = (site?.phones as string[] | undefined) ?? [];
    if (!ph?.valid) add('phone', 'format', 'fail', `not a valid number: ${p.phone ?? 'none'}`);
    else if (sitePhones.includes(String(p.phone_e164))) add('phone', 'listing + website', 'pass', 'the same number is on Google Maps and their website');
    else if (sitePhones.length) { add('phone', 'listing + website', 'warn', `Maps ${p.phone_e164}, website ${sitePhones.slice(0, 2).join(', ')}: needs a person or the verifier to decide`); notes.push(`website phone differs: ${sitePhones[0]}`); }
    else add('phone', 'format', 'warn', `${ph.type} number, one source (Google Maps)`);

    // Listing: it came from a Maps place that is not closed and matched the target categories.
    add('listing', 'google maps', /permanently closed/i.test(String(p.org_notes ?? '')) ? 'fail' : 'pass', `${p.sector ?? p.role ?? 'listing'} on Google Maps`);

    // Website: loads and appears to belong to them.
    if (!p.website) log('website', 'none listed', 'no website on the listing');
    else if (!site?.live) add('website', 'open it', 'fail', `does not load (${site?.status ?? 'error'})`);
    else add('website', 'open it', site.owner_match === false ? 'warn' : 'pass', site.owner_match === false ? `loads, but the page does not name ${p.org_name}` : `loads: ${String(site.title ?? '').slice(0, 80)}`);

    // Email: one published on their site (or the listing), whose domain takes mail.
    const published = [p.email && p.email_status === 'published' ? String(p.email) : null, ...((site?.emails as string[] | undefined) ?? [])].filter(Boolean) as string[];
    const email = published[0] ?? null;
    let emailStatus = String(p.email_status ?? 'unknown');
    if (!email && !p.website) log('email', 'listing', 'no published email');
    else if (!email) add('email', 'website + listing', 'warn', 'no published email found');
    else {
      const s = emailSyntax(email);
      const mx = s.valid ? await hasMx(email.split('@')[1]) : false;
      add('email', 'published + MX', s.valid && mx ? 'pass' : 'fail', `${email}${mx ? ' (domain takes mail)' : ' (domain does not take mail)'}`);
      if (s.valid && mx) emailStatus = 'mx_ok';
    }

    // Name: the website names the business or practitioner.
    if (p.website) add('name', 'website', site?.owner_match ? 'pass' : 'warn', site?.owner_match ? 'named on their own website' : 'only the listing name');
    else log('name', 'listing', 'only the listing name');

    let confidence = score(checks);
    // Disagreeing phones, or a "name" that is really a search phrase, are never exported until the verifier decides.
    const conflict = Boolean(sitePhones.length && ph?.valid && !sitePhones.includes(String(p.phone_e164)));
    const searchPhrase = /^(best |top )?(dietitian|dietician|nutritionist|diet clinic|weight loss)[\w\s]*\b(in|near)\b/i.test(String(p.name));
    if (conflict || searchPhrase) {
      confidence = Math.min(confidence, 0.6);
      notes.push(searchPhrase ? 'name looks like a search phrase, not a practice' : 'needs review: phones differ');
    }
    // Verified (0.7+) always means their own website or a second source; the verifier lifts a small practice once it finds one.
    if (!p.website) confidence = Math.min(confidence, 0.65);
    // A clinic address shared by several practitioners stays with the first; the others get it as a note.
    const takenBy = email ? (db.prepare('SELECT id FROM people WHERE lower(email) = lower(?) AND id <> ?').get(email, Number(p.id)) as Row | undefined) : undefined;
    if (email && takenBy && !p.email) notes.push(`shares the clinic email ${email} with lead ${takenBy.id}`);
    const storeEmail = takenBy ? null : email;
    const ig = ((site?.instagram as string[] | undefined) ?? [])[0];
    const small = confidence < 0.7 && !p.website && Boolean(ph?.valid) && checks.listing === 'pass' && Number(p.reviews ?? 0) >= SMALL_MIN_REVIEWS && !conflict && !searchPhrase;
    if (small) notes.push(`small practice: phone from the listing only (${p.reviews} reviews)`);
    db.prepare(`UPDATE people SET confidence = ?, email = coalesce(email, ?), email_status = ?, tags = ?, notes = trim(ifnull(notes,'') || ' ' || ?), updated_at = datetime('now') WHERE id = ?`)
      .run(confidence, storeEmail, storeEmail || p.email ? emailStatus : String(p.email_status ?? 'unknown'), withTag(p.tags, LISTING_CHECKED, small), [...notes, ig ? `instagram ${ig}` : ''].filter(Boolean).join('; '), Number(p.id));
    return { id: p.id, name: p.name, confidence, checks, small };
  });
  const bands = { high: results.filter((r) => r.confidence >= 0.7).length, listing_checked: results.filter((r) => r.small).length,
    mid: results.filter((r) => !r.small && r.confidence >= 0.4 && r.confidence < 0.7).length, low: results.filter((r) => !r.small && r.confidence < 0.4).length };
  logActivity(db, { agent: opts.agent ?? 'verifier', action: 'verify.done', detail: { summary: `checked ${results.length} leads`, ...bands } });
  return { checked: results.length, ...bands, low_ids: results.filter((r) => r.confidence < 0.4).map((r) => r.id) };
}

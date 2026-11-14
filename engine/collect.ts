// Fast, deterministic collection for lead research: Google Maps via gosom/google-maps-scraper (MIT),
// business websites for published contacts, and pincode lookups so results stay inside the asked-for area.
import type { DatabaseSync } from 'node:sqlite';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform, arch } from 'node:os';
import type { Row } from './db.ts';
import { HOME } from './paths.ts';
import { normalizeDomain, normalizePhone, emailSyntax } from './normalize.ts';

export const GOSOM_VERSION = '1.18.1';
export function gosomPath(): string {
  const name = platform() === 'win32' ? 'google_maps_scraper.exe' : 'google_maps_scraper';
  return join(HOME, 'tools', 'gosom', name);
}
export function gosomAsset(): { name: string; url: string } {
  const os = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'darwin' : 'linux';
  if (arch() !== 'x64' && !(os === 'darwin')) throw new Error(`no gosom build for ${os}/${arch()}`);
  const name = `google_maps_scraper-${GOSOM_VERSION}-${os}-amd64${os === 'windows' ? '.exe' : ''}`;
  return { name, url: `https://github.com/gosom/google-maps-scraper/releases/download/v${GOSOM_VERSION}/${name}` };
}

export function recordSource(db: DatabaseSync, source: string, target: string | null, ok: boolean, items: number, ms: number, error?: string): void {
  db.prepare('INSERT INTO source_runs (source, target, ok, items, error, ms) VALUES (?, ?, ?, ?, ?, ?)').run(source, target, ok ? 1 : 0, items, error ?? null, ms);
}

export type Place = {
  name: string; category: string | null; address: string | null; pincode: string | null; phone: string | null; phone_e164: string | null;
  website: string | null; rating: number | null; reviews: number | null; status: string | null; lat: number | null; lng: number | null;
  maps_url: string | null; place_id: string | null; emails: string[];
};

// gosom writes one JSON object per line (or an array); fields per its README.
export function parseGosom(text: string): Place[] {
  const t = text.trim();
  if (!t) return [];
  const rows: Record<string, unknown>[] = t.startsWith('[') ? JSON.parse(t) : t.split(/\r?\n/).filter((l) => l.trim().startsWith('{')).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return rows.map((r) => {
    const ca = (r.complete_address ?? {}) as Record<string, string>;
    const address = (r.address as string) || [ca.street, ca.borough, ca.city].filter(Boolean).join(', ') || null;
    const pin = String(ca.postal_code ?? '').match(/\b\d{6}\b/)?.[0] ?? String(address ?? '').match(/\b\d{6}\b/)?.[0] ?? null;
    const phone = (r.phone as string) || null;
    const p = phone ? normalizePhone(phone) : null;
    return {
      name: String(r.title ?? '').trim(), category: (r.category as string) ?? null, address, pincode: pin,
      phone, phone_e164: p?.valid ? p.e164 : null, website: (r.web_site as string) || (r.website as string) || null, // gosom's field is web_site
      rating: r.review_rating != null ? Number(r.review_rating) : null, reviews: r.review_count != null ? Number(r.review_count) : null,
      status: (r.status as string) || null, lat: r.latitude != null ? Number(r.latitude) : null, lng: (r.longitude ?? r.longtitude) != null ? Number(r.longitude ?? r.longtitude) : null, // gosom spells it longtitude
      maps_url: (r.link as string) || null, place_id: (r.place_id as string) || (r.cid as string) || null,
      emails: Array.isArray(r.emails) ? (r.emails as string[]).filter((e) => emailSyntax(e).valid) : [],
    };
  }).filter((p) => p.name);
}

// Keep places inside the asked-for area: a listed pincode, or the locality name in the address.
export function inArea(p: Place, area: { localities?: string[]; pincodes?: string[] }): boolean {
  const locs = (area.localities ?? []).map((l) => l.toLowerCase());
  const pins = area.pincodes ?? [];
  if (!locs.length && !pins.length) return true;
  if (p.pincode && pins.includes(p.pincode)) return true;
  if (pins.length && p.pincode && !pins.includes(p.pincode)) return false;
  return matchedLocality(p, locs) !== null;
}

// Whole-word match, so "Fort" does not match "Fortune Plaza".
export function matchedLocality(p: Place, localities: string[]): string | null {
  const addr = ` ${(p.address ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return localities.find((l) => addr.includes(` ${l.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `)) ?? null;
}

export function dedupePlaces(list: Place[]): Place[] {
  const seen = new Set<string>();
  return list.filter((p) => {
    const keys = [p.place_id && `id:${p.place_id}`, p.phone_e164 && `ph:${p.phone_e164}`, `na:${p.name.toLowerCase()}|${(p.address ?? '').toLowerCase().slice(0, 40)}`].filter(Boolean) as string[];
    if (keys.some((k) => seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  });
}

// gosom sometimes keeps running with its browser open long after its last result (seen 2026-11-01: output unchanged
// for 23 minutes, -exit-on-inactivity never fired). Watch the results file and end the whole process tree once it
// has not changed for stallMs, or at maxMs; what gosom wrote so far is kept and parsed as usual.
export async function runWatched(bin: string, args: string[], cwd: string, out: string, opts: { stallMs: number; maxMs: number; pollMs?: number; graceMs?: number }): Promise<{ code: number | null; stderr: string; stalled: boolean; timedOut: boolean; ms: number }> {
  const started = Date.now();
  const child = spawn(bin, args, { cwd, detached: platform() !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000); });
  let lastSize = -1, lastChange = Date.now() + (opts.graceMs ?? 0), stalled = false, timedOut = false, done = false;
  const killTree = () => {
    if (child.pid == null) return;
    // gosom's browser driver and Chrome tabs are children; ending only gosom leaves them running.
    if (platform() === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  };
  const code = await new Promise<number | null>((resolve) => {
    child.on('exit', (c) => { done = true; resolve(c); });
    child.on('error', (e) => { stderr += String(e); done = true; resolve(null); });
    const timer = setInterval(() => {
      if (done) return clearInterval(timer);
      const size = existsSync(out) ? statSync(out).size : -1;
      if (size !== lastSize) { lastSize = size; lastChange = Math.max(lastChange, Date.now()); }
      if (Date.now() - started > opts.maxMs) timedOut = true;
      else if (Date.now() - lastChange > opts.stallMs) stalled = true;
      if (stalled || timedOut) { clearInterval(timer); killTree(); }
    }, opts.pollMs ?? 15_000);
  });
  return { code, stderr, stalled, timedOut, ms: Date.now() - started };
}

export async function collectMaps(db: DatabaseSync, workDir: string, opts: { queries: string[]; depth?: number; concurrency?: number; emails?: boolean; area?: { localities?: string[]; pincodes?: string[] }; stallMs?: number }): Promise<{ places: Place[]; dropped_outside_area: number; raw: number; file: string; stalled: boolean }> {
  const bin = gosomPath();
  if (!existsSync(bin)) throw new Error('the Maps collector is not installed yet: `he tools install maps` (asks before downloading)');
  mkdirSync(workDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const qfile = join(workDir, `queries-${stamp}.txt`);
  const out = join(workDir, `maps-${stamp}.json`);
  writeFileSync(qfile, opts.queries.join('\n') + '\n');
  const started = Date.now();
  const args = ['-input', qfile, '-results', out, '-json', '-depth', String(opts.depth ?? 10), '-c', String(opts.concurrency ?? 4), '-lang', 'en', '-exit-on-inactivity', '3m'];
  if (opts.emails) args.push('-email');
  // First results can take a while (browser start, first query), so the stall clock gets two extra minutes at the start.
  const stallMs = opts.stallMs ?? 3 * 60_000;
  const r = await runWatched(bin, args, join(HOME, 'tools', 'gosom'), out, { stallMs, maxMs: 60 * 60_000, graceMs: 2 * 60_000 });
  const ms = Date.now() - started;
  const why = r.stalled ? `ended after ${Math.round(stallMs / 60_000)} min with no new results` : r.timedOut ? 'ended at the 60 min limit' : '';
  if (!existsSync(out) || !statSync(out).size) {
    recordSource(db, 'maps', opts.queries.join(' | ').slice(0, 200), false, 0, ms, `${why} ${r.stderr}`.trim().slice(-500));
    throw new Error(`the Maps collector produced no output${why ? ` (${why})` : ''}: ${r.stderr.slice(-500)}`);
  }
  const all = parseGosom(readFileSync(out, 'utf8'));
  const kept = dedupePlaces(all.filter((p) => inArea(p, opts.area ?? {})));
  recordSource(db, 'maps', opts.queries.join(' | ').slice(0, 200), true, kept.length, ms, why || undefined);
  return { places: kept, dropped_outside_area: all.length - all.filter((p) => inArea(p, opts.area ?? {})).length, raw: all.length, file: out, stalled: r.stalled || r.timedOut };
}

// ---- A business's own website: published emails, phones and Instagram, and whether the site really is theirs.
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' };
// Numbers website templates ship with (9876543210, 1234567890, 9999999999...).
const PLACEHOLDER_PHONE = /^\+91(9876543210|1234567890|0123456789|9999999999|8888888888|7777777777|9000000000|9123456789)$/;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg|js|css|json|woff2?)$|^(example|email|name|your)@|@(example|domain|sentry|wixpress)\.|@\d+\.\d+/i;

async function get(url: string): Promise<{ ok: boolean; status: number; html: string; final: string }> {
  try {
    const ctl = AbortSignal.timeout(15_000);
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: ctl });
    const html = r.ok ? (await r.text()).slice(0, 2_000_000) : '';
    return { ok: r.ok, status: r.status, html, final: r.url };
  } catch (e) {
    return { ok: false, status: 0, html: '', final: url };
  }
}

export function extractContacts(html: string): { emails: string[]; phones: string[]; instagram: string[]; title: string | null } {
  // Only what a visitor sees, plus mailto/tel/Instagram links: scripts and styles are full of things that look like contacts.
  const titleTag = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i)?.[1]?.trim() ?? null;
  const links = [...html.matchAll(/href=["'](mailto:[^"']+|tel:[^"']+|https?:\/\/(?:www\.)?instagram\.com\/[^"']+)["']/gi)].map((m) => m[1]).join(' ');
  const visible = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ');
  html = `${visible} ${links}`;
  // Obfuscated addresses ("riya [at] site [dot] in") are still published addresses.
  const decoded = html.replace(/&#64;|&commat;|\s*\[at\]\s*|\s*\(at\)\s*/gi, '@').replace(/&#46;|\s*\[dot\]\s*|\s*\(dot\)\s*/gi, '.');
  const emails = [...new Set([...(decoded.match(/mailto:([^"'?>\s]+)/gi) ?? []).map((m) => m.slice(7)), ...(decoded.match(EMAIL_RE) ?? [])].map((e) => decodeURIComponent(e).toLowerCase()))]
    .filter((e) => emailSyntax(e).valid && !BAD_EMAIL.test(e));
  const phones = [...new Set([...(decoded.match(/tel:([+\d\s()-]{8,})/gi) ?? []).map((m) => m.slice(4)), ...(decoded.match(/(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g) ?? [])]
    .map((p) => normalizePhone(p)).filter((p) => p.valid && !PLACEHOLDER_PHONE.test(p.e164!)).map((p) => p.e164!))];
  const instagram = [...new Set((decoded.match(/https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+/g) ?? []).filter((u) => !/\/(p|reel|explore|accounts)\b/.test(u)))];
  return { emails, phones, instagram, title: titleTag };
}

export async function collectSite(db: DatabaseSync, url: string, businessName?: string): Promise<Row> {
  const started = Date.now();
  const home = await get(url.startsWith('http') ? url : `https://${url}`);
  if (!home.ok) {
    recordSource(db, 'site', url, false, 0, Date.now() - started, `HTTP ${home.status}`);
    return { url, live: false, status: home.status, emails: [], phones: [], instagram: [], owner_match: null };
  }
  const base = new URL(home.final);
  const links = [...home.html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => m[1])
    .filter((h) => /contact|about|reach|connect|team|book/i.test(h)).slice(0, 4)
    .map((h) => { try { return new URL(h, base).href; } catch { return null; } })
    .filter((h): h is string => Boolean(h) && normalizeDomain(h!) === normalizeDomain(base.href));
  const pages = [home, ...(await Promise.all([...new Set(links)].map(get)))].filter((p) => p.ok);
  const found = pages.map((p) => extractContacts(p.html));
  const emails = [...new Set(found.flatMap((f) => f.emails))];
  const phones = [...new Set(found.flatMap((f) => f.phones))];
  const instagram = [...new Set(found.flatMap((f) => f.instagram))];
  const title = found[0]?.title ?? null;
  // Ownership: the business name's main words appear in the title or the page.
  let owner_match: boolean | null = null;
  if (businessName) {
    const words = businessName.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/clinic|nutrition|diet|centre|center|studio|the|and/.test(w));
    const hay = `${title ?? ''} ${home.html.slice(0, 200_000)}`.toLowerCase();
    owner_match = words.length ? words.some((w) => hay.includes(w)) : null;
  }
  recordSource(db, 'site', base.hostname, true, emails.length + phones.length, Date.now() - started);
  return { url: home.final, live: true, title, emails, phones, instagram, owner_match, pages_read: pages.length };
}

// ---- India Post pincodes (free API), cached under the Hunt Engine home.
const CACHE = () => join(HOME, 'cache', 'pincodes.json');
export async function pincodeInfo(pin: string): Promise<{ pincode: string; localities: string[]; district: string | null; state: string | null }> {
  mkdirSync(join(HOME, 'cache'), { recursive: true });
  const cache = existsSync(CACHE()) ? (JSON.parse(readFileSync(CACHE(), 'utf8')) as Record<string, ReturnType<typeof Object>>) : {};
  if (cache[pin]) return cache[pin] as never;
  const r = await fetch(`https://api.postalpincode.in/pincode/${encodeURIComponent(pin)}`, { headers: UA });
  const d = (await r.json()) as { Status: string; PostOffice: { Name: string; District: string; State: string }[] | null }[];
  const offices = d[0]?.PostOffice ?? [];
  const info = { pincode: pin, localities: offices.map((o) => o.Name), district: offices[0]?.District ?? null, state: offices[0]?.State ?? null };
  cache[pin] = info;
  writeFileSync(CACHE(), JSON.stringify(cache));
  return info;
}

// Company data for the job track: YC's hiring list (with team size), job-board discovery from careers pages,
// a watchlist the scout sweeps, headcount lookup, and email patterns learned from published addresses.
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from './db.ts';
import { HOME } from './paths.ts';
import { normalizeDomain, emailSyntax } from './normalize.ts';
import { classifyTier } from './tier.ts';
import { recordSource } from './collect.ts';
import type { Posting } from './sources.ts';

const UA = { 'User-Agent': 'Mozilla/5.0 (HuntEngine personal job search)' };

// ---- YC companies that are hiring (yc-oss mirror of the YC directory), cached for a day.
export type YcCompany = { name: string; slug: string; website: string; one_liner: string; team_size: number | null; regions: string[]; industries: string[]; tags: string[]; batch: string; stage: string; url: string; isHiring: boolean; all_locations: string };

export async function ycHiring(db?: DatabaseSync): Promise<YcCompany[]> {
  const file = join(HOME, 'cache', 'yc-hiring.json');
  mkdirSync(join(HOME, 'cache'), { recursive: true });
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 86_400_000) return JSON.parse(readFileSync(file, 'utf8')) as YcCompany[];
  const started = Date.now();
  const r = await fetch('https://yc-oss.github.io/api/companies/hiring.json', { headers: UA });
  if (!r.ok) {
    if (db) recordSource(db, 'yc', null, false, 0, Date.now() - started, `HTTP ${r.status}`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as YcCompany[];
    throw new Error(`YC list unavailable: HTTP ${r.status}`);
  }
  const list = ((await r.json()) as YcCompany[]).map((c) => ({ name: c.name, slug: c.slug, website: c.website, one_liner: c.one_liner, team_size: c.team_size ?? null, regions: c.regions ?? [], industries: c.industries ?? [], tags: c.tags ?? [], batch: c.batch, stage: c.stage, url: c.url, isHiring: c.isHiring, all_locations: c.all_locations ?? '' }));
  writeFileSync(file, JSON.stringify(list));
  if (db) recordSource(db, 'yc', null, true, list.length, Date.now() - started);
  return list;
}

export function filterYc(list: YcCompany[], o: { region?: string; match?: string; maxTeam?: number }): YcCompany[] {
  const region = o.region?.toLowerCase();
  const re = o.match ? new RegExp(o.match, 'i') : null;
  return list.filter((c) =>
    (!region || c.regions.some((r) => r.toLowerCase().includes(region)) || c.all_locations.toLowerCase().includes(region)) &&
    (!re || re.test(`${c.name} ${c.one_liner} ${c.industries.join(' ')} ${c.tags.join(' ')}`)) &&
    (!o.maxTeam || (c.team_size ?? 0) <= o.maxTeam));
}

// ---- Find the public job board behind a careers page.
const BOARDS: [RegExp, Row['provider']][] = [
  [/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, 'greenhouse'],
  [/boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i, 'greenhouse'],
  [/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/i, 'lever'],
  [/jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i, 'ashby'],
  [/apply\.workable\.com\/([a-z0-9_-]+)/i, 'workable'],
  [/careers\.smartrecruiters\.com\/([a-z0-9_-]+)/i, 'smartrecruiters'],
];
const IGNORE = new Set(['embed', 'v1', 'api', 'jobs', 'js', 'css', 'static', 'assets']);

export function detectBoards(html: string): { provider: string; board: string }[] {
  const found = new Map<string, { provider: string; board: string }>();
  for (const [re, provider] of BOARDS) {
    for (const m of html.matchAll(new RegExp(re.source, 'gi'))) {
      const board = m[1].replace(/[.]+$/, '');
      if (!IGNORE.has(board.toLowerCase())) found.set(`${provider}:${board.toLowerCase()}`, { provider: String(provider), board });
    }
  }
  return [...found.values()];
}

export async function discoverBoards(db: DatabaseSync, careersUrl: string, company: string, orgId?: number): Promise<{ provider: string; board: string; added: boolean }[]> {
  const started = Date.now();
  const r = await fetch(careersUrl.startsWith('http') ? careersUrl : `https://${careersUrl}`, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const html = r?.ok ? await r.text() : '';
  // The final URL itself may be the board (careers links that redirect to Lever or Ashby).
  const boards = detectBoards(`${r?.url ?? ''} ${html}`);
  recordSource(db, 'discover', careersUrl, Boolean(r?.ok), boards.length, Date.now() - started, r?.ok ? undefined : `HTTP ${r?.status ?? 'error'}`);
  return boards.map((b) => {
    const res = db.prepare(`INSERT OR IGNORE INTO watchlist (provider, board, company, organization_id) VALUES (?, ?, ?, ?)`).run(b.provider, b.board, company, orgId ?? null);
    return { ...b, added: Number(res.changes) > 0 };
  });
}

// Sweeps every active watchlist board with the same filters as `he source`.
export async function sweepWatchlist(db: DatabaseSync, filter: (p: Posting) => boolean): Promise<{ board: string; provider: string; found: number; matching: Posting[]; error?: string }[]> {
  const S = await import('./sources.ts');
  const fetchers: Record<string, (b: string) => Promise<Posting[]>> = { greenhouse: S.greenhouse, lever: S.lever, ashby: S.ashby, workable: S.workable };
  const rows = db.prepare(`SELECT * FROM watchlist WHERE active = 1 ORDER BY ifnull(last_checked_at, '') LIMIT 200`).all() as Row[];
  const out = [];
  for (const w of rows) {
    const fn = fetchers[String(w.provider)];
    if (!fn) continue;
    const started = Date.now();
    try {
      const list = await fn(String(w.board));
      const matching = list.filter(filter).map((p) => ({ ...p, company: String(w.company) }));
      db.prepare(`UPDATE watchlist SET last_checked_at = datetime('now'), last_count = ? WHERE id = ?`).run(list.length, Number(w.id));
      recordSource(db, String(w.provider), String(w.board), true, list.length, Date.now() - started);
      out.push({ board: String(w.board), provider: String(w.provider), found: list.length, matching });
    } catch (e) {
      recordSource(db, String(w.provider), String(w.board), false, 0, Date.now() - started, (e as Error).message);
      // A board that 404s three times in a row is switched off.
      const fails = Number((db.prepare(`SELECT count(*) AS n FROM (SELECT ok FROM source_runs WHERE source = ? AND target = ? ORDER BY id DESC LIMIT 3) WHERE ok = 0`).get(String(w.provider), String(w.board)) as Row).n);
      if (fails >= 3) db.prepare('UPDATE watchlist SET active = 0 WHERE id = ?').run(Number(w.id));
      out.push({ board: String(w.board), provider: String(w.provider), found: 0, matching: [], error: (e as Error).message });
    }
  }
  return out;
}

// ---- Headcount: YC's team size when the company is in YC's list; otherwise leave it for the scout to research.
export async function resolveSize(db: DatabaseSync, orgId: number, dreamList: string[]): Promise<Row> {
  const org = db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId) as Row | undefined;
  if (!org) throw new Error(`organization ${orgId} not found`);
  const yc = await ycHiring(db).catch(() => [] as YcCompany[]);
  let all = yc;
  // The hiring list covers most cases; fall back to the full directory only when needed (it is large).
  const dom = normalizeDomain(String(org.domain ?? org.website ?? ''));
  let hit = all.find((c) => (dom && normalizeDomain(c.website) === dom) || c.name.toLowerCase() === String(org.name).toLowerCase());
  if (!hit) {
    const file = join(HOME, 'cache', 'yc-all.json');
    if (!existsSync(file) || Date.now() - statSync(file).mtimeMs > 7 * 86_400_000) {
      const r = await fetch('https://yc-oss.github.io/api/companies/all.json', { headers: UA }).catch(() => null);
      if (r?.ok) writeFileSync(file, JSON.stringify(((await r.json()) as YcCompany[]).map((c) => ({ name: c.name, website: c.website, team_size: c.team_size, slug: c.slug }))));
    }
    all = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as YcCompany[]) : [];
    hit = all.find((c) => (dom && normalizeDomain(c.website) === dom) || c.name.toLowerCase() === String(org.name).toLowerCase());
  }
  if (!hit?.team_size) return { organization_id: orgId, found: false, note: 'not in the YC directory; the scout looks it up on the careers page, Wellfound or LinkedIn and records employees with size_source' };
  const t = classifyTier({ ...(org as never), employees: hit.team_size }, dreamList);
  db.prepare(`UPDATE organizations SET employees = ?, size_source = ?, tier = ?, tier_reasons = ?, updated_at = datetime('now') WHERE id = ?`).run(hit.team_size, `yc:${hit.slug}`, t.tier, JSON.stringify(t.reasons), orgId);
  return { organization_id: orgId, found: true, employees: hit.team_size, source: `yc:${hit.slug}`, tier: t.tier };
}

// ---- Email patterns learned from addresses a company has published.
export const PATTERNS: Record<string, (f: string, l: string) => string> = {
  'first': (f) => f, 'first.last': (f, l) => `${f}.${l}`, 'firstlast': (f, l) => `${f}${l}`, 'flast': (f, l) => `${f[0]}${l}`,
  'firstl': (f, l) => `${f}${l[0]}`, 'first_last': (f, l) => `${f}_${l}`, 'last.first': (f, l) => `${l}.${f}`, 'f.last': (f, l) => `${f[0]}.${l}`, 'last': (_f, l) => l,
};
const clean = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '');

export function patternOf(name: string, email: string): string | null {
  const parts = name.trim().split(/\s+/).map(clean).filter(Boolean);
  if (!parts.length) return null;
  const [f, l] = [parts[0], parts[parts.length - 1]];
  const local = email.split('@')[0].toLowerCase();
  for (const [k, fn] of Object.entries(PATTERNS)) {
    if (k !== 'first' && parts.length < 2) continue; // every other pattern needs a last name
    if (fn(f, l) === local) return k;
  }
  return null;
}

export function learnPattern(db: DatabaseSync, orgId: number): { pattern: string | null; votes: Record<string, number> } {
  // Guesses never count as evidence (an MX check only says the domain takes mail), so a guess cannot teach its own pattern.
  const rows = db.prepare(`SELECT name, email FROM people WHERE organization_id = ? AND email IS NOT NULL AND email_status IN ('published','verified')`).all(orgId) as Row[];
  const votes: Record<string, number> = {};
  for (const r of rows) {
    if (emailSyntax(String(r.email)).role) continue;
    const p = patternOf(String(r.name), String(r.email));
    if (p) votes[p] = (votes[p] ?? 0) + 1;
  }
  const best = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const cur = db.prepare('SELECT email_pattern, email_pattern_status FROM organizations WHERE id = ?').get(orgId) as Row | undefined;
  // A pattern that bounced stays bounced; learning only records a different pattern.
  if (best && !(cur?.email_pattern === best && cur?.email_pattern_status === 'bounced')) db.prepare(`UPDATE organizations SET email_pattern = ?, email_pattern_status = 'seen' WHERE id = ?`).run(best, orgId);
  return { pattern: cur?.email_pattern === best && cur?.email_pattern_status === 'bounced' ? null : best, votes };
}

export function applyPattern(pattern: string, name: string, domain: string): string | null {
  const parts = name.trim().split(/\s+/).map(clean).filter(Boolean);
  const fn = PATTERNS[pattern];
  if (!fn || !parts.length) return null;
  const [f, l] = [parts[0], parts[parts.length - 1]];
  if (pattern !== 'first' && parts.length < 2) return null;
  return `${fn(f, l)}@${domain}`;
}

// The master resume: imported from the person's .docx, every line a claim with a stable id,
// re-importable when the resume changes. Tailored resumes are built only from these lines.
import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Row } from './db.ts';
import { insert, logActivity } from './db.ts';
import { REPO_ROOT, workspaceDir } from './paths.ts';

export type Bullet = { id: string; text: string; claim_id?: number };
export type Entry = { id: string; title: string; role: string; dates: string; subtitle: string; bullets: Bullet[]; claim_id?: number };
export type Item = { id: string; label: string; text: string; claim_id?: number };
export type Section = { key: string; title: string; entries: Entry[]; items: Item[] };
export type Master = {
  name: string;
  contact: { line: string; parts: string[]; links: { label: string; url: string }[] };
  summary: Bullet[];
  sections: Section[];
  layout: { page_width_in: number; page_height_in: number };
  source: { file: string; imported_at: string };
};

const norm = (s: string) => s.toLowerCase().replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[^a-z0-9₹%.]+/g, ' ').trim();
const hid = (prefix: string, s: string) => `${prefix}-${createHash('sha1').update(norm(s)).digest('hex').slice(0, 8)}`;
export const plainText = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

function words(s: string): Set<string> {
  return new Set(norm(s).split(' ').filter((w) => w.length > 2));
}
export function similarity(a: string, b: string): number {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export function masterPath(slug: string): string {
  return join(workspaceDir(slug), 'files', 'resume', 'master.json');
}

export function loadMaster(slug: string): Master | null {
  const p = masterPath(slug);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Master) : null;
}

type Raw = Omit<Master, 'summary' | 'sections' | 'source'> & { warnings?: string[]; summary: string[]; sections: { key: string; title: string; entries: { title: string; role: string; dates: string; subtitle: string; bullets: string[] }[]; items: { label: string; text: string }[] }[] };

export function parseDocx(file: string): Raw {
  const script = join(REPO_ROOT, 'engine', 'adapters', 'python', 'resume_import.py');
  const r = spawnSync('uv', ['run', '--quiet', '--with', 'python-docx', 'python', '-I', script, file], { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`could not read the resume: ${(r.stderr || r.stdout).slice(-600)}`);
  return JSON.parse(r.stdout.trim()) as Raw;
}

// Give every entry, bullet and item a stable id based on its text.
export function withIds(raw: Raw, file: string): Master {
  return {
    name: raw.name, contact: raw.contact, layout: raw.layout,
    summary: raw.summary.map((t) => ({ id: hid('s', t), text: t })),
    sections: raw.sections.map((s) => ({
      key: s.key, title: s.title,
      entries: s.entries.map((e) => ({ id: hid('e', `${s.key} ${e.title} ${e.role} ${e.subtitle} ${e.dates}`), title: e.title, role: e.role, dates: e.dates, subtitle: e.subtitle, bullets: e.bullets.map((b) => ({ id: hid('b', b), text: b })) })),
      items: s.items.map((it) => ({ id: hid('i', `${it.label} ${it.text}`), label: it.label, text: it.text })),
    })),
    source: { file, imported_at: new Date().toISOString() },
  };
}

type Line = { id: string; text: string; where: string; kind: 'summary' | 'entry' | 'bullet' | 'item' };

export function lines(m: Master): Line[] {
  const out: Line[] = m.summary.map((b) => ({ id: b.id, text: b.text, where: 'Profile', kind: 'summary' as const }));
  for (const s of m.sections) {
    for (const e of s.entries) {
      const head = [e.title, e.role, e.subtitle, e.dates].filter(Boolean).join(' | ');
      out.push({ id: e.id, text: head, where: s.title, kind: 'entry' });
      for (const b of e.bullets) out.push({ id: b.id, text: b.text, where: `${s.title} > ${e.title}`, kind: 'bullet' });
    }
    for (const it of s.items) out.push({ id: it.id, text: it.label ? `${it.label}: ${it.text}` : it.text, where: s.title, kind: 'item' });
  }
  return out;
}

export type ImportDiff = { added: Line[]; removed: Line[]; changed: { from: Line; to: Line }[]; unchanged: number };

export function diffMasters(prev: Master | null, next: Master): ImportDiff {
  const a = prev ? lines(prev) : [];
  const b = lines(next);
  const aIds = new Set(a.map((l) => l.id));
  const bIds = new Set(b.map((l) => l.id));
  let added = b.filter((l) => !aIds.has(l.id));
  let removed = a.filter((l) => !bIds.has(l.id));
  // A line that was edited (not replaced) keeps most of its words: pair it up as a change.
  const changed: { from: Line; to: Line }[] = [];
  for (const r of [...removed]) {
    const best = added.filter((x) => x.kind === r.kind).map((x) => ({ x, s: similarity(r.text, x.text) })).sort((p, q) => q.s - p.s)[0];
    if (best && best.s >= 0.5) {
      changed.push({ from: r, to: best.x });
      added = added.filter((x) => x !== best.x);
      removed = removed.filter((x) => x !== r);
    }
  }
  return { added, removed, changed, unchanged: b.length - added.length - changed.length };
}

// Imports (or re-imports) the resume: master.json, a dated copy, and claims kept in step with it.
export function importResume(db: DatabaseSync, slug: string, file: string, agent: string): { diff: ImportDiff; master: string; claims: { added: number; retired: number }; warnings: string[] } {
  if (!existsSync(file)) throw new Error(`resume not found: ${file}`);
  const raw = parseDocx(file);
  if (!raw.sections.length) throw new Error(`no sections were recognised in ${basename(file)}; nothing was changed. ${raw.warnings?.join('; ') ?? ''}`);
  const next = withIds(raw, basename(file));
  const prev = loadMaster(slug);
  const diff = diffMasters(prev, next);
  const date = new Date().toISOString().slice(0, 10);
  const evidence = (l: Line) => `resume ${basename(file)} (${date}), ${l.where}`;

  db.exec('BEGIN');
  try {
    let addedClaims = 0;
    let retired = 0;
    const retire = db.prepare(`UPDATE claims SET status = 'retired' WHERE source_ref = ? AND status = 'active'`);
    for (const l of diff.removed) retired += Number(retire.run(l.id).changes);
    for (const c of diff.changed) retired += Number(retire.run(c.from.id).changes);
    // Every line in the new master needs an active claim (new, changed, or carried over from before claims existed).
    for (const l of lines(next)) {
      const has = db.prepare(`SELECT id FROM claims WHERE source_ref = ? AND status = 'active'`).get(l.id) as Row | undefined;
      if (has) continue;
      insert(db, 'claims', { text: plainText(l.text), evidence: evidence(l), contexts: 'job,freelance', status: 'active', source_ref: l.id });
      addedClaims++;
    }
    db.exec('COMMIT');
    const dir = join(workspaceDir(slug), 'files', 'resume');
    mkdirSync(dir, { recursive: true });
    if (prev) writeFileSync(join(dir, `master-${prev.source.imported_at.slice(0, 10)}-${Date.now()}.json`), JSON.stringify(prev, null, 2));
    writeFileSync(masterPath(slug), JSON.stringify(next, null, 2));
    logActivity(db, { agent, action: 'resume.import', detail: { file: basename(file), added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length } });
    return { diff, master: masterPath(slug), claims: { added: addedClaims, retired }, warnings: raw.warnings ?? [] };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- Rephrasing guard: a tailored line may reorder and trim words, never add numbers or names.
const NUM = /\d[\d,]*(?:\.\d+)?/g;
// Words that turn taking part into leading; a rewrite may keep them only if the original line had them.
const CLAIM_WORDS = ['led', 'lead', 'leading', 'headed', 'managed', 'manage', 'managing', 'owned', 'own', 'spearheaded', 'directed', 'founded', 'co-founded', 'cofounded', 'launched', 'architected', 'supervised', 'mentored', 'oversaw', 'drove', 'pioneered', 'sole', 'solely', 'single-handedly', 'chief', 'head', 'senior', 'principal', 'expert', 'award', 'awarded', 'won', 'first', 'only', 'top', 'best', 'record', 'increased', 'reduced', 'grew', 'doubled', 'tripled', 'saved', 'generated'];
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;

export function rewriteProblems(source: string, rewrite: string, vocabulary: Set<string>): string[] {
  const p: string[] = [];
  const src = plainText(source);
  const out = plainText(rewrite);
  const srcLinks = new Set([...source.matchAll(LINK)].map((m) => m[2]));
  for (const m of rewrite.matchAll(LINK)) if (!srcLinks.has(m[2])) p.push(`adds a link (${m[2]})`);
  const srcLower = new Set(src.toLowerCase().split(/[^\p{L}\p{N}-]+/u));
  for (const w of out.toLowerCase().split(/[^\p{L}\p{N}-]+/u)) if (CLAIM_WORDS.includes(w) && !srcLower.has(w)) p.push(`adds the claim word "${w}"`);
  const srcNums = new Set((src.match(NUM) ?? []).map((n) => n.replace(/,/g, '')));
  for (const n of out.match(NUM) ?? []) if (!srcNums.has(n.replace(/,/g, ''))) p.push(`adds the number ${n}`);
  const srcWords = new Set(src.split(/[^\p{L}\p{N}&.+#'-]+/u).map((w) => w.toLowerCase()));
  // Capitalised words that are not the first word and not in the source or the person's own resume are new names.
  const tokens = out.split(/[^\p{L}\p{N}&.+#'-]+/u).filter(Boolean);
  tokens.forEach((t, i) => {
    const w = t.replace(/^[.'-]+|[.'-]+$/g, '');
    if (i === 0 || !/^\p{Lu}/u.test(w) || w.length < 2) return;
    if (!srcWords.has(w.toLowerCase()) && !vocabulary.has(w.toLowerCase())) p.push(`adds the name "${w}"`);
  });
  if (/—/.test(out)) p.push('contains an em dash');
  if (out.length > src.length * 1.25 + 20) p.push('is much longer than the original line');
  return [...new Set(p)];
}

export function vocabulary(m: Master): Set<string> {
  return wordsOf(lines(m).map((l) => plainText(l.text)).join(' '));
}

export function wordsOf(text: string): Set<string> {
  return new Set(text.split(/[^\p{L}\p{N}&.+#'-]+/u).map((w) => w.toLowerCase().replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean));
}

// The words a rewrite of a line in this entry may use for names: the entry's own heading and lines.
export function entryVocabulary(e: Entry): Set<string> {
  return wordsOf(plainText([e.title, e.role, e.subtitle, ...e.bullets.map((b) => b.text)].join(' ')));
}

// Tailored resumes and cover letters: the tailor picks lines from the master by id; this file checks the plan,
// lays it out in the person's style, writes PDF and DOCX, and trims until the chosen page count fits.
import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from './db.ts';
import { REPO_ROOT, workspaceDir } from './paths.ts';
import { htmlToPdf } from './docs.ts';
import type { Master } from './resume.ts';
import { entryVocabulary, loadMaster, plainText, rewriteProblems, vocabulary } from './resume.ts';
import { factCheck } from './docs.ts';
import { slugKey } from './normalize.ts';

// ---- Format suggestion from what we know about the posting. The tailor researches and makes the final call.
export type FormatHint = {
  ats: string; region: string; paper: 'A4' | 'Letter'; upload: 'pdf' | 'docx';
  pages: { suggest: 1 | 2 | null; strength: 'strong' | 'leaning' | 'open'; reasons: string[] };
  photo: 'no' | 'optional'; notes: string[];
};

const ATS: [RegExp, string][] = [
  [/greenhouse\.io|grnh\.se/, 'greenhouse'], [/lever\.co/, 'lever'], [/ashbyhq\.com/, 'ashby'], [/workable\.com/, 'workable'],
  [/myworkdayjobs|workday\.com/, 'workday'], [/smartrecruiters/, 'smartrecruiters'], [/icims\.com/, 'icims'], [/taleo\.net/, 'taleo'],
  [/successfactors|sapsf/, 'successfactors'], [/naukri\.com/, 'naukri'], [/internshala\.com/, 'internshala'], [/wellfound\.com|angel\.co/, 'wellfound'],
  [/linkedin\.com/, 'linkedin'], [/workatastartup|ycombinator/, 'yc'], [/instahyre/, 'instahyre'], [/cutshort/, 'cutshort'],
];
const STRICT_ATS = new Set(['workday', 'taleo', 'icims', 'successfactors']);

export function formatHint(opp: Row, org?: Row): FormatHint {
  const url = String(opp.url ?? '').toLowerCase();
  const text = `${opp.title ?? ''} ${opp.description ?? ''}`.toLowerCase();
  const where = `${opp.location ?? ''} ${org?.city ?? ''} ${org?.country ?? ''}`.toLowerCase();
  const ats = ATS.find(([re]) => re.test(url))?.[1] ?? 'other';
  const region = /india|mumbai|bengaluru|bangalore|delhi|gurgaon|gurugram|noida|pune|hyderabad|chennai|kolkata|ahmedabad/.test(where) ? 'IN'
    : /united states|usa|\bus\b|new york|san francisco|california|texas|seattle|boston|chicago|remote \(us/.test(where) ? 'US'
    : /canada|toronto|vancouver/.test(where) ? 'CA'
    : /united kingdom|\buk\b|london|manchester/.test(where) ? 'UK'
    : /dubai|uae|abu dhabi|saudi|riyadh|qatar|doha/.test(where) ? 'GULF'
    : /germany|berlin|munich|france|paris|netherlands|amsterdam|spain|italy|europe|\beu\b/.test(where) ? 'EU'
    : /singapore|hong kong|australia|sydney|japan|tokyo/.test(where) ? 'APAC'
    : /remote/.test(where) ? 'REMOTE' : 'UNKNOWN';
  const reasons: string[] = [];
  let suggest: 1 | 2 | null = null;
  let strength: 'strong' | 'leaning' | 'open' = 'open';
  const finance = /investment bank|\bib\b|asset management|equity research|private equity|venture capital|hedge fund|wealth management|corporate finance|m&a|capital markets|quant|trading|valuation/.test(text);
  const consulting = /consult|strategy analyst|business analyst/.test(text);
  const tech = /engineer|developer|software|machine learning|\bai\b|data scien|product manager|full.?stack/.test(text);
  if (finance) { suggest = 1; strength = 'strong'; reasons.push('finance roles for students and freshers expect one page'); }
  else if (consulting) { suggest = 1; strength = 'leaning'; reasons.push('consulting and strategy screens favour one page'); }
  else if (tech) { strength = 'open'; reasons.push('tech and AI roles accept two pages when the projects are relevant'); }
  if (/one.page|1.page|single.page/.test(text)) { suggest = 1; strength = 'strong'; reasons.push('the posting asks for one page'); }
  if (/two.page|2.page/.test(text)) { suggest = 2; strength = 'strong'; reasons.push('the posting allows two pages'); }
  const wantsDocx = /\.docx?|word (document|format)|ms word/.test(text);
  const notes: string[] = [];
  if (STRICT_ATS.has(ats)) notes.push(`${ats} parses DOCX most reliably and wants exact section headings (Education, Experience, Skills)`);
  if (region === 'GULF' || region === 'EU') notes.push('a photo is common in this region but not required; leave it out unless the posting asks');
  return {
    ats, region, paper: region === 'US' || region === 'CA' ? 'Letter' : 'A4',
    upload: wantsDocx || STRICT_ATS.has(ats) ? 'docx' : 'pdf',
    pages: { suggest, strength, reasons }, photo: region === 'GULF' || region === 'EU' ? 'optional' : 'no', notes,
  };
}

// ---- The tailor's plan.
export type Plan = {
  format: { pages: 1 | 2; paper?: 'A4' | 'Letter'; font_pt?: number; order?: string[]; summary?: boolean; why?: string };
  summary?: string;                                     // a rephrasing of the master profile (guarded)
  // dates / subtitle change an entry's heading (for example a different graduation year). Only headings the
  // person approved, recorded in the job profile's `approved_headings`, are accepted; anything else stops the build.
  entries: { id: string; bullets: string[]; rewrite?: Record<string, string>; dates?: string; subtitle?: string }[];
  items?: Record<string, string[]>;                      // section key -> item ids, e.g. certifications, skills
  drop_order?: string[];                                 // bullets to drop first if the page count is over
};

export type Model = {
  name: string; contact: Master['contact'];
  format: { pages: 1 | 2; paper: 'A4' | 'Letter'; font_pt: number; margin_in: number };
  summary: string | null;
  sections: { key: string; title: string; entries: { id: string; title: string; role: string; dates: string; subtitle: string; bullets: { id: string; text: string }[] }[]; items: { id: string; label: string; text: string }[] }[];
};

// for_opportunities limits an approval to those opportunities; without it the approval holds for every application.
export type ApprovedHeading = { entry: string; dates?: string; subtitle?: string; why?: string; for_opportunities?: number[] };
export const headingsFor = (approved: ApprovedHeading[], oppId: number) =>
  approved.filter((a) => !Array.isArray(a.for_opportunities) || a.for_opportunities.map(Number).includes(Number(oppId)));

// A heading change must match one the person approved, field for field (whitespace-insensitive).
function headingProblem(e: { id: string; title: string; dates: string; subtitle: string }, p: { dates?: string; subtitle?: string }, approved: ApprovedHeading[]): string | null {
  if (p.dates == null && p.subtitle == null) return null;
  const norm = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim();
  const ok = approved.some((a) => a.entry === e.id
    && (p.dates == null || norm(a.dates) === norm(p.dates))
    && (p.subtitle == null || norm(a.subtitle) === norm(p.subtitle)));
  return ok ? null : `heading change for ${e.title} is not one the person approved (add it to the job profile's approved_headings first)`;
}

// The headings the person approved for this opportunity, from the newest job profile.
export function approvedHeadings(db: DatabaseSync, oppId: number): ApprovedHeading[] {
  const prof = db.prepare(`SELECT data FROM profiles WHERE track = 'job' ORDER BY version DESC LIMIT 1`).get() as Row | undefined;
  try { return headingsFor(((prof ? JSON.parse(String(prof.data)) : {}) as { approved_headings?: ApprovedHeading[] }).approved_headings ?? [], oppId); } catch { return []; }
}
// What an approved heading says counts as backed for the fact check, for that opportunity only.
const headingText = (a: ApprovedHeading[]) => a.map((h) => `${h.dates ?? ''} ${h.subtitle ?? ''}`).join('\n');

export function buildModel(master: Master, plan: Plan, approved: ApprovedHeading[] = []): { model: Model; problems: string[] } {
  const problems: string[] = [];
  const vocab = vocabulary(master);
  const byEntry = new Map(master.sections.flatMap((s) => s.entries.map((e) => [e.id, { s, e }] as const)));
  const order = plan.format.order ?? master.sections.map((s) => s.key);
  const chosen = new Map(plan.entries.map((p) => [p.id, p]));
  for (const p of plan.entries) if (!byEntry.has(p.id)) problems.push(`unknown entry ${p.id}`);

  let summary: string | null = null;
  if (plan.format.summary !== false && master.summary.length) {
    summary = master.summary.map((s) => s.text).join(' ');
    if (plan.summary) {
      const bad = rewriteProblems(summary, plan.summary, vocab);
      if (bad.length) problems.push(`summary: ${bad.join(', ')}`); else summary = plan.summary;
    }
  }

  const sections: Model['sections'] = [];
  for (const key of order) {
    const s = master.sections.find((x) => x.key === key);
    if (!s || key === 'summary') continue;
    const entries = s.entries.filter((e) => chosen.has(e.id)).sort((a, b) => plan.entries.findIndex((p) => p.id === a.id) - plan.entries.findIndex((p) => p.id === b.id)).map((e) => {
      const p = chosen.get(e.id)!;
      const bullets = p.bullets.map((bid) => {
        const src = e.bullets.find((b) => b.id === bid);
        if (!src) { problems.push(`${e.title}: unknown bullet ${bid}`); return null; }
        const rw = p.rewrite?.[bid];
        if (!rw) return { id: bid, text: src.text };
        const bad = rewriteProblems(src.text, rw, entryVocabulary(e));
        if (bad.length) { problems.push(`${bid}: ${bad.join(', ')}`); return { id: bid, text: src.text }; }
        return { id: bid, text: rw };
      }).filter(Boolean) as { id: string; text: string }[];
      const hp = headingProblem(e, p, approved);
      if (hp) problems.push(hp);
      const useHeading = !hp && (p.dates != null || p.subtitle != null);
      return { id: e.id, title: e.title, role: e.role, dates: useHeading && p.dates != null ? p.dates : e.dates, subtitle: useHeading && p.subtitle != null ? p.subtitle : e.subtitle, bullets };
    });
    const itemIds = plan.items?.[key];
    const items = itemIds ? s.items.filter((it) => itemIds.includes(it.id)) : s.items;
    if (entries.length || items.length) sections.push({ key, title: s.title, entries, items });
  }
  if (!sections.some((s) => s.key === 'education')) problems.push('the education section must be included');
  const model: Model = {
    name: master.name, contact: master.contact,
    format: { pages: plan.format.pages, paper: plan.format.paper ?? 'A4', font_pt: Math.max(10, Math.min(11.5, plan.format.font_pt ?? 10.5)), margin_in: plan.format.pages === 1 ? 0.5 : 0.6 },
    summary, sections,
  };
  return { model, problems };
}

// ---- HTML in the person's style: single column, bold uppercase headings with a rule, dates right-aligned.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const linkify = (s: string) => esc(s).replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s"]+)\)/g, (_, l, u) => `<a href="${u.replace(/"/g, '&quot;')}">${l}</a>`);

export function resumeHtml(m: Model): string {
  const f = m.format;
  const size = f.paper === 'Letter' ? 'Letter' : 'A4';
  const contact = m.contact.parts.map((p) => {
    const link = m.contact.links.find((l) => l.label === p);
    return link ? `<a href="${esc(link.url)}">${esc(p)}</a>` : esc(p);
  }).join('  |  ');
  const sec = m.sections.map((s) => {
    const entries = s.entries.map((e) => `
      <div class="entry">
        <div class="row"><span class="t">${esc(e.title)}${e.role ? `<span class="role">  ${esc(e.role)}</span>` : ''}</span><span class="d">${esc(e.dates)}</span></div>
        ${e.subtitle ? `<div class="sub">${linkify(e.subtitle)}</div>` : ''}
        ${e.bullets.length ? `<ul>${e.bullets.map((b) => `<li>${linkify(b.text)}</li>`).join('')}</ul>` : ''}
      </div>`).join('');
    const items = s.items.length ? (s.key === 'skills'
      ? `<div class="items">${s.items.map((it) => `<p>${it.label ? `<b>${esc(it.label)}:</b> ` : ''}${linkify(it.text)}</p>`).join('')}</div>`
      : `<ul>${s.items.map((it) => `<li>${it.label ? `<b>${esc(it.label)}:</b> ` : ''}${linkify(it.text)}</li>`).join('')}</ul>`) : '';
    return `<section><h2>${esc(s.title.toUpperCase())}</h2>${entries}${items}</section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(m.name)} Resume</title><style>
@page { size: ${size}; margin: ${f.margin_in}in; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: ${f.font_pt}pt; line-height: 1.22; color: #1a1a1a; }
a { color: #1155cc; text-decoration: none; }
h1 { font-size: ${f.font_pt + 9}pt; margin: 0; text-align: center; letter-spacing: 0.5px; }
.contact { text-align: center; font-size: ${f.font_pt - 0.5}pt; margin: 2pt 0 4pt; }
h2 { font-size: ${f.font_pt + 0.5}pt; margin: 7pt 0 3pt; padding-bottom: 1pt; border-bottom: 0.75pt solid #1a1a1a; letter-spacing: 0.3px; }
.entry { margin: 0 0 4pt; break-inside: avoid-page; }
.row { display: flex; justify-content: space-between; gap: 8pt; font-weight: 700; }
.row .d { white-space: nowrap; }
.role { font-weight: 400; font-style: italic; }
.sub { font-style: italic; }
ul { margin: 1pt 0 0; padding-left: 13pt; }
li { margin: 0 0 1.2pt; }
.items p { margin: 0 0 1.5pt; }
.summary { margin: 0; text-align: justify; }
</style></head><body>
<h1>${esc(m.name)}</h1>
<div class="contact">${contact}</div>
${m.summary ? `<section><h2>PROFILE</h2><p class="summary">${linkify(m.summary)}</p></section>` : ''}
${sec}
</body></html>`;
}

export function pdfPages(pdf: string): number {
  const bytes = readFileSync(pdf).toString('latin1');
  return (bytes.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}

function writeDocx(model: Model, out: string, kind: 'resume' | 'letter' = 'resume', letter?: Row): void {
  const script = join(REPO_ROOT, 'engine', 'adapters', 'python', 'resume_docx.py');
  const input = `${out}.json`;
  writeFileSync(input, JSON.stringify({ kind, model, letter }));
  const r = spawnSync('uv', ['run', '--quiet', '--with', 'python-docx', 'python', '-I', script, input, out], { encoding: 'utf8', timeout: 180_000 });
  rmSync(input, { force: true });
  if (r.status !== 0 || !existsSync(out)) throw new Error(`DOCX not written: ${(r.stderr || r.stdout).slice(-600)}`);
}

// ---- Build, then trim until the chosen page count fits.
export function buildResume(db: DatabaseSync, slug: string, oppId: number, plan: Plan): Row {
  const master = loadMaster(slug);
  if (!master) throw new Error('no master resume yet: run `he resume import <file.docx>` first');
  const opp = db.prepare('SELECT o.*, org.name AS org_name FROM opportunities o LEFT JOIN organizations org ON org.id = o.organization_id WHERE o.id = ?').get(oppId) as Row | undefined;
  if (!opp) throw new Error(`opportunity ${oppId} not found`);
  const approved = approvedHeadings(db, oppId);
  const { model, problems } = buildModel(master, plan, approved);
  if (problems.some((p) => /unknown|education|heading change/.test(p))) throw new Error(`plan problems: ${problems.join('; ')}`);

  const dir = join(workspaceDir(slug), 'files', 'resumes');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `${slugKey(String(opp.org_name ?? 'company'), String(opp.title)).replace(/\|/g, '-').slice(0, 60)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  const html = `${base}.html`;
  const pdf = `${base}.pdf`;
  // Drop order: the tailor's list first, then always the last bullet of whichever entry has the most,
  // so every role keeps its strongest lines. Each entry keeps at least one bullet.
  const seq: string[] = [];
  {
    const counts = new Map(model.sections.flatMap((s) => s.entries.map((e) => [e.id, e.bullets.map((b) => b.id)] as const)));
    const take = (bid: string) => { for (const [eid, ids] of counts) if (ids.includes(bid) && ids.length > 1) { counts.set(eid, ids.filter((x) => x !== bid)); seq.push(bid); return; } };
    for (const bid of plan.drop_order ?? []) take(bid);
    // Certifications beyond the first two go before any experience bullet.
    const certs = model.sections.find((x) => x.key === 'certifications');
    if (certs) for (const it of certs.items.slice(2).reverse()) seq.push(it.id);
    for (;;) {
      const [eid, ids] = [...counts.entries()].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length || -1)[0] ?? [];
      if (!eid) break;
      take(ids![ids!.length - 1]);
    }
  }
  const full = JSON.parse(JSON.stringify(model)) as Model;
  const apply = (k: number, font: number) => {
    const gone = new Set(seq.slice(0, k));
    model.format.font_pt = font;
    model.sections = full.sections.map((s) => ({ ...s, items: s.items.filter((it) => !gone.has(it.id)), entries: s.entries.map((e) => ({ ...e, bullets: e.bullets.filter((b) => !gone.has(b.id)) })) }));
  };
  const render = () => { writeFileSync(html, resumeHtml(model)); htmlToPdf(html, pdf); return pdfPages(pdf); };
  const target = model.format.pages;
  let pages = render();
  let dropped = 0;
  if (pages > target && model.format.font_pt > 10) { apply(0, 10); pages = render(); }
  if (pages > target) {
    // Smallest number of drops that fits, found by halving (renders are the slow part).
    let lo = 1, hi = seq.length, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      apply(mid, 10);
      if (render() <= target) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    dropped = best === -1 ? seq.length : best;
    apply(dropped, 10);
    pages = render();
  }
  // Still over with one bullet per entry: the layout is not squeezed further; the tailor has to drop a whole entry.
  const advice = pages > target
    ? `Does not fit on ${target} page(s) even with one line per entry. Drop the least relevant entry (for example ${
        model.sections.flatMap((s) => s.entries.map((e) => e.title)).slice(-1)[0] ?? 'an older role'}) or a project, then build again.`
    : null;
  const trimmed = seq.slice(0, dropped);

  // Every number must trace to the person's claims.
  const text = plainText([model.summary ?? '', ...model.sections.flatMap((s) => [...s.entries.flatMap((e) => [e.title, e.role, e.subtitle, e.dates, ...e.bullets.map((b) => b.text)]), ...s.items.map((i) => `${i.label} ${i.text}`)])].join('\n'));
  const fc = factCheck(db, text, headingText(approved));
  const docx = `${base}.docx`;
  writeDocx(model, docx);
  writeFileSync(`${base}.model.json`, JSON.stringify({ plan, model, trimmed, problems }, null, 2));
  return { html, pdf, docx, pages, target_pages: model.format.pages, fits: pages <= model.format.pages, advice, font_pt: model.format.font_pt, margin_in: model.format.margin_in, trimmed, rewrite_problems: problems, factcheck: fc };
}

// ---- Cover letter: header in the resume's style, body from the tailor (fact-checked), PDF and DOCX.
export function buildLetter(db: DatabaseSync, slug: string, oppId: number, body: string, paper: 'A4' | 'Letter' = 'A4'): Row {
  const master = loadMaster(slug);
  if (!master) throw new Error('no master resume yet: run `he resume import <file.docx>` first');
  const opp = db.prepare('SELECT o.*, org.name AS org_name FROM opportunities o LEFT JOIN organizations org ON org.id = o.organization_id WHERE o.id = ?').get(oppId) as Row | undefined;
  if (!opp) throw new Error(`opportunity ${oppId} not found`);
  const problems: string[] = [];
  if (/—/.test(body)) problems.push('contains an em dash');
  if (/i am writing to apply|i hope this (letter|email) finds you/i.test(body)) problems.push('uses a stock opening line');
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 320) problems.push(`is ${words} words; keep it under 300`);
  const fc = factCheck(db, body, headingText(approvedHeadings(db, oppId)));
  const dir = join(workspaceDir(slug), 'files', 'letters');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `letter-${slugKey(String(opp.org_name ?? 'company'), String(opp.title)).replace(/\|/g, '-').slice(0, 60)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const contact = master.contact.parts.join('  |  ');
  const paras = body.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${paper}; margin: 0.9in; } body { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #1a1a1a; }
h1 { font-size: 18pt; margin: 0; } .c { font-size: 10pt; margin: 2pt 0 18pt; border-bottom: 0.75pt solid #1a1a1a; padding-bottom: 6pt; } p { margin: 0 0 10pt; }
</style></head><body><h1>${esc(master.name)}</h1><div class="c">${esc(contact)}</div>
<p>${esc(date)}</p><p>${esc(String(opp.org_name ?? ''))}<br>Re: ${esc(String(opp.title))}</p>${paras}<p>${esc(master.name)}</p></body></html>`;
  writeFileSync(`${base}.html`, html);
  htmlToPdf(`${base}.html`, `${base}.pdf`);
  writeDocx({ name: master.name, contact: master.contact, format: { pages: 1, paper, font_pt: 11, margin_in: 0.9 }, summary: null, sections: [] }, `${base}.docx`, 'letter', { date, company: opp.org_name, role: opp.title, body });
  return { html: `${base}.html`, pdf: `${base}.pdf`, docx: `${base}.docx`, words, problems, factcheck: fc, pages: pdfPages(`${base}.pdf`) };
}

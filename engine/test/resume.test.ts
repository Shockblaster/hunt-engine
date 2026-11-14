import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIds, diffMasters, rewriteProblems, vocabulary } from '../resume.ts';
import { buildModel, formatHint } from '../render.ts';

const raw = (bullets: string[], extra: string[] = []) => ({
  name: 'Test Person', contact: { line: '', parts: ['Mumbai', 'a@b.com'], links: [] }, layout: { page_width_in: 8.27, page_height_in: 11.69 },
  summary: ['Second-year B.Com student building AI products.'],
  sections: [
    { key: 'education', title: 'Education', entries: [{ title: 'Example University', role: '', dates: '2025 – 2029', subtitle: 'B.Com (Honours) | CGPA: 8.1/10', bullets: [] }], items: [] },
    { key: 'experience', title: 'Experience', entries: [{ title: 'Analyst', role: '', dates: 'May 2026 – Present', subtitle: 'Northwind Capital | Pune', bullets }], items: [] },
    { key: 'certifications', title: 'Certifications', entries: [], items: extra.map((t) => ({ label: '', text: t })) },
  ],
});

const B1 = 'Built Northwind Desk, an analytics dashboard with 12+ reports and a daily price sync';
const B2 = 'Diagnosed a ~39% WhatsApp delivery failure across 182 CRM leads';
const B3 = 'Built the ₹99 webinar funnel with Razorpay and CRM sync';

test('ids are stable for the same text', () => {
  const a = withIds(raw([B1, B2]), 'v3.docx');
  const b = withIds(raw([B1, B2]), 'v3.docx');
  assert.deepEqual(a.sections[1].entries[0].bullets.map((x) => x.id), b.sections[1].entries[0].bullets.map((x) => x.id));
  assert.equal(a.sections[1].entries[0].bullets[0].id.startsWith('b-'), true);
});

test('re-import diff: added, removed and edited lines', () => {
  const before = withIds(raw([B1, B2, B3]), 'v3.docx');
  const edited = 'Diagnosed a ~39% WhatsApp delivery failure across 182 CRM leads in the pipeline';
  const after = withIds(raw([B1, edited, 'Launched the Northwind app for iOS and Android']), 'v4.docx');
  const d = diffMasters(before, after);
  assert.equal(d.changed.length, 1);
  assert.match(d.changed[0].to.text, /in the pipeline/);
  assert.equal(d.added.length, 1);
  assert.match(d.added[0].text, /Northwind app/);
  assert.equal(d.removed.length, 1);
  assert.match(d.removed[0].text, /webinar/);
});

test('rewrites may reword but never add numbers or names', () => {
  const m = withIds(raw([B1, B2]), 'v3.docx');
  const v = vocabulary(m);
  assert.deepEqual(rewriteProblems(B2, 'Traced a ~39% WhatsApp delivery failure across 182 CRM leads to its root cause', v), []);
  assert.match(rewriteProblems(B2, 'Diagnosed a 45% WhatsApp delivery failure across 182 CRM leads', v).join(), /adds the number 45/);
  assert.match(rewriteProblems(B2, 'Diagnosed a ~39% delivery failure across 182 Salesforce leads', v).join(), /Salesforce/);
  assert.match(rewriteProblems(B2, 'Diagnosed a ~39% failure — 182 leads', v).join(), /em dash/);
});

test('plan checks: unknown ids, refused rewrites, education required', () => {
  const m = withIds(raw([B1, B2], ['CFA Level I Candidate', 'McKinsey Forward']), 'v3.docx');
  const exp = m.sections[1].entries[0];
  const edu = m.sections[0].entries[0];
  const ok = buildModel(m, { format: { pages: 1 }, entries: [{ id: edu.id, bullets: [] }, { id: exp.id, bullets: [exp.bullets[1].id], rewrite: { [exp.bullets[1].id]: 'Diagnosed a 60% failure' } }] });
  assert.match(ok.problems.join(), /adds the number 60/);
  assert.equal(ok.model.sections[1].entries[0].bullets[0].text, B2, 'refused rewrite keeps the original line');
  assert.equal(ok.model.format.margin_in, 0.5);
  assert.ok(ok.model.format.font_pt >= 10);
  const noEdu = buildModel(m, { format: { pages: 2 }, entries: [{ id: exp.id, bullets: [exp.bullets[0].id] }] });
  assert.match(noEdu.problems.join(), /education/);
  const bad = buildModel(m, { format: { pages: 1 }, entries: [{ id: 'e-nope', bullets: [] }] });
  assert.match(bad.problems.join(), /unknown entry/);
});

test('format hint: ATS, region, paper, upload type and page lean', () => {
  const ib = formatHint({ url: 'https://boards.greenhouse.io/x/jobs/1', title: 'Investment Banking Summer Analyst', location: 'Mumbai, India', description: '' });
  assert.deepEqual([ib.ats, ib.region, ib.paper, ib.upload, ib.pages.suggest], ['greenhouse', 'IN', 'A4', 'pdf', 1]);
  const wd = formatHint({ url: 'https://acme.wd5.myworkdayjobs.com/en-US/careers/job/1', title: 'Software Engineer', location: 'New York, NY', description: 'Build AI products' });
  assert.deepEqual([wd.ats, wd.region, wd.paper, wd.upload], ['workday', 'US', 'Letter', 'docx']);
  assert.equal(wd.pages.suggest, null, 'tech roles are left to the tailor');
  const word = formatHint({ url: 'https://acme.com/careers', title: 'Analyst', location: 'Dubai', description: 'Please send your CV as a Word document' });
  assert.equal(word.upload, 'docx');
  assert.equal(word.photo, 'optional');
});

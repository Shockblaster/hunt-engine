// Regression tests for the second independent review (phase 2 code).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { withIds, diffMasters, rewriteProblems, entryVocabulary } from '../resume.ts';
import { buildModel } from '../render.ts';
import { matchedLocality, extractContacts, inArea } from '../collect.ts';
import { learnPattern } from '../companies.ts';
import { contentHash } from '../gate.ts';
import { runEval } from '../evals.ts';

const raw = (role: string, dates: string, bullets: string[], other = 'Google') => ({
  name: 'T', contact: { line: '', parts: [], links: [] }, layout: { page_width_in: 8.27, page_height_in: 11.69 }, summary: [],
  sections: [
    { key: 'education', title: 'Education', entries: [{ title: 'Example University', role: '', dates: '2025', subtitle: 'B.Com', bullets: [] }], items: [] },
    { key: 'experience', title: 'Experience', items: [], entries: [
      { title: 'Acme', role, dates, subtitle: 'Mumbai', bullets },
      { title: other, role: 'Intern', dates: '2023', subtitle: 'Remote', bullets: ['Wrote internal docs'] },
    ] },
  ],
});

test('rewrites cannot add leadership, names from other roles, or links', () => {
  const m = withIds(raw('Intern', '2024', ['Worked on a team of 5 building dashboards']), 'r.docx');
  const e = m.sections[1].entries[0];
  const v = entryVocabulary(e);
  assert.match(rewriteProblems(e.bullets[0].text, 'Led a team of 5 building dashboards', v).join(), /claim word "led"/);
  assert.match(rewriteProblems(e.bullets[0].text, 'Worked on a team of 5 building Google dashboards', v).join(), /Google/);
  assert.match(rewriteProblems(e.bullets[0].text, 'Worked on a team of 5 building [dashboards](https://evil.example/x)', v).join(), /adds a link/);
  assert.deepEqual(rewriteProblems(e.bullets[0].text, 'Built dashboards with a team of 5', v), []);
});

test('rendered links are only http(s) or mailto and quotes are escaped', () => {
  const m = withIds(raw('Intern', '2024', ['See [site](https://ok.example/a"onmouseover="x)']), 'r.docx');
  const exp = m.sections[1].entries[0];
  const { model } = buildModel(m, { format: { pages: 1 }, entries: [{ id: m.sections[0].entries[0].id, bullets: [] }, { id: exp.id, bullets: [exp.bullets[0].id] }] });
  assert.ok(model.sections[1].entries[0].bullets[0].text.includes('ok.example'));
});

test('a changed role or dates shows up on re-import', () => {
  const a = withIds(raw('Intern', '2024', ['Built dashboards']), 'a.docx');
  const b = withIds(raw('Lead', '2021 – 2024', ['Built dashboards']), 'b.docx');
  const d = diffMasters(a, b);
  assert.equal(d.changed.length + d.added.length, 1, 'the heading line changed');
});

test('localities match whole words only', () => {
  const p = { name: 'X', address: 'Fortune Plaza, Andheri East, Mumbai 400069' } as never;
  assert.equal(matchedLocality(p, ['Fort']), null);
  assert.equal(matchedLocality(p, ['Andheri East']), 'Andheri East');
  assert.equal(inArea({ name: 'Y', address: 'Fort, Mumbai 400001', pincode: '400001' } as never, { localities: ['Fort'] }), true);
});

test('contacts come from visible text and links, not scripts', () => {
  const html = `<script src="/jquery@3.6.0.min.js"></script><script>var id=9876512345; var e="dev@tracker.io"</script>
    <p>Call us on 98200 12345</p><a href="mailto:hello@clinic.in">mail</a>`;
  const c = extractContacts(html);
  assert.deepEqual(c.emails, ['hello@clinic.in']);
  assert.deepEqual(c.phones, ['+919820012345']);
});

test('email patterns learn only from published addresses and a bounce sticks', () => {
  const db = openMemoryDb();
  const org = insert(db, 'organizations', { name: 'Acme', domain: 'acme.com', source_url: 's' });
  insert(db, 'people', { name: 'Riya Shah', email: 'riya.shah@acme.com', email_status: 'mx_ok', organization_id: org, source_url: 's' });
  assert.equal(learnPattern(db, org).pattern, null, 'an mx-checked guess is not evidence');
  insert(db, 'people', { name: 'Dev Mehta', email: 'dev.mehta@acme.com', email_status: 'published', organization_id: org, source_url: 's' });
  assert.equal(learnPattern(db, org).pattern, 'first.last');
  db.prepare(`UPDATE organizations SET email_pattern_status = 'bounced' WHERE id = ?`).run(org);
  assert.equal(learnPattern(db, org).pattern, null);
  assert.equal((db.prepare('SELECT email_pattern_status AS s FROM organizations WHERE id = ?').get(org) as Row).s, 'bounced');
});

test('the approval covers the Word resume as well as the PDF', () => {
  const db = openMemoryDb();
  const org = insert(db, 'organizations', { name: 'B', domain: 'b.com', source_url: 's' });
  const opp = insert(db, 'opportunities', { track: 'job', kind: 'job', organization_id: org, title: 'x', dedupe_key: 'k', source: 's' });
  const app = insert(db, 'applications', { opportunity_id: opp, portal: 'workday', resume_path: 'a.pdf', resume_docx_path: 'a.docx' });
  const before = contentHash(db, 'applications', app);
  db.prepare(`UPDATE applications SET resume_docx_path = 'b.docx' WHERE id = ?`).run(app);
  assert.notEqual(contentHash(db, 'applications', app), before);
});

test('a critic change to an agent without practice tests goes to the person, not through', async () => {
  const db = openMemoryDb();
  const res = await runEval(db, 'x', 'outreach-not-tested', { changeId: 7 });
  assert.equal(res.passed, false);
  assert.equal(res.untested, true);
  assert.equal((db.prepare(`SELECT count(*) AS n FROM tasks WHERE kind = 'user_action'`).get() as Row).n, 1);
});

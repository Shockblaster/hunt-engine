import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, insert } from '../db.ts';
import { detectBoards, patternOf, learnPattern, applyPattern, filterYc } from '../companies.ts';
import { pickVariant, checkExperiment, compare } from '../experiments.ts';

test('finds job boards behind careers pages', () => {
  const html = `<a href="https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited/jobs/123">x</a>
    <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
    <a href="https://jobs.lever.co/cred/abc">y</a> <iframe src="https://jobs.ashbyhq.com/Mercor"></iframe>`;
  const b = detectBoards(html).map((x) => `${x.provider}:${x.board}`).sort();
  assert.ok(b.includes('greenhouse:razorpaysoftwareprivatelimited'));
  assert.ok(b.includes('lever:cred'));
  assert.ok(b.includes('ashby:Mercor'));
  assert.ok(!b.some((x) => x.endsWith(':embed')));
});

test('email patterns: recognised, learned by vote, applied', () => {
  assert.equal(patternOf('Riya Shah', 'riya.shah@acme.com'), 'first.last');
  assert.equal(patternOf('Riya Shah', 'rshah@acme.com'), 'flast');
  assert.equal(patternOf('Riya', 'riya@acme.com'), 'first');
  assert.equal(patternOf('Riya Shah', 'hello@acme.com'), null);
  const db = openMemoryDb();
  const org = insert(db, 'organizations', { name: 'Acme', domain: 'acme.com', source_url: 's' });
  for (const [n, e] of [['Riya Shah', 'riya.shah@acme.com'], ['Dev Mehta', 'dev.mehta@acme.com'], ['Asha Rao', 'arao@acme.com'], ['Info', 'info@acme.com']]) {
    insert(db, 'people', { name: n, email: e, email_status: 'published', organization_id: org, source_url: 's' });
  }
  const res = learnPattern(db, org);
  assert.equal(res.pattern, 'first.last');
  assert.equal(applyPattern('first.last', 'Kabir Singh', 'acme.com'), 'kabir.singh@acme.com');
  assert.equal(applyPattern('first.last', 'Kabir', 'acme.com'), null, 'needs a last name');
});

test('YC filter by region, keywords and team size', () => {
  const list = [
    { name: 'A', slug: 'a', website: '', one_liner: 'fintech for SMEs', team_size: 20, regions: ['India'], industries: ['Fintech'], tags: [], batch: 'W24', stage: 'Early', url: '', isHiring: true, all_locations: 'Bengaluru' },
    { name: 'B', slug: 'b', website: '', one_liner: 'robots', team_size: 900, regions: ['United States'], industries: ['Hardware'], tags: [], batch: 'S20', stage: 'Growth', url: '', isHiring: true, all_locations: 'SF' },
  ];
  assert.deepEqual(filterYc(list, { region: 'india', match: 'fintech' }).map((c) => c.name), ['A']);
  assert.deepEqual(filterYc(list, { maxTeam: 100 }).map((c) => c.name), ['A']);
});

test('variants are handed out in turn and results need enough data', () => {
  const db = openMemoryDb();
  const exp = insert(db, 'experiments', { track: 'job', dimension: 'angle', variants: ['a', 'b'], min_n: 3, started_at: '2026-01-01 00:00:00' });
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const v = pickVariant(db, 'job', 'angle').variant!;
    seen.push(v);
    insert(db, 'messages', { track: 'job', channel: 'email', direction: 'out', body: 'x', status: 'queued', sequence_step: 0, variant: { angle: v } });
  }
  assert.deepEqual(seen.sort(), ['a', 'a', 'b', 'b']);
  assert.equal(checkExperiment(db, exp).verdict, 'not enough data yet');
  assert.equal(pickVariant(db, 'job', 'subject').variant, null);
});

test('two-proportion test separates a real gap from noise', () => {
  assert.ok(compare({ n: 30, k: 12 }, { n: 30, k: 3 }).p < 0.05);
  assert.ok(compare({ n: 30, k: 5 }, { n: 30, k: 4 }).p > 0.3);
});

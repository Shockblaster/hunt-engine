import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openMemoryDb, upsert, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { sameCompany } from '../normalize.ts';
import { classifyTier } from '../tier.ts';
import { gate, neverList, neverListHit, isDryRun } from '../gate.ts';
import { claim } from '../claim.ts';
import { REPO_ROOT, parseTracks } from '../paths.ts';

const NOON = new Date('2026-11-02T06:30:00Z'); // 12:00 IST, inside the send window
const cli = join(REPO_ROOT, 'engine', 'cli.ts');
const cleanEnv = (home: string) => { const e = { ...process.env, HE_HOME: home }; delete e.HE_HEADLESS; delete e.HE_WORKSPACE; delete e.HE_AGENT; delete e.HE_RUN_ID; return e; };
const he = (home: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: cleanEnv(home) });
  return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout) as Row; } catch { return null; } })() };
};

test('company names match across spacing and suffixes, and short names do not over-match', () => {
  assert.equal(sameCompany('JPMorgan Chase', 'JPMorganChase'), true);
  assert.equal(sameCompany('JPMorgan', 'JPMorgan Chase & Co.'), true);
  assert.equal(sameCompany('Goldman Sachs', 'Goldman Sachs Services Pvt Ltd'), true);
  assert.equal(sameCompany('Oldcorp', 'Oldcorp.com & Oldcorp Labs'), true);
  assert.equal(sameCompany('Morgan Stanley', 'JPMorgan'), false);
  assert.equal(sameCompany('Meta', 'Metabase'), false, 'names under 5 characters need an exact match');
  assert.equal(sameCompany('', 'Acme'), false);
});

test('a dream company is recognised however the scout spelled it', () => {
  const t = classifyTier({ name: 'JPMorganChase', employees: null }, ['JPMorgan Chase', 'Goldman Sachs']);
  assert.equal(t.tier, 'big');
  assert.ok(t.reasons.includes('on the dream list'));
  assert.equal(classifyTier({ name: 'Acme Robotics', employees: 12 }, ['JPMorgan Chase']).tier, 'small');
});

function world(profile: Row) {
  const db = openMemoryDb();
  db.prepare(`INSERT INTO profiles (track, version, data) VALUES ('job', 1, ?)`).run(JSON.stringify(profile));
  const mk = (name: string, domain: string) => {
    const org = upsert(db, 'organizations', { name, domain, employees: 20, tier: 'small', source_url: 'https://x.test' }).id;
    const opp = insert(db, 'opportunities', { track: 'job', organization_id: org, kind: 'job', source: 'test', title: 'Analyst', dedupe_key: `k-${name}`, fit_score: 4.2 });
    const person = upsert(db, 'people', { name: `Riya at ${name}`, email: `riya@${domain}`, organization_id: org, source_url: 'https://x.test' }).id;
    const msg = insert(db, 'messages', { track: 'job', channel: 'email', direction: 'out', person_id: person, organization_id: org, opportunity_id: opp, to_address: `riya@${domain}`, subject: 'hello', body: 'hi', status: 'queued', sequence_step: 0 });
    const app = insert(db, 'applications', { opportunity_id: opp, portal: 'company form', status: 'draft' });
    return { org, opp, person, msg, app };
  };
  return { db, mk };
}

test('the never list is read as a list or as { companies } and blocks applications and messages at the gate', () => {
  const { db, mk } = world({ never_list: { companies: ['Oldco', 'Formerco'], his_words: 'my employer must not know' } });
  assert.deepEqual(neverList(db).sort(), ['Formerco', 'Oldco']);
  const bad = mk('Oldco Wealth Pvt Ltd', 'oldco.com');
  const ok = mk('Acme Capital', 'acme.com');
  const blockedMsg = gate(db, { ref_table: 'messages', ref_id: bad.msg, account: 'me@gmail.com', now: NOON });
  assert.equal(blockedMsg.allowed, false);
  assert.match(blockedMsg.blocks.join(' '), /never list \(Oldco\)/);
  const blockedApp = gate(db, { ref_table: 'applications', ref_id: bad.app, now: NOON });
  assert.match(blockedApp.blocks.join(' '), /never list/);
  assert.equal(gate(db, { ref_table: 'messages', ref_id: ok.msg, account: 'me@gmail.com', now: NOON }).allowed, true);
  // A person at a never-list company written to at their work address is caught by the address alone.
  assert.equal(neverListHit(['Formerco'], undefined, 'someone@formerco.com'), 'Formerco');
  assert.equal(neverListHit(['Formerco'], undefined, 'someone@gmail.com'), null);
  const plain = world({ never_list: ['Oldco'] });
  assert.deepEqual(neverList(plain.db), ['Oldco']);
});

test('an approval does not get a never-list company through', () => {
  const { db, mk } = world({ never_list: ['Oldco'] });
  const bad = mk('Oldco', 'oldco.com');
  db.prepare(`INSERT INTO approvals (ref_table, ref_id, summary, reason, status, content_hash) VALUES ('applications', ?, 's', 'r', 'approved', 'x')`).run(bad.app);
  const g = gate(db, { ref_table: 'applications', ref_id: bad.app, now: NOON });
  assert.equal(g.allowed, false);
  assert.equal(g.needs_approval, false);
});

test('in a dry-run workspace a claim never submits, and the gate says why', () => {
  const { db, mk } = world({});
  const ok = mk('Acme Capital', 'acme.com');
  assert.equal(isDryRun(db), false);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('dry_run', '1')`).run();
  assert.equal(isDryRun(db), true);
  const g = gate(db, { ref_table: 'applications', ref_id: ok.app });
  assert.equal(g.dry_run, true);
  const c = claim(db, 'applications', ok.app, 'applier');
  assert.equal(c.claimed, false);
  assert.equal(c.dry_run, true);
  assert.match(c.reasons.join(' '), /dry run/);
  assert.equal((db.prepare('SELECT status FROM applications WHERE id = ?').get(ok.app) as Row).status, 'draft');
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('dry_run', '0')`).run();
  const live = claim(db, 'applications', ok.app, 'applier');
  if (!live.claimed) assert.doesNotMatch(live.reasons.join(' '), /dry run/); // caps or the clock may still say no
});

test('tracks parse strictly', () => {
  assert.deepEqual(parseTracks('job, lead'), ['job', 'lead']);
  assert.throws(() => parseTracks('jobs'));
  assert.throws(() => parseTracks(''));
});

test('--help prints usage and runs nothing, for every command', () => {
  const home = mkdtempSync(join(tmpdir(), 'he-help-'));
  for (const args of [['dashboard', '--help'], ['export', 'leads', '--help'], ['mail', 'flush', '-h'], ['ws', 'create', 'x', '--help'], ['cycle', 'job-hunt', 'morning', '--help'], ['help'], ['help', 'mail'], []]) {
    const r = he(home, ...args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.err}`);
    assert.ok(r.json && (r.json.usage || r.json.commands), `${args.join(' ')} should print usage`);
  }
  assert.deepEqual(readdirSync(home), [], 'help must not create a workspace, a config or a key');
});

test('a new workspace starts in dry run, carries its tracks, and refuses another track\'s cycle', () => {
  const home = mkdtempSync(join(tmpdir(), 'he-ws-'));
  const made = he(home, 'ws', 'create', 'leads', '--name', 'Lead client', '--track', 'lead');
  assert.equal(made.code, 0, made.err);
  assert.equal(made.json!.dry_run, true);
  assert.deepEqual(made.json!.tracks, ['lead']);
  const st = he(home, 'status', '--ws', 'leads').json!;
  assert.equal(st.dry_run, true);
  assert.deepEqual(st.tracks, ['lead']);
  assert.equal(st.workspace_from, 'flag');
  assert.equal(he(home, 'status').json!.workspace_from, 'current');
  const sched = JSON.parse(he(home, 'schedule', '--ws', 'leads').out) as Row[];
  assert.ok(sched.length > 0 && sched.every((s) => String(s.name).includes('lead-research')), 'only the lead-research schedule is offered');
  const wrong = he(home, 'cycle', 'job-hunt', 'morning', '--ws', 'leads');
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /is set up for lead/);
  assert.equal(he(home, 'ws', 'dry-run', 'off', '--ws', 'leads').json!.dry_run, false);
  assert.equal(he(home, 'ws', 'dry-run', 'on', '--ws', 'leads').json!.dry_run, true);
  const headless = spawnSync(process.execPath, [cli, 'ws', 'dry-run', 'off', '--ws', 'leads'], { encoding: 'utf8', env: { ...process.env, HE_HOME: home, HE_HEADLESS: '1' } });
  assert.equal(headless.status, 1, 'a scheduled run cannot take a workspace live');
  assert.ok(existsSync(join(home, 'workspaces', 'leads')));
});

test('status lists runs that were cut off', () => {
  const home = mkdtempSync(join(tmpdir(), 'he-stale-'));
  he(home, 'ws', 'create', 'w', '--name', 'W');
  const run = he(home, 'run', 'start', '--skill', 'job-hunt', '--cycle', 'manual', '--ws', 'w').json!;
  assert.deepEqual(he(home, 'status', '--ws', 'w').json!.stale_runs, [], 'a fresh run is not stale');
  he(home, 'sql', `select 1`, '--ws', 'w');
  // Age the run through the engine's own database file.
  const db = new DatabaseSync(join(home, 'workspaces', 'w', 'db.sqlite'));
  db.prepare(`UPDATE runs SET started_at = datetime('now', '-7 hours') WHERE id = ?`).run(Number(run.run_id));
  db.close();
  const stale = he(home, 'status', '--ws', 'w').json!.stale_runs as Row[];
  assert.equal(stale.length, 1);
  assert.equal(stale[0].id, run.run_id);
});

test('a resume heading change builds only when the person approved that exact heading', async () => {
  const { buildModel } = await import('../render.ts');
  const master = { name: 'A', contact: {}, summary: [{ id: 's', text: 'Student' }], sections: [
    { key: 'education', title: 'Education', entries: [{ id: 'e1', title: 'Example University', role: '', dates: 'Jul 2025 – Jun 2029', subtitle: 'B.Com (Honours)', bullets: [] }], items: [] },
  ] } as never;
  const plan = (dates: string, subtitle: string) => ({ format: { pages: 1 as const }, entries: [{ id: 'e1', bullets: [], dates, subtitle }] });
  const none = buildModel(master, plan('Jul 2025 – Jun 2028 (expected)', 'B.Com'));
  assert.match(none.problems.join(' '), /heading change/);
  assert.equal(none.model.sections[0].entries[0].dates, 'Jul 2025 – Jun 2029', 'an unapproved heading is not printed');
  const ok = buildModel(master, plan('Jul 2025 – Jun 2028 (expected)', 'B.Com'), [{ entry: 'e1', dates: 'Jul 2025 –  Jun 2028 (expected)', subtitle: 'B.Com' }]);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.model.sections[0].entries[0].dates, 'Jul 2025 – Jun 2028 (expected)');
  assert.equal(ok.model.sections[0].entries[0].subtitle, 'B.Com');
  const other = buildModel(master, plan('Jul 2025 – Jun 2027', 'B.Com'), [{ entry: 'e1', dates: 'Jul 2025 – Jun 2028 (expected)', subtitle: 'B.Com' }]);
  assert.match(other.problems.join(' '), /heading change/, 'only the exact approved heading passes');
});
test('an approved heading applies only to the opportunities it names', async () => {
  const { headingsFor } = await import('../render.ts');
  const a = [{ entry: 'e1', dates: 'x', for_opportunities: [26, 27] }, { entry: 'e2', dates: 'y' }];
  assert.deepEqual(headingsFor(a, 26).map((h) => h.entry), ['e1', 'e2']);
  assert.deepEqual(headingsFor(a, 29).map((h) => h.entry), ['e2'], 'opportunity 29 does not get the 26/27 heading');
});
test('an approved heading backs its own numbers in the fact check, for its opportunities only', async () => {
  const { approvedHeadings } = await import('../render.ts');
  const { factCheck } = await import('../docs.ts');
  const db = openMemoryDb();
  db.prepare(`INSERT INTO profiles (track, version, data) VALUES ('job', 1, ?)`).run(JSON.stringify({ approved_headings: [{ entry: 'e1', dates: 'Jul 2025 – Jun 2028 (expected)', for_opportunities: [26] }] }));
  const text = (id: number) => approvedHeadings(db, id).map((h) => `${h.dates} ${h.subtitle ?? ''}`).join('\n');
  assert.equal(factCheck(db, 'Graduating June 2028', text(26)).ok, true);
  assert.equal(factCheck(db, 'Graduating June 2028', text(29)).ok, false, 'another opportunity does not get the approval');
});
test('options glued into one argument are refused instead of falling back to another workspace', () => {
  const home = mkdtempSync(join(tmpdir(), 'he-glued-'));
  he(home, 'ws', 'create', 'w', '--name', 'W');
  const r = he(home, 'status', '--ws w --agent x');
  assert.equal(r.code, 1);
  assert.match(r.err, /several options/);
});

test('a workspace file path saved on another machine is found under this machine\'s workspace folder', async () => {
  const { resolveWorkspaceFile } = await import('../gate.ts');
  const { workspaceDir } = await import('../paths.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = join(workspaceDir('portable-test'), 'files', 'resumes');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'r.pdf'), 'x');
  assert.equal(resolveWorkspaceFile('C:\\Users\\someone\\.hunt-engine\\workspaces\\portable-test\\files\\resumes\\r.pdf'), join(dir, 'r.pdf'));
  assert.equal(resolveWorkspaceFile('C:\\Users\\someone\\.hunt-engine\\workspaces\\portable-test\\files\\resumes\\missing.pdf'), null);
  assert.equal(resolveWorkspaceFile('/nowhere/else.pdf'), null);
  const { rmSync } = await import('node:fs');
  rmSync(workspaceDir('portable-test'), { recursive: true, force: true });
});

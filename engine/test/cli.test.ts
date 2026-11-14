// Runs the real `he` CLI against a throwaway HE_HOME to check the protections agents cannot get around.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.ts';

const home = mkdtempSync(join(tmpdir(), 'he-cli-'));
const CLI = join(REPO_ROOT, 'engine', 'cli.ts');

function he(args: string[], env: Record<string, string> = {}): { ok: boolean; out: any; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--ws', 't'], { encoding: 'utf8', env: { ...process.env, HE_HOME: home, HE_HEADLESS: '', HE_DECIDER_KEY: '', ...env } });
  let out: unknown = null;
  try { out = JSON.parse(r.stdout); } catch { /* not json */ }
  return { ok: r.status === 0, out, err: r.stderr };
}

spawnSync(process.execPath, [CLI, 'ws', 'create', 't', '--name', 'Test'], { env: { ...process.env, HE_HOME: home } });
he(['upsert', 'organizations', '--json', JSON.stringify({ name: 'Bigco', domain: 'bigco.com', is_listed: true, source_url: 'https://bigco.com' })]);
he(['upsert', 'people', '--json', JSON.stringify({ name: 'Ann', email: 'ann@bigco.com', organization_id: 1, source_url: 'https://bigco.com/team' })]);
he(['upsert', 'opportunities', '--json', JSON.stringify({ track: 'job', kind: 'job', organization_id: 1, title: 'Ops', url: 'https://bigco.com/jobs/1', source: 'test' })]);
he(['upsert', 'messages', '--json', JSON.stringify({ track: 'job', channel: 'email', direction: 'out', person_id: 1, organization_id: 1, opportunity_id: 1, to_address: 'ann@bigco.com', subject: 'ops role', body: 'Hello Ann', status: 'queued' })]);

test('agents cannot mark things sent, set fit scores or tiers, or undo an opt-out', () => {
  assert.match(he(['update', 'messages', '1', '--json', '{"status":"sent"}']).err, /agents may set outbound/);
  assert.match(he(['update', 'messages', '1', '--json', '{"sent_at":"2026-11-01 05:00:00"}']).err, /set by the sender/);
  assert.match(he(['update', 'opportunities', '1', '--json', '{"fit_score":5}']).err, /he score --opp/);
  he(['update', 'organizations', '1', '--json', '{"tier":"small"}']);
  assert.equal(he(['get', 'organizations', '1']).out.tier, 'big', 'tier stays with the classifier');
  he(['update', 'people', '1', '--json', '{"opt_out":1}']);
  assert.match(he(['update', 'people', '1', '--json', '{"opt_out":0}']).err, /cannot be undone/);
});

test('fit scores go through he score --opp', () => {
  const r = he(['score', '--opp', '1', '--json', JSON.stringify({ dimensions: { role_fit: { score: 5, reason: 'r' }, eligibility: { score: 4, reason: 'e' }, goal_alignment: { score: 4, reason: 'g' }, recency: { score: 5, reason: 'n' } } })]);
  assert.ok(r.ok, r.err);
  assert.ok(he(['get', 'opportunities', '1']).out.fit_score >= 4);
});

test('only the person decides approvals: never headless, dashboard needs its key', () => {
  he(['upsert', 'messages', '--json', JSON.stringify({ track: 'job', channel: 'email', direction: 'out', person_id: 1, organization_id: 1, opportunity_id: 1, to_address: 'bob@bigco.com', subject: 'x', body: 'y', status: 'drafted' })]);
  const req = he(['approval', 'request', '--ref', 'messages:2', '--summary', 's', '--reason', 'big company']);
  assert.ok(req.ok, req.err);
  const id = String(req.out.id);
  assert.match(he(['approval', 'decide', id, 'approve', '--via', 'chat'], { HE_HEADLESS: '1' }).err, /not by a scheduled run/);
  assert.match(he(['approval', 'decide', id, 'approve', '--via', 'dashboard']).err, /must come from the dashboard/);
  const key = readFileSync(join(home, '.decider-key'), 'utf8').trim();
  assert.ok(he(['approval', 'decide', id, 'approve', '--via', 'dashboard'], { HE_DECIDER_KEY: key }).ok);
  assert.equal(he(['get', 'messages', '2']).out.status, 'queued');
});

test('an approval cannot be granted for content that changed after the request', () => {
  he(['upsert', 'messages', '--json', JSON.stringify({ track: 'job', channel: 'email', direction: 'out', person_id: 1, organization_id: 1, opportunity_id: 1, to_address: 'cat@bigco.com', subject: 'x', body: 'first', status: 'drafted' })]);
  const req = he(['approval', 'request', '--ref', 'messages:3', '--summary', 's', '--reason', 'r']);
  assert.match(he(['update', 'messages', '3', '--json', '{"status":"queued"}']).err, /waiting for the person/);
  assert.ok(he(['update', 'messages', '3', '--json', '{"body":"second"}']).ok);
  assert.match(he(['approval', 'decide', String(req.out.id), 'approve', '--via', 'chat']).err, /changed after approval was requested/);
});

test('exports stay inside the workspace and secrets cannot be attached', () => {
  const r = he(['export', 'organizations', '--out', join(home, '..', 'escape.csv')]);
  assert.ok(r.ok, r.err);
  assert.ok(String(r.out.file).includes(join('workspaces', 't', 'files', 'exports')));
  assert.equal(existsSync(join(home, '..', 'escape.csv')), false);
  he(['upsert', 'messages', '--json', JSON.stringify({ track: 'freelance', channel: 'email', direction: 'out', to_address: 'z@z.com', subject: 'x', body: 'y. If you would rather not hear from me, reply "no thanks" and I will not write again.', status: 'queued', attachments: [join(home, 'workspaces', 't', '.env')] })]);
  const sent = he(['mail', 'send', '4', '--dry-run']);
  assert.match(JSON.stringify(sent.out), /files folder|hidden/);
});

test('he sql cannot write, even through WITH', () => {
  assert.match(he(['sql', 'WITH x AS (SELECT 1) DELETE FROM people']).err, /readonly/);
  assert.equal(he(['get', 'people', '1']).out.name, 'Ann');
});

test('an inbound unsubscribe recorded by upsert suppresses the person', () => {
  he(['upsert', 'messages', '--json', JSON.stringify({ track: 'job', channel: 'linkedin_dm', direction: 'in', person_id: 1, to_address: 'ann@bigco.com', body: 'please stop', status: 'received', reply_class: 'unsubscribe', external_id: 'li-1' })]);
  assert.ok(he(['suppress', 'check', 'ann@bigco.com']).out.reason);
});

test('the dashboard can still write its workspace settings untouched by agents (settings only keep known skills)', () => {
  writeFileSync(join(home, 'workspaces', 't', 'settings.json'), JSON.stringify({ skills: ['lead-research', 'evil'], claude_bin: 'calc.exe' }));
  const r = he(['schedule', 'show']);
  assert.ok(r.ok, r.err);
  assert.ok(r.out.every((x: { command: string }) => !x.command.includes('calc') && x.command.includes('lead-research')));
});

test('experiments can be created and stopped by agents, never given results', () => {
  assert.ok(he(['upsert', 'experiments', '--json', JSON.stringify({ track: 'job', dimension: 'angle', variants: ['a', 'b'], min_n: 25 })]).ok);
  assert.match(he(['update', 'experiments', '1', '--json', '{"min_n":2}']).err, /can only be stopped/);
  assert.match(he(['update', 'experiments', '1', '--json', '{"status":"concluded","result":{"winner":"a"}}']).err, /can only be stopped/);
  assert.ok(he(['update', 'experiments', '1', '--json', '{"status":"stopped"}']).ok);
  assert.match(he(['upsert', 'experiments', '--json', JSON.stringify({ track: 'job', dimension: 'x', variants: ['a'], status: 'concluded' })]).err, /start as running/);
});

test('chat approvals are refused while agents run unattended', () => {
  writeFileSync(join(home, 'automation.lock'), JSON.stringify({ pid: process.pid, label: 'test cycle', at: new Date().toISOString() }));
  he(['upsert', 'messages', '--json', JSON.stringify({ track: 'job', channel: 'email', direction: 'out', person_id: 1, organization_id: 1, opportunity_id: 1, to_address: 'dan@bigco.com', subject: 'x', body: 'z', status: 'drafted' })]);
  const req = he(['approval', 'request', '--ref', 'messages:5', '--summary', 's', '--reason', 'r']);
  assert.match(he(['approval', 'decide', String(req.out.id), 'approve', '--via', 'chat']).err, /running unattended/);
});

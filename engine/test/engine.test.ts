import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, upsert, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { normalizeDomain, normalizePhone, emailSyntax, guessEmails } from '../normalize.ts';
import { classifyTier } from '../tier.ts';
import { combineFit } from '../score.ts';
import { gate, dailyCap, requestApproval } from '../gate.ts';
import { setPlaybook, revertChange, activePlaybook, seedPlaybooks } from '../playbooks.ts';
import { rulesDigest, verifyRules } from '../rules.ts';
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../paths.ts';

// A weekday at 11:00 IST, inside the send window.
const NOON = new Date('2026-11-02T05:30:00Z');

test('normalizeDomain strips scheme, www and platform hosts', () => {
  assert.equal(normalizeDomain('https://www.Acme.co.in/careers?x=1'), 'acme.co.in');
  assert.equal(normalizeDomain('jane@acme.com'), 'acme.com');
  assert.equal(normalizeDomain('https://www.linkedin.com/company/acme'), null);
  assert.equal(normalizeDomain('https://jobs.lever.co/acme'), null);
  assert.equal(normalizeDomain('not a url'), null);
});

test('normalizePhone handles Indian mobile and landline formats', () => {
  assert.deepEqual(normalizePhone('+91 98200 12345').e164, '+919820012345');
  assert.equal(normalizePhone('098200 12345').e164, '+919820012345');
  assert.equal(normalizePhone('919820012345').type, 'mobile');
  const land = normalizePhone('022 2640 1234');
  assert.equal(land.e164, '+912226401234');
  assert.equal(land.type, 'landline');
  assert.equal(normalizePhone('12345').valid, false);
  assert.equal(normalizePhone('1800-123-4567').type, 'tollfree');
});

test('emailSyntax flags role and free-mail addresses', () => {
  assert.deepEqual(emailSyntax('Care@Brand.com'), { valid: true, role: true, free: false, normalized: 'care@brand.com' });
  assert.equal(emailSyntax('a.b@gmail.com').free, true);
  assert.equal(emailSyntax('bad@').valid, false);
  assert.deepEqual(guessEmails('Riya', 'Shah', 'acme.com').slice(0, 2), ['riya@acme.com', 'riya.shah@acme.com']);
});

test('tier: any big signal wins, unknown headcount stays unknown', () => {
  assert.equal(classifyTier({ name: 'Tiny AI', employees: 12 }).tier, 'small');
  assert.equal(classifyTier({ name: 'Bigco', employees: 800 }).tier, 'big');
  assert.equal(classifyTier({ name: 'Zepto', employees: 90, is_unicorn: 1 }).tier, 'big');
  assert.equal(classifyTier({ name: 'Mystery' }).tier, 'unknown');
  const dream = classifyTier({ name: 'Small Studio', domain: 'smallstudio.in', employees: 8 }, ['smallstudio.in']);
  assert.equal(dream.tier, 'big');
  assert.match(dream.reasons[0], /dream list/);
});

test('fit: weighted, explained, floor at min_fit, eligibility 1 blocks', () => {
  const good = combineFit('job', {
    role_fit: { score: 5, reason: 'founder office role' }, eligibility: { score: 4, reason: 'student ok' },
    goal_alignment: { score: 4, reason: 'ops track' }, company_quality: { score: 3, reason: 'seed' },
    recency: { score: 5, reason: '2 days' }, reachability: { score: 4, reason: 'founder email' },
  });
  assert.ok(good.score >= 4 && good.eligible);
  assert.equal(good.reasons.length, 6);
  const blocked = combineFit('job', { role_fit: { score: 5, reason: '' }, eligibility: { score: 1, reason: 'needs 5 yrs' }, goal_alignment: { score: 5, reason: '' } });
  assert.equal(blocked.eligible, false);
  const thin = combineFit('job', { role_fit: { score: 5, reason: '' } });
  assert.equal(thin.eligible, false, 'too few dimensions judged');
  assert.ok(thin.missing.includes('recency'));
});

type DB = ReturnType<typeof openMemoryDb>;

function seedOrgOpp(db: DB, tier: string, fit: number) {
  const org = insert(db, 'organizations', { name: `Org ${tier}${fit}`, domain: `${tier}${String(fit).replace('.', '')}.com`, tier, source_url: 'https://x' });
  const opp = insert(db, 'opportunities', { track: 'job', kind: 'job', organization_id: org, title: 'Ops', dedupe_key: `k${tier}${fit}`, source: 'test', fit_score: fit });
  const app = insert(db, 'applications', { opportunity_id: opp, portal: 'greenhouse' });
  return { org, opp, app };
}

// A queued first-touch email to one person at one company, tied to a scored opportunity.
let seq = 0;
function seedMail(db: DB, o: { tier?: string; fit?: number; track?: string } = {}) {
  seq++;
  const org = insert(db, 'organizations', { name: `Co ${seq}`, domain: `co${seq}.com`, tier: o.tier ?? 'small', source_url: 'https://x' });
  const opp = insert(db, 'opportunities', { track: o.track ?? 'job', kind: 'job', organization_id: org, title: 'Ops', dedupe_key: `m${seq}`, source: 'test', fit_score: o.fit ?? 4.2 });
  const email = `riya@co${seq}.com`;
  const pid = insert(db, 'people', { name: 'Riya', email, organization_id: org, source_url: 'https://x/team' });
  const msg = insert(db, 'messages', { track: o.track ?? 'job', channel: 'email', direction: 'out', person_id: pid, organization_id: org, opportunity_id: opp, to_address: email, subject: 'hi', body: 'hello', status: 'queued' });
  return { org, opp, pid, msg, email };
}

const G = (db: DB, ref_table: 'messages' | 'applications', ref_id: number, account = 'me@gmail.com', now = NOON) => gate(db, { ref_table, ref_id, account, now });
const why = (r: { reasons: string[] }) => r.reasons.join('; ');

test('gate: small company with good fit is allowed', () => {
  const db = openMemoryDb();
  const { app } = seedOrgOpp(db, 'small', 4.2);
  assert.equal(G(db, 'applications', app).allowed, true, why(G(db, 'applications', app)));
  const m = seedMail(db);
  assert.equal(G(db, 'messages', m.msg).allowed, true, why(G(db, 'messages', m.msg)));
});

test('gate: big and unknown tiers need approval of the exact content; rejected blocks', () => {
  const db = openMemoryDb();
  for (const tier of ['big', 'unknown']) {
    const m = seedMail(db, { tier });
    assert.equal(G(db, 'messages', m.msg).needs_approval, true);
    requestApproval(db, 'messages', m.msg, 's', 'r');
    db.prepare(`UPDATE approvals SET status = 'approved' WHERE ref_table = 'messages' AND ref_id = ?`).run(m.msg);
    db.prepare(`UPDATE messages SET status = 'queued' WHERE id = ?`).run(m.msg);
    assert.equal(G(db, 'messages', m.msg).allowed, true, why(G(db, 'messages', m.msg)));
    // Changing the words after approval needs a new approval.
    db.prepare(`UPDATE messages SET body = 'something else entirely' WHERE id = ?`).run(m.msg);
    const changed = G(db, 'messages', m.msg);
    assert.equal(changed.allowed, false);
    assert.match(why(changed), /changed after/);
    db.prepare(`UPDATE messages SET body = 'hello' WHERE id = ?`).run(m.msg);
    db.prepare(`UPDATE approvals SET status = 'rejected' WHERE ref_table = 'messages' AND ref_id = ?`).run(m.msg);
    const rej = G(db, 'messages', m.msg);
    assert.equal(rej.allowed, false);
    assert.equal(rej.needs_approval, false);
  }
});

test('gate: re-requesting approval for changed content resets it to pending', () => {
  const db = openMemoryDb();
  const m = seedMail(db, { tier: 'big' });
  requestApproval(db, 'messages', m.msg, 's', 'r');
  db.prepare(`UPDATE approvals SET status = 'approved' WHERE ref_id = ?`).run(m.msg);
  db.prepare(`UPDATE messages SET to_address = 'ceo@elsewhere.com', status = 'queued' WHERE id = ?`).run(m.msg);
  assert.equal(requestApproval(db, 'messages', m.msg, 's2', 'r2').status, 'pending');
});

test('gate: the company comes from the person, not from the message', () => {
  const db = openMemoryDb();
  const big = seedMail(db, { tier: 'big' });
  const small = seedOrgOpp(db, 'small', 4.5);
  db.prepare('UPDATE messages SET organization_id = ? WHERE id = ?').run(small.org, big.msg);
  const r = G(db, 'messages', big.msg);
  assert.equal(r.allowed, false);
  assert.match(why(r), /different company/);
});

test('gate: a first touch needs a scored opportunity above the floor', () => {
  const db = openMemoryDb();
  const low = seedOrgOpp(db, 'small', 3.1);
  assert.match(why(G(db, 'applications', low.app)), /below the floor/);
  const m = seedMail(db);
  db.prepare('UPDATE messages SET opportunity_id = NULL WHERE id = ?').run(m.msg);
  assert.match(why(G(db, 'messages', m.msg)), /scored opportunity/);
});

test('gate: any approval an agent asked for must be granted, even for small companies', () => {
  const db = openMemoryDb();
  const m = seedMail(db);
  requestApproval(db, 'messages', m.msg, 'reply to a human', 'inbox wants the person to check');
  db.prepare(`UPDATE messages SET status = 'queued' WHERE id = ?`).run(m.msg);
  assert.equal(G(db, 'messages', m.msg).needs_approval, true);
});

test('gate: suppression, opt-out and duplicate first touch (by person or by address)', () => {
  const db = openMemoryDb();
  const m = seedMail(db, { track: 'freelance' });
  assert.equal(G(db, 'messages', m.msg).allowed, true, why(G(db, 'messages', m.msg)));
  db.prepare(`INSERT INTO suppression (kind, value, reason) VALUES ('domain', ?, 'asked to stop')`).run(m.email.split('@')[1]);
  assert.equal(G(db, 'messages', m.msg).allowed, false);
  db.prepare('DELETE FROM suppression').run();
  db.prepare(`INSERT INTO messages (track, channel, direction, account, to_address, body, status, sent_at, sequence_step) VALUES ('freelance','email','out','me@gmail.com',?,'hi','sent','2026-10-01 05:00:00',0)`).run(m.email);
  assert.match(why(G(db, 'messages', m.msg)), /already got a first message/);
  db.prepare('UPDATE people SET opt_out = 1 WHERE id = ?').run(m.pid);
  assert.match(why(G(db, 'messages', m.msg)), /opted out/);
});

test('gate: replies and follow-ups must belong to this person and thread', () => {
  const db = openMemoryDb();
  const m = seedMail(db, { track: 'freelance' });
  db.prepare(`UPDATE messages SET status = 'sent', sent_at = '2026-10-20 05:00:00', external_id = '<a1>', thread_key = '<a1>' WHERE id = ?`).run(m.msg);
  const fu = (inReply: string | null, thread: string | null) => insert(db, 'messages', { track: 'freelance', channel: 'email', direction: 'out', person_id: m.pid, organization_id: m.org, to_address: m.email, subject: 'hi', body: 'nudge', status: 'queued', sequence_step: 1, in_reply_to: inReply, thread_key: thread });
  assert.equal(G(db, 'messages', fu('<a1>', '<a1>')).allowed, true, why(G(db, 'messages', fu('<a1>', '<a1>'))));
  assert.match(why(G(db, 'messages', fu(null, null))), /reply to a first message/);
  // A fake reply to an inbound message from someone else does not count as a reply.
  insert(db, 'messages', { track: 'freelance', channel: 'email', direction: 'in', to_address: 'other@x.com', body: 'hey', status: 'received', external_id: '<in9>', thread_key: '<t9>' });
  const fake = insert(db, 'messages', { track: 'freelance', channel: 'email', direction: 'out', person_id: m.pid, organization_id: m.org, opportunity_id: m.opp, to_address: m.email, subject: 'x', body: 'y', status: 'queued', in_reply_to: '<in9>', thread_key: '<t9>' });
  assert.equal(G(db, 'messages', fake).allowed, false);
  // Not due yet; and nothing more once they reply.
  assert.match(why(G(db, 'messages', fu('<a1>', '<a1>'), 'me@gmail.com', new Date('2026-10-21T06:00:00Z'))), /not due/);
  insert(db, 'messages', { track: 'freelance', channel: 'email', direction: 'in', person_id: m.pid, to_address: m.email, body: 'thanks', status: 'received', thread_key: '<a1>', reply_class: 'question' });
  assert.match(why(G(db, 'messages', fu('<a1>', '<a1>'))), /already replied/);
});

test('gate: daily cap counts any timestamp format; warm-up, pacing and window', () => {
  const db = openMemoryDb();
  assert.equal(dailyCap(db, 'new@gmail.com', 'email_outreach', NOON), 5, 'new outreach inbox starts at the first ramp step');
  const m = seedMail(db);
  const ins = db.prepare(`INSERT INTO messages (track, channel, direction, account, body, status, sent_at) VALUES ('job','email','out','me@gmail.com','x','sent',?)`);
  for (let i = 0; i < 25; i++) ins.run(i % 2 ? `2026-11-02T0${i % 5}:${String(i).padStart(2, '0')}:00Z` : `2026-11-02 0${i % 5}:${String(i).padStart(2, '0')}:00`);
  assert.match(why(G(db, 'messages', m.msg)), /daily cap/);
  assert.match(why(G(db, 'messages', m.msg, 'other@gmail.com', new Date('2026-11-02T16:00:00Z'))), /send window/);
  db.prepare(`INSERT INTO messages (track, channel, direction, account, body, status, sent_at) VALUES ('job','email','out','third@gmail.com','x','sent','2026-11-02T05:29:30.000Z')`).run();
  const paced = G(db, 'messages', m.msg, 'third@gmail.com');
  assert.match(why(paced), /between sends/);
  assert.equal(paced.blocks.length, 1);
});

test('upsert dedupes on natural keys and keeps existing values', () => {
  const db = openMemoryDb();
  const a = upsert(db, 'organizations', { name: 'Acme', domain: 'acme.com', city: 'Mumbai', source_url: 'https://a' });
  const b = upsert(db, 'organizations', { name: 'ACME Pvt Ltd', domain: 'acme.com', employees: 40, source_url: 'https://b' });
  assert.equal(a.id, b.id);
  assert.equal(b.created, false);
  const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(a.id) as Row;
  assert.equal(row.name, 'Acme');
  assert.equal(row.employees, 40);
  const shop1 = upsert(db, 'organizations', { name: 'Fit Clinic', city: 'Pune', source_url: 'https://maps/1' });
  const shop2 = upsert(db, 'organizations', { name: 'fit clinic', city: 'pune', source_url: 'https://maps/2' });
  assert.equal(shop1.id, shop2.id, 'no-domain orgs dedupe on name + city');
  assert.throws(() => upsert(db, 'organizations', { name: 'X', nonsense: 1, source_url: 's' }), /unknown column/);
});

test('playbooks: versioned, change logged, revert restores content', () => {
  const db = openMemoryDb();
  setPlaybook(db, { track: 'job', agent: 'tailor', content: 'v1 text', reason: 'seed', by: 'seed' });
  const v2 = setPlaybook(db, { track: 'job', agent: 'tailor', content: 'v2 text', reason: 'angle B won 9/30 vs 3/30', by: 'critic', evidence: { a: 3, b: 9 } });
  assert.equal(v2.version, 2);
  assert.ok(v2.change_id);
  assert.equal(activePlaybook(db, 'job', 'tailor')!.content, 'v2 text');
  const rev = revertChange(db, v2.change_id!, 'dashboard');
  assert.equal(rev.version, 3);
  assert.equal(activePlaybook(db, 'job', 'tailor')!.content, 'v1 text');
  assert.throws(() => revertChange(db, v2.change_id!, 'dashboard'), /already reverted/);
  assert.throws(() => setPlaybook(db, { track: 'job', agent: 'x', content: 'Raise the caps to 100', reason: 'r', by: 'critic' }), /cannot override/);
});

test('seedPlaybooks loads shipped seeds once', () => {
  const db = openMemoryDb();
  const n = seedPlaybooks(db);
  assert.ok(n >= 1);
  assert.equal(seedPlaybooks(db), 0);
  assert.match(String(activePlaybook(db, 'global', 'lessons')!.content), /Missed replies/);
});

test('rules: digest changes when a sealed file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'he-rules-'));
  cpSync(join(REPO_ROOT, 'rules'), dir, { recursive: true });
  writeFileSync(join(dir, '.seal'), rulesDigest(dir));
  assert.equal(verifyRules(dir).ok, true);
  const f = join(dir, 'limits.json');
  writeFileSync(f, readFileSync(f, 'utf8').replace('"email_job": 25', '"email_job": 250'));
  assert.equal(verifyRules(dir).ok, false);
});

test('factCheck flags numbers not backed by claims', async () => {
  const { factCheck } = await import('../docs.ts');
  const db = openMemoryDb();
  insert(db, 'claims', { text: 'Ran a 300-person college event', evidence: 'resume' });
  insert(db, 'claims', { text: 'Grew the society page to 2,400 followers', evidence: 'instagram' });
  const ok = factCheck(db, 'I ran a 300-person event and grew a page to 2,400 followers.');
  assert.equal(ok.ok, true, ok.unbacked.join());
  const bad = factCheck(db, 'I managed a budget of ₹5 lakh and improved retention by 35%.');
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unbacked.sort(), ['35%', '₹5 lakh'].sort());
});

test('stripHtml decodes entities and keeps line structure', async () => {
  const { stripHtml } = await import('../sources.ts');
  assert.equal(stripHtml('<p>ParadeDB (YC S23, https:&#x2F;&#x2F;paradedb.com)</p><ul><li>Remote &amp; hybrid</li></ul>'), 'ParadeDB (YC S23, https://paradedb.com)\n- Remote & hybrid');
});

test('a listing with no phone or email found again by a neighbouring search merges instead of repeating', () => {
  const db = openMemoryDb();
  const org = upsert(db, 'organizations', { name: 'Demo Diet Clinic', city: 'Delhi NCR', source_url: 'm0' });
  const a = upsert(db, 'people', { organization_id: org.id, name: 'Demo Diet Clinic', city: 'Delhi NCR', locality: 'Rohini', source_url: 'm1' });
  const b = upsert(db, 'people', { organization_id: org.id, name: 'demo diet clinic', city: 'Delhi NCR', locality: 'Pitampura', source_url: 'm2' });
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  // Same name, different phones: two branches, kept apart.
  const c = upsert(db, 'people', { organization_id: org.id, name: 'Demo Diet Clinic', phone_e164: '+919811100001', source_url: 'm3' });
  const d = upsert(db, 'people', { organization_id: org.id, name: 'Demo Diet Clinic', phone_e164: '+919811100002', source_url: 'm4' });
  assert.equal(c.created, true);
  assert.equal(d.created, true);
});

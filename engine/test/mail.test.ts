import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { ingest, textProblems, scheduleFollowUps, OPT_OUT_LINE, cancelFollowUps } from '../mail.ts';

function sent(db: ReturnType<typeof openMemoryDb>, to = 'riya@acme.com') {
  const org = insert(db, 'organizations', { name: 'Acme', domain: 'acme.com', tier: 'small', source_url: 's' });
  const pid = insert(db, 'people', { name: 'Riya', email: to, organization_id: org, source_url: 's' });
  const opp = insert(db, 'opportunities', { track: 'job', kind: 'job', organization_id: org, title: 'Ops', dedupe_key: 'k', source: 't', fit_score: 4, stage: 'contacted' });
  const mid = insert(db, 'messages', { track: 'job', channel: 'email', direction: 'out', account: 'me@gmail.com', person_id: pid, organization_id: org, opportunity_id: opp, to_address: to, subject: 'Hi', body: 'x', status: 'sent', sent_at: '2026-11-01 05:00:00', external_id: '<a1@gmail.com>', thread_key: '<a1@gmail.com>' });
  scheduleFollowUps(db, mid, '2026-11-01 05:00:00', 'Riya');
  return { org, pid, opp, mid };
}

test('textProblems enforces em dash, placeholders and opt-out', () => {
  assert.deepEqual(textProblems('job', 'Hi', 'Short and true.'), []);
  assert.match(textProblems('job', 'Hi', 'one — two').join(), /em dash/);
  assert.match(textProblems('job', 'Hi {{first_name}}', 'x').join(), /placeholder/);
  assert.match(textProblems('freelance', 'Hi', 'A pitch.').join(), /opt-out/);
  assert.deepEqual(textProblems('freelance', 'Hi', `A pitch.\n\n${OPT_OUT_LINE}`), []);
});

test('follow-ups are scheduled at the configured days', () => {
  const db = openMemoryDb();
  sent(db);
  const tasks = db.prepare(`SELECT due_at FROM tasks WHERE kind = 'follow_up' ORDER BY due_at`).all() as Row[];
  assert.deepEqual(tasks.map((t) => t.due_at), ['2026-11-04 05:00:00', '2026-11-08 05:00:00']);
});

test('a reply matched by In-Reply-To is stored, cancels follow-ups and moves the stage', () => {
  const db = openMemoryDb();
  const { opp } = sent(db);
  const r = ingest(db, { messageId: '<r1@acme.com>', inReplyTo: '<a1@gmail.com>', references: [], from: 'Riya@Acme.com', subject: 'Re: Hi', text: 'Sure, send your CV', date: '2026-11-02 06:00:00', account: 'me@gmail.com' });
  assert.equal(r.kind, 'reply');
  assert.equal((db.prepare(`SELECT count(*) AS n FROM tasks WHERE status = 'open'`).get() as Row).n, 0);
  assert.equal((db.prepare('SELECT stage FROM opportunities WHERE id = ?').get(opp) as Row).stage, 'replied');
  assert.equal(ingest(db, { messageId: '<r1@acme.com>', inReplyTo: null, references: [], from: 'riya@acme.com', subject: '', text: '', date: '', account: '' }).kind, 'duplicate');
});

test('a reply without headers matches on address, then on company domain', () => {
  const db = openMemoryDb();
  sent(db);
  assert.equal(ingest(db, { messageId: '<r2@x>', inReplyTo: null, references: [], from: 'riya@acme.com', subject: 'hey', text: 't', date: '2026-11-02 06:00:00', account: 'me' }).kind, 'reply');
  assert.equal(ingest(db, { messageId: '<r3@x>', inReplyTo: null, references: [], from: 'boss@acme.com', subject: 'hey', text: 't', date: '2026-11-02 06:00:00', account: 'me' }).kind, 'reply');
  assert.equal(ingest(db, { messageId: '<r4@x>', inReplyTo: null, references: [], from: 'random@else.com', subject: 'news', text: 't', date: '2026-11-02 06:00:00', account: 'me' }).kind, 'unmatched');
});

test('a bounce suppresses the address, marks the person and stops follow-ups', () => {
  const db = openMemoryDb();
  const { mid, pid } = sent(db, 'gone@acme.com');
  const r = ingest(db, { messageId: '<b1@google>', inReplyTo: null, references: [], from: 'mailer-daemon@googlemail.com', fromName: 'Mail Delivery Subsystem', subject: 'Delivery Status Notification (Failure)', text: "Your message wasn't delivered to gone@acme.com because the address couldn't be found", date: '2026-11-01 05:01:00', account: 'me' });
  assert.equal(r.kind, 'bounce');
  assert.equal(r.original_id, mid);
  assert.equal((db.prepare('SELECT status FROM messages WHERE id = ?').get(mid) as Row).status, 'bounced');
  assert.equal((db.prepare('SELECT email_status FROM people WHERE id = ?').get(pid) as Row).email_status, 'bounced');
  assert.ok(db.prepare(`SELECT 1 FROM suppression WHERE value = 'gone@acme.com'`).get());
  assert.equal((db.prepare(`SELECT count(*) AS n FROM tasks WHERE status = 'open'`).get() as Row).n, 0);
});

test('cancelFollowUps also cancels drafted follow-up emails in that thread', () => {
  const db = openMemoryDb();
  const { mid } = sent(db);
  const draft = insert(db, 'messages', { track: 'job', channel: 'email', direction: 'out', body: 'nudge', status: 'queued', sequence_step: 1, in_reply_to: '<a1@gmail.com>', thread_key: '<a1@gmail.com>' });
  cancelFollowUps(db, mid, 'they replied');
  assert.equal((db.prepare('SELECT status FROM messages WHERE id = ?').get(draft) as Row).status, 'cancelled');
});

test('a stranger on a free-mail domain is not threaded into someone else\'s conversation', () => {
  const db = openMemoryDb();
  sent(db, 'friend@gmail.com');
  assert.equal(ingest(db, { messageId: '<s1@x>', inReplyTo: null, references: [], from: 'stranger@gmail.com', subject: 'hi', text: 't', date: '2026-11-02 06:00:00', account: 'me' }).kind, 'unmatched');
});

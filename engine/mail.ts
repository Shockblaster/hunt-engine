import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Row } from './db.ts';
import { insert, logActivity, update } from './db.ts';
import { workspaceDir } from './paths.ts';
import { gate, requestApproval, isDryRun } from './gate.ts';
import { limits } from './rules.ts';
import { emailSyntax, normalizeDomain } from './normalize.ts';

export type Account = { key: 'job' | 'outreach'; address: string; password?: string; oauth?: { clientId: string; clientSecret: string; refreshToken: string } };

export function loadEnv(slug: string): Record<string, string> {
  const f = join(workspaceDir(slug), '.env');
  if (!existsSync(f)) return {};
  return Object.fromEntries(readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
}

// Job applications and referral asks go from the person's own Gmail; freelance and lead outreach from a separate inbox.
export function accountFor(slug: string, track: string): Account | null {
  const env = loadEnv(slug);
  const key = track === 'job' ? 'job' : 'outreach';
  const address = env[key === 'job' ? 'JOB_EMAIL' : 'OUTREACH_EMAIL'];
  const password = env[key === 'job' ? 'JOB_EMAIL_APP_PASSWORD' : 'OUTREACH_EMAIL_APP_PASSWORD'];
  if (!address) return null;
  if (password) return { key, address: address.toLowerCase(), password: password.replace(/\s+/g, '') };
  // No app password: a Google sign-in made with `he mail connect` works instead.
  const tokFile = join(workspaceDir(slug), `.oauth-${key}.json`);
  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && existsSync(tokFile)) {
    const t = JSON.parse(readFileSync(tokFile, 'utf8')) as { refresh_token: string; email: string };
    return { key, address: (t.email || address).toLowerCase(), oauth: { clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET, refreshToken: t.refresh_token } };
  }
  return null;
}

export function smtpAuth(a: Account): Record<string, string> {
  return a.oauth ? { type: 'OAuth2', user: a.address, clientId: a.oauth.clientId, clientSecret: a.oauth.clientSecret, refreshToken: a.oauth.refreshToken } : { user: a.address, pass: a.password! };
}

export const OPT_OUT_LINE = 'If you would rather not hear from me, reply "no thanks" and I will not write again.';

// Deterministic checks on the text itself (hard rules 14 and 18). Everything else is the QA agent's job.
export function textProblems(track: string, subject: string | null, body: string): string[] {
  const p: string[] = [];
  if (/—/.test(`${subject ?? ''}${body}`)) p.push('contains an em dash (hard rule 18)');
  if (/i hope this (email |message )?finds you well/i.test(body)) p.push('uses "I hope this finds you well" (hard rule 18)');
  if (/\{\{|\[(first ?name|company|name)\]|<insert/i.test(`${subject ?? ''}${body}`)) p.push('has an unfilled placeholder');
  if (track !== 'job' && !body.includes(OPT_OUT_LINE) && !/no thanks|unsubscribe|not hear from me/i.test(body)) p.push('missing the opt-out line (hard rule 14)');
  return p;
}

export type SendResult = { status: 'sent' | 'dry_run' | 'needs_approval' | 'blocked'; reasons: string[]; blocks?: string[]; message_id?: string; preview?: Row };

// Attachments come only from the workspace's files/ folder (resumes, letters, samples): never .env, the database or browser data.
export function safeAttachment(slug: string, f: string): string | { error: string } {
  const filesDir = realpathSync(join(workspaceDir(slug), 'files'));
  let real: string;
  try { real = realpathSync(resolve(f)); } catch { return { error: `attachment missing: ${f}` }; }
  if (!real.startsWith(filesDir + sep)) return { error: `attachments must be inside the workspace files folder: ${f}` };
  if (real.slice(filesDir.length + 1).split(sep).some((part) => part.startsWith('.'))) return { error: `hidden files cannot be attached: ${f}` };
  return real;
}

export async function sendMessage(db: DatabaseSync, slug: string, id: number, opts: { dryRun?: boolean; agent?: string } = {}): Promise<SendResult> {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
  if (!m) throw new Error(`message ${id} not found`);
  if (m.channel !== 'email' || m.direction !== 'out') throw new Error(`message ${id} is not an outbound email`);
  // A workspace in dry run turns every send into a preview, whatever the caller asked for.
  if (isDryRun(db)) opts = { ...opts, dryRun: true };
  if (m.status === 'sent') return { status: 'blocked', reasons: ['already sent'] };
  if (m.status === 'cancelled') return { status: 'blocked', reasons: ['cancelled'] };
  if (m.status === 'pending_review') return { status: 'needs_approval', reasons: ['waiting for the person to approve'], blocks: [] };
  const track = String(m.track);
  const account = accountFor(slug, track);
  const reasons: string[] = [];
  if (!account && !opts.dryRun) reasons.push(`the ${track === 'job' ? 'job' : 'outreach'} Gmail is not connected: add its app password to the workspace .env, or run he mail connect ${track === 'job' ? 'job' : 'outreach'}`);
  const person = m.person_id ? (db.prepare('SELECT * FROM people WHERE id = ?').get(Number(m.person_id)) as Row | undefined) : undefined;
  const to = String(m.to_address ?? person?.email ?? '');
  if (!to) reasons.push('no recipient address');
  reasons.push(...textProblems(track, m.subject as string | null, String(m.body)));
  const files: string[] = [];
  for (const f of m.attachments ? (JSON.parse(String(m.attachments)) as string[]) : []) {
    const ok = safeAttachment(slug, f);
    if (typeof ok === 'string') files.push(ok); else reasons.push(ok.error);
  }
  if (reasons.length) return { status: 'blocked', reasons, blocks: reasons };

  const g = gate(db, { ref_table: 'messages', ref_id: id, account: account?.address });
  if (g.needs_approval) {
    // A dry run only reports; it never files approval requests or changes status.
    if (!opts.dryRun) {
      const org = person?.organization_id ? (db.prepare('SELECT name FROM organizations WHERE id = ?').get(Number(person.organization_id)) as Row | undefined) : undefined;
      requestApproval(db, 'messages', id, `Email to ${person?.name ?? to}${org ? ` at ${org.name}` : ''}: ${m.subject ?? '(no subject)'}`, g.reasons.join('; '));
      logActivity(db, { agent: opts.agent ?? 'mailer', action: 'approval.request', ref_table: 'messages', ref_id: id, detail: { reason: g.reasons.join('; ') } });
    }
    return { status: 'needs_approval', reasons: g.reasons, blocks: [] };
  }
  if (!g.allowed) return { status: 'blocked', reasons: g.reasons, blocks: g.blocks };
  const isReply = Boolean(g.is_reply);

  // Follow-ups reply in the same thread: In-Reply-To and References point at the first message.
  const domain = account?.address.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;
  const firstId = m.in_reply_to ? String(m.in_reply_to) : null;
  const subject = String(m.subject ?? '');
  const mail = {
    from: account?.address, to, subject: (isReply || Number(m.sequence_step) > 0) && !/^re:/i.test(subject) ? `Re: ${subject}` : subject,
    text: String(m.body), messageId, ...(firstId ? { inReplyTo: firstId, references: [firstId] } : {}),
    ...(files.length ? { attachments: files.map((path) => ({ path, filename: basename(path) })) } : {}),
  };
  if (opts.dryRun) return { status: 'dry_run', reasons: g.reasons, preview: mail as unknown as Row };

  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: smtpAuth(account!) });
  try {
    await transport.sendMail(mail);
  } catch (e) {
    update(db, 'messages', id, { status: 'failed' });
    logActivity(db, { agent: opts.agent ?? 'mailer', action: 'mail.failed', ref_table: 'messages', ref_id: id, detail: { error: (e as Error).message } });
    return { status: 'blocked', reasons: [`SMTP error: ${(e as Error).message}`] };
  }
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const threadKey = (m.thread_key as string) ?? messageId;
  db.prepare(`UPDATE messages SET status = 'sent', sent_at = ?, external_id = ?, account = ?, to_address = ?, thread_key = ? WHERE id = ?`).run(now, messageId, account!.address, to, threadKey, id);
  logActivity(db, { agent: opts.agent ?? 'mailer', action: 'mail.sent', ref_table: 'messages', ref_id: id, external: true, detail: { to, subject } });
  if (!isReply && Number(m.sequence_step ?? 0) === 0) scheduleFollowUps(db, id, now, person?.name as string | undefined);
  if (m.opportunity_id) db.prepare(`UPDATE opportunities SET stage = 'contacted', updated_at = ? WHERE id = ? AND stage IN ('found','shortlisted','preparing','pending_review')`).run(now, Number(m.opportunity_id));
  return { status: 'sent', reasons: g.reasons, message_id: messageId };
}

export function scheduleFollowUps(db: DatabaseSync, messageId: number, sentAt: string, who?: string): void {
  const L = limits();
  const base = new Date(`${sentAt.replace(' ', 'T')}Z`).getTime();
  L.follow_up_days.slice(0, L.max_follow_ups).forEach((days, i) => {
    const due = new Date(base + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    insert(db, 'tasks', { kind: 'follow_up', title: `Follow-up ${i + 1}${who ? ` to ${who}` : ''}`, due_at: due, ref_table: 'messages', ref_id: messageId, agent: 'follow-up', notes: `step ${i + 1}` });
  });
}

// ---- Inbound mail. Kept separate from IMAP so it can be tested with plain objects.
export type Inbound = { messageId: string | null; inReplyTo: string | null; references: string[]; from: string; fromName?: string; subject: string; text: string; date: string; account: string };

const BOUNCE_FROM = /mailer-daemon|postmaster|mail delivery subsystem/i;

export function ingest(db: DatabaseSync, mail: Inbound): { kind: 'reply' | 'bounce' | 'unmatched' | 'duplicate'; message_id?: number; original_id?: number } {
  if (mail.messageId && db.prepare('SELECT id FROM messages WHERE external_id = ?').get(mail.messageId)) return { kind: 'duplicate' };
  const refs = [mail.inReplyTo, ...mail.references].filter(Boolean) as string[];
  const findOriginal = (): Row | undefined => {
    for (const r of refs) {
      const o = db.prepare(`SELECT * FROM messages WHERE external_id = ? AND direction = 'out'`).get(r) as Row | undefined;
      if (o) return o;
    }
    return undefined;
  };

  if (BOUNCE_FROM.test(`${mail.from} ${mail.fromName ?? ''}`)) {
    const original = findOriginal() ?? (() => {
      // Bounce bodies name the failed address; take the first address in the text that we actually wrote to.
      for (const addr of mail.text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) {
        const hit = db.prepare(`SELECT * FROM messages WHERE lower(to_address) = lower(?) AND direction = 'out' ORDER BY id DESC LIMIT 1`).get(addr) as Row | undefined;
        if (hit) return hit;
      }
      return undefined;
    })();
    if (!original) return { kind: 'unmatched' };
    update(db, 'messages', Number(original.id), { status: 'bounced' });
    const addr = String(original.to_address ?? '').toLowerCase();
    if (addr) {
      db.prepare(`INSERT OR IGNORE INTO suppression (kind, value, reason) VALUES ('email', ?, 'hard bounce')`).run(addr);
      const was = db.prepare(`SELECT email_status, organization_id FROM people WHERE lower(email) = ?`).get(addr) as Row | undefined;
      // Any bounce of an address the company did not publish means the guessed pattern is wrong.
      if (was && !['published', 'verified'].includes(String(was.email_status)) && was.organization_id) db.prepare(`UPDATE organizations SET email_pattern_status = 'bounced' WHERE id = ?`).run(Number(was.organization_id));
      db.prepare(`UPDATE people SET email_status = 'bounced' WHERE lower(email) = ?`).run(addr);
    }
    cancelFollowUps(db, Number(original.id), 'bounced');
    logActivity(db, { agent: 'inbox', action: 'mail.bounced', ref_table: 'messages', ref_id: Number(original.id), external: true, detail: { to: addr } });
    return { kind: 'bounce', original_id: Number(original.id) };
  }

  const from = emailSyntax(mail.from).normalized;
  let original = findOriginal();
  // Some clients drop the headers; fall back to the last thing we sent this address.
  original ??= db.prepare(`SELECT * FROM messages WHERE direction = 'out' AND status = 'sent' AND lower(to_address) = ? ORDER BY id DESC LIMIT 1`).get(from) as Row | undefined;
  if (!original) {
    // Replies from a colleague at the same company still count when the domain matches someone we wrote to.
    const dom = emailSyntax(from).free ? null : normalizeDomain(from); // never match on gmail.com and other shared domains
    original = dom ? (db.prepare(`SELECT * FROM messages WHERE direction = 'out' AND status = 'sent' AND lower(to_address) LIKE ? ORDER BY id DESC LIMIT 1`).get(`%@${dom}`) as Row | undefined) : undefined;
  }
  if (!original) return { kind: 'unmatched' };

  const id = insert(db, 'messages', {
    track: original.track, channel: 'email', direction: 'in', account: mail.account, person_id: original.person_id, organization_id: original.organization_id,
    opportunity_id: original.opportunity_id, thread_key: original.thread_key, to_address: from, subject: mail.subject, body: mail.text.slice(0, 20000),
    status: 'received', external_id: mail.messageId, in_reply_to: mail.inReplyTo, sent_at: mail.date,
  });
  // Any reply stops the automatic follow-ups for that thread; the inbox agent decides what happens next.
  const outs = db.prepare(`SELECT id FROM messages WHERE thread_key = ? AND direction = 'out'`).all(String(original.thread_key)) as Row[];
  for (const o of outs) cancelFollowUps(db, Number(o.id), 'they replied');
  if (original.opportunity_id) db.prepare(`UPDATE opportunities SET stage = 'replied', updated_at = datetime('now') WHERE id = ? AND stage IN ('found','shortlisted','preparing','pending_review','applied','contacted')`).run(Number(original.opportunity_id));
  logActivity(db, { agent: 'inbox', action: 'reply.received', ref_table: 'messages', ref_id: id, external: true, detail: { from, subject: mail.subject } });
  return { kind: 'reply', message_id: id, original_id: Number(original.id) };
}

export function cancelFollowUps(db: DatabaseSync, messageId: number, why: string): void {
  db.prepare(`UPDATE tasks SET status = 'cancelled', done_at = datetime('now'), notes = ? WHERE kind = 'follow_up' AND status = 'open' AND ref_table = 'messages' AND ref_id = ?`).run(why, messageId);
  db.prepare(`UPDATE messages SET status = 'cancelled' WHERE direction = 'out' AND status IN ('drafted','queued','approved') AND in_reply_to = (SELECT external_id FROM messages WHERE id = ?)`).run(messageId);
}

// Reads new mail over IMAP since the last sync and ingests it. Read-only on the mailbox.
export async function syncInbox(db: DatabaseSync, slug: string, which: 'job' | 'outreach'): Promise<{ account: string; fetched: number; replies: number; bounces: number; unmatched: number }> {
  const acc = accountFor(slug, which === 'job' ? 'job' : 'freelance');
  if (!acc) throw new Error(`the ${which} Gmail is not connected: add its app password to the workspace .env, or run he mail connect ${which}`);
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const auth = acc.oauth ? { user: acc.address, accessToken: await (await import('./oauth.ts')).accessToken(slug, which) } : { user: acc.address, pass: acc.password! };
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth, logger: false });
  const key = `imap_last_uid:${acc.address}`;
  const last = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined)?.value ?? 0);
  const stats = { account: acc.address, fetched: 0, replies: 0, bounces: 0, unmatched: 0 };
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  let maxUid = last;
  try {
    // First sync looks back 14 days; later syncs fetch only new UIDs.
    const range = last ? { uid: `${last + 1}:*` } : { since: new Date(Date.now() - 14 * 86400000) };
    for await (const msg of client.fetch(range as never, { uid: true, source: true }, { uid: Boolean(last) })) {
      if (msg.uid <= last) continue;
      maxUid = Math.max(maxUid, msg.uid);
      const p = await simpleParser(msg.source as Buffer);
      const fromAddr = p.from?.value?.[0];
      const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
      const res = ingest(db, {
        messageId: p.messageId ?? null, inReplyTo: p.inReplyTo ?? null, references: refs, from: fromAddr?.address ?? '', fromName: fromAddr?.name,
        subject: p.subject ?? '', text: (p.text ?? '').trim(), date: (p.date ?? new Date()).toISOString().replace('T', ' ').slice(0, 19), account: acc.address,
      });
      stats.fetched++;
      if (res.kind === 'reply') stats.replies++;
      else if (res.kind === 'bounce') stats.bounces++;
      else if (res.kind === 'unmatched') stats.unmatched++;
    }
  } finally {
    lock.release();
    await client.logout();
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(maxUid));
  logActivity(db, { agent: 'inbox', action: 'mail.sync', detail: stats });
  return stats;
}

// Follow-ups that are due, with what the follow-up agent needs to write the next step.
export function dueFollowUps(db: DatabaseSync): Row[] {
  return db.prepare(`SELECT t.id AS task_id, t.title, t.due_at, t.notes, m.id AS message_id, m.track, m.thread_key, m.external_id, m.subject, m.body, m.to_address,
      m.person_id, m.organization_id, m.opportunity_id, p.name AS person, o.name AS organization
    FROM tasks t JOIN messages m ON m.id = t.ref_id AND t.ref_table = 'messages'
    LEFT JOIN people p ON p.id = m.person_id LEFT JOIN organizations o ON o.id = m.organization_id
    WHERE t.kind = 'follow_up' AND t.status = 'open' AND t.due_at <= datetime('now') ORDER BY t.due_at`).all() as Row[];
}

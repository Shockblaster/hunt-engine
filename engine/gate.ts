import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Row } from './db.ts';
import { limits, verifyRules } from './rules.ts';
import { emailSyntax, normalizeDomain, sameCompany } from './normalize.ts';

// The gate decides from the stored row (message or application), never from what the caller says about it,
// so an agent cannot pick a friendlier company, drop the opportunity, or borrow another item's approval.
export type GateInput = {
  ref_table: 'messages' | 'applications';
  ref_id: number;
  account?: string;            // sending account (the mailer fills it in)
  now?: Date;
};

export type GateResult = { allowed: boolean; needs_approval: boolean; defer_until?: string; reasons: string[]; blocks: string[]; is_reply?: boolean; dry_run?: boolean };

// A workspace in dry run prepares everything and sends nothing. The two ways out (`he mail send` and `he claim`)
// both check this, so a dry run does not depend on each agent being told. Only the person turns it off.
export const DRY_RUN_NOTE = 'this workspace is in dry run: nothing is sent or submitted until the person runs `he ws dry-run off`';
export function isDryRun(db: DatabaseSync): boolean {
  const r = db.prepare(`SELECT value FROM meta WHERE key = 'dry_run'`).get() as Row | undefined;
  return r?.value === '1';
}

// Companies the person must never apply to or contact (for example a current employer). Read from the newest
// profile of each track: `never_list` as a list of names, or as { companies: [...] }.
export function neverList(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT data FROM profiles p WHERE version = (SELECT max(version) FROM profiles WHERE track = p.track)`).all() as Row[];
  const names = new Set<string>();
  for (const r of rows) {
    let nl: unknown;
    try { nl = (JSON.parse(String(r.data)) as { never_list?: unknown }).never_list; } catch { continue; }
    const list = Array.isArray(nl) ? nl : Array.isArray((nl as { companies?: unknown })?.companies) ? (nl as { companies: unknown[] }).companies : [];
    for (const n of list) if (typeof n === 'string' && n.trim()) names.add(n.trim());
  }
  return [...names];
}

// A never-list name matches the company's name, its domain, or the domain of the address being written to.
export function neverListHit(never: string[], org: Row | undefined, to: string | null): string | null {
  const labels: string[] = [];
  if (org?.name) labels.push(String(org.name));
  for (const d of [org?.domain ? String(org.domain) : null, to && to.includes('@') && !emailSyntax(to).free ? normalizeDomain(to) : null]) {
    if (d) labels.push(d, d.split('.')[0]);
  }
  for (const n of never) {
    const asDomain = n.includes('.') ? normalizeDomain(n) : null;
    if (labels.some((l) => sameCompany(n, l) || (asDomain !== null && l === asDomain))) return n;
  }
  return null;
}

export function capKey(track: string, channel: string): string {
  if (channel === 'email') return track === 'job' ? 'email_job' : 'email_outreach';
  if (channel === 'portal') return 'portal_submit';
  return channel;
}

function istParts(d: Date): { date: string; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

const sqlTime = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
// Stored times are UTC, either 'YYYY-MM-DD HH:MM:SS' or ISO; both parse here.
export const parseUtc = (s: unknown) => { const v = String(s); return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`); };

// SQLite datetime('now') is UTC; convert an IST calendar day into its UTC bounds.
function istDayBoundsUtc(istDate: string): [string, string] {
  const start = new Date(`${istDate}T00:00:00+05:30`);
  return [sqlTime(start), sqlTime(new Date(start.getTime() + 86_400_000))];
}

// datetime() normalises whatever format a timestamp was stored in before comparing.
export function sentToday(db: DatabaseSync, account: string | undefined, key: string, now: Date): number {
  const [from, to] = istDayBoundsUtc(istParts(now).date);
  const rows = db.prepare(`SELECT track, channel FROM messages WHERE direction = 'out' AND status IN ('sent','bounced')
    AND datetime(sent_at) >= ? AND datetime(sent_at) < ? AND ifnull(account,'') = ifnull(?, '')`).all(from, to, account ?? null) as Row[];
  let n = rows.filter((r) => capKey(String(r.track), String(r.channel)) === key).length;
  if (key === 'portal_submit') {
    n += Number((db.prepare(`SELECT count(*) AS n FROM applications WHERE status = 'submitted' AND datetime(submitted_at) >= ? AND datetime(submitted_at) < ?`).get(from, to) as Row).n);
  }
  return n;
}

export function dailyCap(db: DatabaseSync, account: string | undefined, key: string, now: Date): number {
  const L = limits();
  const cap = L.caps_per_day[key] ?? 0;
  if (!L.warmup.applies_to.includes(key) || !account) return cap;
  const first = db.prepare(`SELECT min(datetime(sent_at)) AS first FROM messages WHERE direction = 'out' AND status = 'sent' AND account = ?`).get(account) as Row;
  if (!first.first) return Math.min(cap, L.warmup.ramp[0]);
  const days = Math.floor((now.getTime() - parseUtc(first.first).getTime()) / 86_400_000);
  return Math.min(cap, L.warmup.ramp[Math.min(Math.max(days, 0), L.warmup.ramp.length - 1)]);
}

function fileDigest(p: unknown): string {
  return typeof p === 'string' && existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : String(p ?? '');
}

// What the person approved: the recipient, the words and the files. Any change after approval needs a new approval.
export function contentHash(db: DatabaseSync, table: string, id: number): string | null {
  const row = db.prepare(`SELECT * FROM ${table === 'applications' ? 'applications' : 'messages'} WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const parts = table === 'applications'
    ? [row.opportunity_id, row.portal, row.answers, row.resume_path, fileDigest(row.resume_path), row.resume_docx_path, fileDigest(row.resume_docx_path), row.cover_letter_path, fileDigest(row.cover_letter_path)]
    : [row.channel, row.to_address, row.person_id, row.organization_id, row.opportunity_id, row.subject, row.body,
       ...((row.attachments ? (JSON.parse(String(row.attachments)) as string[]) : []).flatMap((f) => [f, fileDigest(f)]))];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function requestApproval(db: DatabaseSync, table: 'messages' | 'applications', id: number, summary: string, reason: string): Row {
  const hash = contentHash(db, table, id);
  if (!hash) throw new Error(`${table} ${id} not found`);
  // A new request for changed content resets an earlier decision.
  db.prepare(`INSERT INTO approvals (ref_table, ref_id, summary, reason, content_hash) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (ref_table, ref_id) DO UPDATE SET summary = excluded.summary, reason = excluded.reason,
      status = CASE WHEN approvals.content_hash IS excluded.content_hash THEN approvals.status ELSE 'pending' END,
      decided_at = CASE WHEN approvals.content_hash IS excluded.content_hash THEN approvals.decided_at ELSE NULL END,
      decided_via = CASE WHEN approvals.content_hash IS excluded.content_hash THEN approvals.decided_via ELSE NULL END,
      content_hash = excluded.content_hash, requested_at = datetime('now')`).run(table, id, summary, reason, hash);
  const unsent = table === 'applications' ? `('draft','approved','pending_review')` : `('drafted','queued','approved','pending_review')`;
  const a = db.prepare('SELECT * FROM approvals WHERE ref_table = ? AND ref_id = ?').get(table, id) as Row;
  if (a.status === 'pending') db.prepare(`UPDATE ${table} SET status = 'pending_review' WHERE id = ? AND status IN ${unsent}`).run(id);
  return a;
}

type Item = { track: string; channel: string; person?: Row; org?: Row; opp?: Row; to: string | null; step: number; thread: string | null; inReplyTo: string | null; row: Row };

function loadItem(db: DatabaseSync, input: GateInput, block: (r: string) => void): Item | null {
  if (input.ref_table === 'applications') {
    const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(input.ref_id) as Row | undefined;
    if (!row) { block(`application ${input.ref_id} not found`); return null; }
    const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(row.opportunity_id)) as Row | undefined;
    const org = opp?.organization_id ? (db.prepare('SELECT * FROM organizations WHERE id = ?').get(Number(opp.organization_id)) as Row | undefined) : undefined;
    return { track: 'job', channel: 'portal', opp, org, to: null, step: 0, thread: null, inReplyTo: null, row };
  }
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(input.ref_id) as Row | undefined;
  if (!row) { block(`message ${input.ref_id} not found`); return null; }
  if (row.direction !== 'out') { block('only outbound messages can be sent'); return null; }
  const person = row.person_id ? (db.prepare('SELECT * FROM people WHERE id = ?').get(Number(row.person_id)) as Row | undefined) : undefined;
  if (row.person_id && !person) block(`person ${row.person_id} not found`);
  // The person's own company decides the tier; a message cannot claim a different one.
  if (person?.organization_id && row.organization_id && Number(person.organization_id) !== Number(row.organization_id)) {
    block('the message names a different company from the person it goes to');
  }
  const orgId = person?.organization_id ?? row.organization_id;
  const org = orgId ? (db.prepare('SELECT * FROM organizations WHERE id = ?').get(Number(orgId)) as Row | undefined) : undefined;
  const opp = row.opportunity_id ? (db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(row.opportunity_id)) as Row | undefined) : undefined;
  if (opp && org && opp.organization_id && Number(opp.organization_id) !== Number(org.id)) block('the opportunity belongs to a different company');
  const channel = String(row.channel);
  const to = (row.to_address as string | null) ?? (channel === 'email' ? (person?.email as string | null) : channel.startsWith('linkedin') ? (person?.linkedin_url as string | null) : (person?.phone_e164 as string | null)) ?? null;
  return { track: String(row.track), channel, person, org, opp, to, step: Number(row.sequence_step ?? 0), thread: (row.thread_key as string) ?? null, inReplyTo: (row.in_reply_to as string) ?? null, row };
}

export function gate(db: DatabaseSync, input: GateInput): GateResult {
  const L = limits();
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const blocks: string[] = [];
  let needsApproval = false;
  let deferUntil: string | undefined;
  const block = (r: string) => { blocks.push(r); reasons.push(r); };

  const rules = verifyRules();
  if (!rules.ok) block(`rules: ${rules.reason}`);
  if (input.ref_table !== 'messages' && input.ref_table !== 'applications') {
    block('the gate needs ref_table messages or applications; record the item first, then gate it');
    return { allowed: false, needs_approval: false, reasons, blocks };
  }
  const it = loadItem(db, input, block);
  if (!it) return { allowed: false, needs_approval: false, reasons, blocks };
  const { track, channel, person, org, opp } = it;

  // Suppression: the address, its domain, every contact detail of the person, or an opt-out.
  const values: string[] = [];
  if (it.to) {
    values.push(it.to.trim().toLowerCase());
    if (it.to.includes('@')) {
      const dom = emailSyntax(it.to).free ? null : normalizeDomain(it.to);
      if (dom) values.push(dom);
    }
    if (channel === 'email' && !emailSyntax(it.to).valid) block(`invalid email address ${it.to}`);
  } else if (channel !== 'portal') block('no recipient');
  if (person) {
    if (person.opt_out) block('person opted out');
    if (person.email_status === 'bounced' && channel === 'email') block('email bounced before');
    for (const k of ['email', 'phone_e164', 'linkedin_url']) if (person[k]) values.push(String(person[k]).toLowerCase());
  }
  for (const v of new Set(values)) {
    const hit = db.prepare('SELECT reason FROM suppression WHERE value = ?').get(v) as Row | undefined;
    if (hit) block(`suppressed (${v}): ${hit.reason}`);
  }

  // The never list: no application, message or referral request reaches these companies, approved or not.
  const never = neverListHit(neverList(db), org, it.to);
  if (never) block(`on the person's never list (${never})`);

  // Replies answer something this same person sent in this same thread; follow-ups chase a first message we sent them.
  const samePerson = `(person_id = ? OR lower(ifnull(to_address,'')) = lower(?))`;
  const pArgs = [Number(it.row.person_id ?? -1), String(it.to ?? '#none')] as const;
  const isReply = Boolean(it.inReplyTo && it.thread && db.prepare(
    `SELECT 1 FROM messages WHERE direction = 'in' AND external_id = ? AND thread_key = ? AND ${samePerson}`).get(it.inReplyTo, it.thread, ...pArgs));
  if (it.inReplyTo && !isReply && it.step === 0) block('in_reply_to does not match a message this person sent in this thread');

  // Fit floor: every first touch on the job and freelance tracks must be tied to a scored opportunity.
  if (track !== 'lead' && !isReply && it.step === 0) {
    if (!opp) block('a first message or application must be linked to a scored opportunity');
    else if (opp.fit_score == null) block('opportunity has no fit score yet');
    else if (Number(opp.fit_score) < L.min_fit) block(`fit ${opp.fit_score} is below the floor ${L.min_fit}`);
  }

  // Approvals: the big-company rule (job track), or any item an agent already asked the person about.
  // Either way the approval must match the exact content now in the row.
  const tier = org ? String(org.tier) : 'unknown';
  const appr = db.prepare('SELECT status, content_hash FROM approvals WHERE ref_table = ? AND ref_id = ?').get(input.ref_table, input.ref_id) as Row | undefined;
  if ((track === 'job' && tier !== 'small') || appr) {
    const same = appr?.content_hash != null && appr.content_hash === contentHash(db, input.ref_table, input.ref_id);
    if (appr?.status === 'approved' && same) reasons.push('approved by the person');
    else if (appr?.status === 'rejected' && same) block('the person rejected this item');
    else { needsApproval = true; reasons.push(appr?.status === 'approved' ? 'changed after the person approved it; needs approval again' : appr ? 'waiting for the person to approve' : `${tier} tier needs the person's approval`); }
  }

  // One first touch per person per track and channel family, matched on the person or the address.
  if (!isReply && it.step === 0 && channel !== 'portal') {
    const family = channel === 'linkedin_connect' ? `channel = 'linkedin_connect'` : `channel <> 'linkedin_connect'`;
    const prior = db.prepare(`SELECT count(*) AS n FROM messages WHERE direction = 'out' AND sequence_step = 0 AND status IN ('sent','bounced')
      AND track = ? AND ${family} AND id <> ? AND ${samePerson}`).get(track, input.ref_id, ...pArgs) as Row;
    if (Number(prior.n) > 0) block('this person already got a first message on this track');
  }
  if (it.step > 0) {
    const first = it.inReplyTo && it.thread ? (db.prepare(`SELECT * FROM messages WHERE direction = 'out' AND sequence_step = 0 AND status = 'sent'
      AND external_id = ? AND thread_key = ? AND ${samePerson}`).get(it.inReplyTo, it.thread, ...pArgs) as Row | undefined) : undefined;
    if (!first) block('a follow-up must reply to a first message we sent this person, in the same thread');
    else {
      const sentFollowUps = Number((db.prepare(`SELECT count(*) AS n FROM messages WHERE direction = 'out' AND sequence_step > 0 AND status IN ('sent','bounced') AND thread_key = ?`).get(it.thread) as Row).n);
      if (sentFollowUps >= L.max_follow_ups) block(`already sent ${sentFollowUps} follow-ups (limit ${L.max_follow_ups})`);
      else {
        const dueDays = L.follow_up_days[sentFollowUps] ?? L.follow_up_days.at(-1)!;
        const due = new Date(parseUtc(first.sent_at).getTime() + dueDays * 86_400_000);
        if (now < due) { block(`follow-up ${sentFollowUps + 1} is not due until ${sqlTime(due)} UTC`); deferUntil = sqlTime(due); }
      }
    }
    if (it.thread) {
      const replied = db.prepare(`SELECT count(*) AS n FROM messages WHERE thread_key = ? AND direction = 'in' AND ifnull(reply_class,'') NOT IN ('ooo','auto')`).get(it.thread) as Row;
      if (Number(replied.n) > 0) block('they already replied in this thread; the inbox agent handles it');
    }
  }

  // Caps, pacing and send window.
  if (channel !== 'call') {
    const account = input.account ?? (channel.startsWith('linkedin') ? 'linkedin' : (it.row.account as string | undefined));
    const key = capKey(track, channel);
    const cap = dailyCap(db, account, key, now);
    const used = sentToday(db, account, key, now);
    if (used >= cap) {
      deferUntil = istDayBoundsUtc(istParts(now).date)[1];
      block(`daily cap reached for ${key} on ${account ?? 'default'} (${used}/${cap})`);
    } else reasons.push(`${key}: ${used}/${cap} used today`);

    if (channel === 'email') {
      const { hm } = istParts(now);
      const [open, close] = L.send_window_ist;
      if (hm < open || hm >= close) { block(`outside the send window ${open}-${close} IST`); deferUntil ??= 'next send window'; }
      const last = db.prepare(`SELECT max(datetime(sent_at)) AS at FROM messages WHERE direction = 'out' AND status = 'sent' AND channel = 'email' AND ifnull(account,'') = ifnull(?, '')`).get(account ?? null) as Row;
      if (last.at) {
        const gap = (now.getTime() - parseUtc(last.at).getTime()) / 1000;
        if (gap < L.min_seconds_between_sends) {
          const wait = Math.ceil(L.min_seconds_between_sends - gap);
          block(`wait ${wait}s between sends`);
          deferUntil ??= `${wait}s`;
        }
      }
    }
  }

  const blocked = blocks.length > 0;
  return { allowed: !blocked && !needsApproval, needs_approval: !blocked && needsApproval, defer_until: deferUntil, reasons, blocks, is_reply: isReply, ...(isDryRun(db) ? { dry_run: true } : {}) };
}

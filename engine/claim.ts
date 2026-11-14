import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './db.ts';
import { insert, logActivity } from './db.ts';
import { gate, requestApproval, DRY_RUN_NOTE } from './gate.ts';

const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// For actions the engine cannot perform itself (LinkedIn clicks, portal submits): the agent claims the item first.
// The claim runs the gate on the stored row and, if allowed, records it as sent or submitted (so caps count it)
// before the agent clicks. If the click then fails, `he release` marks it failed.
export function claim(db: DatabaseSync, table: 'messages' | 'applications', id: number, agent: string): { claimed: boolean; status: string; reasons: string[]; dry_run?: boolean } {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
  if (!row) throw new Error(`${table} ${id} not found`);
  if (table === 'messages' && row.channel === 'email') throw new Error('emails are sent with `he mail send`, not claimed');
  if (['sent', 'submitted'].includes(String(row.status))) return { claimed: false, status: String(row.status), reasons: ['already done'] };
  const g = gate(db, { ref_table: table, ref_id: id });
  if (g.needs_approval) {
    const summary = table === 'applications' ? describeApplication(db, row) : `${String(row.channel).replace('_', ' ')} to ${personName(db, row)}`;
    requestApproval(db, table, id, summary, g.reasons.join('; '));
    logActivity(db, { agent, action: 'approval.request', ref_table: table, ref_id: id, detail: { reason: g.reasons.join('; ') } });
    return { claimed: false, status: 'pending_review', reasons: g.reasons };
  }
  if (!g.allowed) return { claimed: false, status: String(row.status), reasons: g.reasons };
  // Dry run: the gate would let this through, so the agent fills the form and stops before the final click.
  if (g.dry_run) return { claimed: false, status: String(row.status), reasons: [...g.reasons, DRY_RUN_NOTE], dry_run: true };
  const now = sqlNow();
  if (table === 'applications') {
    db.prepare(`UPDATE applications SET status = 'submitted', submitted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
    db.prepare(`UPDATE opportunities SET stage = 'applied', updated_at = ? WHERE id = ? AND stage IN ('found','shortlisted','preparing','pending_review')`).run(now, Number(row.opportunity_id));
    insert(db, 'tasks', { kind: 'follow_up', title: `Check ${describeApplication(db, row)}`, due_at: new Date(Date.now() + 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19), ref_table: 'applications', ref_id: id, agent: 'follow-up' });
  } else {
    db.prepare(`UPDATE messages SET status = 'sent', sent_at = ?, account = coalesce(account, ?) WHERE id = ?`).run(now, String(row.channel).startsWith('linkedin') ? 'linkedin' : null, id);
  }
  logActivity(db, { agent, action: table === 'applications' ? 'application.submitted' : String(row.channel).startsWith('linkedin') ? 'linkedin.connect' : 'message.sent', ref_table: table, ref_id: id, external: true });
  return { claimed: true, status: table === 'applications' ? 'submitted' : 'sent', reasons: g.reasons };
}

export function release(db: DatabaseSync, table: 'messages' | 'applications', id: number, reason: string, agent: string): void {
  db.prepare(`UPDATE ${table} SET status = 'failed' WHERE id = ? AND status IN ('sent','submitted')`).run(id);
  if (table === 'applications') db.prepare(`UPDATE applications SET result = ? WHERE id = ?`).run(reason, id);
  logActivity(db, { agent, action: `${table}.failed`, ref_table: table, ref_id: id, detail: { reason } });
}

function describeApplication(db: DatabaseSync, app: Row): string {
  const r = db.prepare(`SELECT o.title, org.name FROM opportunities o LEFT JOIN organizations org ON org.id = o.organization_id WHERE o.id = ?`).get(Number(app.opportunity_id)) as Row | undefined;
  return r ? `${r.title} at ${r.name ?? 'unknown company'}` : `application ${app.id}`;
}

function personName(db: DatabaseSync, m: Row): string {
  const p = m.person_id ? (db.prepare('SELECT name FROM people WHERE id = ?').get(Number(m.person_id)) as Row | undefined) : undefined;
  return String(p?.name ?? m.to_address ?? 'someone');
}

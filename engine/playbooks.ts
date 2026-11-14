import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Row } from './db.ts';
import { logActivity } from './db.ts';
import { REPO_ROOT } from './paths.ts';

export function activePlaybook(db: DatabaseSync, track: string, agent: string): Row | undefined {
  return db.prepare('SELECT * FROM playbooks WHERE track = ? AND agent = ? AND active = 1 ORDER BY version DESC LIMIT 1').get(track, agent) as Row | undefined;
}

// A new version becomes active and the change is recorded so the dashboard can show it and revert it.
export function setPlaybook(db: DatabaseSync, p: { track: string; agent: string; content: string; reason: string; by: string; evidence?: unknown }): { id: number; version: number; change_id: number | null } {
  // Playbooks may mention the rules, but the critic cannot write guidance that loosens them.
  if (p.by === 'critic' && /\b(ignore|skip|raise|increase|bypass|override|disable)\s+(the\s+)?(daily\s+)?(hard rules?|caps?|limits?|approvals?|min_fit|suppression|send window)/i.test(p.content)) {
    throw new Error('a playbook cannot override hard rules, caps or approvals');
  }
  db.exec('BEGIN');
  try {
    const prev = activePlaybook(db, p.track, p.agent);
    const version = prev ? Number(prev.version) + 1 : 1;
    db.prepare('UPDATE playbooks SET active = 0 WHERE track = ? AND agent = ?').run(p.track, p.agent);
    const id = Number(db.prepare('INSERT INTO playbooks (track, agent, version, content, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(p.track, p.agent, version, p.content, p.reason, p.by).lastInsertRowid);
    let changeId: number | null = null;
    if (prev) {
      changeId = Number(db.prepare('INSERT INTO strategy_changes (playbook_id, prev_playbook_id, reason, evidence) VALUES (?, ?, ?, ?)')
        .run(id, Number(prev.id), p.reason, p.evidence === undefined ? null : JSON.stringify(p.evidence)).lastInsertRowid);
    }
    logActivity(db, { agent: p.by, action: 'playbook.set', ref_table: 'playbooks', ref_id: id, detail: { track: p.track, agent: p.agent, version, reason: p.reason } });
    db.exec('COMMIT');
    return { id, version, change_id: changeId };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Revert re-activates the previous version as a new version, so history stays append-only.
export function revertChange(db: DatabaseSync, changeId: number, via: string): { id: number; version: number } {
  const ch = db.prepare('SELECT * FROM strategy_changes WHERE id = ?').get(changeId) as Row | undefined;
  if (!ch) throw new Error(`strategy change ${changeId} not found`);
  if (ch.reverted) throw new Error(`strategy change ${changeId} is already reverted`);
  const prev = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(Number(ch.prev_playbook_id)) as Row;
  const cur = db.prepare('SELECT * FROM playbooks WHERE id = ?').get(Number(ch.playbook_id)) as Row;
  const res = setPlaybook(db, { track: String(cur.track), agent: String(cur.agent), content: String(prev.content), reason: `revert of change ${changeId} (v${cur.version} back to v${prev.version} content)`, by: `person:${via}` });
  db.prepare('UPDATE strategy_changes SET reverted = 1, reverted_via = ? WHERE id = ?').run(via, changeId);
  return { id: res.id, version: res.version };
}

// Seeds ship in playbooks/<track>/<agent>.md and load once per workspace.
export function seedPlaybooks(db: DatabaseSync): number {
  const root = join(REPO_ROOT, 'playbooks');
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const track of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    for (const file of readdirSync(join(root, track)).filter((f) => f.endsWith('.md'))) {
      const agent = file.replace(/\.md$/, '');
      if (activePlaybook(db, track, agent)) continue;
      setPlaybook(db, { track, agent, content: readFileSync(join(root, track, file), 'utf8'), reason: 'seed', by: 'seed' });
      n++;
    }
  }
  return n;
}

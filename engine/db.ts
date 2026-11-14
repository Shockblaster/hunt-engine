import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, workspaceDir } from './paths.ts';

export type Row = Record<string, unknown>;

// Tables agents may write through `he upsert` / `he update`, with the columns that identify a duplicate.
export const TABLES: Record<string, { natural: string[][]; json: string[] }> = {
  claims: { natural: [['text']], json: [] },
  organizations: { natural: [['domain']], json: ['tier_reasons', 'funding'] },
  people: { natural: [['email'], ['linkedin_url'], ['phone_e164']], json: [] },
  opportunities: { natural: [['dedupe_key']], json: ['fit_reasons'] },
  applications: { natural: [], json: ['answers'] },
  messages: { natural: [['external_id']], json: ['variant', 'attachments'] },
  tasks: { natural: [], json: [] },
  verifications: { natural: [], json: [] },
  profiles: { natural: [], json: ['data'] },
  experiments: { natural: [], json: ['variants', 'result'] },
  agent_notes: { natural: [], json: [] },
};

export function openDb(slug: string): DatabaseSync {
  const db = new DatabaseSync(join(workspaceDir(slug), 'db.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

// A database file by path (practice-test workspaces live under their own home folder).
export function openDbAt(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function openMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  const done = new Set((db.prepare('SELECT name FROM _migrations').all() as Row[]).map((r) => r.name));
  const dir = join(REPO_ROOT, 'engine', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'));
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
}

// Accepts objects for JSON columns and drops keys that are not columns, so agents get a clear error instead of SQL noise.
function clean(db: DatabaseSync, table: string, data: Row): Row {
  const cols = columns(db, table);
  const out: Row = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (!cols.has(k)) { unknown.push(k); continue; }
    out[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v;
  }
  if (unknown.length) throw new Error(`${table}: unknown column(s) ${unknown.join(', ')}`);
  return out;
}

export function findExisting(db: DatabaseSync, table: string, data: Row): Row | undefined {
  for (const keys of TABLES[table]?.natural ?? []) {
    if (keys.some((k) => data[k] === undefined || data[k] === null || data[k] === '')) continue;
    const where = keys.map((k) => `${k} = ?`).join(' AND ');
    const row = db.prepare(`SELECT * FROM ${table} WHERE ${where}`).get(...keys.map((k) => data[k] as string)) as Row | undefined;
    if (row) return row;
  }
  // Organizations without a domain dedupe on name + city (local shops, clinics).
  if (table === 'organizations' && !data.domain && data.name) {
    return db.prepare('SELECT * FROM organizations WHERE domain IS NULL AND lower(name) = lower(?) AND ifnull(lower(city),\'\') = ifnull(lower(?),\'\')')
      .get(String(data.name), (data.city as string) ?? null) as Row | undefined;
  }
  // People with no phone, email or LinkedIn (listings that show no number) used to be saved again every time a
  // neighbouring locality search found them. Same business and same name is the same lead. Only when the new row
  // has no contact key: two same-name branches with different phones stay separate.
  if (table === 'people' && data.organization_id && data.name && !data.phone_e164 && !data.email && !data.linkedin_url) {
    return db.prepare('SELECT * FROM people WHERE organization_id = ? AND lower(name) = lower(?) ORDER BY id LIMIT 1')
      .get(Number(data.organization_id), String(data.name)) as Row | undefined;
  }
  return undefined;
}

export function insert(db: DatabaseSync, table: string, data: Row): number {
  const row = clean(db, table, data);
  const keys = Object.keys(row);
  const res = db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...(keys.map((k) => row[k]) as never[]));
  return Number(res.lastInsertRowid);
}

export function update(db: DatabaseSync, table: string, id: number, data: Row): void {
  const row = clean(db, table, data);
  if (columns(db, table).has('updated_at')) row.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const keys = Object.keys(row);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...(keys.map((k) => row[k]) as never[]), id);
}

// Insert, or merge into the duplicate: existing non-empty values are kept unless overwrite is set.
export function upsert(db: DatabaseSync, table: string, data: Row, overwrite = false): { id: number; created: boolean } {
  const existing = findExisting(db, table, data);
  if (!existing) return { id: insert(db, table, data), created: true };
  const patch: Row = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (overwrite || existing[k] === null || existing[k] === undefined || existing[k] === '') patch[k] = v;
  }
  update(db, table, Number(existing.id), patch);
  return { id: Number(existing.id), created: false };
}

export function logActivity(db: DatabaseSync, a: { agent: string; action: string; ref_table?: string; ref_id?: number; detail?: unknown; external?: boolean; run_id?: number }): void {
  db.prepare('INSERT INTO activities (agent, action, ref_table, ref_id, detail, external, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(a.agent, a.action, a.ref_table ?? null, a.ref_id ?? null, a.detail === undefined ? null : JSON.stringify(a.detail), a.external ? 1 : 0, a.run_id ?? (process.env.HE_RUN_ID ? Number(process.env.HE_RUN_ID) : null));
}

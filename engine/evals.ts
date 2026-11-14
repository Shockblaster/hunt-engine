// Practice tests for agents: seed a throwaway workspace, run the agent headless on a task, then check the
// result in code. Results are stored in the real workspace's `evals` table; a failed test after a critic
// change reverts that change.
import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Row } from './db.ts';
import { insert, logActivity } from './db.ts';
import { HOME, REPO_ROOT } from './paths.ts';
import { claudePermissionArgs, takeAutomationLock } from './schedule.ts';
import { revertChange } from './playbooks.ts';
import { resolveClaude } from './schedule.ts';

export type Check =
  | { type: 'sql'; sql: string; op: '=' | '>=' | '<=' | '>' | '<'; value: number; label: string }
  | { type: 'no_text'; sql: string; pattern: string; label: string }
  | { type: 'accuracy'; sql: string; expected: Record<string, string>; min: number; label: string }
  | { type: 'files'; dir: string; ext: string; min: number; label: string }
  | { type: 'file_no_text'; dir: string; ext: string; pattern: string; label: string };

export type Case = { name: string; track: string; task: string; seed: Record<string, Row[]>; master?: unknown; checks: Check[]; timeout_min?: number };

export function loadCases(agent: string): Case[] {
  const f = join(REPO_ROOT, 'evals', `${agent}.json`);
  if (!existsSync(f)) throw new Error(`no practice tests for ${agent} (evals/${agent}.json)`);
  return JSON.parse(readFileSync(f, 'utf8')) as Case[];
}

export function listEvalAgents(): string[] {
  const d = join(REPO_ROOT, 'evals');
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
}

function agentPrompt(agent: string): string {
  const raw = readFileSync(join(REPO_ROOT, 'agents', `${agent}.md`), 'utf8');
  return raw.replace(/^---[\s\S]*?---\s*/, '');
}

// Run every check against the throwaway workspace database and files.
export function runChecks(db: DatabaseSync, wsDir: string, checks: Check[]): { label: string; passed: boolean; detail: string; score?: number }[] {
  return checks.map((c) => {
    try {
      if (c.type === 'sql') {
        const v = Number((db.prepare(c.sql).get() as Row | undefined)?.n ?? 0);
        const ok = c.op === '=' ? v === c.value : c.op === '>=' ? v >= c.value : c.op === '<=' ? v <= c.value : c.op === '>' ? v > c.value : v < c.value;
        return { label: c.label, passed: ok, detail: `got ${v}, want ${c.op} ${c.value}` };
      }
      if (c.type === 'no_text') {
        const re = new RegExp(c.pattern, 'i');
        const hits = (db.prepare(c.sql).all() as Row[]).map((r) => String(Object.values(r)[0] ?? '')).filter((t) => re.test(t));
        return { label: c.label, passed: hits.length === 0, detail: hits.length ? `found: ${hits[0].slice(0, 160)}` : 'clean' };
      }
      if (c.type === 'accuracy') {
        const rows = db.prepare(c.sql).all() as Row[];
        const got = Object.fromEntries(rows.map((r) => [String(r.k), String(r.v ?? '')]));
        const keys = Object.keys(c.expected);
        const right = keys.filter((k) => got[k] === c.expected[k]);
        const score = keys.length ? right.length / keys.length : 0;
        const wrong = keys.filter((k) => got[k] !== c.expected[k]).map((k) => `${k}: ${got[k] || 'none'} (want ${c.expected[k]})`);
        return { label: c.label, passed: score >= c.min, score, detail: `${right.length}/${keys.length}${wrong.length ? `; wrong: ${wrong.slice(0, 4).join(', ')}` : ''}` };
      }
      const dir = join(wsDir, c.dir);
      if (c.type === 'file_no_text') {
        const re = new RegExp(c.pattern, 'i');
        const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(c.ext)) : [];
        const hit = files.find((f) => re.test(readFileSync(join(dir, f), 'utf8').replace(/<[^>]+>/g, ' ')));
        return { label: c.label, passed: files.length > 0 && !hit, detail: !files.length ? `no ${c.ext} files` : hit ? `found in ${hit}` : `clean (${files.length} file(s))` };
      }
      const n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(c.ext)).length : 0;
      return { label: c.label, passed: n >= c.min, detail: `${n} ${c.ext} file(s)` };
    } catch (e) {
      return { label: c.label, passed: false, detail: `check failed to run: ${(e as Error).message}` };
    }
  });
}

export async function runEval(realDb: DatabaseSync, realSlug: string, agent: string, opts: { caseName?: string; trigger?: string; changeId?: number } = {}): Promise<Row> {
  // An agent without practice tests cannot be checked: a critic change to it goes to the person instead of passing silently.
  if (!listEvalAgents().includes(agent)) {
    if (opts.changeId) {
      insert(realDb, 'tasks', { kind: 'user_action', title: `Review the critic's change to ${agent}`, notes: `Strategy change ${opts.changeId} has no practice test to check it. Read it on the Critic page and press Revert if it looks wrong.`, agent: 'eval' });
      logActivity(realDb, { agent: 'eval', action: 'eval.untested', detail: { agent, change: opts.changeId } });
    }
    return { agent, passed: false, untested: true, results: [], reverted: null, note: `no practice tests for ${agent}${opts.changeId ? '; the person was asked to review the change' : ''}` };
  }
  const cases = loadCases(agent).filter((c) => !opts.caseName || c.name === opts.caseName);
  if (!cases.length) return { agent, passed: false, results: [], reverted: null, note: `no practice test named ${opts.caseName}` };
  const results: Row[] = [];
  const lock = takeAutomationLock('eval');
  try {
  for (const c of cases) {
    // A separate Hunt Engine home, so the agent under test can never touch real data or send anything.
    const home = mkdtempSync(join(tmpdir(), `he-eval-${agent}-`));
    // HE_REAL_HOME keeps the guard protecting the person's real data while HE_HOME points at the throwaway home.
    const env = { ...process.env, HE_HOME: home, HE_REAL_HOME: HOME, HE_WORKSPACE: 'eval', HE_HEADLESS: '1', HE_EVAL: '1' };
    const cli = join(REPO_ROOT, 'engine', 'cli.ts');
    spawnSync(process.execPath, [cli, 'ws', 'create', 'eval', '--name', 'Practice test'], { env, encoding: 'utf8' });
    const wsDir = join(home, 'workspaces', 'eval');
    const { openDbAt } = await import('./db.ts');
    const dbFile = join(wsDir, 'db.sqlite');
    const db = openDbAt(dbFile);
    // The strategies under test: copy the real workspace's current playbooks (so a critic change is what gets tested).
    for (const pb of realDb.prepare(`SELECT track, agent, content FROM playbooks WHERE active = 1`).all() as Row[]) {
      db.prepare(`UPDATE playbooks SET active = 0 WHERE track = ? AND agent = ?`).run(String(pb.track), String(pb.agent));
      db.prepare(`INSERT INTO playbooks (track, agent, version, content, reason, created_by) VALUES (?, ?, 100, ?, 'copied for practice test', 'eval')`).run(String(pb.track), String(pb.agent), String(pb.content));
    }
    for (const [table, rows] of Object.entries(c.seed)) for (const r of rows) insert(db, table, r);
    if (c.master) {
      mkdirSync(join(wsDir, 'files', 'resume'), { recursive: true });
      writeFileSync(join(wsDir, 'files', 'resume', 'master.json'), JSON.stringify(c.master, null, 2));
    }
    db.close();
    const prompt = `PRACTICE TEST "${c.name}" for the ${agent} agent. Workspace: eval. Track: ${c.track}. Nothing you do here reaches real people.\n\nTask: ${c.task}\n\nWork exactly as your instructions say, using the he CLI with --ws eval and --agent ${agent}. When done, reply with a short summary.`;
    const claude = resolveClaude();
    const started = Date.now();
    // No MCP servers (no Gmail, browser profile or Jarvis) and only the listed tools, whatever the person's own settings say.
    const mcp = join(home, 'mcp-empty.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    const perms = claudePermissionArgs(join(home, 'permissions.json'),
      ['Bash(he:*)', 'Bash(he *)', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      ['Bash(he mail:*)', 'Bash(he approval:*)', 'Bash(he claim:*)', 'Bash(he notify:*)', 'Bash(he upgrade:*)', 'Bash(he schedule:*)', 'Bash(he tools:*)']);
    const run = spawnSync(claude.cmd, ['-p', prompt, '--append-system-prompt', agentPrompt(agent), '--strict-mcp-config', '--mcp-config', mcp, ...perms], { cwd: wsDir, env, encoding: 'utf8', timeout: (c.timeout_min ?? 10) * 60_000, shell: claude.shell, maxBuffer: 16 * 1024 * 1024 });
    const db2 = openDbAt(dbFile);
    const checks = runChecks(db2, wsDir, c.checks);
    db2.close();
    const passed = checks.every((x) => x.passed);
    const score = checks.filter((x) => x.passed).length / Math.max(1, checks.length);
    results.push({ case: c.name, passed, score, minutes: Math.round((Date.now() - started) / 6000) / 10, checks, agent_summary: (run.stdout ?? '').trim().slice(-600), workspace: home });
  }
  } finally {
    lock.release();
  }
  // Results go to the real workspace.
  for (const r of results) {
    realDb.prepare(`INSERT INTO evals (agent, case_name, passed, score, detail, trigger) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(agent, String(r.case), r.passed ? 1 : 0, Number(r.score), JSON.stringify(r.checks), opts.trigger ?? 'manual');
  }
  const allPassed = results.length > 0 && results.every((r) => r.passed);
  let reverted: Row | null = null;
  if (!allPassed && opts.changeId) {
    reverted = revertChange(realDb, opts.changeId, 'eval') as unknown as Row;
    realDb.prepare(`INSERT INTO agent_notes (from_agent, to_agent, topic, body) VALUES ('eval', 'critic', 'practice test failed', ?)`)
      .run(`Your change ${opts.changeId} to ${agent} failed its practice test and was undone: ${results.filter((r) => !r.passed).map((r) => `${r.case}: ${(r.checks as { label: string; passed: boolean; detail: string }[]).filter((c) => !c.passed).map((c) => `${c.label} (${c.detail})`).join('; ')}`).join(' | ')}`);
  }
  logActivity(realDb, { agent: 'eval', action: 'eval.run', detail: { agent, passed: allPassed, cases: results.length, reverted: Boolean(reverted) } });
  return { agent, passed: allPassed, results, reverted };
}

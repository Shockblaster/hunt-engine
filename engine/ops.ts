// Operations: health check, alerts to the person, backups, and run accounting for scheduled cycles.
import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { Row } from './db.ts';
import { logActivity, insert } from './db.ts';
import { REPO_ROOT, workspaceDir } from './paths.ts';
import { verifyRules } from './rules.ts';
import { findChrome } from './docs.ts';
import { accountFor, loadEnv, smtpAuth } from './mail.ts';
import { gosomPath } from './collect.ts';
import { resolveClaude } from './schedule.ts';

type Check = { check: string; ok: boolean; detail: string; fix?: string };

function which(cmd: string): string | null {
  const r = spawnSync(platform() === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

export function doctor(slug: string | null): Check[] {
  const out: Check[] = [];
  const node = Number(process.versions.node.split('.')[0]);
  out.push({ check: 'Node.js 24 or newer', ok: node >= 24, detail: process.versions.node, fix: 'Install Node 24 LTS from nodejs.org' });
  const chrome = findChrome();
  out.push({ check: 'Chrome or Edge (PDFs, samples)', ok: Boolean(chrome), detail: chrome ?? 'not found', fix: 'Install Google Chrome, or set CHROME_PATH' });
  const uv = which('uv');
  out.push({ check: 'uv (Python tools: Word files, Excel, JobSpy)', ok: Boolean(uv), detail: uv ?? 'not found', fix: 'Install uv: https://docs.astral.sh/uv/getting-started/installation/' });
  const claude = which('claude');
  out.push({ check: 'Claude Code', ok: Boolean(claude), detail: claude ?? 'not found', fix: 'Install Claude Code and log in' });
  if (claude) {
    let list: { stdout?: string } = {};
    try { const c = resolveClaude(); list = spawnSync(c.cmd, ['plugin', 'list'], { encoding: 'utf8', shell: c.shell, timeout: 60_000 }); } catch { /* reported below */ }
    const ok = /hunt-engine/.test(list.stdout ?? '');
    out.push({ check: 'Hunt Engine plugin installed', ok, detail: ok ? 'yes' : 'no', fix: `claude plugin marketplace add "${REPO_ROOT}" then claude plugin install hunt-engine@hunt-engine` });
  }
  const rules = verifyRules();
  out.push({ check: 'Hard rules sealed', ok: rules.ok, detail: rules.ok ? 'sealed' : String(rules.reason), fix: 'Run `he rules seal` in your own terminal' });
  out.push({ check: 'Dashboard built', ok: existsSync(join(REPO_ROOT, 'dashboard', '.next', 'BUILD_ID')), detail: '', fix: 'Run `he dashboard` (it builds on first run)' });
  out.push({ check: 'Fast Maps collector (lead research)', ok: existsSync(gosomPath()), detail: existsSync(gosomPath()) ? 'installed' : 'not installed (the browser method still works)', fix: 'Run `he tools install maps` to see what it downloads' });
  if (slug) {
    const env = loadEnv(slug);
    out.push({ check: 'Job email (your Gmail, app password)', ok: Boolean(accountFor(slug, 'job')), detail: env.JOB_EMAIL ? env.JOB_EMAIL : 'not set', fix: `Add JOB_EMAIL and JOB_EMAIL_APP_PASSWORD to ${join(workspaceDir(slug), '.env')}` });
    out.push({ check: 'Outreach email (separate Gmail)', ok: Boolean(accountFor(slug, 'freelance')), detail: env.OUTREACH_EMAIL ? env.OUTREACH_EMAIL : 'not set (needed for freelance and lead outreach only)', fix: `Add OUTREACH_EMAIL and OUTREACH_EMAIL_APP_PASSWORD to ${join(workspaceDir(slug), '.env')}` });
    const scheduled = platform() === 'win32'
      ? spawnSync('schtasks', ['/Query', '/FO', 'CSV'], { encoding: 'utf8' }).stdout?.includes(`HuntEngine-${slug}-`)
      : platform() === 'darwin' ? existsSync(join(homedir(), 'Library', 'LaunchAgents')) && readdirSync(join(homedir(), 'Library', 'LaunchAgents')).some((f) => f.startsWith(`com.huntengine.huntengine-${slug}-`)) : false;
    out.push({ check: 'Automatic runs scheduled', ok: Boolean(scheduled), detail: scheduled ? 'yes' : 'no', fix: 'Run `he schedule install`' });
    const backups = join(workspaceDir(slug), 'backups');
    const last = existsSync(backups) ? readdirSync(backups).sort().at(-1) : undefined;
    out.push({ check: 'Recent backup', ok: Boolean(last), detail: last ?? 'none yet', fix: 'Run `he backup` (the evening cycle does this daily)' });
  }
  return out;
}

// Copy of the database (consistent, even while in use) plus cleanup of old backups and logs.
export function backup(db: DatabaseSync, slug: string, keep = 14): { file: string; kept: number; logs_removed: number } {
  const dir = join(workspaceDir(slug), 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const file = join(dir, `db-${stamp}.sqlite`);
  rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir).filter((f) => f.startsWith('db-')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) rmSync(join(dir, f), { force: true });
  let logsRemoved = 0;
  const logs = join(workspaceDir(slug), 'logs');
  if (existsSync(logs)) for (const f of readdirSync(logs)) {
    if (Date.now() - statSync(join(logs, f)).mtimeMs > 30 * 86_400_000) { rmSync(join(logs, f), { force: true }); logsRemoved++; }
  }
  logActivity(db, { agent: 'ops', action: 'backup', detail: { file } });
  return { file, kept: Math.min(all.length, keep), logs_removed: logsRemoved };
}

// Urgent news for the person: always a dashboard task; an email to themselves when their Gmail is set up.
// Voice (Jarvis) is spoken by the agent through the Jarvis tool; this tells it to.
export async function notify(db: DatabaseSync, slug: string, title: string, body: string): Promise<Row> {
  const task = insert(db, 'tasks', { kind: 'user_action', title, notes: body, agent: 'inbox' });
  const env = loadEnv(slug);
  const acc = accountFor(slug, 'job') ?? accountFor(slug, 'freelance');
  const to = env.NOTIFY_EMAIL || acc?.address;
  let emailed = false;
  let error: string | undefined;
  const recent = Number((db.prepare(`SELECT count(*) AS n FROM activities WHERE action = 'notify' AND json_extract(detail, '$.emailed') = 1 AND at >= datetime('now', '-1 hour')`).get() as Row).n);
  if (recent >= 6) error = 'six alert emails already this hour; this one is on the dashboard only';
  if (acc && to && !process.env.HE_EVAL && recent < 6) {
    try {
      const nodemailer = (await import('nodemailer')).default;
      await nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: smtpAuth(acc) })
        .sendMail({ from: acc.address, to, subject: `[Hunt Engine] ${title}`, text: `${body}\n\nOpen the dashboard: http://127.0.0.1:3010` });
      emailed = true;
    } catch (e) { error = (e as Error).message; }
  }
  const settings = workspaceNotify(slug);
  logActivity(db, { agent: 'inbox', action: 'notify', ref_table: 'tasks', ref_id: task, detail: { title, emailed } });
  return { task_id: task, emailed, email_error: error ?? null, jarvis: settings.jarvis ? `Also call mcp__jarvis__tell_user with: "${title}. ${body}"` : 'Jarvis voice alerts are off for this workspace' };
}

export function workspaceNotify(slug: string): { jarvis: boolean } {
  const f = join(workspaceDir(slug), 'settings.json');
  if (!existsSync(f)) return { jarvis: false };
  const s = JSON.parse(readFileSync(f, 'utf8')) as { notify?: { jarvis?: boolean } };
  return { jarvis: Boolean(s.notify?.jarvis) };
}

// The Jarvis MCP server as configured in the person's Claude Code user settings, for scheduled runs.
export function jarvisServer(): Record<string, unknown> | null {
  const f = join(homedir(), '.claude.json');
  if (!existsSync(f)) return null;
  const cfg = JSON.parse(readFileSync(f, 'utf8')) as { mcpServers?: Record<string, unknown> };
  return (cfg.mcpServers?.jarvis as Record<string, unknown>) ?? null;
}


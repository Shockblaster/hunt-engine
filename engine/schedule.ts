import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, unlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { HOME, REPO_ROOT, workspaceDir, workspaceTracks, TRACK_SKILL } from './paths.ts';
import { openDb } from './db.ts';
import { jarvisServer, workspaceNotify } from './ops.ts';

// Times are IST and sit inside the 09:30-19:00 send window, so every cycle that sends can actually send.
export const CYCLES: { cycle: string; when: { hour: number; minute: number }[] | 'every3h'; weekday?: number; what: string }[] = [
  { cycle: 'morning', when: [{ hour: 9, minute: 40 }], what: 'discover, score, tailor, QA, apply and send' },
  { cycle: 'inbox', when: 'every3h', what: 'read replies and portal inboxes, classify, alert (08:00 to 22:00)' },
  { cycle: 'evening', when: [{ hour: 18, minute: 15 }], what: 'follow-ups and the daily critic' },
  { cycle: 'weekly', when: [{ hour: 11, minute: 0 }], weekday: 0, what: 'deep critic, experiments, intake refresh' },
];
const INBOX_HOURS_IST = [8, 11, 14, 17, 20];

const SKILLS = ['job-hunt', 'freelance-hunt', 'lead-research'];
const taskName = (slug: string, skill: string, cycle: string) => `HuntEngine-${slug}-${skill}-${cycle}`;
const cli = join(REPO_ROOT, 'engine', 'cli.ts');

// The OS scheduler uses the machine's clock; convert IST to local so a laptop abroad still runs at Indian hours.
export function istToLocal(hour: number, minute: number): { hour: number; minute: number } {
  const now = new Date();
  const ist = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute) - 330 * 60_000);
  return { hour: ist.getHours(), minute: ist.getMinutes() };
}

// ---- One cycle at a time per machine: a lock file with the pid, cleared if that process is gone.
const LOCK = join(HOME, 'cycle.lock');

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireLock(label: string): boolean {
  mkdirSync(HOME, { recursive: true });
  if (existsSync(LOCK)) {
    const held = JSON.parse(readFileSync(LOCK, 'utf8')) as { pid: number; label: string; at: string };
    const ageH = (Date.now() - new Date(held.at).getTime()) / 3_600_000;
    if (pidAlive(held.pid) && ageH < 3) return false;
    unlinkSync(LOCK);
  }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }), { flag: 'wx' });
  return true;
}

export function releaseLock(): void {
  if (existsSync(LOCK)) rmSync(LOCK);
}

// While agents run unattended (a scheduled cycle or a practice test), approvals by chat are refused: an agent
// could otherwise approve its own work. The lock is a file in the Hunt Engine home with the owner's pid.
const AUTO_LOCK = join(HOME, 'automation.lock');
export function takeAutomationLock(label: string): { release: () => void } {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(AUTO_LOCK, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }));
  return { release: () => { try { const h = JSON.parse(readFileSync(AUTO_LOCK, 'utf8')) as { pid: number }; if (h.pid === process.pid) rmSync(AUTO_LOCK); } catch { /* already gone */ } } };
}
export function automationRunning(): string | null {
  for (const f of [AUTO_LOCK, LOCK]) {
    if (!existsSync(f)) continue;
    try {
      const h = JSON.parse(readFileSync(f, 'utf8')) as { pid: number; label: string; at: string };
      if (pidAlive(h.pid) && Date.now() - new Date(h.at).getTime() < 3 * 3_600_000) return h.label;
    } catch { /* unreadable lock: ignore */ }
  }
  return null;
}

// Finds the claude executable itself, so arguments are passed without a shell re-splitting them.
export function resolveClaude(): { cmd: string; shell: boolean } {
  if (process.env.HE_CLAUDE_BIN) return { cmd: process.env.HE_CLAUDE_BIN, shell: false };
  if (platform() !== 'win32') return { cmd: 'claude', shell: false };
  const found = (spawnSync('where', ['claude'], { encoding: 'utf8' }).stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const exe = found.find((f) => /\.exe$/i.test(f));
  if (exe) return { cmd: exe, shell: false };
  const shim = found.find((f) => /\.cmd$/i.test(f));
  if (shim) {
    const pkg = join(shim, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(pkg)) return { cmd: pkg, shell: false };
  }
  throw new Error('claude.exe not found; set HE_CLAUDE_BIN to its full path');
}

// Runs one skill cycle headlessly through Claude Code and waits for it.
export function runCycle(slug: string, skill: string, cycle: string): number {
  if (!SKILLS.includes(skill)) throw new Error(`unknown skill ${skill}`);
  if (!acquireLock(`${slug}/${skill}/${cycle}`)) {
    console.log('another cycle is running; skipping this one');
    return 0;
  }
  try {
    const logs = join(workspaceDir(slug), 'logs');
    mkdirSync(logs, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = openSync(join(logs, `${stamp}-${skill}-${cycle}.log`), 'a');
    const prompt = `/hunt-engine:${skill} cycle=${cycle} workspace=${slug} headless=true`;
    // Each workspace gets its own Playwright browser profile, so one person's portal logins never mix with another's.
    const mcp = join(workspaceDir(slug), 'mcp.json');
    const servers: Record<string, unknown> = { playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--user-data-dir', join(workspaceDir(slug), 'browser')] } };
    // Voice alerts: the person's own Jarvis server, when this workspace has it switched on.
    const jarvis = workspaceNotify(slug).jarvis ? jarvisServer() : null;
    if (jarvis) servers.jarvis = jarvis;
    writeFileSync(mcp, JSON.stringify({ mcpServers: servers }, null, 2));
    const claude = resolveClaude();
    const extra = jarvis ? ['mcp__jarvis__tell_user', 'mcp__jarvis__ask_user'] : [];
    const args = claudePermissionArgs(join(workspaceDir(slug), 'permissions.json'), [...SCHEDULED_ALLOW, ...extra], SCHEDULED_DENY);
    const auto = takeAutomationLock(`${slug}/${skill}/${cycle}`);
    const started = Date.now();
    const res = spawnSync(claude.cmd, ['-p', prompt, '--output-format', 'json', '--mcp-config', mcp, '--strict-mcp-config', ...args], {
      cwd: workspaceDir(slug),
      env: { ...process.env, HE_WORKSPACE: slug, HE_HEADLESS: '1' },
      encoding: 'utf8',
      shell: claude.shell,
      timeout: 2 * 3_600_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    writeSync(out, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
    // Time and cost of every scheduled run, for the dashboard's Health page.
    let parsed: { total_cost_usd?: number; num_turns?: number; is_error?: boolean; result?: string } = {};
    try { parsed = JSON.parse(String(res.stdout ?? '').trim().split('\n').pop() ?? '{}'); } catch { /* not JSON: the log has the details */ }
    const db = openDb(slug);
    db.prepare(`INSERT INTO runs (skill, cycle, agent, status, summary, counts, started_at, ended_at) VALUES (?, ?, 'scheduler', ?, ?, ?, datetime(?), datetime('now'))`)
      .run(skill, cycle, res.status === 0 && !parsed.is_error ? 'ok' : 'failed', String(parsed.result ?? res.error?.message ?? '').slice(0, 300), JSON.stringify({ cost_usd: parsed.total_cost_usd ?? null, turns: parsed.num_turns ?? null, minutes: Math.round((Date.now() - started) / 6000) / 10 }), new Date(started).toISOString());
    db.close();
    auto.release();
    return res.status ?? 1;
  } finally {
    releaseLock();
  }
}

// Scheduled runs may use the he CLI, files and the browser, but never decide approvals or reseal the rules.
export const SCHEDULED_ALLOW = ['Bash(he:*)', 'Bash(he *)', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'Agent', 'mcp__playwright__*'];
export const SCHEDULED_DENY = ['Bash(he approval decide:*)', 'Bash(*approval*decide*)', 'Bash(he rules seal:*)', 'Bash(he schedule:*)', 'Bash(he upgrade:*)', 'Bash(he tools:*)'];

// Permissions go in a settings file, not command-line flags: settings rules also bind the subagents a conductor
// starts, while --allowedTools does not reach them (found in the 50-lead pilot). dontAsk means anything not
// allowed is refused rather than approved on the fly, whatever the person's own default mode is.
export function claudePermissionArgs(file: string, allow: string[], deny: string[]): string[] {
  writeFileSync(file, JSON.stringify({ permissions: { allow, deny } }, null, 2));
  return ['--permission-mode', 'dontAsk', '--settings', file];
}

export function defaultClaudeArgs(file: string): string[] {
  return claudePermissionArgs(file, SCHEDULED_ALLOW, SCHEDULED_DENY);
}

// Only the list of skills is read from a workspace's settings; nothing in it can change what program runs.
type WsSettings = { skills?: string[] }; // notify settings are read by ops.ts
export function workspaceSettings(slug: string): WsSettings {
  const f = join(workspaceDir(slug), 'settings.json');
  if (!existsSync(f)) return {};
  const s = JSON.parse(readFileSync(f, 'utf8')) as WsSettings;
  return { skills: (s.skills ?? []).filter((k) => SKILLS.includes(k)) };
}

// A workspace's own settings win; otherwise its tracks decide; a workspace with neither is open to every skill.
const skillsFor = (slug: string) => {
  const s = workspaceSettings(slug).skills;
  if (s && s.length) return s;
  const tracks = workspaceTracks(slug);
  return tracks ? tracks.map((t) => TRACK_SKILL[t]) : SKILLS;
};
const cyclesFor = (skill: string) => CYCLES.filter((c) => !(skill === 'lead-research' && c.cycle === 'inbox')); // lead research sends nothing

// ---- Install into the OS scheduler: Task Scheduler on Windows, launchd on macOS.
export function installSchedule(slug: string, skills = skillsFor(slug)): string[] {
  const done: string[] = [];
  for (const skill of skills) for (const c of cyclesFor(skill)) {
    const name = taskName(slug, skill, c.cycle);
    const command = [process.execPath, cli, 'cycle', skill, c.cycle, '--ws', slug];
    if (platform() === 'win32') installWindows(name, command, c);
    else if (platform() === 'darwin') installMac(name, command, c);
    else throw new Error('scheduling supports Windows and macOS; on Linux add the commands from `he schedule show` to cron');
    done.push(name);
  }
  return done;
}

function installWindows(name: string, command: string[], c: (typeof CYCLES)[number]): void {
  const tr = command.map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p)).join(' ');
  const base = ['/Create', '/F', '/TN', name, '/TR', tr];
  const first = istToLocal(INBOX_HOURS_IST[0], 0);
  const timing = c.when === 'every3h'
    ? ['/SC', 'HOURLY', '/MO', '3', '/ST', hm(first), '/DU', '14:00'] // 08:00 to 22:00 IST, not through the night
    : c.weekday !== undefined
      ? ['/SC', 'WEEKLY', '/D', 'SUN', '/ST', hm(istToLocal(c.when[0].hour, c.when[0].minute))]
      : ['/SC', 'DAILY', '/ST', hm(istToLocal(c.when[0].hour, c.when[0].minute))];
  const r = spawnSync('schtasks', [...base, ...timing], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`schtasks failed for ${name}: ${r.stderr || r.stdout}`);
}

function installMac(name: string, command: string[], c: (typeof CYCLES)[number]): void {
  const label = `com.huntengine.${name.toLowerCase()}`;
  const intervals = c.when === 'every3h'
    ? INBOX_HOURS_IST.map((h) => istToLocal(h, 0)).map((t) => ({ Hour: t.hour, Minute: t.minute }))
    : c.when.map((w) => istToLocal(w.hour, w.minute)).map((t) => ({ Hour: t.hour, Minute: t.minute, ...(c.weekday !== undefined ? { Weekday: c.weekday } : {}) }));
  const dict = (o: Record<string, number>) => `<dict>${Object.entries(o).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${command.map((p) => `<string>${esc(p)}</string>`).join('')}</array>
<key>StartCalendarInterval</key><array>${intervals.map(dict).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH ?? '')}</string></dict>
</dict></plist>`;
  const file = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  spawnSync('launchctl', ['unload', file]);
  writeFileSync(file, plist);
  const r = spawnSync('launchctl', ['load', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`launchctl load failed for ${label}: ${r.stderr}`);
}

export function removeSchedule(slug: string): string[] {
  const removed: string[] = [];
  for (const skill of new Set([...SKILLS, ...skillsFor(slug)])) for (const c of CYCLES) {
    const name = taskName(slug, skill, c.cycle);
    if (platform() === 'win32') {
      if (spawnSync('schtasks', ['/Delete', '/F', '/TN', name]).status === 0) removed.push(name);
    } else if (platform() === 'darwin') {
      const file = join(homedir(), 'Library', 'LaunchAgents', `com.huntengine.${name.toLowerCase()}.plist`);
      if (existsSync(file)) { spawnSync('launchctl', ['unload', file]); rmSync(file); removed.push(name); }
    }
  }
  return removed;
}

export function showSchedule(slug: string): { name: string; when: string; what: string; command: string }[] {
  return skillsFor(slug).flatMap((skill) => cyclesFor(skill).map((c) => ({
    name: taskName(slug, skill, c.cycle),
    when: c.when === 'every3h' ? `${INBOX_HOURS_IST.map((h) => `${h}:00`).join(', ')} IST` : `${c.weekday !== undefined ? 'Sundays ' : 'daily '}${hm(c.when[0])} IST`,
    what: c.what,
    command: `node ${cli} cycle ${skill} ${c.cycle} --ws ${slug}`,
  })));
}

export function spawnDetached(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  // Only npm needs a shell on Windows (npm.cmd); a shell would split paths with spaces, like Chrome's.
  spawn(cmd, args, { cwd, env: env ?? process.env, detached: true, stdio: 'ignore', shell: platform() === 'win32' && /(^|[\\/])npm(\.cmd)?$/i.test(cmd) }).unref();
}

const hm = (w: { hour: number; minute: number }) => `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;

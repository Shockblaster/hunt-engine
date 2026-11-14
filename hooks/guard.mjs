// Blocks agents from changing what keeps them honest. Always: the hard rules and their seal, workspace databases,
// passwords and the dashboard decision key. In scheduled (headless) runs also: the engine, skills, agents, hooks,
// workspace settings, and shell commands that decide approvals, reseal rules or touch the protected files.
// The person changes rules in their own editor and reseals with `he rules seal`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();
const headless = Boolean(process.env.HE_HEADLESS);
// Every Hunt Engine home that could hold real data: the default, the configured one, and the real one during practice tests.
const homes = [...new Set([join(homedir(), '.hunt-engine'), process.env.HE_HOME, process.env.HE_REAL_HOME].filter(Boolean).map(norm))];
const repo = norm(process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dirname, '..'));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const R = esc(repo);

const always = [[new RegExp(`${R}/rules/`), 'the hard rules and limits can only be changed by the person, then resealed with `he rules seal`']];
const scheduled = [
  [new RegExp(`${R}/(engine|skills|agents|hooks|references|dashboard|evals)/`), 'scheduled runs cannot change the engine, skills or agents'],
  [new RegExp(`${R}/package\\.json$`), 'scheduled runs cannot change the engine'],
];
for (const h of homes) {
  const H = esc(h);
  always.push(
    [new RegExp(`${H}/.*\\.sqlite(-wal|-shm|-journal)?$`), 'workspace databases are written only through the `he` CLI'],
    [new RegExp(`${H}/.*\\.env$`), 'the workspace .env holds passwords; the person edits it themselves'],
    [new RegExp(`${H}/.*\\.oauth-[a-z]+\\.json$`), 'Google sign-in tokens are written only by he mail connect'],
    [new RegExp(`${H}/\\.decider-key$`), 'the decision key belongs to the dashboard'],
    [new RegExp(`${H}/(config\\.json|automation\\.lock|cycle\\.lock)$`), 'use `he` commands for workspaces and runs'],
  );
  scheduled.push([new RegExp(`${H}/workspaces/[^/]+/(settings|mcp|permissions)\\.json$`), 'scheduled runs cannot change workspace settings']);
}

const deny = (why) => { process.stderr.write(`Hunt Engine guard: ${why}.`); process.exit(2); };
const tool = String(input.tool_name ?? '');
const ti = input.tool_input ?? {};

// The decision key is never read by any agent, in any mode, by any tool.
const everything = norm(JSON.stringify(ti)).replace(/["'`^]/g, '');
if (/decider[-_ ]?k|decider-ke\?|decider\*|he_decider_key/.test(everything)) deny('the decision key belongs to the dashboard');

if (tool === 'Bash' || tool === 'PowerShell') {
  if (!headless) process.exit(0);
  // Strip quotes and escapes so `he approval 'decide'` or `he "rules" seal` are seen for what they are.
  const cmd = norm(ti.command).replace(/["'`^\\]/g, '').replace(/\s+/g, ' ');
  if (/\bapproval\b.*\bdecide\b|\brules\b.*\bseal\b|\bschedule\b.*\b(install|remove)\b|\bupgrade\b|\btools\b.*\binstall\b/.test(cmd)) deny('scheduled runs cannot decide approvals, reseal rules, change the schedule or install software');
  if (/\bhe_(headless|home|real_home|eval)\s*=/.test(cmd)) deny('scheduled runs cannot change Hunt Engine environment settings');
  const touchesProtected = cmd.includes('/rules/') || /\.sqlite|\.env\b|settings\.json|mcp\.json|permissions\.json|config\.json|\.lock\b/.test(cmd);
  if (touchesProtected && /(>|\btee\b|\bcp\b|\bmv\b|\brm\b|\bdel\b|sed\s+-i|\bdd\b|\bchmod\b|writefile|set-content|out-file|copy-item|move-item|remove-item|new-item)/.test(cmd)) deny('scheduled runs cannot write to protected files from the shell');
  process.exit(0);
}

const path = norm(ti.file_path ?? ti.notebook_path ?? ti.path);
if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') process.exit(0);
if (!path) process.exit(0);
for (const [re, why] of always) if (re.test(path)) deny(why);
if (headless) for (const [re, why] of scheduled) if (re.test(path)) deny(why);
process.exit(0);

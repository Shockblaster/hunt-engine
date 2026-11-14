import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOME = process.env.HE_HOME ?? join(homedir(), '.hunt-engine');
const CONFIG = join(HOME, 'config.json');

// `tracks` says what a workspace is for (job, freelance, lead). Without it a workspace is open to every skill.
type Config = { current: string | null; workspaces: Record<string, { name: string; created_at: string; tracks?: string[] }> };

export const TRACK_SKILL: Record<string, string> = { job: 'job-hunt', freelance: 'freelance-hunt', lead: 'lead-research' };
export function parseTracks(v: string): string[] {
  const list = v.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((t) => !TRACK_SKILL[t]);
  if (bad.length || !list.length) throw new Error(`tracks are job, freelance and lead (comma-separated); got "${v}"`);
  return [...new Set(list)];
}
export function workspaceTracks(slug: string): string[] | null {
  const t = readConfig().workspaces[slug]?.tracks;
  return t && t.length ? t : null;
}
// Which workspace a command ran on, and how it was chosen. "current" means nobody named it.
export function workspaceSource(flag?: string): 'flag' | 'env' | 'current' {
  return flag ? 'flag' : process.env.HE_WORKSPACE ? 'env' : 'current';
}

export function readConfig(): Config {
  if (!existsSync(CONFIG)) return { current: null, workspaces: {} };
  return JSON.parse(readFileSync(CONFIG, 'utf8')) as Config;
}

export function writeConfig(cfg: Config): void {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

// A random key only the dashboard server reads; the CLI accepts dashboard decisions only with it.
export function deciderKey(): string {
  const f = join(HOME, '.decider-key');
  if (!existsSync(f)) {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(f, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(f, 'utf8').trim();
}

export function workspaceDir(slug: string): string {
  return join(HOME, 'workspaces', slug);
}

// --ws flag, then HE_WORKSPACE, then the current workspace in config.
export function resolveWorkspace(flag?: string): string {
  const slug = flag ?? process.env.HE_WORKSPACE ?? readConfig().current;
  if (!slug) throw new Error('No workspace. Run: he ws create <slug> --name "<Person>"');
  if (!existsSync(workspaceDir(slug))) throw new Error(`Workspace "${slug}" does not exist`);
  return slug;
}

export function ensureWorkspaceDirs(slug: string): void {
  for (const sub of ['files', 'files/resumes', 'files/letters', 'files/samples', 'files/snapshots', 'files/exports', 'browser']) {
    mkdirSync(join(workspaceDir(slug), sub), { recursive: true });
  }
}

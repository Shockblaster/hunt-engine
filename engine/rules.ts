import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.ts';

const RULES_DIR = join(REPO_ROOT, 'rules');
const SEALED = ['hard-rules.md', 'limits.json'];
const SEAL_FILE = join(RULES_DIR, '.seal');

export type Limits = {
  min_fit: number;
  big_company: { employees_at_least: number; listed: boolean; unicorn: boolean; mnc: boolean; brand: boolean; dream_list: boolean };
  caps_per_day: Record<string, number>;
  warmup: { applies_to: string[]; ramp: number[] };
  linkedin_notes_per_month: number;
  max_follow_ups: number;
  follow_up_days: number[];
  send_window_ist: [string, string];
  min_seconds_between_sends: number;
};

export function rulesDigest(dir = RULES_DIR): string {
  const h = createHash('sha256');
  // Line endings are normalised so a git checkout on Windows and macOS gives the same digest.
  for (const f of SEALED) h.update(f).update(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex');
}

export function verifyRules(dir = RULES_DIR): { ok: boolean; reason?: string } {
  const seal = join(dir, '.seal');
  if (!existsSync(seal)) return { ok: false, reason: 'rules are not sealed (run `he rules seal` in a terminal)' };
  const want = readFileSync(seal, 'utf8').trim();
  return want === rulesDigest(dir) ? { ok: true } : { ok: false, reason: 'hard rules or limits changed since they were sealed' };
}

// Sealing needs an interactive terminal, so a headless scheduled run (or an agent) cannot loosen the rules.
export function sealRules(interactive: boolean): string {
  if (!interactive) throw new Error('`he rules seal` must be run by a person in an interactive terminal');
  const digest = rulesDigest();
  writeFileSync(SEAL_FILE, `${digest}\n`);
  return digest;
}

let cached: Limits | null = null;
export function limits(): Limits {
  cached ??= JSON.parse(readFileSync(join(RULES_DIR, 'limits.json'), 'utf8')) as Limits;
  return cached;
}

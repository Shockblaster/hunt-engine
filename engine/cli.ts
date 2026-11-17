#!/usr/bin/env node
// `he`: the only way agents read and write a workspace. Every command prints JSON.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, upsert, update, insert, logActivity, TABLES, columns, findExisting } from './db.ts';
import type { Row } from './db.ts';
import { readConfig, writeConfig, workspaceDir, ensureWorkspaceDirs, resolveWorkspace, REPO_ROOT, deciderKey } from './paths.ts';
import { normalizeDomain, normalizePhone, emailSyntax, hasMx, guessEmails, slugKey } from './normalize.ts';
import { classifyTier } from './tier.ts';
import { combineFit } from './score.ts';
import { gate, parseUtc, requestApproval, contentHash, isDryRun, neverList } from './gate.ts';
import { claim, release } from './claim.ts';
import { parseTracks, workspaceTracks, workspaceSource, TRACK_SKILL } from './paths.ts';
import { usage } from './help.ts';
import { verifyRules, sealRules, limits } from './rules.ts';
import { activePlaybook, setPlaybook, revertChange, seedPlaybooks } from './playbooks.ts';
import { installSchedule, removeSchedule, showSchedule, runCycle } from './schedule.ts';
import { sendMessage, syncInbox, dueFollowUps } from './mail.ts';

const { values: flags, positionals: pos } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    ws: { type: 'string' }, json: { type: 'string' }, file: { type: 'string' }, where: { type: 'string', multiple: true },
    limit: { type: 'string' }, agent: { type: 'string' }, name: { type: 'string' }, reason: { type: 'string' },
    note: { type: 'string' }, via: { type: 'string' }, overwrite: { type: 'boolean' }, status: { type: 'string' },
    ref: { type: 'string' }, summary: { type: 'string' }, topic: { type: 'string' }, body: { type: 'string' },
    from: { type: 'string' }, to: { type: 'string' }, skill: { type: 'string' }, cycle: { type: 'string' },
    out: { type: 'string' }, order: { type: 'string' }, campaign: { type: 'string' }, track: { type: 'string' },
    'dry-run': { type: 'boolean' }, max: { type: 'string' }, min: { type: 'string' },
    query: { type: 'string', multiple: true }, localities: { type: 'string' }, pins: { type: 'string' }, save: { type: 'boolean' }, include: { type: 'string' }, exclude: { type: 'string' }, emails: { type: 'boolean' }, depth: { type: 'string' }, format: { type: 'string' }, yes: { type: 'boolean' }, location: { type: 'string' },
    region: { type: 'string' }, 'max-team': { type: 'string' }, org: { type: 'string' }, person: { type: 'string' }, dimension: { type: 'string' }, conclude: { type: 'boolean' },
    case: { type: 'string' }, change: { type: 'string' }, trigger: { type: 'string' },
    kind: { type: 'string' }, phone: { type: 'string' },
    all: { type: 'boolean' }, help: { type: 'boolean' }, h: { type: 'boolean', short: 'h' },
    full: { type: 'boolean' }, opp: { type: 'string' }, app: { type: 'string' }, paper: { type: 'string' }, match: { type: 'string' }, loc: { type: 'string' }, since: { type: 'string' }, term: { type: 'string' }, location: { type: 'string' }, sites: { type: 'string' },
  },
});

const out = (v: unknown) => console.log(JSON.stringify(v, null, 2));
class Handled extends Error {}
// Throwing (instead of process.exit) lets open sockets close cleanly; main() turns it into exit code 1.
const fail = (msg: string): never => { console.error(JSON.stringify({ error: msg })); throw new Handled(msg); };
const agent = () => String(flags.agent ?? process.env.HE_AGENT ?? 'conductor');

function payload(): Row | Row[] {
  const raw = flags.file ? readFileSync(String(flags.file), 'utf8') : flags.json ? String(flags.json) : fail('pass --json \'{...}\' or --file path.json');
  try { return JSON.parse(raw) as Row | Row[]; } catch (e) { return fail(`invalid JSON: ${(e as Error).message}`); }
}

function ref(): { table: string; id: number } {
  const r = String(flags.ref ?? fail('pass --ref table:id'));
  const [table, id] = r.split(':');
  if (!table || !Number(id)) fail(`bad --ref ${r}`);
  return { table, id: Number(id) };
}

function whereClause(): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  for (const w of (flags.where as string[] | undefined) ?? []) {
    const m = /^([a-z_]+)(=|!=|>=|<=|>|<|~)(.*)$/.exec(w);
    if (!m) fail(`bad --where ${w} (use col=value, col~text for LIKE)`);
    const [, col, op, val] = m!;
    if (op === '~') { parts.push(`${col} LIKE ?`); args.push(`%${val}%`); }
    else if (val === 'null') parts.push(op === '!=' ? `${col} IS NOT NULL` : `${col} IS NULL`);
    else { parts.push(`${col} ${op} ?`); args.push(val); }
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

// Organizations and people get normalised on the way in, so dedupe works whatever the agent passes.
function prepare(db: DatabaseSync, table: string, r: Row, isNew = true): Row {
  const row = { ...r };
  if (table === 'organizations') {
    row.domain ??= normalizeDomain((row.website as string) ?? null);
    if (row.domain) row.domain = normalizeDomain(String(row.domain));
    if (row.phone && !row.phone_e164) row.phone_e164 = normalizePhone(String(row.phone)).e164;
    // Tier always comes from the classifier, never from what an agent passes.
    delete row.tier;
    delete row.tier_reasons;
    if (isNew) {
      const t = classifyTier(row as never, dreamList(db));
      row.tier = t.tier;
      row.tier_reasons = t.reasons;
    }
  }
  if (table === 'people') {
    if (row.email) {
      const s = emailSyntax(String(row.email));
      row.email = s.normalized;
      if (!s.valid) row.email_status = 'invalid';
    }
    if (row.phone && !row.phone_e164) {
      const p = normalizePhone(String(row.phone));
      row.phone_e164 = p.e164;
      row.phone_type ??= p.type;
    }
  }
  if (isNew && table === 'opportunities' && !row.dedupe_key) {
    row.dedupe_key = row.url ? String(row.url).split('?')[0].toLowerCase() : slugKey(String(row.track), String(row.organization_id ?? ''), String(row.title));
  }
  if (isNew && (table === 'organizations' || table === 'people') && !row.source_url) fail(`${table}: source_url is required (hard rule 15)`);
  return row;
}

const OUT_STATUSES = ['drafted', 'queued', 'cancelled', 'failed'];
const APP_STATUSES = ['draft', 'failed', 'withdrawn'];

// What agents may not write directly. Sending, submitting, approving, scoring and tiering each have one way in.
function guardWrite(table: string, row: Row, existing?: Row): Row {
  for (const k of ['sent_at', 'submitted_at', 'due_at', 'done_at', 'posted_at']) {
    if (row[k] == null || row[k] === '') continue;
    const d = parseUtc(row[k]);
    if (Number.isNaN(d.getTime())) fail(`${k} is not a date: ${row[k]}`);
    row[k] = k === 'posted_at' ? d.toISOString().slice(0, 10) : d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (table === 'opportunities') {
    if ('fit_score' in row || 'fit_reasons' in row) fail('fit scores are saved with `he score --opp <id> --json ...`');
    delete row.tier;
  }
  if (table === 'people') {
    if (existing?.opt_out && 'opt_out' in row && !row.opt_out) fail('an opt-out cannot be undone by an agent');
    if (existing?.email_status === 'bounced' && row.email_status && row.email_status !== 'bounced') fail('a bounced address stays bounced');
  }
  if (table === 'messages') {
    const dir = row.direction ?? existing?.direction;
    if (dir === 'out') {
      if (existing && ['sent', 'bounced'].includes(String(existing.status))) fail('a sent message cannot be edited');
      if (existing?.status === 'pending_review' && 'status' in row) fail('this message is waiting for the person; only an approval moves it');
      if (row.status && !OUT_STATUSES.includes(String(row.status))) fail(`agents may set outbound messages to ${OUT_STATUSES.join(', ')}; sending goes through \`he mail send\` or \`he claim\``);
      for (const k of ['sent_at', 'external_id', 'account']) if (k in row) fail(`${k} is set by the sender, not by agents`);
    } else if (dir === 'in') {
      if (row.status && row.status !== 'received') fail('inbound messages have status received');
    }
  }
  if (table === 'experiments' && existing) {
    if (Object.keys(row).some((k) => k !== 'status') || !['stopped'].includes(String(row.status))) fail('an experiment can only be stopped; results are written by `he experiment check <id> --conclude`');
  }
  if (table === 'experiments' && !existing && (row.result || (row.status && row.status !== 'running'))) fail('new experiments start as running with no result');
  if (table === 'applications') {
    if (existing && ['submitted'].includes(String(existing.status))) fail('a submitted application cannot be edited');
    if (existing?.status === 'pending_review' && 'status' in row) fail('this application is waiting for the person; only an approval moves it');
    if (row.status && !APP_STATUSES.includes(String(row.status))) fail(`agents may set applications to ${APP_STATUSES.join(', ')}; submitting goes through \`he claim\``);
    if ('submitted_at' in row) fail('submitted_at is set by `he claim`');
  }
  return row;
}

function applyUnsubscribe(db: DatabaseSync, messageId: number): void {
  const m = db.prepare('SELECT person_id, to_address FROM messages WHERE id = ?').get(messageId) as Row;
  if (m.to_address) db.prepare(`INSERT OR IGNORE INTO suppression (kind, value, reason) VALUES ('email', ?, 'asked not to be contacted')`).run(String(m.to_address).toLowerCase());
  if (m.person_id) db.prepare('UPDATE people SET opt_out = 1 WHERE id = ?').run(Number(m.person_id));
}

function dreamList(db: DatabaseSync): string[] {
  const p = db.prepare(`SELECT data FROM profiles WHERE track = 'job' ORDER BY version DESC LIMIT 1`).get() as Row | undefined;
  if (!p) return [];
  const data = JSON.parse(String(p.data)) as { dream_list?: string[] };
  return data.dream_list ?? [];
}

function status(db: DatabaseSync, slug: string): Row {
  const count = (sql: string, ...a: string[]) => Number((db.prepare(sql).get(...a) as Row).n);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  // A run still marked running long after it started was cut off (a crash, a usage limit, a closed terminal).
  const stale = db.prepare(`SELECT id, skill, cycle, agent, started_at FROM runs WHERE status = 'running' AND datetime(started_at) < datetime('now', '-6 hours') ORDER BY id`).all() as Row[];
  return {
    workspace: slug,
    // How the workspace was chosen. "current" means nobody named it: pass --ws when more than one workspace exists.
    workspace_from: workspaceSource(flags.ws as string | undefined),
    tracks: workspaceTracks(slug) ?? 'any',
    dry_run: isDryRun(db),
    never_list: neverList(db),
    stale_runs: stale.map((r) => ({ ...r, note: `still marked running; close it with: he run end ${r.id} --status partial --summary "..."` })),
    rules: verifyRules(),
    counts: Object.fromEntries(['organizations', 'people', 'opportunities', 'applications', 'messages', 'tasks', 'activities'].map((t) => [t, count(`SELECT count(*) AS n FROM ${t}`)])),
    pending_approvals: db.prepare(`SELECT id, ref_table, ref_id, summary, reason, requested_at FROM approvals WHERE status = 'pending' ORDER BY requested_at`).all(),
    decided_not_actioned: db.prepare(`SELECT a.id, a.ref_table, a.ref_id, a.status, a.note FROM approvals a
      LEFT JOIN applications ap ON a.ref_table = 'applications' AND ap.id = a.ref_id
      LEFT JOIN messages m ON a.ref_table = 'messages' AND m.id = a.ref_id
      WHERE a.status = 'approved' AND (ap.status = 'pending_review' OR m.status = 'pending_review')`).all(),
    tasks_due: db.prepare(`SELECT id, kind, title, due_at, ref_table, ref_id FROM tasks WHERE status = 'open' AND (due_at IS NULL OR due_at <= ?) ORDER BY due_at LIMIT 50`).all(now),
    open_notes: db.prepare(`SELECT id, from_agent, to_agent, topic, body FROM agent_notes WHERE status = 'open' ORDER BY created_at LIMIT 50`).all(),
    unclassified_replies: count(`SELECT count(*) AS n FROM messages WHERE direction = 'in' AND reply_class IS NULL`),
    funnel: db.prepare(`SELECT track, stage, count(*) AS n FROM opportunities GROUP BY track, stage`).all(),
    last_runs: db.prepare(`SELECT id, skill, cycle, agent, status, summary, started_at, ended_at FROM runs WHERE parent_id IS NULL ORDER BY id DESC LIMIT 5`).all(),
  };
}

async function main(): Promise<void> {
  const [cmd, sub, ...rest] = pos;

  // "--ws arhaan --agent x" passed as ONE argument (zsh does not split an unquoted variable) would silently
  // drop --ws and fall back to the current workspace. Refuse it instead of acting on the wrong workspace.
  const glued = [...Object.keys(flags), ...pos].find((a) => /\s/.test(a) && /^-|--/.test(a));
  if (glued) fail(`one argument holds several options ("${glued}"); pass each option and value as separate arguments`);

  // Help comes first and runs nothing: no workspace is opened, no server started, no file written.
  if (flags.help || flags.h || cmd === 'help' || !cmd) return out(usage(cmd === 'help' ? sub : cmd));

  // ---- Commands that do not need a workspace.
  if (cmd === 'ws') {
    const cfg = readConfig();
    if (sub === 'create') {
      const slug = rest[0] ?? fail('he ws create <slug> --name "Person" [--track job,freelance,lead]');
      if (!/^[a-z0-9-]+$/.test(slug)) fail('slug: lowercase letters, digits and dashes only');
      const tracks = flags.track ? parseTracks(String(flags.track)) : undefined;
      ensureWorkspaceDirs(slug);
      cfg.workspaces[slug] = { name: String(flags.name ?? slug), created_at: new Date().toISOString(), ...(tracks ? { tracks } : {}) };
      cfg.current ??= slug;
      writeConfig(cfg);
      const db = openDb(slug);
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('name', String(flags.name ?? slug));
      // New workspaces start in dry run: everything is prepared, nothing leaves, until the person has seen samples.
      db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES ('dry_run', '1')`).run();
      const seeded = seedPlaybooks(db);
      const env = join(workspaceDir(slug), '.env');
      if (!existsSync(env)) writeFileSync(env, '# Gmail app passwords (Google Account > Security > App passwords). Never commit this file.\nJOB_EMAIL=\nJOB_EMAIL_APP_PASSWORD=\nOUTREACH_EMAIL=\nOUTREACH_EMAIL_APP_PASSWORD=\n');
      return out({ created: slug, dir: workspaceDir(slug), current: cfg.current, tracks: tracks ?? 'any', dry_run: true, note: 'Starts in dry run. The person turns it off with: he ws dry-run off --ws ' + slug, playbooks_seeded: seeded });
    }
    if (sub === 'tracks') {
      const slug = rest[0] ?? fail('he ws tracks <slug> [job,freelance,lead]');
      if (!cfg.workspaces[slug]) fail(`no workspace ${slug}`);
      if (rest[1]) { cfg.workspaces[slug].tracks = parseTracks(rest[1]); writeConfig(cfg); }
      return out({ workspace: slug, tracks: cfg.workspaces[slug].tracks ?? 'any' });
    }
    if (sub === 'dry-run') {
      const slug = resolveWorkspace(flags.ws as string | undefined);
      const db = openDb(slug);
      const want = rest[0] ?? 'status';
      if (want === 'on' || want === 'off') {
        if (want === 'off') {
          // Going live is the person's call, like an approval: never a scheduled run, never while agents run unattended.
          if (process.env.HE_HEADLESS) fail('dry run is turned off by the person, not by a scheduled run');
          const { automationRunning } = await import('./schedule.ts');
          const busy = automationRunning();
          if (busy) fail(`agents are running unattended right now (${busy}); turn dry run off once they have finished`);
        }
        db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('dry_run', ?)`).run(want === 'on' ? '1' : '0');
        logActivity(db, { agent: want === 'off' ? 'person:chat' : agent(), action: `dry_run.${want}` });
      } else if (want !== 'status') fail('he ws dry-run on|off|status');
      return out({ workspace: slug, dry_run: isDryRun(db) });
    }
    if (sub === 'use') {
      const slug = rest[0] ?? fail('he ws use <slug>');
      if (!cfg.workspaces[slug]) fail(`no workspace ${slug}`);
      cfg.current = slug;
      writeConfig(cfg);
      return out({ current: slug });
    }
    if (sub === 'list' || !sub) return out(cfg);
    return fail(`unknown: ws ${sub}`);
  }
  if (cmd === 'rules') {
    if (sub === 'verify') return out(verifyRules());
    if (sub === 'seal') return out({ sealed: sealRules(Boolean(process.stdin.isTTY) && !process.env.HE_HEADLESS) });
    if (sub === 'limits') return out(limits());
    return fail('he rules verify|seal|limits');
  }
  if (cmd === 'phone') return out(normalizePhone(sub ?? fail('he phone <number>')));
  if (cmd === 'domain') return out({ domain: normalizeDomain(sub ?? fail('he domain <url>')) });
  if (cmd === 'email') {
    if (sub === 'check') {
      const s = emailSyntax(rest[0] ?? fail('he email check <address>'));
      const domain = s.normalized.split('@')[1] ?? '';
      return out({ ...s, mx: s.valid ? await hasMx(domain) : false });
    }
    if (sub === 'guess') {
      const [first, last, domain] = rest;
      if (!first || !domain) fail('he email guess <first> <last|-> <domain>');
      const dom = normalizeDomain(domain) ?? fail(`not a company domain: ${domain}`);
      return out({ domain: dom, mx: await hasMx(dom), candidates: guessEmails(first, last === '-' ? '' : last ?? '', dom) });
    }
    return fail('he email check|guess');
  }
  if (cmd === 'upgrade') {
    // Pull the latest version (if this is a git checkout), reinstall, rebuild the dashboard, check the rules.
    const steps: { step: string; ok: boolean; note?: string }[] = [];
    const run = (step: string, c: string, a: string[], cwd = REPO_ROOT) => {
      const r = spawnSync(c, a, { cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600_000 });
      steps.push({ step, ok: r.status === 0, note: r.status === 0 ? undefined : (r.stderr || r.stdout).slice(-300) });
      return r.status === 0;
    };
    if (existsSync(join(REPO_ROOT, '.git'))) run('git pull', 'git', ['pull', '--ff-only']);
    run('engine packages', 'npm', ['install', '--no-audit', '--no-fund']);
    run('dashboard packages', 'npm', ['install', '--no-audit', '--no-fund'], join(REPO_ROOT, 'dashboard'));
    run('dashboard build', 'npm', ['run', 'build'], join(REPO_ROOT, 'dashboard'));
    const rules = verifyRules();
    steps.push({ step: 'hard rules', ok: rules.ok, note: rules.ok ? undefined : `${rules.reason}: if the update changed the rules, read rules/hard-rules.md and run he rules seal yourself` });
    return out({ ok: steps.every((s) => s.ok), steps, note: 'Database changes apply automatically the next time each workspace opens.' });
  }
  if (cmd === 'doctor') {
    const { doctor } = await import('./ops.ts');
    let slug: string | null = null;
    try { slug = resolveWorkspace(flags.ws as string | undefined); } catch { /* no workspace yet */ }
    const res = doctor(slug);
    return out({ workspace: slug, all_ok: res.every((r) => r.ok), checks: res.map((r) => (r.ok ? { check: r.check, ok: true, detail: r.detail } : r)) });
  }
  if (cmd === 'geo') {
    const { pincodeInfo } = await import('./collect.ts');
    if (sub === 'pin') return out(await pincodeInfo(rest[0] ?? fail('he geo pin <pincode>')));
    return fail('he geo pin <pincode>');
  }
  if (cmd === 'tools') {
    // Downloads only with --yes, which an agent may pass only after the person agreed to the named file and size.
    const C = await import('./collect.ts');
    if (sub === 'status') return out({ maps: { installed: existsSync(C.gosomPath()), path: C.gosomPath(), version: C.GOSOM_VERSION } });
    if (sub === 'install' && rest[0] === 'maps') {
      const asset = C.gosomAsset();
      if (!flags.yes) return out({ will_download: asset, size_note: 'about 61 MB on Windows, 63 MB on macOS; on first run it also downloads its own browser (about 150 MB)', licence: 'MIT, github.com/gosom/google-maps-scraper', run_again_with: '--yes' });
      const fs = await import('node:fs');
      const { dirname } = await import('node:path');
      const res = await fetch(asset.url);
      if (!res.ok) fail(`download failed: HTTP ${res.status}`);
      fs.mkdirSync(dirname(C.gosomPath()), { recursive: true });
      fs.writeFileSync(C.gosomPath(), Buffer.from(await res.arrayBuffer()));
      if (process.platform !== 'win32') fs.chmodSync(C.gosomPath(), 0o755);
      return out({ installed: C.gosomPath(), from: asset.url });
    }
    return fail('he tools status | he tools install maps [--yes]');
  }
  if (cmd === 'source') {
    // Fetch public postings, then filter: --match title regex, --loc location regex, --since days. Prints postings; nothing is stored.
    const S = await import('./sources.ts');
    const arg = rest[0];
    const need = (what: string) => arg ?? fail(`he source ${sub} <${what}>`);
    let list: unknown[];
    switch (sub) {
      case 'greenhouse': list = await S.greenhouse(need('board token')); break;
      case 'lever': list = await S.lever(need('company')); break;
      case 'ashby': list = await S.ashby(need('org')); break;
      case 'workable': list = await S.workable(need('account')); break;
      case 'hn': list = await S.hnWhoIsHiring(); break;
      case 'remoteok': list = await S.remoteok(); break;
      case 'himalayas': list = await S.himalayas(); break;
      case 'rss': return out((await S.rss(need('feed url'))).filter((i) => !flags.match || new RegExp(String(flags.match), 'i').test(`${i.title} ${i.summary ?? ''}`)));
      case 'jobspy': list = S.jobspy({ term: String(flags.term ?? fail('--term')), location: String(flags.location ?? 'India'), ...(flags.sites ? { sites: String(flags.sites).split(',') } : {}), ...(flags.since ? { hours: Number(flags.since) * 24 } : {}), ...(flags.max ? { results: Number(flags.max) } : {}) }); break;
      default: return fail('he source greenhouse|lever|ashby|workable <id> | hn | remoteok | himalayas | rss <url> | jobspy --term --location [--sites linkedin,indeed,naukri,google]');
    }
    const since = flags.since ? Date.now() - Number(flags.since) * 86400000 : 0;
    const res = (list as import('./sources.ts').Posting[]).filter((p) =>
      (!flags.match || new RegExp(String(flags.match), 'i').test(`${p.title} ${p.department ?? ''}`)) &&
      (!flags.loc || new RegExp(String(flags.loc), 'i').test(`${p.location ?? ''} ${p.remote ? 'remote' : ''}`)) &&
      (!since || !p.posted_at || new Date(p.posted_at).getTime() >= since));
    // Listings stay short unless --full; the scout opens the full description only for roles it shortlists.
    const brief = res.slice(0, Number(flags.limit ?? 200)).map((p) => (flags.full ? p : { ...p, description: p.description ? `${p.description.slice(0, 280)}...` : null }));
    return out({ count: res.length, of: list.length, postings: brief });
  }
  if (cmd === 'tier') { const p = payload() as Row; return out(classifyTier(p as never, (p.dream_list as string[]) ?? [])); }
  if (cmd === 'score' && !flags.opp) {
    const p = payload() as Row;
    return out(combineFit(String(p.track ?? flags.track ?? 'job'), p.dimensions as never));
  }

  // ---- Workspace commands.
  const slug = resolveWorkspace(flags.ws as string | undefined);
  const db = openDb(slug);

  switch (cmd) {
    case 'status': return out(status(db, slug));

    case 'upsert': {
      const table = sub ?? fail('he upsert <table> --json');
      if (!TABLES[table]) fail(`cannot upsert into ${table}; allowed: ${Object.keys(TABLES).join(', ')}`);
      const rows = ([] as Row[]).concat(payload());
      const results = rows.map((r) => {
        const row = prepare(db, table, r);
        guardWrite(table, row, findExisting(db, table, row));
        const res = upsert(db, table, row, Boolean(flags.overwrite));
        if (table === 'messages' && row.direction === 'in' && row.reply_class === 'unsubscribe') applyUnsubscribe(db, res.id);
        logActivity(db, { agent: agent(), action: `${table}.${res.created ? 'create' : 'merge'}`, ref_table: table, ref_id: res.id });
        return res;
      });
      return out(results.length === 1 ? results[0] : { count: results.length, created: results.filter((r) => r.created).length, results });
    }

    case 'update': {
      const table = sub ?? fail('he update <table> <id> --json');
      const id = Number(rest[0] ?? fail('he update <table> <id> --json'));
      if (!TABLES[table]) fail(`cannot update ${table}`);
      const patch = payload() as Row;
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
      if (!existing) fail(`${table} ${id} not found`);
      update(db, table, id, guardWrite(table, prepare(db, table, patch, false), existing));
      if (table === 'organizations' && ['name', 'domain', 'employees', 'is_listed', 'is_unicorn', 'is_mnc', 'is_brand'].some((k) => k in patch)) {
        const t = classifyTier(db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as never, dreamList(db));
        update(db, 'organizations', id, { tier: t.tier, tier_reasons: t.reasons });
      }
      if (table === 'messages' && patch.reply_class === 'unsubscribe') applyUnsubscribe(db, id);
      logActivity(db, { agent: agent(), action: `${table}.update`, ref_table: table, ref_id: id, detail: Object.keys(patch) });
      return out({ updated: id });
    }

    case 'get': {
      const table = sub ?? fail('he get <table> [--where col=val] [--limit n]');
      if (!/^[a-z_]+$/.test(table) || !columns(db, table).size) fail(`no table ${table}`);
      if (rest[0]) return out(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(rest[0])) ?? null);
      const w = whereClause();
      const order = flags.order && /^[a-z_]+( desc| asc)?$/i.test(String(flags.order)) ? String(flags.order) : 'id DESC';
      return out(db.prepare(`SELECT * FROM ${table} ${w.sql} ORDER BY ${order} LIMIT ?`).all(...w.args, Number(flags.limit ?? 100)));
    }

    case 'sql': {
      // Read-only escape hatch for the critic and dashboards; writes go through upsert/update.
      const q = sub ?? fail('he sql "SELECT ..."');
      if (!/^\s*(select|with)\b/i.test(q) || /;\s*\S/.test(q)) fail('he sql runs one SELECT only');
      // `WITH ... DELETE` is valid SQLite, so the keyword check is not enough: run it on a read-only connection.
      const { DatabaseSync } = await import('node:sqlite');
      const ro = new DatabaseSync(join(workspaceDir(slug), 'db.sqlite'), { readOnly: true });
      try { return out(ro.prepare(q).all()); } finally { ro.close(); }
    }

    case 'log': {
      const r = flags.ref ? ref() : undefined;
      logActivity(db, { agent: agent(), action: sub ?? fail('he log <action>'), ref_table: r?.table, ref_id: r?.id, detail: flags.json ? JSON.parse(String(flags.json)) : undefined, external: rest.includes('--external') || Boolean(flags.external) });
      return out({ logged: sub });
    }

    case 'run': {
      if (sub === 'start') {
        const id = insert(db, 'runs' as never, { skill: String(flags.skill ?? fail('--skill')), cycle: String(flags.cycle ?? 'manual'), agent: agent(), parent_id: rest[0] ? Number(rest[0]) : process.env.HE_RUN_ID ? Number(process.env.HE_RUN_ID) : null } as Row);
        logActivity(db, { agent: agent(), action: 'run.start', ref_table: 'runs', ref_id: id });
        return out({ run_id: id });
      }
      if (sub === 'end') {
        const id = Number(rest[0] ?? fail('he run end <id> --status ok|partial|failed --summary "..."'));
        const st = String(flags.status ?? 'ok');
        if (!['ok', 'partial', 'failed'].includes(st)) fail('status must be ok, partial or failed');
        db.prepare(`UPDATE runs SET status = ?, summary = ?, counts = ?, error = ?, ended_at = datetime('now') WHERE id = ?`)
          .run(st, String(flags.summary ?? ''), flags.json ? String(flags.json) : null, st === 'failed' ? String(flags.reason ?? '') : null, id);
        logActivity(db, { agent: agent(), action: 'run.end', ref_table: 'runs', ref_id: id, detail: { status: st, summary: flags.summary } });
        return out({ run_id: id, status: st });
      }
      return fail('he run start|end');
    }

    case 'note': {
      if (sub === 'send') {
        const r = flags.ref ? ref() : undefined;
        const id = Number(db.prepare('INSERT INTO agent_notes (from_agent, to_agent, topic, body, ref_table, ref_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(String(flags.from ?? agent()), String(flags.to ?? fail('--to agent|all')), String(flags.topic ?? fail('--topic')), String(flags.body ?? fail('--body')), r?.table ?? null, r?.id ?? null).lastInsertRowid);
        return out({ note_id: id });
      }
      if (sub === 'inbox') {
        const who = rest[0] ?? agent();
        const notes = db.prepare(`SELECT * FROM agent_notes WHERE status = 'open' AND to_agent IN (?, 'all') ORDER BY created_at`).all(who) as Row[];
        const mark = db.prepare(`UPDATE agent_notes SET status = 'read' WHERE id = ? AND to_agent <> 'all'`);
        for (const n of notes) mark.run(Number(n.id));
        return out(notes);
      }
      if (sub === 'done') {
        db.prepare(`UPDATE agent_notes SET status = 'done' WHERE id = ?`).run(Number(rest[0] ?? fail('he note done <id>')));
        return out({ done: Number(rest[0]) });
      }
      return fail('he note send|inbox|done');
    }

    case 'approval': {
      if (sub === 'request') {
        const r = ref();
        if (r.table !== 'applications' && r.table !== 'messages') fail('approvals are for messages or applications');
        requestApproval(db, r.table as 'messages', r.id, String(flags.summary ?? fail('--summary')), String(flags.reason ?? fail('--reason')));
        logActivity(db, { agent: agent(), action: 'approval.request', ref_table: r.table, ref_id: r.id, detail: { reason: flags.reason } });
        return out(db.prepare('SELECT * FROM approvals WHERE ref_table = ? AND ref_id = ?').get(r.table, r.id));
      }
      if (sub === 'decide') {
        const id = Number(rest[0] ?? fail('he approval decide <id> approve|reject --via chat|voice|dashboard'));
        const decision = rest[1] === 'approve' ? 'approved' : rest[1] === 'reject' ? 'rejected' : fail('approve or reject');
        const via = String(flags.via ?? 'chat');
        // Only the person decides: never a scheduled run, and the dashboard proves itself with a key agents cannot read.
        if (process.env.HE_HEADLESS) fail('approvals are made by the person, not by a scheduled run');
        // Environment variables can be cleared by whoever runs the command; the automation lock cannot be.
        const { automationRunning } = await import('./schedule.ts');
        const busy = automationRunning();
        if (busy && via !== 'dashboard') fail(`agents are running unattended right now (${busy}); approve on the dashboard, or by chat once it has finished`);
        if (!['chat', 'voice', 'dashboard'].includes(via)) fail('--via chat, voice or dashboard');
        if (via === 'dashboard' && process.env.HE_DECIDER_KEY !== deciderKey()) fail('dashboard decisions must come from the dashboard');
        decideApproval(db, id, decision, via, flags.note as string | undefined);
        return out(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
      }
      if (sub === 'list') return out(db.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at').all(String(flags.status ?? 'pending')));
      return fail('he approval request|decide|list');
    }

    case 'task': {
      if (sub === 'add') {
        const p = payload() as Row;
        const id = insert(db, 'tasks', { agent: agent(), ...p });
        return out({ task_id: id });
      }
      if (sub === 'done') {
        db.prepare(`UPDATE tasks SET status = 'done', done_at = datetime('now'), notes = coalesce(?, notes) WHERE id = ?`).run((flags.note as string) ?? null, Number(rest[0]));
        return out({ done: Number(rest[0]) });
      }
      if (sub === 'cancel') {
        db.prepare(`UPDATE tasks SET status = 'cancelled', done_at = datetime('now'), notes = coalesce(?, notes) WHERE id = ?`).run((flags.note as string) ?? null, Number(rest[0]));
        return out({ cancelled: Number(rest[0]) });
      }
      return fail('he task add|done|cancel');
    }

    case 'suppress': {
      if (sub === 'add') {
        const [kind, value] = rest;
        if (!kind || !value) fail('he suppress add <email|domain|phone|linkedin> <value> --reason');
        const v = kind === 'phone' ? normalizePhone(value).e164 ?? value : kind === 'domain' ? normalizeDomain(value) ?? value : value.trim().toLowerCase();
        db.prepare('INSERT OR IGNORE INTO suppression (kind, value, reason) VALUES (?, ?, ?)').run(kind, v, String(flags.reason ?? fail('--reason')));
        if (kind === 'email') db.prepare(`UPDATE people SET opt_out = CASE WHEN ? LIKE '%unsub%' OR ? LIKE '%opt%' THEN 1 ELSE opt_out END, email_status = CASE WHEN ? LIKE '%bounce%' THEN 'bounced' ELSE email_status END WHERE email = ?`).run(String(flags.reason), String(flags.reason), String(flags.reason), v);
        logActivity(db, { agent: agent(), action: 'suppress.add', detail: { kind, value: v, reason: flags.reason } });
        return out({ suppressed: v });
      }
      if (sub === 'check') return out(db.prepare('SELECT * FROM suppression WHERE value = ?').get(String(rest[0]).toLowerCase()) ?? { suppressed: false });
      return fail('he suppress add|check');
    }

    case 'gate': {
      const r = ref();
      if (r.table !== 'messages' && r.table !== 'applications') fail('he gate --ref messages:<id> | applications:<id>');
      return out(gate(db, { ref_table: r.table as 'messages', ref_id: r.id }));
    }

    case 'claim': {
      // LinkedIn actions and portal submits: claim (gate + record) first, then click; `he release` if the click fails.
      const r = ref();
      if (r.table !== 'messages' && r.table !== 'applications') fail('he claim --ref messages:<id> | applications:<id>');
      return out(claim(db, r.table as 'messages', r.id, agent()));
    }

    case 'release': {
      const r = ref();
      if (r.table !== 'messages' && r.table !== 'applications') fail('he release --ref messages:<id> | applications:<id> --reason "..."');
      release(db, r.table as 'messages', r.id, String(flags.reason ?? fail('--reason')), agent());
      return out({ released: `${r.table}:${r.id}` });
    }

    case 'score': {
      // The only way to set a fit score: the engine combines the agent's per-dimension judgement.
      const opp = Number(flags.opp ?? fail('he score --opp <id> --json {"dimensions":{...}}'));
      const row = db.prepare('SELECT track FROM opportunities WHERE id = ?').get(opp) as Row | undefined;
      if (!row) fail(`opportunity ${opp} not found`);
      const res = combineFit(String(row!.track), (payload() as Row).dimensions as never);
      db.prepare(`UPDATE opportunities SET fit_score = ?, fit_reasons = ?, updated_at = datetime('now') WHERE id = ?`).run(res.score, JSON.stringify([...res.reasons, ...res.missing.map((m) => `${m}: not judged`)]), opp);
      logActivity(db, { agent: agent(), action: 'opportunities.score', ref_table: 'opportunities', ref_id: opp, detail: { score: res.score, eligible: res.eligible } });
      return out({ opportunity_id: opp, ...res });
    }

    case 'playbook': {
      if (sub === 'get') {
        const [track, ag] = rest;
        const pb = activePlaybook(db, track ?? fail('he playbook get <track> <agent>'), ag ?? fail('agent'));
        const global = activePlaybook(db, 'global', 'lessons');
        return out({ playbook: pb ?? null, global_lessons: global?.content ?? null });
      }
      if (sub === 'set') {
        const [track, ag] = rest;
        const content = flags.file ? readFileSync(String(flags.file), 'utf8') : String(flags.body ?? fail('--file or --body'));
        return out(setPlaybook(db, { track: track ?? fail('track'), agent: ag ?? fail('agent'), content, reason: String(flags.reason ?? fail('--reason')), by: agent(), evidence: flags.json ? JSON.parse(String(flags.json)) : undefined }));
      }
      if (sub === 'revert') return out(revertChange(db, Number(rest[0] ?? fail('he playbook revert <change_id>')), String(flags.via ?? 'chat')));
      if (sub === 'history') return out(db.prepare('SELECT sc.*, p.track, p.agent, p.version FROM strategy_changes sc JOIN playbooks p ON p.id = sc.playbook_id ORDER BY sc.id DESC LIMIT 50').all());
      if (sub === 'seed') return out({ seeded: seedPlaybooks(db) });
      return fail('he playbook get|set|revert|history|seed');
    }

    case 'export': {
      const what = sub ?? fail('he export <table|leads> [--campaign x] [--out file.csv]');
      const rows = what === 'leads'
        // Small practices in the listing-checked band ship with the verified rows unless --verified-only.
        ? db.prepare(`SELECT p.name, p.role, o.name AS business, p.phone_e164 AS phone, p.phone_type, p.email, p.email_status, p.city, p.locality,
            o.website, o.rating, o.reviews, p.confidence,
            CASE WHEN ifnull(p.confidence, 0) >= 0.7 THEN 'Verified' WHEN ifnull(p.tags,'') LIKE '%listing-checked%' THEN 'Small practice, listing-checked' ELSE '' END AS band,
            p.source_url, p.updated_at AS checked
            FROM people p LEFT JOIN organizations o ON o.id = p.organization_id
            WHERE p.opt_out = 0 AND ifnull(p.tags,'') NOT LIKE '%duplicate-of%' AND ifnull(p.tags,'') NOT LIKE '%not-target%'
              AND (ifnull(p.confidence, 0) >= ? ${flags['verified-only'] ? '' : "OR ifnull(p.tags,'') LIKE '%listing-checked%'"}) ${flags.campaign ? 'AND p.campaign = ?' : ''}
            ORDER BY p.city, ifnull(p.confidence, 0) >= 0.7 DESC, p.confidence DESC`).all(Number(flags.min ?? 0), ...(flags.campaign ? [String(flags.campaign)] : [])) as Row[]
        : db.prepare(`SELECT * FROM ${/^[a-z_]+$/.test(what) ? what : fail('bad table')}`).all() as Row[];
      // Exports always land in this workspace's exports folder; --out only names the file.
      const name = flags.out ? basename(String(flags.out)).replace(/[^\w.-]+/g, '-') : `${what}-${new Date().toISOString().slice(0, 10)}.csv`;
      const file = join(workspaceDir(slug), 'files', 'exports', `${name.replace(/\.(csv|xlsx)$/i, '')}.csv`); // --out x.xlsx must not become x.xlsx.xlsx
      const headers = rows.length ? Object.keys(rows[0]) : [];
      const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const note = what === 'leads' ? '# Every record lists its public source. Check numbers against the DND (NCPR) registry before any telemarketing call or message.\n' : '';
      if (flags.format === 'xlsx') {
        const xlsx = file.replace(/\.csv$/, '.xlsx');
        const input = `${xlsx}.json`;
        writeFileSync(input, JSON.stringify({ rows, title: `${what === 'leads' ? 'Leads' : what}${flags.campaign ? `: ${flags.campaign}` : ''}`, note: note.replace(/^# /, '') + 'Green rows are verified (0.7 and higher): each has its own website that matches the Google Maps listing, or a second independent source, so these are the more credible contacts. Blue rows are small practices without a website: the phone comes from an open Google Maps listing with at least 3 reviews, but no second source has confirmed it yet. Yellow rows are 40 to 70% sure. Each row links to the public page it came from.' }));
        const r = spawnSync('uv', ['run', '--quiet', '--with', 'openpyxl', 'python', '-I', join(REPO_ROOT, 'engine', 'adapters', 'python', 'export_xlsx.py'), input, xlsx], { encoding: 'utf8', timeout: 180_000 });
        rmSync(input, { force: true });
        if (r.status !== 0) fail(`xlsx export failed: ${(r.stderr || r.stdout).slice(-400)}`);
        logActivity(db, { agent: agent(), action: 'export', detail: { what, rows: rows.length, file: xlsx } });
        return out({ file: xlsx, rows: rows.length });
      }
      writeFileSync(file, '﻿' + note + [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n'));
      logActivity(db, { agent: agent(), action: 'export', detail: { what, rows: rows.length, file } });
      return out({ file, rows: rows.length });
    }

    case 'schedule': {
      if (sub === 'install') return out({ installed: installSchedule(slug) });
      if (sub === 'remove') return out({ removed: removeSchedule(slug) });
      return out(showSchedule(slug));
    }

    case 'cycle': {
      const skill = sub ?? fail('he cycle <skill> <cycle>');
      const cycle = rest[0] ?? 'manual';
      const tracks = workspaceTracks(slug);
      if (tracks && !tracks.some((t) => TRACK_SKILL[t] === skill)) fail(`workspace ${slug} is set up for ${tracks.join(', ')}; ${skill} does not run here (change it with: he ws tracks ${slug} <tracks>)`);
      db.close();
      process.exitCode = runCycle(slug, skill, cycle);
      return;
    }

    case 'mail': {
      const dry = Boolean(flags['dry-run']);
      if (sub === 'send') return out(await sendMessage(db, slug, Number(rest[0] ?? fail('he mail send <message_id> [--dry-run]')), { dryRun: dry, agent: agent() }));
      if (sub === 'flush') {
        // Sends queued emails one by one, waiting out the pacing gap, and stops at a cap or outside the send window.
        const max = Number(flags.max ?? 50);
        const queued = db.prepare(`SELECT id FROM messages WHERE direction = 'out' AND channel = 'email' AND status IN ('queued','approved') ${flags.track ? 'AND track = ?' : ''} ORDER BY id LIMIT ?`)
          .all(...(flags.track ? [String(flags.track), max] : [max])) as Row[];
        const results: unknown[] = [];
        for (const q of queued) {
          let r = await sendMessage(db, slug, Number(q.id), { dryRun: dry, agent: agent() });
          // Retry only when pacing is the one thing in the way.
          const wait = (r.blocks ?? []).map((x) => /wait (\d+)s between sends/.exec(x)?.[1]).find(Boolean);
          if (r.status === 'blocked' && wait && (r.blocks ?? []).length === 1) {
            await new Promise((res) => setTimeout(res, (Number(wait) + 2) * 1000));
            r = await sendMessage(db, slug, Number(q.id), { dryRun: dry, agent: agent() });
          }
          results.push({ id: q.id, ...r });
          if (r.status === 'blocked' && (r.blocks ?? []).some((x) => /daily cap|send window|rules:/.test(x))) break;
        }
        return out({ attempted: results.length, results });
      }
      if (sub === 'connect') {
        // Google sign-in for a Gmail where app passwords are blocked. The person clicks Allow in their browser.
        const which = rest[0] === 'job' ? 'job' : rest[0] === 'outreach' ? 'outreach' : fail('he mail connect job|outreach');
        const env = (await import('./mail.ts')).loadEnv(slug);
        const { connect } = await import('./oauth.ts');
        const res = await connect(slug, which as 'job', env[which === 'job' ? 'JOB_EMAIL' : 'OUTREACH_EMAIL'] || undefined);
        logActivity(db, { agent: 'person:chat', action: 'mail.connect', detail: { which, email: res.email } });
        return out({ connected: res.email, account: which });
      }
      if (sub === 'test') {
        // Logs in to SMTP and IMAP without sending anything.
        const M = await import('./mail.ts');
        const results = [];
        for (const w of ['job', 'outreach'] as const) {
          const acc = M.accountFor(slug, w === 'job' ? 'job' : 'freelance');
          if (!acc) { results.push({ account: w, connected: false, note: 'not set up' }); continue; }
          try {
            const nodemailer = (await import('nodemailer')).default;
            await nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: M.smtpAuth(acc) as never }).verify();
            const { ImapFlow } = await import('imapflow');
            const auth = acc.oauth ? { user: acc.address, accessToken: await (await import('./oauth.ts')).accessToken(slug, w) } : { user: acc.address, pass: acc.password! };
            const c = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth, logger: false });
            await c.connect(); await c.logout();
            results.push({ account: w, address: acc.address, method: acc.oauth ? 'google sign-in' : 'app password', connected: true });
          } catch (e) { results.push({ account: w, address: acc.address, connected: false, error: (e as Error).message }); }
        }
        return out(results);
      }
      if (sub === 'sync') {
        const which = rest[0] ?? 'all';
        const { accountFor } = await import('./mail.ts');
        const res: unknown[] = [];
        for (const w of which === 'all' ? (['job', 'outreach'] as const) : [which as 'job' | 'outreach']) {
          // Skips only accounts with neither an app password nor a Google sign-in.
          if (which === 'all' && !accountFor(slug, w === 'job' ? 'job' : 'freelance')) continue;
          res.push(await syncInbox(db, slug, w));
        }
        return out(res);
      }
      return fail('he mail send|flush|sync|connect|test');
    }

    case 'followups': return out(dueFollowUps(db));

    case 'dashboard': {
      // Builds once, then serves on http://127.0.0.1:3010 in the background (add --lan for phones on the same Wi-Fi).
      const dash = join(REPO_ROOT, 'dashboard');
      const { spawnSync } = await import('node:child_process');
      const { spawnDetached } = await import('./schedule.ts');
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      if (!existsSync(join(dash, 'node_modules'))) spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: dash, stdio: 'inherit', shell: process.platform === 'win32' });
      if (!existsSync(join(dash, '.next', 'BUILD_ID')) || sub === 'rebuild') spawnSync(npm, ['run', 'build'], { cwd: dash, stdio: 'inherit', shell: process.platform === 'win32' });
      const lan = rest.includes('--lan') || sub === 'lan';
      deciderKey(); // make sure the dashboard's decision key exists
      const ping = await fetch('http://127.0.0.1:3010/').then((r) => r.status < 500).catch(() => false);
      if (ping) return out({ url: 'http://127.0.0.1:3010', already_running: true, note: lan ? 'Already running; stop it first to restart in LAN mode.' : undefined });
      // LAN mode: everyone on the Wi-Fi could reach it, so every request needs the key in this link.
      const env = lan ? { ...process.env, HE_LAN_KEY: deciderKey().slice(0, 24) } : process.env;
      spawnDetached(npm, ['run', lan ? 'start:lan' : 'start'], dash, env);
      const { networkInterfaces } = await import('node:os');
      const ip = Object.values(networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
      return out(lan ? { url: `http://${ip}:3010/?key=${deciderKey().slice(0, 24)}`, note: 'Open this link on your phone (same Wi-Fi). Share it with nobody.' } : { url: 'http://127.0.0.1:3010' });
    }

    case 'pdf': {
      const { htmlToPdf } = await import('./docs.ts');
      const [html, pdf] = [sub, rest[0]];
      if (!html || !pdf) fail('he pdf <file.html> <out.pdf>');
      htmlToPdf(html!, pdf!);
      return out({ pdf });
    }

    case 'factcheck': {
      // he factcheck <file> : numbers in the file that are not backed by claims or the master resume text.
      const { factCheck, readMaster } = await import('./docs.ts');
      const file = sub ?? fail('he factcheck <file.html|md|txt>');
      const text = readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
      const prof = db.prepare(`SELECT data FROM profiles WHERE track = 'job' ORDER BY version DESC LIMIT 1`).get() as Row | undefined;
      const master = prof ? (JSON.parse(String(prof.data)) as { resume_master_text_path?: string }).resume_master_text_path : undefined;
      return out(factCheck(db, text, readMaster(master)));
    }

    case 'browser': {
      // Opens Chrome on this workspace's profile so the person can sign in to portals once; agents reuse the session.
      const { findChrome } = await import('./docs.ts');
      const { spawnDetached } = await import('./schedule.ts');
      const chrome = findChrome() ?? fail('Chrome not found; set CHROME_PATH');
      spawnDetached(chrome!, [`--user-data-dir=${join(workspaceDir(slug), 'browser')}`, sub ?? 'https://www.linkedin.com/login'], workspaceDir(slug));
      return out({ opened: sub ?? 'https://www.linkedin.com/login', profile: join(workspaceDir(slug), 'browser'), note: 'Sign in, then close this window before the next scheduled run.' });
    }

    case 'resume': {
      const R = await import('./resume.ts');
      if (sub === 'import') {
        // Re-run whenever the resume changes: new lines become claims, removed ones are retired, edits are paired up.
        const res = R.importResume(db, slug, rest[0] ?? fail('he resume import <file.docx>'), agent());
        const short = (l: { text: string; where: string }) => `${l.where}: ${R.plainText(l.text).slice(0, 110)}`;
        return out({ master: res.master, claims: res.claims, warnings: res.warnings, unchanged: res.diff.unchanged, added: res.diff.added.map(short), removed: res.diff.removed.map(short), changed: res.diff.changed.map((c) => ({ from: short(c.from), to: short(c.to) })) });
      }
      if (sub === 'show') {
        // The tailor's menu: every entry and line with its id.
        const m = R.loadMaster(slug) ?? fail('no master resume yet: he resume import <file.docx>');
        return out({ name: m!.name, imported_at: m!.source.imported_at, summary: m!.summary, sections: m!.sections.map((s) => ({ key: s.key, title: s.title, entries: s.entries.map((e) => ({ id: e.id, title: e.title, role: e.role, dates: e.dates, subtitle: e.subtitle, bullets: e.bullets.map((b) => ({ id: b.id, text: b.text })) })), items: s.items.map((i) => ({ id: i.id, label: i.label, text: i.text })) })) });
      }
      if (sub === 'format') {
        const { formatHint } = await import('./render.ts');
        const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(Number(flags.opp ?? fail('--opp <id>'))) as Row | undefined;
        if (!opp) fail('opportunity not found');
        const org = opp!.organization_id ? (db.prepare('SELECT * FROM organizations WHERE id = ?').get(Number(opp!.organization_id)) as Row) : undefined;
        return out({ hint: formatHint(opp!, org), saved_for_company: org?.resume_format ? JSON.parse(String(org.resume_format)) : null, rules: join(REPO_ROOT, 'references', 'resume-formats.md') });
      }
      if (sub === 'build') {
        const { buildResume } = await import('./render.ts');
        const oppId = Number(flags.opp ?? fail('--opp <id>'));
        const plan = payload() as never;
        const res = buildResume(db, slug, oppId, plan);
        const opp = db.prepare('SELECT organization_id FROM opportunities WHERE id = ?').get(oppId) as Row;
        const fmt = (plan as { format: Row }).format;
        if (opp.organization_id) db.prepare(`UPDATE organizations SET resume_format = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify({ ...fmt, decided_at: new Date().toISOString().slice(0, 10) }), Number(opp.organization_id));
        if (flags.app) {
          const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(Number(flags.app)) as Row | undefined;
          if (!app) fail('application not found');
          if (['submitted', 'pending_review'].includes(String(app!.status))) fail('this application is submitted or waiting for approval; build a new one');
          db.prepare(`UPDATE applications SET resume_path = ?, resume_docx_path = ?, format = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(String(res.pdf), String(res.docx), JSON.stringify({ pages: res.pages, target: res.target_pages, font_pt: res.font_pt, trimmed: res.trimmed, why: fmt.why ?? null }), Number(flags.app));
        }
        logActivity(db, { agent: agent(), action: 'resume.build', ref_table: 'opportunities', ref_id: oppId, detail: { pages: res.pages, fits: res.fits, factcheck_ok: (res.factcheck as Row).ok } });
        return out(res);
      }
      return fail('he resume import <docx> | show | format --opp <id> | build --opp <id> --file plan.json [--app <id>]');
    }

    case 'letter': {
      if (sub !== 'build') fail('he letter build --opp <id> --file letter.txt [--app <id>] [--paper A4|Letter]');
      const { buildLetter } = await import('./render.ts');
      const body = readFileSync(String(flags.file ?? fail('--file letter.txt')), 'utf8');
      const res = buildLetter(db, slug, Number(flags.opp ?? fail('--opp <id>')), body, flags.paper === 'Letter' ? 'Letter' : 'A4');
      if (flags.app) db.prepare(`UPDATE applications SET cover_letter_path = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('draft','failed')`).run(String(res.pdf), Number(flags.app));
      return out(res);
    }

    case 'collect': {
      const C = await import('./collect.ts');
      if (sub === 'site') return out(await C.collectSite(db, rest[0] ?? fail('he collect site <url> [--name "Business"]'), flags.name as string | undefined));
      if (sub !== 'maps') return fail('he collect maps --query "<q>" [--query ...] [--localities "Bandra West"] [--pins 400050] [--location Mumbai] [--save --campaign X --include re --exclude re] | he collect site <url>');
      const queries = (flags.query as string[] | undefined) ?? fail('--query "dietitian in Bandra West Mumbai" (repeatable)');
      const area = { localities: flags.localities ? String(flags.localities).split(',').map((s) => s.trim()).filter(Boolean) : undefined, pincodes: flags.pins ? String(flags.pins).split(',').map((s) => s.trim()).filter(Boolean) : undefined };
      const res = await C.collectMaps(db, join(workspaceDir(slug), 'files', 'snapshots'), { queries: queries!, depth: flags.depth ? Number(flags.depth) : undefined, emails: Boolean(flags.emails), area });
      const inc = flags.include ? new RegExp(String(flags.include), 'i') : null;
      const exc = flags.exclude ? new RegExp(String(flags.exclude), 'i') : null;
      const matching = res.places.filter((p) => (!inc || inc.test(`${p.category ?? ''} ${p.name}`)) && (!exc || !exc.test(`${p.category ?? ''} ${p.name}`)) && !/permanently closed/i.test(p.status ?? ''));
      if (!flags.save) return out({ raw: res.raw, outside_area: res.dropped_outside_area, kept: res.places.length, matching: matching.length, stalled: res.stalled, file: res.file, places: matching });
      const campaign = String(flags.campaign ?? fail('--campaign is required with --save'));
      const city = flags.location ? String(flags.location) : null;
      let created = 0, merged = 0;
      for (const p of matching) {
        const org = upsert(db, 'organizations', prepare(db, 'organizations', { name: p.name, address: p.address, phone: p.phone, website: p.website, rating: p.rating, reviews: p.reviews, sector: p.category, city, campaign, source_url: p.maps_url ?? 'google maps' }));
        const locality = (area.localities?.length ? C.matchedLocality(p, area.localities) : null) ?? (p.pincode && area.pincodes?.includes(p.pincode) ? area.localities?.[0] ?? null : null);
        const person = prepare(db, 'people', { organization_id: org.id, name: p.name, role: p.category, phone: p.phone, email: p.emails[0] ?? null, email_status: p.emails[0] ? 'published' : 'unknown', city, locality, campaign, source_url: p.maps_url ?? 'google maps' });
        guardWrite('people', person, findExisting(db, 'people', person));
        const saved = upsert(db, 'people', person);
        if (saved.created) created++; else merged++;
      }
      logActivity(db, { agent: agent(), action: 'collect.maps', detail: { queries, kept: res.places.length, matching: matching.length, created, merged, campaign } });
      return out({ raw: res.raw, outside_area: res.dropped_outside_area, kept: res.places.length, saved_new: created, merged, stalled: res.stalled, file: res.file });
    }

    case 'yc': {
      // YC companies that are hiring, with team size; --save records them (tier from team size).
      const Co = await import('./companies.ts');
      const list = Co.filterYc(await Co.ycHiring(db), { region: flags.region as string | undefined, match: flags.match as string | undefined, maxTeam: flags['max-team'] ? Number(flags['max-team']) : undefined });
      if (!flags.save) return out({ count: list.length, companies: list.slice(0, Number(flags.limit ?? 100)).map((c) => ({ name: c.name, website: c.website, team_size: c.team_size, one_liner: c.one_liner, regions: c.regions, batch: c.batch, jobs: `${c.url}/jobs` })) });
      let created = 0;
      for (const c of list.slice(0, Number(flags.limit ?? 100))) {
        const res = upsert(db, 'organizations', prepare(db, 'organizations', { name: c.name, website: c.website, employees: c.team_size, size_source: `yc:${c.slug}`, sector: c.industries.join(', '), city: c.all_locations.split(';')[0]?.trim() || null, notes: `${c.one_liner} (YC ${c.batch})`, source_url: c.url }));
        if (res.created) created++;
      }
      return out({ matched: list.length, saved_new: created });
    }

    case 'watchlist': {
      const Co = await import('./companies.ts');
      if (sub === 'add') {
        const [provider, board] = rest;
        if (!provider || !board) fail('he watchlist add <greenhouse|lever|ashby|workable> <board> --name "Company"');
        db.prepare('INSERT OR IGNORE INTO watchlist (provider, board, company, organization_id, added_by) VALUES (?, ?, ?, ?, ?)').run(provider, board, String(flags.name ?? board), flags.org ? Number(flags.org) : null, agent());
        return out({ added: `${provider}:${board}` });
      }
      if (sub === 'discover') return out(await Co.discoverBoards(db, rest[0] ?? fail('he watchlist discover <careers-url> --name "Company"'), String(flags.name ?? rest[0]), flags.org ? Number(flags.org) : undefined));
      if (sub === 'list') return out(db.prepare('SELECT * FROM watchlist ORDER BY active DESC, company').all());
      if (sub === 'sweep') {
        const since = flags.since ? Date.now() - Number(flags.since) * 86400000 : 0;
        const m = flags.match ? new RegExp(String(flags.match), 'i') : null;
        const l = flags.loc ? new RegExp(String(flags.loc), 'i') : null;
        const res = await Co.sweepWatchlist(db, (p) => (!m || m.test(`${p.title} ${p.department ?? ''}`)) && (!l || l.test(`${p.location ?? ''} ${p.remote ? 'remote' : ''}`)) && (!since || !p.posted_at || new Date(p.posted_at).getTime() >= since));
        return out({ boards: res.length, matching: res.reduce((a, b) => a + b.matching.length, 0), results: res.map((r) => ({ ...r, matching: r.matching.map((p) => ({ ...p, description: p.description ? `${p.description.slice(0, 200)}...` : null })) })) });
      }
      return fail('he watchlist add|discover|list|sweep');
    }

    case 'company': {
      if (sub !== 'size') fail('he company size --org <id>');
      const { resolveSize } = await import('./companies.ts');
      return out(await resolveSize(db, Number(flags.org ?? fail('--org <id>')), dreamList(db)));
    }

    case 'pattern': {
      // he pattern learn --org <id> | he pattern guess --org <id> --person "First Last"
      const Co = await import('./companies.ts');
      const orgId = Number(flags.org ?? fail('--org <id>'));
      if (sub === 'learn') return out(Co.learnPattern(db, orgId));
      if (sub === 'guess') {
        const org = db.prepare('SELECT domain, email_pattern, email_pattern_status FROM organizations WHERE id = ?').get(orgId) as Row | undefined;
        if (!org?.domain) fail('this company has no domain on record');
        const name = String(flags.person ?? fail('--person "First Last"'));
        const learned = org!.email_pattern && org!.email_pattern_status !== 'bounced' ? Co.applyPattern(String(org!.email_pattern), name, String(org!.domain)) : null;
        const parts = name.split(/\s+/);
        return out({ learned_pattern: org!.email_pattern ?? null, pattern_status: org!.email_pattern_status ?? null, best: learned, candidates: learned ? [learned] : guessEmails(parts[0], parts.slice(1).join(' '), String(org!.domain)), mx: await hasMx(String(org!.domain)) });
      }
      return fail('he pattern learn|guess --org <id>');
    }

    case 'variant': {
      const { pickVariant } = await import('./experiments.ts');
      return out(pickVariant(db, String(flags.track ?? fail('--track')), String(flags.dimension ?? fail('--dimension'))));
    }

    case 'experiment': {
      const { checkExperiment } = await import('./experiments.ts');
      if (sub !== 'check') fail('he experiment check <id> [--conclude]');
      return out(checkExperiment(db, Number(rest[0] ?? fail('he experiment check <id>')), Boolean(flags.conclude)));
    }

    case 'eval': {
      // he eval <agent|all> [--case name] [--change <strategy change id>]: practice tests; a failure after a critic change undoes it.
      const E = await import('./evals.ts');
      const who = sub ?? fail(`he eval <agent|all>; agents with tests: ${E.listEvalAgents().join(', ')}`);
      if (who === 'list') return out(E.listEvalAgents());
      const agents = who === 'all' ? E.listEvalAgents() : [who!];
      const results = [];
      for (const a of agents) results.push(await E.runEval(db, slug, a, { caseName: flags.case as string | undefined, trigger: flags.change ? 'critic' : String(flags.trigger ?? 'manual'), changeId: flags.change ? Number(flags.change) : undefined }));
      return out(agents.length === 1 ? results[0] : { passed: results.every((r) => r.passed), results });
    }

    case 'sample': {
      // he sample build --kind homepage|listing|reel --file data.json [--opp <id>]
      const Sm = await import('./samples.ts');
      if (sub !== 'build') fail('he sample build --kind homepage|listing|reel --file data.json [--opp <id>]');
      const kind = String(flags.kind ?? 'homepage') as 'homepage' | 'listing' | 'reel';
      if (!['homepage', 'listing', 'reel'].includes(kind)) fail('--kind homepage, listing or reel');
      const res = Sm.buildSample(join(workspaceDir(slug), 'files', 'samples'), kind, payload() as never);
      if (flags.opp) logActivity(db, { agent: agent(), action: 'sample.build', ref_table: 'opportunities', ref_id: Number(flags.opp), detail: { kind, png: res.png } });
      return out(res);
    }

    case 'proposal': {
      const Sm = await import('./samples.ts');
      if (sub !== 'build') fail('he proposal build --file proposal.json [--opp <id>]');
      const res = Sm.buildProposal(join(workspaceDir(slug), 'files', 'letters'), payload() as never);
      if (flags.opp) logActivity(db, { agent: agent(), action: 'proposal.build', ref_table: 'opportunities', ref_id: Number(flags.opp), detail: { pdf: res.pdf } });
      return out(res);
    }

    case 'wa': {
      // A one-tap WhatsApp link with the message already typed; the person sends it from their phone.
      const { waLink } = await import('./samples.ts');
      return out({ link: waLink(String(flags.phone ?? fail('--phone')), String(flags.body ?? fail('--body "message"'))) });
    }

    case 'backup': {
      const { backup } = await import('./ops.ts');
      return out(backup(db, slug));
    }

    case 'notify': {
      const { notify } = await import('./ops.ts');
      return out(await notify(db, slug, String(flags.summary ?? flags.topic ?? fail('--summary "Interview invite from Acme"')), String(flags.body ?? fail('--body "details, with the time in IST"'))));
    }

    case 'verify': {
      // he verify leads --campaign X [--all]: mechanical checks and confidence; the verifier agent reviews the unclear ones.
      if (sub !== 'leads') fail('he verify leads --campaign <name> [--all]');
      const { verifyLeads } = await import('./verify.ts');
      return out(await verifyLeads(db, { campaign: String(flags.campaign ?? fail('--campaign')), all: Boolean(flags.all), noWebsite: Boolean(flags['no-website']), agent: agent() }));
    }

    case 'repo': return out({ root: REPO_ROOT, workspace_dir: workspaceDir(slug) });

    default:
      return fail(`unknown command ${cmd ?? ''}. Run \`he help\` for the list.`);
  }
}

export function decideApproval(db: DatabaseSync, id: number, decision: 'approved' | 'rejected', via: string, note?: string): void {
  const a = db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
  if (!a) throw new Error(`approval ${id} not found`);
  if (decision === 'approved' && a.content_hash !== contentHash(db, String(a.ref_table), Number(a.ref_id))) {
    throw new Error('this item changed after approval was requested; the agent has to request approval again so you see the current version');
  }
  db.prepare(`UPDATE approvals SET status = ?, decided_via = ?, note = ?, decided_at = datetime('now') WHERE id = ?`).run(decision, via, note ?? null, id);
  if (decision === 'approved' && a.ref_table === 'messages') db.prepare(`UPDATE messages SET status = 'queued' WHERE id = ? AND status = 'pending_review'`).run(Number(a.ref_id));
  if (decision === 'approved' && a.ref_table === 'applications') db.prepare(`UPDATE applications SET status = 'approved' WHERE id = ? AND status = 'pending_review'`).run(Number(a.ref_id));
  // Only unsent items change; a rejection never rewrites what already went out.
  if (decision === 'rejected' && a.ref_table === 'applications') db.prepare(`UPDATE applications SET status = 'rejected' WHERE id = ? AND status IN ('draft','pending_review','approved')`).run(Number(a.ref_id));
  if (decision === 'rejected' && a.ref_table === 'messages') db.prepare(`UPDATE messages SET status = 'cancelled' WHERE id = ? AND status IN ('drafted','queued','pending_review','approved')`).run(Number(a.ref_id));
  logActivity(db, { agent: `person:${via}`, action: `approval.${decision}`, ref_table: String(a.ref_table), ref_id: Number(a.ref_id), detail: { approval_id: id, note } });
}

main().catch((e: Error) => {
  if (!(e instanceof Handled)) console.error(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
});

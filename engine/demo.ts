// Builds a "demo" workspace with obviously fictional data (example.* domains) so the dashboard can be checked end to end.
// Usage: node engine/demo.ts
import { rmSync } from 'node:fs';
import { openDb, insert, logActivity } from './db.ts';
import { ensureWorkspaceDirs, readConfig, writeConfig, workspaceDir } from './paths.ts';
import { seedPlaybooks, setPlaybook } from './playbooks.ts';
import { classifyTier } from './tier.ts';
import { requestApproval } from './gate.ts';

const slug = 'demo';
rmSync(workspaceDir(slug), { recursive: true, force: true });
ensureWorkspaceDirs(slug);
const cfg = readConfig();
cfg.workspaces[slug] = { name: 'Demo (made-up data)', created_at: new Date().toISOString() };
cfg.current ??= slug;
writeConfig(cfg);
const db = openDb(slug);
db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('demo', '1'), ('name', 'Demo (made-up data)')`).run();
seedPlaybooks(db);

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const ts = (daysAgo: number, hour = 11) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10) + ` ${String(hour - 5).padStart(2, '0')}:${String(Math.floor(rnd() * 59)).padStart(2, '0')}:00`;

insert(db, 'profiles', { track: 'job', version: 1, data: { goal: 'Founder office or operations internship', cities: ['Mumbai', 'Remote'], dream_list: ['Example Rockets'] } });
insert(db, 'profiles', { track: 'freelance', version: 1, data: { offer: 'Websites and launch films for small businesses' } });
insert(db, 'profiles', { track: 'lead', version: 1, data: { brief: 'Dietitians and nutritionists, name, phone, email', cities: ['Mumbai', 'Pune', 'Bengaluru'] } });
for (const c of ['Led finance for a 40-member student society', 'Built a two-page resume site', 'Ran a 300-person college event']) insert(db, 'claims', { text: c, evidence: 'demo' });

const orgs: { id: number; name: string; tier: string }[] = [];
const ORGS: [string, number | null, number][] = [
  ['Tidepool Labs', 14, 0], ['Example Rockets', 60, 0], ['Northwind Health', 2200, 1], ['Lumen Ledger', 35, 0], ['Paper Kite AI', 9, 0],
  ['Globex India', 18000, 1], ['Quill & Sons', null, 0], ['Brightside Foods', 120, 0], ['Orbitfold', 22, 0], ['Initech Services', 900, 0],
  ['Sable Studio', 6, 0], ['Marigold Clinics', 45, 0],
];
for (const [name, employees, listed] of ORGS) {
  const domain = `${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`;
  const t = classifyTier({ name, domain, employees, is_listed: listed }, ['Example Rockets']);
  const id = insert(db, 'organizations', { name, domain, website: `https://${domain}`, employees, is_listed: listed, tier: t.tier, tier_reasons: t.reasons, sector: pick(['AI', 'Fintech', 'Health', 'D2C', 'SaaS']), city: pick(['Mumbai', 'Bengaluru', 'Remote']), source_url: `https://${domain}/careers` });
  orgs.push({ id, name, tier: t.tier });
}

const FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Tara', 'Dev', 'Isha', 'Neel', 'Zoya', 'Arjun'];
const people: number[] = [];
for (const o of orgs.slice(0, 10)) {
  const f = pick(FIRST);
  people.push(insert(db, 'people', { organization_id: o.id, name: `${f} Example`, role: pick(['Founder', 'Head of Ops', 'Recruiter', 'Product lead']), email: `${f.toLowerCase()}.${o.id}@${o.name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`, email_status: pick(['published', 'guessed', 'mx_ok']), source_url: 'https://example.com/team' }));
}

const runId = insert(db, 'runs', { skill: 'job-hunt', cycle: 'morning', agent: 'conductor', status: 'ok', summary: '18 new roles, 6 good fits, 3 applied, 1 waiting for you', started_at: ts(0, 9), ended_at: ts(0, 10) });
for (const a of ['scout', 'tailor', 'applier', 'qa-gate', 'referral-outreach', 'inbox', 'follow-up', 'critic', 'researcher', 'verifier', 'db-builder'])
  insert(db, 'runs', { skill: a === 'researcher' || a === 'verifier' || a === 'db-builder' ? 'lead-research' : 'job-hunt', cycle: a === 'critic' ? 'evening' : 'morning', agent: a, parent_id: runId, status: a === 'applier' ? 'partial' : 'ok', summary: a === 'applier' ? '3 submitted, 1 held for approval, 1 stopped by a CAPTCHA' : 'done', started_at: ts(0, 9), ended_at: ts(0, 10) });

const STAGES = ['found', 'found', 'found', 'shortlisted', 'shortlisted', 'skipped', 'pending_review', 'applied', 'applied', 'applied', 'replied', 'interview', 'lost'];
const TITLES = ['Founder office intern', 'Operations associate', 'Growth intern', 'Strategy and ops intern', 'Chief of staff intern', 'Finance and ops intern'];
let pendingApp = 0;
for (let i = 0; i < 26; i++) {
  const o = orgs[i % orgs.length];
  const stage = STAGES[i % STAGES.length];
  const fit = stage === 'skipped' ? 2.8 : Math.round((3.4 + rnd() * 1.5) * 10) / 10;
  const opp = insert(db, 'opportunities', { track: i % 5 === 4 ? 'freelance' : 'job', kind: i % 5 === 4 ? 'prospect' : 'internship', organization_id: o.id, title: i % 5 === 4 ? 'Website rebuild' : TITLES[i % TITLES.length], url: `https://example.com/jobs/${i}`, dedupe_key: `demo-${i}`, source: pick(['greenhouse', 'wellfound', 'yc', 'naukri', 'funding news']), location: pick(['Mumbai', 'Remote']), fit_score: fit, fit_reasons: [`role_fit 4/5 x0.3: matches operations goal`, `eligibility 4/5 x0.2: students welcome`, `recency 5/5 x0.1: posted 2 days ago`], tier: o.tier, stage, skip_reason: stage === 'skipped' ? 'fit below 3.5' : null });
  if (['pending_review', 'applied', 'replied', 'interview', 'lost'].includes(stage)) {
    const status = stage === 'pending_review' ? 'pending_review' : 'submitted';
    const app = insert(db, 'applications', { opportunity_id: opp, portal: pick(['greenhouse', 'wellfound', 'lever']), resume_path: `${workspaceDir(slug)}/files/resumes/demo-${i}.pdf`, answers: { 'Why this role?': 'I have run operations for a 40-member society and want to do it full time at a startup.', 'Notice period': 'Immediate' }, status, submitted_at: status === 'submitted' ? ts(i % 6, 12) : null });
    if (status === 'pending_review') {
      pendingApp = app;
      requestApproval(db, 'applications', app, `${TITLES[i % TITLES.length]} at ${o.name}`, o.tier === 'big' ? `Big company (${classifyTier({ name: o.name, employees: ORGS.find((x) => x[0] === o.name)?.[1] ?? null }).reasons.join(', ')}). Resume and answers are ready.` : 'Company size unknown, so treated as big until confirmed.');
    }
  }
}
// One item stopped by a CAPTCHA, which always goes to the person.
const capOpp = insert(db, 'opportunities', { track: 'job', kind: 'internship', organization_id: orgs[7].id, title: 'Business operations intern', dedupe_key: 'demo-captcha', source: 'company site', fit_score: 4.1, tier: 'small', stage: 'pending_review' });
const capApp = insert(db, 'applications', { opportunity_id: capOpp, portal: 'company site', status: 'pending_review' });
requestApproval(db, 'applications', capApp, 'Business operations intern at Brightside Foods', 'The form showed a CAPTCHA, so the applier stopped. Everything else is filled in; approve and finish the CAPTCHA when it opens.');

const ANGLES = ['their recent launch', 'a gap on their site', 'mutual college', 'their open role'];
for (let i = 0; i < people.length; i++) {
  const angle = ANGLES[i % ANGLES.length];
  const thread = `demo-thread-${i}`;
  const sent = ts(i % 7, 10 + (i % 6));
  const mid = insert(db, 'messages', { track: i % 4 === 3 ? 'freelance' : 'job', channel: 'email', direction: 'out', account: 'you@example.com', person_id: people[i], organization_id: orgs[i].id, thread_key: thread, to_address: 'redacted@example.com', subject: pick(['Quick question about the ops role', 'Referral for the founder office internship', 'An idea for your homepage']), body: `Hi there,\n\nI saw ${angle} and wanted to ask one thing.\n\n(Demo text.)`, variant: { angle, subject_style: i % 2 ? 'question' : 'statement', length: i % 3 ? 'short' : 'medium' }, status: i === 9 ? 'bounced' : 'sent', sent_at: sent, sequence_step: 0, external_id: `demo-${i}@example.com` });
  logActivity(db, { agent: 'referral-outreach', action: 'mail.sent', ref_table: 'messages', ref_id: mid, external: true, detail: { to: orgs[i].name }, run_id: runId });
  if (i % 3 === 0) insert(db, 'messages', { track: 'job', channel: 'email', direction: 'in', person_id: people[i], organization_id: orgs[i].id, thread_key: thread, subject: 'Re: Quick question', body: i === 0 ? 'Happy to refer you. Send me your resume.\n\n(Demo text.)' : 'Can you do a call Thursday?\n\n(Demo text.)', status: 'received', reply_class: i === 0 ? 'referral' : 'interview', created_at: ts(i % 5, 15) });
  else insert(db, 'tasks', { kind: 'follow_up', title: `Follow up with ${orgs[i].name}`, due_at: ts(-(i % 4) + 1, 11), ref_table: 'messages', ref_id: mid, agent: 'follow-up' });
}
insert(db, 'tasks', { kind: 'user_action', title: 'Create your Internshala account (agents cannot sign up for you)', agent: 'applier' });
insert(db, 'tasks', { kind: 'prep', title: 'Interview prep pack for Lumen Ledger', due_at: ts(-2), agent: 'interview-prep' });

const notes: [string, string, string, string][] = [
  ['inbox', 'scout', 'lookalikes', 'Tidepool Labs replied with a referral. Find 10 more seed-stage AI startups in Mumbai like them.'],
  ['qa-gate', 'tailor', 'claims', 'Draft 14 said "managed a budget of 5 lakh". That is not in the claims list, so I removed it. Please stick to the claims.'],
  ['verifier', 'researcher', 'source quality', 'Directory listings in Pune had 4 dead numbers out of 10. Prefer Maps place pages there.'],
  ['critic', 'all', 'strategy', 'Emails that open with their open role get replies twice as often as ones that open with a compliment (small sample, watching).'],
];
for (const [f, t, topic, body] of notes) insert(db, 'agent_notes' as never, { from_agent: f, to_agent: t, topic, body, status: t === 'all' ? 'open' : 'read' } as never);

setPlaybook(db, { track: 'job', agent: 'referral-outreach', content: 'Open with something specific you admire about the company. Keep under 120 words.', reason: 'seed', by: 'seed' });
setPlaybook(db, { track: 'job', agent: 'referral-outreach', content: 'Open with their open role. Keep under 90 words.', reason: 'First line "their open role" got 4 of 10 replies against 1 of 10 for compliments', by: 'critic', evidence: { open_role: '4/10', compliment: '1/10' } });
insert(db, 'experiments' as never, { track: 'job', dimension: 'subject_style', variants: ['question', 'statement'], min_n: 25 } as never);

// Lead research: a fictional dietitian campaign across three cities.
const AREAS: Record<string, string[]> = { Mumbai: ['Bandra', 'Andheri', 'Powai', 'Dadar'], Pune: ['Kothrud', 'Baner', 'Aundh'], Bengaluru: ['Indiranagar', 'HSR Layout', 'Jayanagar'] };
let n = 0;
for (const [city, areas] of Object.entries(AREAS)) for (let i = 0; i < (city === 'Mumbai' ? 14 : 8); i++) {
  n++;
  const area = pick(areas);
  const clinic = insert(db, 'organizations', { name: `Demo Nutrition Clinic ${n}`, city, address: `${area}, ${city}`, rating: Math.round((3.8 + rnd() * 1.2) * 10) / 10, reviews: Math.floor(rnd() * 300), tier: 'small', campaign: 'Dietitians (demo)', source_url: `https://maps.example.com/place/${n}` });
  const conf = Math.round(rnd() * 100) / 100;
  const pid = insert(db, 'people', { organization_id: clinic, name: `Dr. Demo ${FIRST[n % FIRST.length]} ${n}`, role: pick(['Dietitian', 'Clinical nutritionist', 'Sports nutritionist']), phone: `+91 9${String(100000000 + n * 7919).slice(0, 9)}`, phone_e164: `+919${String(100000000 + n * 7919).slice(0, 9)}`, phone_type: 'mobile', email: conf > 0.4 ? `clinic${n}@nutrition.example.com` : null, email_status: conf > 0.7 ? 'mx_ok' : conf > 0.4 ? 'published' : 'unknown', city, locality: area, confidence: conf, campaign: 'Dietitians (demo)', source_url: `https://maps.example.com/place/${n}` });
  insert(db, 'verifications', { ref_table: 'people', ref_id: pid, field: 'phone', method: 'format + listing match', result: conf > 0.3 ? 'pass' : 'warn' });
  insert(db, 'verifications', { ref_table: 'people', ref_id: pid, field: 'email', method: 'MX record', result: conf > 0.7 ? 'pass' : conf > 0.4 ? 'warn' : 'fail' });
}
logActivity(db, { agent: 'verifier', action: 'verify.done', detail: { summary: `checked ${n} demo leads` } });
logActivity(db, { agent: 'applier', action: 'approval.request', ref_table: 'applications', ref_id: pendingApp, detail: { reason: 'big company' } });
console.log(JSON.stringify({ workspace: slug, organizations: orgs.length + n, leads: n }));

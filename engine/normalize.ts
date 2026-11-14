import { resolveMx, Resolver } from 'node:dns/promises';

// Public resolvers, used only when the system resolver itself is unreachable (seen 2026-11-04: Node pointed at
// 127.0.0.1 and every lookup, gmail.com included, failed ECONNREFUSED, so every email scored "no mail").
const publicResolver = new Resolver({ timeout: 4000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);
const NO_SUCH_DOMAIN = new Set(['ENOTFOUND', 'ENODATA', 'ENONAME', 'NXDOMAIN']);

// Hosts that are platforms, not a company's own domain; never dedupe organizations on these.
const SHARED_HOSTS = new Set([
  'linkedin.com', 'instagram.com', 'facebook.com', 'wa.me', 'whatsapp.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
  'linktr.ee', 'wellfound.com', 'angel.co', 'ycombinator.com', 'workatastartup.com', 'naukri.com', 'internshala.com',
  'justdial.com', 'practo.com', 'lybrate.com', 'indiamart.com', 'sites.google.com', 'wixsite.com', 'blogspot.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'notion.site', 'carrd.co', 'business.site',
]);

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s.includes('@')) s = s.split('@').pop()!;
  if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/^www\d?\./, '').replace(/\.$/, '');
  if (!host.includes('.')) return null;
  for (const shared of SHARED_HOSTS) if (host === shared || host.endsWith(`.${shared}`)) return null;
  return host;
}

export type Phone = { e164: string | null; type: 'mobile' | 'landline' | 'tollfree' | 'unknown'; valid: boolean; input: string };

// India-first normaliser. Mobiles are 10 digits starting 6-9; landlines are STD code + number (10 digits without the 0).
export function normalizePhone(input: string, defaultCountry = '91'): Phone {
  const raw = input.trim();
  let d = raw.replace(/[^\d+]/g, '');
  const bad: Phone = { e164: null, type: 'unknown', valid: false, input: raw };
  if (!d) return bad;
  if (d.startsWith('+')) {
    d = d.slice(1);
    if (!d.startsWith('91')) return d.length >= 8 && d.length <= 15 ? { e164: `+${d}`, type: 'unknown', valid: true, input: raw } : bad;
    d = d.slice(2);
  } else if (d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.startsWith('1800') || d.startsWith('1860')) return { e164: `+${defaultCountry}${d}`, type: 'tollfree', valid: d.length >= 10 && d.length <= 11, input: raw };
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10) return bad;
  const type = /^[6-9]/.test(d) ? 'mobile' : /^[1-5]/.test(d) ? 'landline' : 'unknown';
  return { e164: `+${defaultCountry}${d}`, type, valid: type !== 'unknown', input: raw };
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ROLE_LOCALS = new Set(['info', 'care', 'support', 'hello', 'contact', 'admin', 'sales', 'help', 'enquiry', 'enquiries', 'office', 'team', 'noreply', 'no-reply', 'hr', 'careers', 'jobs', 'hiring']);
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'rediffmail.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com']);

export function emailSyntax(email: string): { valid: boolean; role: boolean; free: boolean; normalized: string } {
  const normalized = email.trim().toLowerCase();
  const [local, domain] = normalized.split('@');
  return { valid: EMAIL_RE.test(normalized), role: ROLE_LOCALS.has(local ?? ''), free: FREE_MAIL.has(domain ?? ''), normalized };
}

export async function hasMx(domain: string): Promise<boolean> {
  try { return (await resolveMx(domain)).length > 0; } catch (e) {
    // A real "no such domain / no MX" answer is final; a resolver failure is retried on public DNS.
    if (NO_SUCH_DOMAIN.has(String((e as { code?: string }).code))) return false;
    try { return (await publicResolver.resolveMx(domain)).length > 0; } catch { return false; }
  }
}

// Common corporate patterns, most frequent first. Guesses are never "verified"; the verifier or a bounce decides.
export function guessEmails(first: string, last: string, domain: string): string[] {
  const f = first.toLowerCase().replace(/[^a-z]/g, '');
  const l = last.toLowerCase().replace(/[^a-z]/g, '');
  if (!f) return [];
  const list = l
    ? [`${f}@${domain}`, `${f}.${l}@${domain}`, `${f}${l}@${domain}`, `${f[0]}${l}@${domain}`, `${f}${l[0]}@${domain}`, `${f}_${l}@${domain}`, `${l}.${f}@${domain}`, `${f[0]}.${l}@${domain}`]
    : [`${f}@${domain}`];
  return [...new Set(list)];
}

export function slugKey(...parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).join('|');
}

// Company names are written many ways ("JPMorganChase", "JPMorgan Chase & Co."). Two names are the same company when
// they match with spaces and punctuation removed, or when the shorter one (5+ characters) starts the longer one.
// Erring towards a match is the safe side: a match only ever adds an approval or a block.
export const nameKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function sameCompany(a: string, b: string): boolean {
  const x = nameKey(a), y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 5 && long.startsWith(short);
}

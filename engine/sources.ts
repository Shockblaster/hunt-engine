// Free, public job sources. Each returns normalised postings; the scout scores them and decides what to store.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.ts';

export type Posting = {
  source: string; company: string; title: string; url: string; location: string | null; remote: boolean | null;
  posted_at: string | null; description: string | null; department?: string | null; pay?: string | null; company_domain?: string | null;
};

const UA = { 'User-Agent': 'Mozilla/5.0 (HuntEngine personal job search; contact via the person running it)' };

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { ...UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function stripHtml(html: string | null | undefined, max = 6000): string | null {
  if (!html) return null;
  const decoded = html.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return decoded.replace(/<(br|\/p|\/li|\/h\d)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim().slice(0, max);
}

const isRemote = (s: string | null | undefined) => (s ? /remote|anywhere|work from home|wfh/i.test(s) : null);
const iso = (v: string | number | null | undefined) => (v == null || v === '' ? null : new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v).toISOString().slice(0, 10));

export async function greenhouse(board: string): Promise<Posting[]> {
  const d = await json<{ jobs: { title: string; absolute_url: string; location?: { name: string }; updated_at?: string; first_published?: string; content?: string; departments?: { name: string }[] }[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`);
  return d.jobs.map((j) => ({ source: 'greenhouse', company: board, title: j.title, url: j.absolute_url, location: j.location?.name ?? null, remote: isRemote(j.location?.name), posted_at: iso(j.first_published ?? j.updated_at), description: stripHtml(j.content), department: j.departments?.[0]?.name ?? null }));
}

export async function lever(company: string): Promise<Posting[]> {
  const d = await json<{ text: string; hostedUrl: string; categories?: { location?: string; team?: string; commitment?: string }; createdAt?: number; descriptionPlain?: string; workplaceType?: string; salaryRange?: { min: number; max: number; currency: string } }[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`);
  return d.map((j) => ({ source: 'lever', company, title: j.text, url: j.hostedUrl, location: j.categories?.location ?? null, remote: j.workplaceType ? j.workplaceType === 'remote' : isRemote(j.categories?.location), posted_at: iso(j.createdAt), description: j.descriptionPlain?.slice(0, 6000) ?? null, department: j.categories?.team ?? null, pay: j.salaryRange ? `${j.salaryRange.currency} ${j.salaryRange.min}-${j.salaryRange.max}` : null }));
}

export async function ashby(org: string): Promise<Posting[]> {
  const d = await json<{ jobs: { title: string; jobUrl: string; location?: string; isRemote?: boolean; publishedAt?: string; descriptionPlain?: string; department?: string; compensation?: { compensationTierSummary?: string } }[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}?includeCompensation=true`);
  return d.jobs.map((j) => ({ source: 'ashby', company: org, title: j.title, url: j.jobUrl, location: j.location ?? null, remote: j.isRemote ?? isRemote(j.location), posted_at: iso(j.publishedAt), description: j.descriptionPlain?.slice(0, 6000) ?? null, department: j.department ?? null, pay: j.compensation?.compensationTierSummary ?? null }));
}

export async function workable(account: string): Promise<Posting[]> {
  const d = await json<{ jobs: { title: string; shortcode: string; url?: string; city?: string; country?: string; telecommuting?: boolean; published_on?: string; department?: string }[] }>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account)}`);
  return d.jobs.map((j) => ({ source: 'workable', company: account, title: j.title, url: j.url ?? `https://apply.workable.com/${account}/j/${j.shortcode}/`, location: [j.city, j.country].filter(Boolean).join(', ') || null, remote: j.telecommuting ?? null, posted_at: iso(j.published_on), description: null, department: j.department ?? null }));
}

// The newest "Ask HN: Who is hiring?" thread; each top-level comment is one company's post.
export async function hnWhoIsHiring(): Promise<Posting[]> {
  const s = await json<{ hits: { objectID: string; title: string; created_at: string }[] }>('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10');
  const story = s.hits.find((h) => /who is hiring/i.test(h.title));
  if (!story) return [];
  const item = await json<{ children: { id: number; text: string | null; created_at: string }[] }>(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  return item.children.filter((c) => c.text).map((c) => {
    const text = stripHtml(c.text, 4000) ?? '';
    const first = text.split('\n')[0];
    const parts = first.split('|').map((x) => x.trim());
    return { source: 'hn', company: parts[0] ?? 'unknown', title: parts.slice(1, 3).join(' | ') || first.slice(0, 120), url: `https://news.ycombinator.com/item?id=${c.id}`, location: parts.find((p) => /remote|onsite|hybrid|india|bangalore|bengaluru|mumbai|delhi|pune|hyderabad/i.test(p)) ?? null, remote: isRemote(first), posted_at: iso(c.created_at), description: text };
  });
}

export async function remoteok(): Promise<Posting[]> {
  const d = await json<({ position?: string; company?: string; url?: string; location?: string; date?: string; description?: string; salary_min?: number; salary_max?: number; tags?: string[] })[]>('https://remoteok.com/api');
  return d.filter((j) => j.position).map((j) => ({ source: 'remoteok', company: j.company ?? '', title: j.position!, url: j.url ?? '', location: j.location || 'Remote', remote: true, posted_at: iso(j.date), description: stripHtml(j.description, 4000), pay: j.salary_min ? `USD ${j.salary_min}-${j.salary_max}` : null }));
}

export async function himalayas(limit = 100): Promise<Posting[]> {
  const d = await json<{ jobs: { title: string; companyName: string; applicationLink?: string; guid?: string; locationRestrictions?: string[]; pubDate?: number; excerpt?: string; minSalary?: number; maxSalary?: number; currency?: string }[] }>(`https://himalayas.app/jobs/api?limit=${limit}`);
  return d.jobs.map((j) => ({ source: 'himalayas', company: j.companyName, title: j.title, url: j.applicationLink ?? j.guid ?? '', location: j.locationRestrictions?.join(', ') || 'Remote', remote: true, posted_at: iso(j.pubDate), description: j.excerpt ?? null, pay: j.minSalary ? `${j.currency ?? ''} ${j.minSalary}-${j.maxSalary}` : null }));
}

// Funding and launch news (Entrackr, Inc42, YourStory, Product Hunt...). Items are signals, not postings: the scout checks each company's careers page.
export async function rss(url: string): Promise<{ title: string; link: string; date: string | null; summary: string | null }[]> {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const xml = await r.text();
  const items = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1);
  const tag = (s: string, t: string) => new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`, 'i').exec(s)?.[1]?.trim() ?? null;
  return items.map((it) => ({
    title: stripHtml(tag(it, 'title'), 300) ?? '',
    link: tag(it, 'link') ?? /<link[^>]+href="([^"]+)"/i.exec(it)?.[1] ?? '',
    date: iso(tag(it, 'pubDate') ?? tag(it, 'published') ?? tag(it, 'updated')),
    summary: stripHtml(tag(it, 'description') ?? tag(it, 'summary'), 600),
  }));
}

// LinkedIn, Indeed, Naukri, Glassdoor and Google Jobs through the open-source JobSpy library (run with uv, nothing installed globally).
export function jobspy(opts: { term: string; location: string; sites?: string[]; hours?: number; results?: number; country?: string }): Posting[] {
  const script = join(REPO_ROOT, 'engine', 'adapters', 'python', 'jobspy_search.py');
  const args = ['run', '--quiet', '--with', 'python-jobspy', 'python', '-I', script, JSON.stringify({ sites: ['linkedin', 'indeed', 'naukri', 'google'], hours: 168, results: 40, country: 'India', ...opts })];
  const r = spawnSync('uv', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`jobspy failed: ${(r.stderr || r.stdout).slice(-800)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '[]') as Posting[];
}

// Freelance samples and proposals: quick, specific, clearly labelled concepts built from a business's public details,
// rendered to a phone-sized PNG (for email or WhatsApp) and proposals to PDF.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOME } from './paths.ts';
import { findChrome, htmlToPdf } from './docs.ts';
import { slugKey } from './normalize.ts';

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const label = (name: string) => `Unsolicited concept for ${esc(name)}, made from your public listing. Not affiliated with or endorsed by ${esc(name)}.`;

export type SampleData = {
  name: string; category?: string; area?: string; city?: string; tagline?: string; rating?: number; reviews?: number;
  phone?: string; services?: string[]; hours?: string; photos?: string[]; color?: string; hooks?: string[]; shots?: string[]; quote?: { text: string; author?: string };
  before?: { website?: string; photos?: number; description?: string; booking?: string };
};

function shell(title: string, body: string, color: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=390"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:"Segoe UI",Roboto,Arial,sans-serif;color:#1d2228;background:#fff;width:390px}
.tag{font-size:10px;color:#6b7280;padding:6px 14px;background:#f5f5f4;border-bottom:1px solid #e7e5e4}
.hero{padding:26px 18px 22px;background:${color};color:#fff}.hero h1{margin:0 0 6px;font-size:28px;line-height:1.1}
.hero p{margin:0;opacity:.92;font-size:15px}.stars{margin-top:10px;font-size:14px;font-weight:600}
.cta{display:block;margin:16px 0 0;padding:13px;border-radius:10px;background:#fff;color:${color};font-weight:700;text-align:center;text-decoration:none}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:4px}.photos img{width:100%;height:120px;object-fit:cover;border-radius:4px}
section{padding:16px 18px;border-bottom:1px solid #eee}h2{font-size:16px;margin:0 0 8px}ul{margin:0;padding-left:18px}li{margin:3px 0}
.row{display:flex;gap:10px}.col{flex:1;padding:12px;border-radius:10px}.bad{background:#fef2f2}.good{background:#f0fdf4}
.small{font-size:12px;color:#6b7280}.hook{padding:10px 12px;margin:8px 0;border-left:4px solid ${color};background:#fafaf9;font-weight:600}
</style></head><body>${body}</body></html>`;
}

export function homepageHtml(d: SampleData): string {
  const color = d.color ?? '#1f6f5c';
  const wa = d.phone ? `https://wa.me/${d.phone.replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${d.name}, I'd like to book`)}` : '#';
  return shell(d.name, `
<div class="tag">${label(d.name)}</div>
<div class="hero"><h1>${esc(d.name)}</h1><p>${esc(d.tagline ?? [d.category, d.area].filter(Boolean).join(' in '))}</p>
${d.rating ? `<div class="stars">★ ${esc(d.rating)} from ${esc(d.reviews ?? 0)} Google reviews</div>` : ''}
<a class="cta" href="${esc(wa)}">Book on WhatsApp</a></div>
${d.photos?.length ? `<div class="photos">${d.photos.slice(0, 4).map((p) => `<img src="${esc(p)}" alt="">`).join('')}</div>` : ''}
${d.quote?.text ? `<section><div style="font-size:15px;font-style:italic">“${esc(d.quote.text)}”</div><div class="small">${esc(d.quote.author ?? 'A Google review')}</div></section>` : ''}
${d.services?.length ? `<section><h2>What we offer</h2><ul>${d.services.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></section>` : ''}
<section><h2>Visit us</h2><div>${esc([d.area, d.city].filter(Boolean).join(', '))}</div>${d.hours ? `<div class="small">${esc(d.hours)}</div>` : ''}</section>`, color);
}

export function listingCardHtml(d: SampleData): string {
  const color = d.color ?? '#1f6f5c';
  const b = d.before ?? {};
  return shell(`${d.name}: listing`, `
<div class="tag">${label(d.name)}</div>
<section><h2>${esc(d.name)} on Google today, and with five fixes</h2>
<div class="row"><div class="col bad"><b>Today</b><ul>
<li>Website: ${esc(b.website ?? 'none')}</li><li>Photos: ${esc(b.photos ?? 'few')}</li><li>Description: ${esc(b.description ?? 'missing')}</li><li>Booking link: ${esc(b.booking ?? 'none')}</li></ul></div>
<div class="col good"><b>After</b><ul><li>One-page site with WhatsApp booking</li><li>12+ fresh photos</li><li>Description with your services and area</li><li>Booking link on the listing</li><li>Weekly post</li></ul></div></div>
<p class="small">${d.rating ? `You already have ★ ${esc(d.rating)} from ${esc(d.reviews ?? 0)} reviews: the listing just needs to turn that into bookings.` : ''}</p></section>`, color);
}

export function reelHooksHtml(d: SampleData): string {
  const color = d.color ?? '#1f6f5c';
  return shell(`${d.name}: reel ideas`, `
<div class="tag">${label(d.name)}</div>
<section><h2>Three reel openings for ${esc(d.name)}</h2>${(d.hooks ?? []).slice(0, 3).map((h) => `<div class="hook">${esc(h)}</div>`).join('')}</section>
${d.shots?.length ? `<section><h2>Six shots, 20 seconds</h2><ol>${d.shots.slice(0, 6).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>` : ''}`, color);
}

// Screenshot at phone width with the private Chrome profile (see htmlToPdf for why).
export function screenshot(html: string, png: string, height = 1400): void {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome or Edge not found; set CHROME_PATH');
  const profile = join(HOME, 'chrome-pdf');
  mkdirSync(profile, { recursive: true });
  rmSync(png, { force: true });
  spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${profile}`, '--force-device-scale-factor=2', `--window-size=390,${height}`, `--screenshot=${resolve(png)}`, pathToFileURL(resolve(html)).href], { encoding: 'utf8', timeout: 120_000 });
  if (!existsSync(png) || statSync(png).size < 1000) throw new Error('screenshot not written');
  // Crop the blank space below the content so the image reads well in a chat.
  const crop = [
    'import sys',
    'from PIL import Image, ImageChops',
    "im = Image.open(sys.argv[1]).convert('RGB')",
    "b = ImageChops.difference(im, Image.new('RGB', im.size, (255, 255, 255))).getbbox()",
    'if b: im.crop((0, 0, im.width, min(im.height, b[3] + 40))).save(sys.argv[1])',
  ].join('\n');
  spawnSync('uv', ['run', '--quiet', '--with', 'pillow', 'python', '-I', '-c', crop, resolve(png)], { encoding: 'utf8', timeout: 120_000 });
}

export function buildSample(dir: string, kind: 'homepage' | 'listing' | 'reel', d: SampleData): { html: string; png: string } {
  if (!d.name) throw new Error('sample data needs the business name');
  if (kind === 'reel' && !(d.hooks?.length)) throw new Error('reel samples need hooks');
  const sub = join(dir, slugKey(d.name).slice(0, 50));
  mkdirSync(sub, { recursive: true });
  const html = join(sub, `${kind}.html`);
  writeFileSync(html, kind === 'homepage' ? homepageHtml(d) : kind === 'listing' ? listingCardHtml(d) : reelHooksHtml(d));
  const png = join(sub, `${kind}.png`);
  screenshot(html, png, 2400);
  return { html, png };
}

// ---- Proposal: the client's goal in their words, scope, exclusions, timeline, price and terms from the profile.
export type Proposal = { client: string; contact?: string; goal: string; scope: string[]; not_included?: string[]; timeline: string; price: string; terms: string[]; next_step: string; from: { name: string; studio?: string; email?: string; phone?: string } };

export function proposalHtml(p: Proposal): string {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:0.8in}body{font-family:Calibri,Carlito,"Segoe UI",Arial,sans-serif;font-size:11pt;line-height:1.45;color:#1a1a1a}
h1{font-size:20pt;margin:0}h2{font-size:12.5pt;margin:16pt 0 4pt;border-bottom:.75pt solid #1a1a1a;padding-bottom:2pt}.m{color:#555;font-size:10pt}ul{margin:2pt 0 0 0;padding-left:16pt}
.price{font-size:14pt;font-weight:700}</style></head><body>
<h1>Proposal for ${esc(p.client)}</h1><div class="m">${esc(date)}${p.contact ? `, for ${esc(p.contact)}` : ''}. From ${esc(p.from.name)}${p.from.studio ? `, ${esc(p.from.studio)}` : ''}</div>
<h2>What you want</h2><p>${esc(p.goal)}</p>
<h2>What I will deliver</h2><ul>${p.scope.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
${p.not_included?.length ? `<h2>Not included</h2><ul>${p.not_included.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
<h2>Timeline</h2><p>${esc(p.timeline)}</p>
<h2>Price</h2><p class="price">${esc(p.price)}</p>
<h2>Terms</h2><ul>${p.terms.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<h2>Next step</h2><p>${esc(p.next_step)}</p>
<p class="m">${esc([p.from.email, p.from.phone].filter(Boolean).join('  |  '))}</p></body></html>`;
}

export function buildProposal(dir: string, p: Proposal): { html: string; pdf: string; problems: string[] } {
  const problems: string[] = [];
  if (!p.scope?.length) problems.push('scope is empty');
  if (!/\d/.test(p.price ?? '')) problems.push('price has no amount');
  if (/—/.test(JSON.stringify(p))) problems.push('contains an em dash');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `proposal-${slugKey(p.client).slice(0, 50)}-${new Date().toISOString().slice(0, 10)}`);
  writeFileSync(`${base}.html`, proposalHtml(p));
  htmlToPdf(`${base}.html`, `${base}.pdf`);
  return { html: `${base}.html`, pdf: `${base}.pdf`, problems };
}

export function waLink(phone: string, text: string): string {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(text)}`;
}

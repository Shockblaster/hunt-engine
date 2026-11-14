import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGosom, inArea, dedupePlaces, extractContacts } from '../collect.ts';

// Shape of gosom's JSON output (one object per line), as documented in its README.
const FIXTURE = [
  { title: 'Demo Dietitian, RD', category: 'Dietitian', address: '12 Hill Rd, Bandra West, Mumbai, Maharashtra 400050', phone: '098200 55501', web_site: 'https://www.demodietitian.example/', review_count: 210, review_rating: 4.8, latitude: 19.05, longitude: 72.83, link: 'https://www.google.com/maps/place/a', place_id: 'P1', status: '', complete_address: { postal_code: '400050', city: 'Mumbai' } },
  { title: 'Khar Diet Studio', category: 'Nutritionist', address: 'Linking Rd, Khar West, Mumbai, Maharashtra 400052', phone: '+91 98200 11111', review_count: 40, review_rating: 4.5, link: 'https://www.google.com/maps/place/b', place_id: 'P2' },
  { title: 'Demo Dietitian, RD', category: 'Dietitian', address: '12 Hill Rd, Bandra West, Mumbai 400050', phone: '+91 98200 55501', link: 'https://www.google.com/maps/place/c', place_id: 'P3' },
  { title: 'FitLife Supplements', category: 'Vitamin & supplements store', address: 'Turner Rd, Bandra West, Mumbai 400050', phone: '022 2640 1234', link: 'https://www.google.com/maps/place/d', place_id: 'P4', status: 'Permanently closed' },
].map((o) => JSON.stringify(o)).join('\n');

test('parses gosom JSON lines into places with pincode and E.164 phone', () => {
  const p = parseGosom(FIXTURE);
  assert.equal(p.length, 4);
  assert.equal(p[0].pincode, '400050');
  assert.equal(p[0].phone_e164, '+919820055501');
  assert.equal(p[0].rating, 4.8);
  assert.equal(p[0].website, 'https://www.demodietitian.example/', 'reads gosom web_site');
  assert.equal(p[1].pincode, '400052');
  assert.equal(parseGosom('[' + FIXTURE.split('\n').join(',') + ']').length, 4, 'also reads a JSON array');
});

test('area filter keeps the asked-for pincode and drops the Khar bleed', () => {
  const p = parseGosom(FIXTURE);
  const area = { localities: ['Bandra West'], pincodes: ['400050'] };
  const kept = p.filter((x) => inArea(x, area)).map((x) => x.name);
  assert.ok(kept.includes('Demo Dietitian, RD'));
  assert.ok(!kept.includes('Khar Diet Studio'));
  assert.equal(inArea(p[1], {}), true, 'no area means keep everything');
});

test('dedupe on place id, phone, or name + address', () => {
  const p = dedupePlaces(parseGosom(FIXTURE));
  assert.equal(p.filter((x) => x.name === 'Demo Dietitian, RD').length, 1, 'same phone, different listing id');
});

test('extracts published contacts and ignores image names and placeholders', () => {
  const html = `<title>Riya Nutrition</title><a href="mailto:hello@riyanutrition.in">mail</a> write to riya [at] riyanutrition [dot] in
    <img src="logo@2x.png"> example@example.com <a href="tel:+91 98200 12345">call</a> 098200 54321
    <a href="https://instagram.com/riya.nutrition">ig</a> <a href="https://www.instagram.com/p/abc">post</a>`;
  const c = extractContacts(html);
  assert.deepEqual(c.emails.sort(), ['hello@riyanutrition.in', 'riya@riyanutrition.in']);
  assert.deepEqual(c.phones.sort(), ['+919820012345', '+919820054321']);
  assert.deepEqual(c.instagram, ['https://instagram.com/riya.nutrition']);
  assert.equal(c.title, 'Riya Nutrition');
});

test('lead confidence follows the verifier weights and caps', async () => {
  const { score } = await import('../verify.ts');
  assert.equal(score({ phone: 'pass', email: 'pass', listing: 'pass', website: 'pass', name: 'pass' }), 1);
  assert.equal(score({ phone: 'warn', email: 'warn', listing: 'pass', website: 'warn', name: 'warn' }), 0.6);
  assert.equal(score({ phone: 'fail', email: 'pass', listing: 'pass', website: 'pass', name: 'pass' }), 0.4);
});

test('template phone numbers on websites are ignored', () => {
  assert.deepEqual(extractContacts('<p>Call 98765 43210 or 98200 12345</p>').phones, ['+919820012345']);
});

test('a collector that stops writing but keeps running is ended, with what it wrote kept', async () => {
  const { runWatched } = await import('../collect.ts');
  const { mkdtempSync, readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const { join: j } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(j(tmpdir(), 'he-stall-'));
  const out = j(dir, 'out.json');
  const script = j(dir, 'hang.mjs');
  // Writes one result, then hangs with a child process of its own (like gosom's browser).
  wf(script, `import { writeFileSync } from 'node:fs'; import { spawn } from 'node:child_process';
writeFileSync(${JSON.stringify(out)}, ${JSON.stringify(JSON.stringify({ title: 'Hung Diet Clinic' }) + '\n')});
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
setInterval(() => {}, 1000);`);
  const r = await runWatched(process.execPath, [script], dir, out, { stallMs: 1500, maxMs: 30_000, pollMs: 200 });
  assert.equal(r.stalled, true);
  assert.ok(r.ms < 15_000, `ended in ${r.ms} ms`);
  assert.equal(parseGosom(rf(out, 'utf8'))[0].name, 'Hung Diet Clinic');
});

test('a half-written last line from an ended collector is skipped, not fatal', () => {
  assert.equal(parseGosom('{"title":"A"}\n{"title":"B", "cat').length, 1);
});

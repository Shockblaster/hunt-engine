// Small practices without a website: not marked down, and delivered as their own band.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, insert } from '../db.ts';
import type { Row } from '../db.ts';
import { verifyLeads, withTag, LISTING_CHECKED } from '../verify.ts';

function lead(db: ReturnType<typeof openMemoryDb>, name: string, reviews: number, phone: string, tags?: string): number {
  const org = insert(db, 'organizations', { name, reviews, sector: 'Dietitian', campaign: 'c', source_url: 'https://maps/x', tier: 'small' });
  return insert(db, 'people', { name, organization_id: org, phone_e164: phone, phone: phone, campaign: 'c', source_url: 'https://maps/x', ...(tags ? { tags } : {}) });
}

test('a small practice with a valid phone and real reviews is listing-checked, not verified', async () => {
  const db = openMemoryDb();
  const good = lead(db, 'Dt. Asha Diet Care', 12, '+919876543210', 'segment:solo');
  const fewReviews = lead(db, 'Nutri Corner', 1, '+919812345678');
  const badPhone = lead(db, 'Diet Point', 20, '12345');
  const res = await verifyLeads(db, { campaign: 'c' });
  const get = (id: number) => db.prepare('SELECT confidence, tags FROM people WHERE id = ?').get(id) as Row;

  const g = get(good);
  assert.ok(Number(g.confidence) < 0.7, 'one phone source is never called verified');
  assert.equal(Number(g.confidence), 0.65, 'not marked down for a missing website, email or name, but held below verified');
  assert.equal(g.tags, `segment:solo,${LISTING_CHECKED}`, 'existing tags are kept');
  assert.equal(get(fewReviews).tags, null, 'too few reviews to count');
  assert.equal(get(badPhone).tags, null);
  assert.ok(Number(get(badPhone).confidence) <= 0.4);
  assert.equal(res.listing_checked, 1);

  const logged = db.prepare(`SELECT field, detail FROM verifications WHERE ref_id = ? AND detail LIKE '%not scored%'`).all(good) as Row[];
  assert.deepEqual(logged.map((r) => r.field).sort(), ['email', 'name', 'website']);
});

test('withTag adds once and removes cleanly', () => {
  assert.equal(withTag(null, 'x', true), 'x');
  assert.equal(withTag('a,x', 'x', true), 'a,x');
  assert.equal(withTag('a, x ,b', 'x', false), 'a,b');
  assert.equal(withTag('x', 'x', false), null);
});

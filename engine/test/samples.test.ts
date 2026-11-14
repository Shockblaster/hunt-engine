import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waLink, homepageHtml, proposalHtml } from '../samples.ts';

test('WhatsApp links add the India code to 10-digit numbers and carry the text', () => {
  assert.equal(waLink('98200 12345', 'Hi there'), 'https://wa.me/919820012345?text=Hi%20there');
  assert.equal(waLink('+44 7700 900123', 'x'), 'https://wa.me/447700900123?text=x');
});

test('samples are labelled as unsolicited concepts and escape their data', () => {
  const h = homepageHtml({ name: 'Bloom <Bakery>', rating: 4.7, reviews: 320, phone: '+91 98200 12345' });
  assert.match(h, /Unsolicited concept for Bloom &lt;Bakery&gt;/);
  assert.ok(!h.includes('<Bakery>'));
  assert.match(h, /wa\.me\/919820012345/);
});

test('proposals show scope, price and terms', () => {
  const h = proposalHtml({ client: 'Bloom', goal: 'Take orders online', scope: ['One-page site'], timeline: '1 week', price: 'Rs 7,999', terms: ['50% advance'], next_step: 'Reply yes', from: { name: 'A' } });
  assert.match(h, /One-page site/);
  assert.match(h, /Rs 7,999/);
});

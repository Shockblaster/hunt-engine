// Gmail accounts: an app password, or a Google sign-in stored by `he mail connect`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// paths.ts reads HE_HOME when it is first imported, so set it before loading the engine.
const home = mkdtempSync(join(tmpdir(), 'he-oauth-'));
process.env.HE_HOME = home;
const { accountFor, smtpAuth } = await import('../mail.ts');
const ws = join(home, 'workspaces', 'o');
mkdirSync(ws, { recursive: true });

test('an app password wins; a Google sign-in is used when there is none', () => {
  writeFileSync(join(ws, '.env'), 'OUTREACH_EMAIL=Out@Example.com\nGOOGLE_OAUTH_CLIENT_ID=cid\nGOOGLE_OAUTH_CLIENT_SECRET=csec\n');
  assert.equal(accountFor('o', 'freelance'), null, 'no token file yet');

  writeFileSync(join(ws, '.oauth-outreach.json'), JSON.stringify({ email: 'out@example.com', refresh_token: 'rt', client_id: 'cid' }));
  const a = accountFor('o', 'freelance')!;
  assert.equal(a.address, 'out@example.com');
  assert.deepEqual(a.oauth, { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt' });
  assert.deepEqual(smtpAuth(a), { type: 'OAuth2', user: 'out@example.com', clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt' });

  writeFileSync(join(ws, '.env'), 'OUTREACH_EMAIL=out@example.com\nOUTREACH_EMAIL_APP_PASSWORD=abcd efgh\nGOOGLE_OAUTH_CLIENT_ID=cid\nGOOGLE_OAUTH_CLIENT_SECRET=csec\n');
  const p = accountFor('o', 'freelance')!;
  assert.equal(p.oauth, undefined);
  assert.deepEqual(smtpAuth(p), { user: 'out@example.com', pass: 'abcdefgh' });
});

test('a token file without the client id and secret is not enough', () => {
  writeFileSync(join(ws, '.env'), 'OUTREACH_EMAIL=out@example.com\n');
  assert.equal(accountFor('o', 'freelance'), null);
});

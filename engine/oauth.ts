// Gmail through Google sign-in (OAuth) for accounts where app passwords are blocked.
// The person creates a Desktop OAuth client in their own Google Cloud project and puts its id and secret in the
// workspace .env; `he mail connect` opens Google's consent page, catches the reply on a local port, and stores the
// refresh token in the workspace (never in the database or logs). Sending and reading then use short-lived tokens.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { workspaceDir } from './paths.ts';
import { loadEnv } from './mail.ts';

const SCOPE = 'https://mail.google.com/';
type Which = 'job' | 'outreach';
type TokenFile = { email: string; refresh_token: string; client_id: string; created_at: string };

const tokenPath = (slug: string, which: Which) => join(workspaceDir(slug), `.oauth-${which}.json`);

export function oauthClient(slug: string): { id: string; secret: string } | null {
  const env = loadEnv(slug);
  return env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET ? { id: env.GOOGLE_OAUTH_CLIENT_ID, secret: env.GOOGLE_OAUTH_CLIENT_SECRET } : null;
}

export function storedToken(slug: string, which: Which): TokenFile | null {
  const f = tokenPath(slug, which);
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as TokenFile) : null;
}

function openBrowser(url: string): void {
  const cmd = platform() === 'win32' ? 'cmd' : platform() === 'darwin' ? 'open' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '""', url.replace(/&/g, '^&')] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

// Loopback flow with PKCE (Google's recommended method for installed apps).
export async function connect(slug: string, which: Which, expectEmail?: string): Promise<{ email: string; stored: string }> {
  const client = oauthClient(slug);
  if (!client) throw new Error('add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to the workspace .env first');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const { code, redirect } = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
    let port = 0;
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const ok = url.searchParams.get('state') === state && url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(ok
        ? '<h2>Connected. You can close this tab and go back to Claude Code.</h2>'
        : `<h2>That did not work: ${url.searchParams.get('error') ?? 'unexpected reply'}. Close this tab and try again.</h2>`);
      server.close();
      // The port is read at listen time: after close() the server no longer has an address.
      if (ok) resolve({ code: url.searchParams.get('code')!, redirect: `http://127.0.0.1:${port}/callback` });
      else reject(new Error(url.searchParams.get('error') ?? 'consent was not completed'));
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      auth.search = new URLSearchParams({
        client_id: client.id, redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: 'code', scope: `${SCOPE} openid email`,
        access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
        ...(expectEmail ? { login_hint: expectEmail } : {}),
      }).toString();
      console.error(`Opening Google sign-in. If no browser opens, visit:\n${auth.href}`);
      openBrowser(auth.href);
    });
    setTimeout(() => { server.close(); reject(new Error('timed out after 5 minutes waiting for the Google sign-in')); }, 5 * 60_000).unref();
  });
  const tok = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
  }).then((r) => r.json()) as { refresh_token?: string; id_token?: string; error?: string; error_description?: string };
  if (!tok.refresh_token) throw new Error(`Google did not return a sign-in token: ${tok.error_description ?? tok.error ?? 'unknown error'}`);
  const email = tok.id_token ? String((JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString()) as { email?: string }).email ?? '') : '';
  if (expectEmail && email && email.toLowerCase() !== expectEmail.toLowerCase()) throw new Error(`you signed in as ${email}, but this workspace expects ${expectEmail}; run it again and pick the right account`);
  const f = tokenPath(slug, which);
  writeFileSync(f, JSON.stringify({ email, refresh_token: tok.refresh_token, client_id: client.id, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch { /* Windows */ }
  return { email, stored: f };
}

// A fresh access token for IMAP (nodemailer refreshes on its own for SMTP).
export async function accessToken(slug: string, which: Which): Promise<string> {
  const client = oauthClient(slug);
  const t = storedToken(slug, which);
  if (!client || !t) throw new Error(`no Google sign-in for the ${which} account: run he mail connect ${which}`);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }),
  }).then((x) => x.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!r.access_token) throw new Error(`Google refused the stored sign-in (${r.error_description ?? r.error}); run he mail connect ${which} again`);
  return r.access_token;
}

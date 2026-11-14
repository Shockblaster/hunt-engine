import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './db.ts';
import { HOME } from './paths.ts';

export function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    ...(platform() === 'win32'
      ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
      : platform() === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Renders an HTML resume or cover letter to PDF with the installed Chrome (A4 unless the HTML sets @page).
// A private profile matters: without it Chrome hands the job to an already-running Chrome and returns before the file exists.
export function htmlToPdf(htmlPath: string, pdfPath: string): void {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome or Edge not found; set CHROME_PATH');
  const profile = join(HOME, 'chrome-pdf');
  mkdirSync(profile, { recursive: true });
  rmSync(pdfPath, { force: true });
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--no-pdf-header-footer', `--print-to-pdf=${resolve(pdfPath)}`, pathToFileURL(resolve(htmlPath)).href], { encoding: 'utf8', timeout: 120_000 });
  if (!existsSync(pdfPath) || statSync(pdfPath).size < 500) throw new Error(`PDF not written: ${(r.stderr || r.stdout).slice(-400)}`);
}

// Every number, percentage, money amount or year-span in a document must appear somewhere in the person's claims or master resume.
// This cannot judge rewording, but it catches the commonest fabrication: a figure that was never true.
export function factCheck(db: DatabaseSync, text: string, masterResume?: string): { ok: boolean; unbacked: string[]; checked: number } {
  const claims = (db.prepare(`SELECT text, evidence FROM claims WHERE status = 'active'`).all() as Row[]).map((c) => `${c.text} ${c.evidence}`).join('\n');
  const source = `${claims}\n${masterResume ?? ''}`.toLowerCase().replace(/,/g, '');
  const tokens = text.match(/(?:₹|rs\.?|inr|\$|usd)\s?\d[\d,.]*\s?(?:lakhs|lakh|crore|cr|million|mn|bn|k|l|m)?|\d[\d,.]*\s?(?:%|\+|x\b|k\b|l\b|lakh|lakhs|cr\b|crore|mn\b|million|users|members|people|clients|students|followers|views)|\b\d{2,}\b/gi) ?? [];
  const unbacked: string[] = [];
  for (const t of new Set(tokens.map((x) => x.trim()))) {
    const digits = t.toLowerCase().replace(/,/g, '').match(/\d+(?:\.\d+)?/)?.[0];
    if (!digits) continue;
    if (/^(19|20)\d\d$/.test(digits) && source.includes(digits)) continue;
    if (!source.includes(digits)) unbacked.push(t);
  }
  return { ok: unbacked.length === 0, unbacked, checked: tokens.length };
}

export function readMaster(path: string | undefined | null): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  if (/\.(md|txt|html?)$/i.test(path)) return readFileSync(path, 'utf8').replace(/<[^>]+>/g, ' ');
  return undefined;
}

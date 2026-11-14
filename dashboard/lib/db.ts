import "server-only";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cookies } from "next/headers";

export type Row = Record<string, string | number | null>;

export const HE_HOME = process.env.HE_HOME ?? join(homedir(), ".hunt-engine");

type Config = { current: string | null; workspaces: Record<string, { name: string; created_at: string }> };

export function readConfig(): Config {
  const f = join(HE_HOME, "config.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Config) : { current: null, workspaces: {} };
}

export async function currentWorkspace(): Promise<{ slug: string; name: string } | null> {
  const cfg = readConfig();
  const picked = (await cookies()).get("he_ws")?.value;
  const slug = picked && cfg.workspaces[picked] ? picked : cfg.current;
  if (!slug || !existsSync(join(HE_HOME, "workspaces", slug, "db.sqlite"))) return null;
  return { slug, name: cfg.workspaces[slug]?.name ?? slug };
}

// The dashboard only reads. Every change goes through the `he` CLI (see actions.ts), so it is logged like an agent's.
export function readDb(slug: string): DatabaseSync {
  return new DatabaseSync(join(HE_HOME, "workspaces", slug, "db.sqlite"), { readOnly: true });
}

export async function query<T = Row>(sql: string, ...args: (string | number | null)[]): Promise<T[]> {
  const ws = await currentWorkspace();
  if (!ws) return [];
  const db = readDb(ws.slug);
  try {
    return db.prepare(sql).all(...args) as T[];
  } finally {
    db.close();
  }
}

export async function one<T = Row>(sql: string, ...args: (string | number | null)[]): Promise<T | undefined> {
  return (await query<T>(sql, ...args))[0];
}

export async function count(sql: string, ...args: (string | number | null)[]): Promise<number> {
  const r = await one<{ n: number }>(sql, ...args);
  return Number(r?.n ?? 0);
}

export function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

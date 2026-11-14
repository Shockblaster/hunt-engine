"use server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { currentWorkspace, HE_HOME, readConfig } from "./db";

const run = promisify(execFile);
const CLI = join(process.cwd(), "..", "engine", "cli.ts");

// The CLI accepts dashboard decisions only with this key, which agents are blocked from reading.
function deciderKey(): string {
  const f = join(HE_HOME, ".decider-key");
  if (!existsSync(f)) writeFileSync(f, randomBytes(24).toString("hex"), { mode: 0o600 });
  return readFileSync(f, "utf8").trim();
}

async function he(args: string[]): Promise<void> {
  const ws = await currentWorkspace();
  if (!ws) throw new Error("No workspace is open");
  const env: NodeJS.ProcessEnv = { ...process.env, HE_DECIDER_KEY: deciderKey() };
  delete env.HE_HEADLESS;
  await run(process.execPath, [CLI, ...args, "--ws", ws.slug], { env });
}

// The only three things a person can change from the dashboard.
export async function decide(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const decision = formData.get("decision") === "approve" ? "approve" : "reject";
  const note = String(formData.get("note") ?? "").trim();
  if (!id) return;
  await he(["approval", "decide", String(id), decision, "--via", "dashboard", ...(note ? ["--note", note] : [])]);
  revalidatePath("/", "layout");
}

export async function revert(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  if (!id) return;
  await he(["playbook", "revert", String(id), "--via", "dashboard"]);
  revalidatePath("/", "layout");
}

export async function switchWorkspace(formData: FormData): Promise<void> {
  const slug = String(formData.get("ws") ?? "");
  if (!readConfig().workspaces[slug]) return;
  (await cookies()).set("he_ws", slug, { path: "/", sameSite: "lax", httpOnly: true, maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

import "server-only";
import { count, query } from "./db";
import type { Station } from "@/components/RouteMap";

const ORDER = ["found", "shortlisted", "preparing", "pending_review", "applied", "contacted", "replied", "interview", "offer", "won"];

const STOPS: Record<string, { label: string; from: string }[]> = {
  job: [
    { label: "Found", from: "found" }, { label: "Good fit", from: "shortlisted" }, { label: "Applied", from: "applied" },
    { label: "Replied", from: "replied" }, { label: "Interview", from: "interview" }, { label: "Offer", from: "offer" },
  ],
  freelance: [
    { label: "Found", from: "found" }, { label: "Good fit", from: "shortlisted" }, { label: "Contacted", from: "applied" },
    { label: "Replied", from: "replied" }, { label: "Call", from: "interview" }, { label: "Won", from: "won" },
  ],
};

export type Line = { track: string; stations: Station[]; dropped: number };

export async function funnel(track: "job" | "freelance"): Promise<Line> {
  const rows = await query<{ stage: string; n: number }>(`SELECT stage, count(*) AS n FROM opportunities WHERE track = ? GROUP BY stage`, track);
  const at = (stage: string) => rows.filter((r) => ORDER.indexOf(r.stage) >= ORDER.indexOf(stage)).reduce((a, r) => a + Number(r.n), 0);
  const all = rows.reduce((a, r) => a + Number(r.n), 0);
  const dropped = rows.filter((r) => ["skipped", "lost", "closed"].includes(r.stage)).reduce((a, r) => a + Number(r.n), 0);
  return {
    track,
    dropped,
    stations: STOPS[track].map((s) => ({ label: s.label, n: s.from === "found" ? all : at(s.from) })),
  };
}

export async function leadLine(): Promise<Line> {
  const base = `FROM people WHERE campaign IS NOT NULL`;
  return {
    track: "lead",
    dropped: await count(`SELECT count(*) AS n ${base} AND opt_out = 1`),
    stations: [
      { label: "Collected", n: await count(`SELECT count(*) AS n ${base}`) },
      { label: "Phone checked", n: await count(`SELECT count(*) AS n ${base} AND phone_e164 IS NOT NULL`) },
      { label: "Email found", n: await count(`SELECT count(*) AS n ${base} AND email IS NOT NULL AND email_status NOT IN ('invalid','bounced')`) },
      { label: "Verified", n: await count(`SELECT count(*) AS n ${base} AND confidence >= 0.7`) },
    ],
  };
}

export async function activeTracks(): Promise<string[]> {
  const rows = await query<{ track: string }>(
    `SELECT track FROM profiles UNION SELECT track FROM opportunities UNION SELECT 'lead' FROM people WHERE campaign IS NOT NULL`,
  );
  const set = new Set(rows.map((r) => r.track));
  const list = ["job", "freelance", "lead"].filter((t) => set.has(t));
  return list.length ? list : ["job", "freelance", "lead"];
}

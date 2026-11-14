// SQLite datetime('now') stores UTC without a zone; everything is shown in IST.
export function toDate(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const IST = "Asia/Kolkata";

export function time(v: unknown): string {
  const d = toDate(v);
  return d ? d.toLocaleTimeString("en-IN", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function day(v: unknown): string {
  const d = toDate(v);
  return d ? d.toLocaleDateString("en-IN", { timeZone: IST, day: "numeric", month: "short" }) : "";
}

export function when(v: unknown): string {
  const d = toDate(v);
  if (!d) return "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: IST });
  const that = d.toLocaleDateString("en-CA", { timeZone: IST });
  return that === today ? `today ${time(d)}` : `${day(d)}, ${time(d)}`;
}

export function ago(v: unknown): string {
  const d = toDate(v);
  if (!d) return "never";
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const dd = Math.round(h / 24);
  return `${dd} day${dd === 1 ? "" : "s"} ago`;
}

export const TRACK_NAME: Record<string, string> = { job: "Job hunt", freelance: "Freelance", lead: "Lead research" };

// Plain-language names for what agents log, so a non-technical viewer can read the activity feed.
export function describe(action: string, ref?: string | null): string {
  const map: Record<string, string> = {
    "organizations.create": "added a company",
    "organizations.merge": "updated a company it already knew",
    "organizations.update": "updated a company",
    "people.create": "added a person",
    "people.merge": "updated a person it already knew",
    "people.update": "updated a person",
    "opportunities.create": "found an opportunity",
    "opportunities.merge": "saw an opportunity again",
    "opportunities.update": "moved an opportunity forward",
    "applications.create": "prepared an application",
    "applications.update": "updated an application",
    "messages.create": "wrote a message",
    "messages.update": "updated a message",
    "approval.request": "asked you to review something",
    "approval.approved": "approved an item",
    "approval.rejected": "rejected an item",
    "playbook.set": "changed a strategy",
    "suppress.add": "added someone to do-not-contact",
    "run.start": "started work",
    "run.end": "finished work",
    "export": "exported a file",
    "mail.sent": "sent an email",
    "mail.bounced": "saw an email bounce",
    "reply.received": "got a reply",
    "application.submitted": "submitted an application",
    "linkedin.connect": "sent a LinkedIn connection request",
    "verify.done": "checked a record",
  };
  return map[action] ?? action.replace(/[._]/g, " ") + (ref ? "" : "");
}

export function agentName(a: string): string {
  if (a.startsWith("person:")) return "You";
  const names: Record<string, string> = {
    conductor: "Conductor", intake: "Intake", scout: "Scout", tailor: "Tailor", applier: "Applier",
    outreach: "Outreach", "referral-outreach": "Referrals", inbox: "Inbox", "follow-up": "Follow-up", critic: "Critic",
    "qa-gate": "QA gate", "interview-prep": "Interview prep", "sample-maker": "Sample maker", "deal-actionables": "Deal desk",
    researcher: "Researcher", "db-builder": "Database builder", verifier: "Verifier", "prospect-scout": "Prospect scout", seed: "Setup",
  };
  return names[a] ?? a.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

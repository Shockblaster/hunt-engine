import { Badge, Empty, PageHead, Section } from "@/components/ui";
import { parseJson, query } from "@/lib/db";
import { agentName, toDate, when } from "@/lib/format";

type Task = { id: number; kind: string; title: string; due_at: string | null; status: string; agent: string | null; notes: string | null; done_at: string | null; payload: string | null };
type Payload = { phone?: string; text?: string; image?: string; call_script?: string };

function waHref(phone: string, text?: string) {
  const d = phone.replace(/\D/g, "");
  return `https://wa.me/${d.length === 10 ? `91${d}` : d}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

function Actions({ t }: { t: Task }) {
  const p = parseJson<Payload>(t.payload, {});
  if (!p.phone) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
      {p.text ? <a className="btn" href={waHref(p.phone, p.text)} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>Open in WhatsApp</a> : null}
      <a className="btn ghost" href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} style={{ textDecoration: "none" }}>Call {p.phone}</a>
      {p.image ? <span className="small" style={{ color: "var(--muted)" }}>Attach: {p.image}</span> : null}
      {p.call_script ? <details style={{ width: "100%" }}><summary className="small">Call script</summary><div className="msg-body">{p.call_script}</div></details> : null}
    </div>
  );
}

const KIND: Record<string, string> = { follow_up: "follow-up", apply: "apply", research: "research", prep: "interview prep", user_action: "for you", verify: "check" };

export default async function FollowUps() {
  const open = await query<Task>(`SELECT * FROM tasks WHERE status = 'open' ORDER BY due_at IS NULL, due_at LIMIT 300`);
  const done = await query<Task>(`SELECT * FROM tasks WHERE status <> 'open' ORDER BY done_at DESC LIMIT 40`);
  const now = Date.now();
  const yours = open.filter((t) => t.kind === "user_action");
  const crew = open.filter((t) => t.kind !== "user_action");
  const row = (t: Task) => {
    const due = toDate(t.due_at);
    const late = due ? due.getTime() < now : false;
    return (
      <tr key={t.id}>
        <td className="strong">{t.title}{t.notes ? <div className="small">{t.notes}</div> : null}<Actions t={t} /></td>
        <td><Badge value={KIND[t.kind] ?? t.kind} kind="plain" /></td>
        <td style={{ color: late ? "var(--signal)" : undefined, whiteSpace: "nowrap" }}>{due ? (late ? `overdue, ${when(t.due_at)}` : when(t.due_at)) : "any time"}</td>
        <td className="small">{t.agent ? agentName(t.agent) : ""}</td>
      </tr>
    );
  };
  return (
    <>
      <PageHead title="Follow-ups">What is scheduled next. Follow-ups stop by themselves the moment someone replies.</PageHead>
      {yours.length ? (
        <Section title={`Only you can do these (${yours.length})`} sub="Signing up to a site, ticking a terms box or taking a call: agents are not allowed to do these for you.">
          <div className="panel needs table-wrap"><table className="t"><tbody>{yours.map(row)}</tbody></table></div>
        </Section>
      ) : null}
      <Section title={`The crew's queue (${crew.length})`}>
        <div className="panel table-wrap">
          {crew.length ? <table className="t"><thead><tr><th>Task</th><th>Kind</th><th>Due</th><th>Agent</th></tr></thead><tbody>{crew.map(row)}</tbody></table> : <Empty title="Nothing queued" />}
        </div>
      </Section>
      <Section title="Recently finished">
        <div className="panel table-wrap">
          {done.length ? (
            <table className="t"><tbody>{done.map((t) => <tr key={t.id}><td>{t.title}</td><td><Badge value={t.status === "done" ? "done" : "cancelled"} kind={t.status === "done" ? "good" : "plain"} /></td><td className="small">{when(t.done_at)}</td></tr>)}</tbody></table>
          ) : <Empty title="Nothing finished yet" />}
        </div>
      </Section>
    </>
  );
}

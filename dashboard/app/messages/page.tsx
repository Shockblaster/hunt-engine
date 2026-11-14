import Link from "next/link";
import { Badge, Empty, Filters, PageHead } from "@/components/ui";
import { parseJson, query } from "@/lib/db";
import { when, TRACK_NAME } from "@/lib/format";

type Msg = {
  id: number; track: string; channel: string; direction: string; account: string | null; to_address: string | null; subject: string | null; body: string;
  status: string; reply_class: string | null; sent_at: string | null; created_at: string; sequence_step: number; variant: string | null; person: string | null; org: string | null; org_id: number | null; thread_key: string | null;
};

export default async function Messages({ searchParams }: { searchParams: Promise<{ box?: string; id?: string }> }) {
  const { box, id } = await searchParams;
  const where = box === "in" ? "m.direction = 'in'" : box === "out" ? "m.direction = 'out' AND m.status IN ('sent','bounced','failed')" : box === "waiting" ? "m.status IN ('pending_review','drafted','queued','approved')" : "1 = 1";
  const msgs = await query<Msg>(
    `SELECT m.*, p.name AS person, o.name AS org, o.id AS org_id FROM messages m
     LEFT JOIN people p ON p.id = m.person_id LEFT JOIN organizations o ON o.id = m.organization_id
     WHERE ${where} ORDER BY coalesce(m.sent_at, m.created_at) DESC LIMIT 300`,
  );
  const focus = id ? Number(id) : null;
  return (
    <>
      <PageHead title="Messages">Every email, LinkedIn message and reply, word for word. Tap one to read it.</PageHead>
      <Filters base="/messages" param="box" current={box} options={[{ value: "", label: "All" }, { value: "in", label: "Replies" }, { value: "out", label: "Sent" }, { value: "waiting", label: "Not sent yet" }]} />
      <div className="panel">
        {msgs.length ? msgs.map((m) => {
          const v = parseJson<Record<string, string>>(m.variant, {});
          return (
            <details className="msg" key={m.id} open={m.id === focus} id={`m${m.id}`} style={{ padding: "12px 18px", borderTop: "1px solid var(--rule)" }}>
              <summary>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
                  <div>
                    <b>{m.direction === "in" ? `From ${m.person ?? m.to_address ?? "someone"}` : `To ${m.person ?? m.to_address ?? "someone"}`}</b>
                    {m.org ? <span style={{ color: "var(--muted)" }}> at {m.org}</span> : null}
                    <div>{m.subject ?? (m.channel === "email" ? "(no subject)" : m.channel.replace("_", " "))}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <Badge value={TRACK_NAME[m.track] ?? m.track} kind={m.track} />
                    <Badge value={m.channel} kind="plain" />
                    {m.sequence_step > 0 ? <Badge value={`follow-up ${m.sequence_step}`} kind="plain" /> : null}
                    <Badge value={m.reply_class ?? m.status} />
                    <span className="small" style={{ color: "var(--muted)", fontSize: 13 }}>{when(m.sent_at ?? m.created_at)}</span>
                  </div>
                </div>
              </summary>
              <div className="msg-body">{m.body}</div>
              <p className="small" style={{ color: "var(--muted)", fontSize: 13, margin: "8px 0 0" }}>
                {m.account ? `${m.direction === "in" ? "Received on" : "Sent from"} ${m.account}. ` : ""}
                {Object.keys(v).length ? `Strategy tags: ${Object.entries(v).map(([k, x]) => `${k} ${x}`).join(", ")}. ` : ""}
                {m.org_id ? <Link href={`/companies/${m.org_id}`}>Company page</Link> : null}
              </p>
            </details>
          );
        }) : <Empty title={box ? "Nothing in this box" : "No messages yet"}>{box ? "Try All." : "Outreach and follow-up agents write here as they send."}</Empty>}
      </div>
    </>
  );
}

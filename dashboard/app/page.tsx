import Link from "next/link";
import { RouteLine } from "@/components/RouteMap";
import { Decide } from "@/components/Decide";
import { Empty, PageHead, Section } from "@/components/ui";
import { count, query } from "@/lib/db";
import { activeTracks, funnel, leadLine } from "@/lib/funnel";
import { agentName, describe, time, when, TRACK_NAME } from "@/lib/format";

type Approval = { id: number; ref_table: string; ref_id: number; summary: string; reason: string; requested_at: string };
type Act = { id: number; at: string; agent: string; action: string; ref_table: string | null; ref_id: number | null; detail: string | null; external: number };

const COLOR: Record<string, string> = { job: "var(--job)", freelance: "var(--freelance)", lead: "var(--lead)" };

export default async function Today() {
  const approvals = await query<Approval>(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at`);
  const tracks = await activeTracks();
  const lines = await Promise.all(tracks.map((t) => (t === "lead" ? leadLine() : funnel(t as "job" | "freelance"))));
  const todayStart = new Date(`${new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}T00:00:00+05:30`).toISOString().replace("T", " ").slice(0, 19);
  const weekStart = new Date(Date.now() - 7 * 86400000).toISOString().replace("T", " ").slice(0, 19);

  const sentToday = await count(`SELECT count(*) AS n FROM messages WHERE direction = 'out' AND status = 'sent' AND sent_at >= ?`, todayStart);
  const submittedToday = await count(`SELECT count(*) AS n FROM applications WHERE status = 'submitted' AND submitted_at >= ?`, todayStart);
  const repliesWeek = await count(`SELECT count(*) AS n FROM messages WHERE direction = 'in' AND created_at >= ? AND ifnull(reply_class,'') NOT IN ('auto','ooo')`, weekStart);
  const due = await count(`SELECT count(*) AS n FROM tasks WHERE status = 'open' AND kind = 'follow_up' AND due_at <= datetime('now')`);

  let acts = await query<Act>(`SELECT * FROM activities WHERE at >= ? AND action NOT IN ('run.start') ORDER BY id DESC LIMIT 40`, todayStart);
  const showingToday = acts.length > 0;
  if (!showingToday) acts = await query<Act>(`SELECT * FROM activities WHERE action NOT IN ('run.start') ORDER BY id DESC LIMIT 15`);

  return (
    <>
      <PageHead title="Today">What your agents did, and the few things only you can decide.</PageHead>

      {approvals.length ? (
        <Section title={`Waiting for you (${approvals.length})`} sub="Big companies and anything the safety checks stopped. Nothing here goes out until you approve it.">
          <div className="panel needs">
            {approvals.map((a) => (
              <div className="needs-item" key={a.id}>
                <div>
                  <h3>{a.summary}</h3>
                  <p>{a.reason}</p>
                  <p style={{ marginTop: 6 }}>
                    <Link href={a.ref_table === "applications" ? `/pipeline/application/${a.ref_id}` : `/messages?id=${a.ref_id}`}>See exactly what will be sent</Link>
                    <span style={{ color: "var(--muted)" }}>, asked {when(a.requested_at)}</span>
                  </p>
                </div>
                <Decide id={a.id} />
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Where everything stands" sub="Each line is one hunt. The number above a stop is how many got at least that far.">
        <div className="panel route">
          {lines.map((l) => (
            <div className="route-row" key={l.track}>
              <div className="route-name"><i style={{ background: COLOR[l.track] }} />{TRACK_NAME[l.track]}</div>
              <RouteLine color={COLOR[l.track]} stations={l.stations} note={l.dropped ? `${l.dropped} ${l.track === "lead" ? "opted out" : "skipped or closed"}` : undefined} />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Today in numbers">
        <div className="panel stats">
          <div className="stat"><b>{sentToday}</b><span>messages sent today</span></div>
          <div className="stat"><b>{submittedToday}</b><span>applications submitted today</span></div>
          <div className="stat"><b>{repliesWeek}</b><span>human replies this week</span></div>
          <div className="stat"><b style={{ color: due ? "var(--signal)" : undefined }}>{due}</b><span>follow-ups due now</span></div>
        </div>
      </Section>

      <Section title={showingToday ? "The crew's day" : "Latest work"} sub="Filled dots are things that happened outside this computer: emails sent, forms submitted, replies received.">
        <div className="panel">
          {acts.length ? (
            <ol className="timeline">
              {acts.map((a) => (
                <li key={a.id}>
                  <time>{showingToday ? time(a.at) : when(a.at).replace("today ", "")}</time>
                  <span className={`dot${a.external ? " ext" : ""}`} aria-hidden="true" />
                  <div>
                    <div className="what">{agentName(a.agent)} {describe(a.action, a.ref_table)}{summaryOf(a)}</div>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <Empty title="Nothing has happened yet">The first scheduled run fills this in. You can also start one now from Claude Code.</Empty>
          )}
        </div>
        <p style={{ marginTop: 10 }}><Link href="/activity">Full activity log</Link></p>
      </Section>
    </>
  );
}

function summaryOf(a: Act): string {
  if (!a.detail) return "";
  try {
    const d = JSON.parse(a.detail) as Record<string, unknown>;
    const s = d.summary ?? d.title ?? d.to ?? d.reason;
    return typeof s === "string" && s ? `: ${s}` : "";
  } catch {
    return "";
  }
}

import { Badge, Empty, PageHead, Section } from "@/components/ui";
import { query } from "@/lib/db";
import { activeTracks } from "@/lib/funnel";
import { ago, agentName, when, TRACK_NAME } from "@/lib/format";

const CREW: Record<string, { agent: string; job: string }[]> = {
  job: [
    { agent: "intake", job: "Learns why you are looking, what you want and what you can honestly claim" },
    { agent: "scout", job: "Finds openings on job boards, careers pages and fresh funding news, then scores fit" },
    { agent: "tailor", job: "Rewrites your resume and cover letter for each job, using only true claims" },
    { agent: "applier", job: "Fills and submits applications; big companies wait for you" },
    { agent: "referral-outreach", job: "Finds people at the company and asks for referrals" },
    { agent: "inbox", job: "Reads every reply and portal inbox, and tells you what matters" },
    { agent: "follow-up", job: "Sends polite follow-ups, and stops the moment someone replies" },
    { agent: "interview-prep", job: "Builds a prep pack when an interview is booked" },
    { agent: "qa-gate", job: "Checks every message for invented claims, limits and do-not-contact" },
    { agent: "critic", job: "Studies what worked and what didn't, then changes the strategy" },
  ],
  freelance: [
    { agent: "intake", job: "Learns the offer, the prices and the proof" },
    { agent: "prospect-scout", job: "Finds businesses and people who could hire you" },
    { agent: "sample-maker", job: "Makes a quick mock-up or idea for the best prospects" },
    { agent: "outreach", job: "Writes and sends a personal pitch to each one" },
    { agent: "follow-up", job: "Follows up and stops at a reply" },
    { agent: "deal-actionables", job: "Lists your next steps when a deal is close, won or lost" },
    { agent: "critic", job: "Changes the strategy based on replies and silence" },
  ],
  lead: [
    { agent: "intake", job: "Pins down who to find, where, and which details matter" },
    { agent: "researcher", job: "Collects contacts city by city from maps and directories" },
    { agent: "db-builder", job: "Removes duplicates, sorts and tags the database" },
    { agent: "verifier", job: "Checks every phone, email and listing, and scores how sure it is" },
    { agent: "critic", job: "Finds gaps and weak sources, and changes the search plan" },
  ],
};

type Run = { agent: string; status: string; started_at: string; summary: string | null; n: number };
type Note = { id: number; from_agent: string; to_agent: string; topic: string; body: string; status: string; created_at: string };

export default async function Agents() {
  const tracks = await activeTracks();
  const runs = await query<Run>(`SELECT agent, status, max(started_at) AS started_at, summary, count(*) AS n FROM runs GROUP BY agent`);
  const byAgent = new Map(runs.map((r) => [r.agent, r]));
  const notes = await query<Note>(`SELECT * FROM agent_notes ORDER BY id DESC LIMIT 80`);
  const recent = await query<{ id: number; skill: string; cycle: string; agent: string; status: string; summary: string | null; started_at: string; ended_at: string | null; error: string | null }>(
    `SELECT * FROM runs ORDER BY id DESC LIMIT 25`);

  return (
    <>
      <PageHead title="Agents">The crew working on your hunt, what each one does, and what they tell each other.</PageHead>
      {tracks.map((t) => (
        <Section key={t} title={TRACK_NAME[t]}>
          <div className="crew">
            {CREW[t].map((c) => {
              const r = byAgent.get(c.agent);
              return (
                <div className="panel crew-member" key={c.agent}>
                  <b>{agentName(c.agent)}</b>
                  <div className="small" style={{ margin: "2px 0 8px" }}>{c.job}</div>
                  <div className="small">{r ? <>Last worked {ago(r.started_at)}, {r.n} run{r.n === 1 ? "" : "s"} <Badge value={r.status} /></> : "Has not run yet"}</div>
                </div>
              );
            })}
          </div>
        </Section>
      ))}

      <Section title="What the agents tell each other" sub="When one agent learns something another needs, it leaves a note here. Each agent reads its notes before it starts work.">
        <div className="panel">
          {notes.length ? (
            <ol className="thread">
              {notes.map((n) => (
                <li key={n.id}>
                  <div className="meta"><b>{agentName(n.from_agent)}</b> to <b>{n.to_agent === "all" ? "everyone" : agentName(n.to_agent)}</b>, {when(n.created_at)}, about {n.topic} <Badge value={n.status === "open" ? "not read yet" : n.status === "read" ? "read" : "done"} kind={n.status === "done" ? "good" : "plain"} /></div>
                  <div className="body">{n.body}</div>
                </li>
              ))}
            </ol>
          ) : <Empty title="No notes yet">They appear once agents start handing work to each other.</Empty>}
        </div>
      </Section>

      <Section title="Recent runs">
        <div className="panel table-wrap">
          {recent.length ? (
            <table className="t"><thead><tr><th>Agent</th><th>Job</th><th>Result</th><th>Started</th><th>What happened</th></tr></thead><tbody>
              {recent.map((r) => (
                <tr key={r.id}><td className="strong">{agentName(r.agent)}</td><td className="small">{r.skill}, {r.cycle}</td><td><Badge value={r.status} /></td><td className="small" style={{ whiteSpace: "nowrap" }}>{when(r.started_at)}</td><td>{r.summary}{r.error ? <div className="small" style={{ color: "var(--signal)" }}>{r.error}</div> : null}</td></tr>
              ))}
            </tbody></table>
          ) : <Empty title="No runs yet" />}
        </div>
      </Section>
    </>
  );
}

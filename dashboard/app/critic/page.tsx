import { Revert } from "@/components/Decide";
import { Badge, Empty, PageHead, Section } from "@/components/ui";
import { parseJson, query } from "@/lib/db";
import { agentName, when, TRACK_NAME } from "@/lib/format";

type Change = { id: number; reason: string; evidence: string | null; reverted: number; reverted_via: string | null; created_at: string; track: string; agent: string; version: number };
type Exp = { id: number; track: string; dimension: string; variants: string; metric: string; min_n: number; status: string; result: string | null; started_at: string };
type Perf = { track: string; dim: string; value: string; sent: number; replied: number; positive: number; bounced: number };

export default async function Critic() {
  const changes = await query<Change>(
    `SELECT sc.*, p.track, p.agent, p.version FROM strategy_changes sc JOIN playbooks p ON p.id = sc.playbook_id ORDER BY sc.id DESC LIMIT 60`);
  const exps = await query<Exp>(`SELECT * FROM experiments ORDER BY status = 'running' DESC, id DESC LIMIT 30`);
  // Reply rates per strategy tag, measured on first-touch messages. A reply counts when any inbound message lands in the same thread.
  const perf = await query<Perf>(
    `WITH firsts AS (
       SELECT m.*, (SELECT reply_class FROM messages r WHERE r.direction = 'in' AND r.thread_key = m.thread_key AND ifnull(r.reply_class,'') NOT IN ('auto','ooo') ORDER BY r.id LIMIT 1) AS rc
       FROM messages m WHERE m.direction = 'out' AND m.sequence_step = 0 AND m.status IN ('sent','bounced') AND m.variant IS NOT NULL)
     SELECT f.track, j.key AS dim, CAST(j.value AS TEXT) AS value, count(*) AS sent,
       sum(rc IS NOT NULL) AS replied, sum(rc IN ('positive','interview','referral')) AS positive, sum(f.status = 'bounced') AS bounced
     FROM firsts f, json_each(f.variant) j GROUP BY f.track, j.key, j.value HAVING count(*) >= 1 ORDER BY f.track, j.key, sent DESC`);
  const groups = new Map<string, Perf[]>();
  for (const p of perf) {
    const k = `${p.track}|${p.dim}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  return (
    <>
      <PageHead title="Critic">What the critic noticed and what it changed. Strategy only changes after enough messages to trust the pattern, and you can undo any change.</PageHead>

      <Section title="Strategy changes" sub="Each change replaces an agent's playbook with a new version. Revert puts the previous version back.">
        <div className="panel">
          {changes.length ? changes.map((c) => {
            const ev = parseJson<Record<string, unknown>>(c.evidence, {});
            return (
              <div className="change" key={c.id}>
                <div>
                  <h3>{agentName(c.agent)}, {TRACK_NAME[c.track] ?? "all hunts"}: version {c.version}</h3>
                  <p>{c.reason}</p>
                  {Object.keys(ev).length ? <p className="small" style={{ color: "var(--muted)", marginTop: 4 }}>Evidence: {Object.entries(ev).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join("; ")}</p> : null}
                  <p className="small" style={{ color: "var(--muted)", marginTop: 4 }}>{when(c.created_at)}</p>
                </div>
                <div>{c.reverted ? <Badge value={`undone via ${c.reverted_via}`} kind="plain" /> : <Revert id={c.id} />}</div>
              </div>
            );
          }) : <Empty title="No changes yet">The critic needs about 20 to 30 messages of a kind before it trusts a pattern.</Empty>}
        </div>
      </Section>

      <Section title="What gets replies" sub="Reply rate for each strategy the agents tag on first messages. Bars show human replies; the darker part is positive ones.">
        {groups.size ? [...groups.entries()].map(([k, rows]) => {
          const [track, dim] = k.split("|");
          return (
            <div className="panel panel-pad" key={k} style={{ marginBottom: 10 }}>
              <b>{TRACK_NAME[track]}: {dim.replace(/_/g, " ")}</b>
              <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
                {rows.map((r) => {
                  const rate = r.sent ? r.replied / r.sent : 0;
                  const pos = r.sent ? r.positive / r.sent : 0;
                  return (
                    <div key={r.value} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 200px) 1fr 150px", gap: 12, alignItems: "center" }}>
                      <span>{r.value}</span>
                      <div className="bar" aria-hidden="true"><i style={{ width: `${rate * 100}%`, background: "var(--job)", opacity: 0.35 }} /><i style={{ width: `${pos * 100}%`, background: "var(--job)" }} /></div>
                      <span className="small" style={{ color: "var(--muted)", textAlign: "right" }}>{Math.round(rate * 100)}% of {r.sent}{r.sent < 20 ? ", too few to trust" : ""}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }) : <div className="panel"><Empty title="No measured messages yet" /></div>}
      </Section>

      <Section title="Experiments">
        <div className="panel table-wrap">
          {exps.length ? (
            <table className="t"><thead><tr><th>Testing</th><th>Options</th><th>Needs</th><th>Status</th><th>Result</th></tr></thead><tbody>
              {exps.map((e) => (
                <tr key={e.id}><td className="strong">{TRACK_NAME[e.track]}: {e.dimension.replace(/_/g, " ")}</td><td>{parseJson<string[]>(e.variants, []).join(" vs ")}</td><td className="small">{e.min_n} each</td><td><Badge value={e.status} /></td><td className="small">{e.result ? Object.entries(parseJson<Record<string, unknown>>(e.result, {})).map(([k, v]) => `${k}: ${v}`).join("; ") : ""}</td></tr>
              ))}
            </tbody></table>
          ) : <Empty title="No experiments yet" />}
        </div>
      </Section>
    </>
  );
}

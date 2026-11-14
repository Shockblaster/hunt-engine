import { Badge, Empty, PageHead, Section } from "@/components/ui";
import { parseJson, query } from "@/lib/db";
import { ago, when } from "@/lib/format";

type Src = { source: string; runs: number; ok: number; items: number; last_at: string; last_error: string | null };
type Ev = { agent: string; case_name: string; passed: number; score: number | null; trigger: string; at: string; detail: string | null };
type Run = { id: number; skill: string; cycle: string; status: string; summary: string | null; counts: string | null; started_at: string };
type Board = { provider: string; board: string; company: string; active: number; last_checked_at: string | null; last_count: number | null };

export default async function Health() {
  const sources = await query<Src>(`SELECT source, count(*) AS runs, sum(ok) AS ok, sum(items) AS items, max(at) AS last_at,
      (SELECT error FROM source_runs s2 WHERE s2.source = s.source AND s2.ok = 0 ORDER BY id DESC LIMIT 1) AS last_error
    FROM source_runs s WHERE at >= datetime('now', '-14 days') GROUP BY source ORDER BY runs DESC`);
  const evals = await query<Ev>(`SELECT e.* FROM evals e WHERE e.id IN (SELECT max(id) FROM evals GROUP BY agent, case_name) ORDER BY agent`);
  const runs = await query<Run>(`SELECT * FROM runs WHERE agent = 'scheduler' ORDER BY id DESC LIMIT 30`);
  const boards = await query<Board>(`SELECT * FROM watchlist ORDER BY active DESC, last_checked_at DESC LIMIT 100`);
  const spend = runs.reduce((a, r) => a + Number(parseJson<{ cost_usd?: number }>(r.counts, {}).cost_usd ?? 0), 0);

  return (
    <>
      <PageHead title="Health">Whether the sources still work, whether each agent still passes its practice test, and what the automatic runs took.</PageHead>

      <Section title="Sources, last 14 days" sub="A source that keeps failing usually means a site changed. The critic is told; this is where you can see it.">
        <div className="panel table-wrap">
          {sources.length ? (
            <table className="t"><thead><tr><th>Source</th><th className="num">Fetches</th><th>Working</th><th className="num">Items</th><th>Last</th><th>Last error</th></tr></thead><tbody>
              {sources.map((s) => {
                const rate = s.runs ? s.ok / s.runs : 0;
                return <tr key={s.source}><td className="strong">{s.source}</td><td className="num">{s.runs}</td><td><Badge value={`${Math.round(rate * 100)}%`} kind={rate >= 0.9 ? "good" : rate >= 0.5 ? "meh" : "bad"} /></td><td className="num">{s.items}</td><td className="small">{ago(s.last_at)}</td><td className="small">{s.last_error ?? ""}</td></tr>;
              })}
            </tbody></table>
          ) : <Empty title="No source has been used yet" />}
        </div>
      </Section>

      <Section title="Practice tests" sub="Each agent is tested on situations with a known right answer, whenever it changes. A failed test after a critic change undoes that change.">
        <div className="panel table-wrap">
          {evals.length ? (
            <table className="t"><thead><tr><th>Agent</th><th>Test</th><th>Result</th><th>Why it ran</th><th>When</th><th>Checks that failed</th></tr></thead><tbody>
              {evals.map((e) => {
                const failed = parseJson<{ label: string; passed: boolean; detail: string }[]>(e.detail, []).filter((c) => !c.passed);
                return <tr key={`${e.agent}-${e.case_name}`}><td className="strong">{e.agent}</td><td>{e.case_name}</td><td><Badge value={e.passed ? "passed" : "failed"} kind={e.passed ? "good" : "bad"} /></td><td className="small">{e.trigger}</td><td className="small">{when(e.at)}</td><td className="small">{failed.map((f) => `${f.label} (${f.detail})`).join("; ")}</td></tr>;
              })}
            </tbody></table>
          ) : <Empty title="No practice tests have run yet" />}
        </div>
      </Section>

      <Section title="Automatic runs" sub={runs.length ? `Usage over these runs: about $${spend.toFixed(2)} of Claude time (covered by the subscription).` : undefined}>
        <div className="panel table-wrap">
          {runs.length ? (
            <table className="t"><thead><tr><th>Hunt</th><th>Cycle</th><th>Result</th><th>Started</th><th className="num">Minutes</th><th>Summary</th></tr></thead><tbody>
              {runs.map((r) => {
                const c = parseJson<{ minutes?: number }>(r.counts, {});
                return <tr key={r.id}><td>{r.skill}</td><td>{r.cycle}</td><td><Badge value={r.status} /></td><td className="small">{when(r.started_at)}</td><td className="num">{c.minutes ?? ""}</td><td className="small">{(r.summary ?? "").slice(0, 160)}</td></tr>;
              })}
            </tbody></table>
          ) : <Empty title="No automatic runs yet">Run `he schedule install` to switch them on.</Empty>}
        </div>
      </Section>

      <Section title="Company job boards the scout watches">
        <div className="panel table-wrap">
          {boards.length ? (
            <table className="t"><thead><tr><th>Company</th><th>Board</th><th>Status</th><th className="num">Jobs last time</th><th>Checked</th></tr></thead><tbody>
              {boards.map((b) => <tr key={`${b.provider}:${b.board}`}><td className="strong">{b.company}</td><td className="small">{b.provider}: {b.board}</td><td><Badge value={b.active ? "watching" : "switched off"} kind={b.active ? "good" : "plain"} /></td><td className="num">{b.last_count ?? ""}</td><td className="small">{b.last_checked_at ? ago(b.last_checked_at) : "not yet"}</td></tr>)}
            </tbody></table>
          ) : <Empty title="No boards on the watchlist yet" />}
        </div>
      </Section>
    </>
  );
}

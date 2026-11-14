import Link from "next/link";
import { Empty, Filters, PageHead } from "@/components/ui";
import { count, query } from "@/lib/db";
import { agentName, describe, when } from "@/lib/format";

type Act = { id: number; at: string; agent: string; action: string; ref_table: string | null; ref_id: number | null; detail: string | null; external: number };
const PAGE = 100;

function refLink(a: Act) {
  if (!a.ref_table || !a.ref_id) return null;
  const href = a.ref_table === "organizations" ? `/companies/${a.ref_id}` : a.ref_table === "applications" ? `/pipeline/application/${a.ref_id}` : a.ref_table === "messages" ? `/messages?id=${a.ref_id}` : null;
  return href ? <Link href={href}>open</Link> : null;
}

export default async function Activity({ searchParams }: { searchParams: Promise<{ only?: string; page?: string }> }) {
  const { only, page } = await searchParams;
  const p = Math.max(1, Number(page ?? 1));
  const where = only === "outside" ? "WHERE external = 1" : only === "you" ? "WHERE agent LIKE 'person:%'" : "";
  const total = await count(`SELECT count(*) AS n FROM activities ${where}`);
  const acts = await query<Act>(`SELECT * FROM activities ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, PAGE, (p - 1) * PAGE);
  const qs = (n: number) => `/activity?${only ? `only=${only}&` : ""}page=${n}`;
  return (
    <>
      <PageHead title="Activity">The complete record of everything every agent did, newest first. Nothing is ever deleted from it.</PageHead>
      <Filters base="/activity" param="only" current={only} options={[{ value: "", label: "Everything" }, { value: "outside", label: "Sent or submitted" }, { value: "you", label: "Your decisions" }]} />
      <div className="panel table-wrap">
        {acts.length ? (
          <table className="t">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th /></tr></thead>
            <tbody>
              {acts.map((a) => (
                <tr key={a.id}>
                  <td className="small" style={{ whiteSpace: "nowrap" }}>{when(a.at)}</td>
                  <td className="strong">{agentName(a.agent)}</td>
                  <td>{describe(a.action, a.ref_table)}</td>
                  <td className="small" style={{ maxWidth: 420, overflowWrap: "anywhere" }}>{a.detail && a.detail.length < 400 ? a.detail.replace(/[{}"[\]]/g, " ").replace(/\s+/g, " ").trim() : ""}</td>
                  <td>{refLink(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title="Nothing recorded yet" />}
      </div>
      {total > PAGE ? (
        <p style={{ display: "flex", gap: 16 }}>
          {p > 1 ? <Link href={qs(p - 1)}>Newer</Link> : null}
          <span className="small" style={{ color: "var(--muted)" }}>Page {p} of {Math.ceil(total / PAGE)}</span>
          {p * PAGE < total ? <Link href={qs(p + 1)}>Older</Link> : null}
        </p>
      ) : null}
    </>
  );
}

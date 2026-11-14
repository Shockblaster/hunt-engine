import Link from "next/link";
import { existsSync, readFileSync } from "node:fs";
import { notFound } from "next/navigation";
import { Decide } from "@/components/Decide";
import { Badge, ExtLink, PageHead, Section } from "@/components/ui";
import { HE_HOME, one, parseJson, query } from "@/lib/db";
import { resolve } from "node:path";
import { when } from "@/lib/format";

type App = {
  id: number; status: string; portal: string; resume_path: string | null; cover_letter_path: string | null; answers: string | null; submitted_at: string | null; result: string | null;
  title: string; url: string | null; fit_score: number | null; fit_reasons: string | null; description: string | null; org: string | null; org_id: number | null; tier: string | null; tier_reasons: string | null;
};

function readText(p: string | null): string | null {
  // Only files inside the workspace folders are shown.
  if (!p || !resolve(p).startsWith(resolve(HE_HOME)) || !existsSync(p) || !/\.(md|txt|html?)$/i.test(p)) return null;
  const s = readFileSync(p, "utf8");
  return p.endsWith(".html") || p.endsWith(".htm") ? s.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim() : s;
}

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await one<App>(
    `SELECT a.*, o.title, o.url, o.fit_score, o.fit_reasons, o.description, org.name AS org, org.id AS org_id, org.tier, org.tier_reasons
     FROM applications a JOIN opportunities o ON o.id = a.opportunity_id LEFT JOIN organizations org ON org.id = o.organization_id WHERE a.id = ?`,
    Number(id),
  );
  if (!a) notFound();
  const approval = await one<{ id: number; status: string; reason: string }>(`SELECT id, status, reason FROM approvals WHERE ref_table = 'applications' AND ref_id = ?`, a.id);
  const answers = parseJson<Record<string, string>>(a.answers, {});
  const reasons = parseJson<string[]>(a.fit_reasons, []);
  const letter = readText(a.cover_letter_path);
  const checks = await query<{ field: string; method: string; result: string; detail: string | null }>(`SELECT field, method, result, detail FROM verifications WHERE ref_table = 'applications' AND ref_id = ?`, a.id);

  return (
    <>
      <PageHead title={a.title}>
        {a.org_id ? <Link href={`/companies/${a.org_id}`}>{a.org}</Link> : a.org} on {a.portal}. <Badge value={a.status} />
      </PageHead>

      {approval?.status === "pending" ? (
        <div className="panel needs" style={{ marginBottom: 8 }}>
          <div className="needs-item"><div><h3>This needs your OK before it is submitted</h3><p>{approval.reason}</p></div><Decide id={approval.id} /></div>
        </div>
      ) : null}

      <Section title="Why the agents picked it" sub={`Fit ${a.fit_score ?? "not scored"} out of 5.`}>
        <div className="panel panel-pad">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {a.url ? <p style={{ marginBottom: 0 }}><ExtLink href={a.url}>Open the original posting</ExtLink></p> : null}
        </div>
      </Section>

      <Section title="What will be sent">
        <div className="panel panel-pad" style={{ display: "grid", gap: 14 }}>
          <div><b>Resume</b><div className="small" style={{ color: "var(--muted)" }}>{a.resume_path ?? "not made yet"}</div></div>
          <div><b>Cover letter</b>{letter ? <div className="msg-body" style={{ marginTop: 6 }}>{letter}</div> : <div className="small" style={{ color: "var(--muted)" }}>{a.cover_letter_path ?? "none for this one"}</div>}</div>
          {Object.keys(answers).length ? (
            <div>
              <b>Form answers</b>
              <table className="t" style={{ marginTop: 6 }}><tbody>
                {Object.entries(answers).map(([q, v]) => <tr key={q}><td className="small" style={{ width: "40%" }}>{q}</td><td>{String(v)}</td></tr>)}
              </tbody></table>
            </div>
          ) : null}
        </div>
      </Section>

      {checks.length ? (
        <Section title="Checks before sending" sub="The QA gate compares every claim with your claims list and looks for anything invented.">
          <div className="panel table-wrap"><table className="t"><tbody>
            {checks.map((c, i) => <tr key={i}><td className="strong">{c.field}</td><td>{c.method}</td><td><Badge value={c.result} /></td><td className="small">{c.detail}</td></tr>)}
          </tbody></table></div>
        </Section>
      ) : null}

      {a.submitted_at ? <p className="small" style={{ marginTop: 20, color: "var(--muted)" }}>Submitted {when(a.submitted_at)}{a.result ? `. ${a.result}` : ""}</p> : null}
    </>
  );
}

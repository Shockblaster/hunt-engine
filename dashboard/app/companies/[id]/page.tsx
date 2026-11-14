import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Empty, ExtLink, PageHead, Section } from "@/components/ui";
import { one, parseJson, query } from "@/lib/db";
import { day, when, TRACK_NAME } from "@/lib/format";

type Org = { id: number; name: string; domain: string | null; website: string | null; tier: string; tier_reasons: string | null; sector: string | null; city: string | null; employees: number | null; funding: string | null; phone_e164: string | null; rating: number | null; reviews: number | null; source_url: string; notes: string | null };

export default async function Company({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const o = await one<Org>(`SELECT * FROM organizations WHERE id = ?`, Number(id));
  if (!o) notFound();
  const people = await query<{ id: number; name: string; role: string | null; email: string | null; email_status: string; linkedin_url: string | null; opt_out: number }>(`SELECT * FROM people WHERE organization_id = ? ORDER BY name`, o.id);
  const opps = await query<{ id: number; track: string; title: string; stage: string; fit_score: number | null; url: string | null }>(`SELECT * FROM opportunities WHERE organization_id = ? ORDER BY updated_at DESC`, o.id);
  const msgs = await query<{ id: number; channel: string; direction: string; subject: string | null; status: string; sent_at: string | null; created_at: string; person: string | null }>(
    `SELECT m.*, p.name AS person FROM messages m LEFT JOIN people p ON p.id = m.person_id WHERE m.organization_id = ? ORDER BY m.id DESC`, o.id);
  const tierReasons = parseJson<string[]>(o.tier_reasons, []);
  const funding = parseJson<Record<string, string>>(o.funding, {});

  return (
    <>
      <PageHead title={o.name}>
        <Badge value={`${o.tier} company`} kind={o.tier === "big" ? "meh" : o.tier === "small" ? "good" : "plain"} /> {tierReasons.join(", ")}
      </PageHead>
      <div className="panel stats">
        <div className="stat"><b>{o.employees ?? "?"}</b><span>staff</span></div>
        <div className="stat"><b>{o.sector ?? "?"}</b><span>sector</span></div>
        <div className="stat"><b>{o.city ?? "?"}</b><span>city</span></div>
        {o.rating ? <div className="stat"><b>{o.rating}</b><span>rating from {o.reviews ?? 0} reviews</span></div> : null}
        {funding.stage ? <div className="stat"><b>{funding.stage}</b><span>{[funding.amount, funding.date].filter(Boolean).join(", ")}</span></div> : null}
      </div>
      <p className="small" style={{ color: "var(--muted)" }}>
        {o.website ? <><ExtLink href={o.website.startsWith("http") ? o.website : `https://${o.website}`}>Website</ExtLink>, </> : null}
        <ExtLink href={o.source_url}>where the agents found it</ExtLink>{o.notes ? `. ${o.notes}` : ""}
      </p>

      <Section title={`People (${people.length})`}>
        <div className="panel table-wrap">
          {people.length ? (
            <table className="t"><thead><tr><th>Name</th><th>Role</th><th>Email</th><th>LinkedIn</th></tr></thead><tbody>
              {people.map((p) => (
                <tr key={p.id}><td className="strong">{p.name}{p.opt_out ? <> <Badge value="do not contact" kind="bad" /></> : null}</td><td>{p.role}</td>
                  <td>{p.email}{p.email ? <> <Badge value={p.email_status} /></> : null}</td><td><ExtLink href={p.linkedin_url}>{p.linkedin_url ? "profile" : ""}</ExtLink></td></tr>
              ))}
            </tbody></table>
          ) : <Empty title="No people found here yet" />}
        </div>
      </Section>

      <Section title={`Opportunities (${opps.length})`}>
        <div className="panel table-wrap">
          {opps.length ? (
            <table className="t"><tbody>
              {opps.map((x) => <tr key={x.id}><td className="strong"><ExtLink href={x.url}>{x.title}</ExtLink></td><td><Badge value={TRACK_NAME[x.track]} kind={x.track} /></td><td><Badge value={x.stage} /></td><td className="num">{x.fit_score != null ? `fit ${x.fit_score}` : ""}</td></tr>)}
            </tbody></table>
          ) : <Empty title="No opportunities here" />}
        </div>
      </Section>

      <Section title={`Messages (${msgs.length})`}>
        <div className="panel table-wrap">
          {msgs.length ? (
            <table className="t"><tbody>
              {msgs.map((m) => <tr key={m.id}><td className="small">{m.direction === "in" ? "From" : "To"} {m.person ?? "?"}</td><td><Link href={`/messages?id=${m.id}`}>{m.subject ?? m.channel.replace("_", " ")}</Link></td><td><Badge value={m.status} /></td><td className="small">{m.sent_at ? when(m.sent_at) : day(m.created_at)}</td></tr>)}
            </tbody></table>
          ) : <Empty title="No messages yet" />}
        </div>
      </Section>
    </>
  );
}

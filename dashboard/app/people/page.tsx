import Link from "next/link";
import { Badge, Empty, ExtLink, PageHead } from "@/components/ui";
import { query } from "@/lib/db";

type Person = { id: number; name: string; role: string | null; org: string | null; org_id: number | null; email: string | null; email_status: string; linkedin_url: string | null; phone_e164: string | null; opt_out: number; msgs: number; last_reply: string | null };

export default async function People({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const people = await query<Person>(
    `SELECT p.*, o.name AS org, o.id AS org_id,
       (SELECT count(*) FROM messages m WHERE m.person_id = p.id) AS msgs,
       (SELECT reply_class FROM messages m WHERE m.person_id = p.id AND m.direction = 'in' ORDER BY m.id DESC LIMIT 1) AS last_reply
     FROM people p LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.campaign IS NULL ${q ? "AND (p.name LIKE ? OR p.role LIKE ? OR o.name LIKE ? OR p.email LIKE ?)" : ""}
     ORDER BY p.updated_at DESC LIMIT 500`,
    ...(q ? Array(4).fill(`%${q}%`) : []),
  );
  return (
    <>
      <PageHead title="People">Founders, hiring managers, employees and clients the agents found for referrals and pitches. Lead-research contacts are on the Leads page.</PageHead>
      <form style={{ marginBottom: 14 }}><input className="search" name="q" defaultValue={q} placeholder="Search name, role, company, email" aria-label="Search people" /></form>
      <div className="panel table-wrap">
        {people.length ? (
          <table className="t cards">
            <thead><tr><th>Name</th><th>Role</th><th>Company</th><th>Email</th><th>LinkedIn</th><th className="num">Messages</th><th>Last reply</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td data-label="Name" className="strong">{p.name}{p.opt_out ? <> <Badge value="do not contact" kind="bad" /></> : null}</td>
                  <td data-label="Role">{p.role}</td>
                  <td data-label="Company">{p.org_id ? <Link href={`/companies/${p.org_id}`}>{p.org}</Link> : null}</td>
                  <td data-label="Email">{p.email}{p.email ? <div><Badge value={p.email_status} /></div> : null}</td>
                  <td data-label="LinkedIn"><ExtLink href={p.linkedin_url}>{p.linkedin_url ? "profile" : ""}</ExtLink></td>
                  <td data-label="Messages" className="num">{p.msgs}</td>
                  <td data-label="Last reply"><Badge value={p.last_reply} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title={q ? "Nobody matches that search" : "No people yet"}>{q ? "Try a name, company or role." : "The outreach agents add people when they research a company."}</Empty>}
      </div>
    </>
  );
}

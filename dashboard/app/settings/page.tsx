import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Badge, PageHead, Section } from "@/components/ui";
import { currentWorkspace, HE_HOME, query } from "@/lib/db";
import { TRACK_NAME } from "@/lib/format";

type Limits = { min_fit: number; caps_per_day: Record<string, number>; linkedin_notes_per_month: number; max_follow_ups: number; follow_up_days: number[]; send_window_ist: string[]; big_company: { employees_at_least: number } };

const CAP_NAME: Record<string, string> = {
  email_job: "Job emails from your own Gmail", email_outreach: "Outreach emails (freelance and leads)", linkedin_connect: "LinkedIn connection requests",
  linkedin_dm: "LinkedIn messages", portal_submit: "Applications submitted", yc_waas_per_week: "YC Work at a Startup applications (per week)",
};

export default async function Settings() {
  const ws = await currentWorkspace();
  const rulesDir = join(process.cwd(), "..", "rules");
  const limits = JSON.parse(readFileSync(join(rulesDir, "limits.json"), "utf8")) as Limits;
  const rules = readFileSync(join(rulesDir, "hard-rules.md"), "utf8");
  const envFile = ws ? join(HE_HOME, "workspaces", ws.slug, ".env") : "";
  // Only whether each account is set up; the values are never read into the page.
  const env = envFile && existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split("=")[0], l.slice(l.indexOf("=") + 1).trim().length > 0])) : {};
  const profiles = await query<{ track: string; version: number; created_at: string }>(`SELECT track, max(version) AS version, max(created_at) AS created_at FROM profiles GROUP BY track`);
  const claims = await query<{ n: number }>(`SELECT count(*) AS n FROM claims WHERE status = 'active'`);

  return (
    <>
      <PageHead title="Setup">How this hunt is configured. To change anything, ask Claude Code; the limits and hard rules can only be changed by you in a terminal.</PageHead>
      <Section title="Accounts">
        <div className="panel table-wrap"><table className="t"><tbody>
          <tr><td className="strong">Job emails</td><td>{env.JOB_EMAIL ? <Badge value="connected" kind="good" /> : <Badge value="not set up" kind="meh" />}</td><td className="small">Your own Gmail, for applications and referral asks</td></tr>
          <tr><td className="strong">Outreach emails</td><td>{env.OUTREACH_EMAIL ? <Badge value="connected" kind="good" /> : <Badge value="not set up" kind="meh" />}</td><td className="small">A separate Gmail for freelance and lead outreach, so a spam flag never touches your main inbox</td></tr>
          <tr><td className="strong">Workspace folder</td><td colSpan={2} className="small">{ws ? join(HE_HOME, "workspaces", ws.slug) : ""}</td></tr>
        </tbody></table></div>
      </Section>
      <Section title="What the agents know about you">
        <div className="panel table-wrap"><table className="t"><tbody>
          {profiles.map((p) => <tr key={p.track}><td className="strong">{TRACK_NAME[p.track]}</td><td className="small">profile version {p.version}</td></tr>)}
          <tr><td className="strong">Claims</td><td className="small">{claims[0]?.n ?? 0} true statements the agents are allowed to make about you</td></tr>
        </tbody></table></div>
      </Section>
      <Section title="Daily limits" sub={`Anything scoring under ${limits.min_fit} out of 5 is never sent. Companies with ${limits.big_company.employees_at_least}+ staff, listed companies, unicorns, MNCs, famous brands and your dream list always wait for your approval.`}>
        <div className="panel table-wrap"><table className="t"><tbody>
          {Object.entries(limits.caps_per_day).map(([k, v]) => <tr key={k}><td>{CAP_NAME[k] ?? k}</td><td className="num strong">{v}</td></tr>)}
          <tr><td>Personal LinkedIn notes per month</td><td className="num strong">{limits.linkedin_notes_per_month}</td></tr>
          <tr><td>Follow-ups per person (after {limits.follow_up_days.join(" and ")} days)</td><td className="num strong">{limits.max_follow_ups}</td></tr>
          <tr><td>Emails go out between (IST)</td><td className="num strong">{limits.send_window_ist.join(" and ")}</td></tr>
        </tbody></table></div>
      </Section>
      <Section title="Hard rules" sub="Every agent follows these. The critic cannot change them.">
        <div className="panel panel-pad"><div className="msg-body" style={{ maxWidth: "none", background: "transparent", padding: 0 }}>{rules.replace(/^# .*\n+/, "")}</div></div>
      </Section>
    </>
  );
}

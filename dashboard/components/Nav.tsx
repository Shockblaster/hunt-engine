"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUPS: { label: string; items: { href: string; name: string }[] }[] = [
  { label: "Overview", items: [{ href: "/", name: "Today" }, { href: "/pipeline", name: "Pipeline" }] },
  {
    label: "Records",
    items: [
      { href: "/companies", name: "Companies" }, { href: "/people", name: "People" }, { href: "/leads", name: "Leads" },
      { href: "/messages", name: "Messages" }, { href: "/follow-ups", name: "Follow-ups" },
    ],
  },
  {
    label: "The crew",
    items: [
      { href: "/agents", name: "Agents" }, { href: "/critic", name: "Critic" }, { href: "/activity", name: "Activity" }, { href: "/health", name: "Health" },
      { href: "/settings", name: "Setup" },
    ],
  },
];

export function Nav({ pending }: { pending: number }) {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {GROUPS.map((g) => (
        <div key={g.label} style={{ display: "contents" }}>
          <div className="nav-group">{g.label}</div>
          {g.items.map((i) => {
            const active = i.href === "/" ? path === "/" : path.startsWith(i.href);
            return (
              <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
                {i.name}
                {i.href === "/" && pending > 0 ? <span className="pill" aria-label={`${pending} waiting for you`}>{pending}</span> : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

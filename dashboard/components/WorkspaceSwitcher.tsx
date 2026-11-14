"use client";
import { switchWorkspace } from "@/lib/actions";

export function WorkspaceSwitcher({ current, options }: { current: string; options: { slug: string; name: string }[] }) {
  return (
    <form action={switchWorkspace} className="ws-form">
      <label htmlFor="ws">Whose hunt</label>
      <select id="ws" name="ws" defaultValue={current} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
        {options.map((o) => (
          <option key={o.slug} value={o.slug}>{o.name}</option>
        ))}
      </select>
    </form>
  );
}

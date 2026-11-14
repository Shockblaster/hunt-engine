"use client";
import { useFormStatus } from "react-dom";
import { decide, revert } from "@/lib/actions";

function Submit({ value, label, ghost }: { value: string; label: string; ghost?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={ghost ? "btn ghost" : "btn"} name="decision" value={value} disabled={pending}>
      {pending ? "Saving" : label}
    </button>
  );
}

export function Decide({ id }: { id: number }) {
  return (
    <form action={decide} className="decide">
      <input type="hidden" name="id" value={id} />
      <input type="text" name="note" placeholder="Note (optional)" aria-label="Note for the agents" />
      <Submit value="reject" label="Reject" ghost />
      <Submit value="approve" label="Approve" />
    </form>
  );
}

function RevertButton() {
  const { pending } = useFormStatus();
  return <button className="btn ghost" disabled={pending}>{pending ? "Reverting" : "Revert"}</button>;
}

export function Revert({ id }: { id: number }) {
  return (
    <form action={revert}>
      <input type="hidden" name="id" value={id} />
      <RevertButton />
    </form>
  );
}

import { KeyRound } from "lucide-react";
import { REFUSALS } from "@/lib/custodes/messages";

/** Status and the "Link Custodes account" action for Settings. Hidden unless Custodes is configured. */
export function CustodesPanel({
  configured,
  linkedAt,
  notice,
}: {
  configured: boolean;
  linkedAt: string | null;
  notice?: string;
}) {
  if (!configured) return null;
  const ok = notice === "linked";
  const text = ok
    ? "Custodes account linked."
    : notice
      ? (REFUSALS[notice] ?? "Linking Custodes did not complete.")
      : "";
  return (
    <section
      className="surface settings-card"
      aria-labelledby="custodes-heading"
    >
      <h2 id="custodes-heading">
        <KeyRound size={18} /> Custodes sign-in
      </h2>
      {text && (
        <div
          className={ok ? "success-note" : "error"}
          role={ok ? "status" : "alert"}
        >
          {text}
        </div>
      )}
      {linkedAt ? (
        <p>
          Your Custodes account is linked (since {linkedAt.slice(0, 10)}). You
          can sign in with Custodes.
        </p>
      ) : (
        <>
          <p>
            Link your Custodes account once so you can sign in with it. You will
            be sent to Custodes and brought back here. Only this signed-in
            session can complete the link.
          </p>
          <form method="post" action="/api/custodes/link">
            <button className="button primary">Link Custodes account</button>
          </form>
        </>
      )}
    </section>
  );
}

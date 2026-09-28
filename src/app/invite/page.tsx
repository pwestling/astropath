"use client";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export default function Invitation() {
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<{
    name: string;
    email: string;
    tenant_name: string;
    existing_account: boolean;
    spaces: { name: string; slug: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const signedInAsInvite =
    !!invite && session?.user.email.toLowerCase() === invite.email;
  useEffect(() => {
    const value =
      new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
    setToken(value);
    void fetch("/api/invitations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "inspect", token: value }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error?.message || "Unable to load invitation.");
        setInvite(data);
      })
      .catch((error) => setError(error.message));
  }, []);
  async function accept(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!invite) return;
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") || "");
    try {
      if (invite.existing_account && !signedInAsInvite) {
        const login = await authClient.signIn.email({
          email: invite.email,
          password,
        });
        if (login.error)
          throw new Error(login.error.message || "Unable to sign in.");
      }
      if (!invite.existing_account && password !== data.get("confirm"))
        throw new Error("Passwords must match.");
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          invite.existing_account
            ? { action: "accept_existing", token }
            : { action: "accept", token, password },
        ),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.error?.code === "existing_account")
          setInvite({ ...invite, existing_account: true });
        throw new Error(
          result.error?.message || "Unable to accept invitation.",
        );
      }
      setAccepted(true);
      window.history.replaceState(null, "", "/invite");
      if (!invite.existing_account) {
        const login = await authClient.signIn.email({
          email: result.email,
          password,
        });
        if (login.error)
          throw new Error(
            "Your account is ready. Sign in with the password you just chose.",
          );
      }
      const selected = await fetch("/api/v1/tenants/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: result.tenant_id }),
      });
      if (!selected.ok)
        throw new Error(
          "Invitation accepted. Open Astropath and select your new tenant.",
        );
      window.location.assign("/");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to accept invitation.",
      );
      setBusy(false);
    }
  }
  return (
    <main className="consent-layout">
      <Brand />
      <section className="consent-card">
        <div className="eyebrow">YOU’RE INVITED</div>
        <h1>Your space in Astropath.</h1>
        {invite && (
          <>
            <p>
              Welcome, {invite.name}. You’re joining{" "}
              <strong>{invite.tenant_name}</strong> as{" "}
              <strong>{invite.email}</strong>.
            </p>
            <p>
              Your access: {invite.spaces.map((space) => space.name).join(", ")}
              . You can connect your apps to these spaces. The tenant owner can
              also access them.
            </p>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {invite && !accepted && (
          <form className="form-stack" onSubmit={accept}>
            {invite.existing_account && (
              <p>
                {signedInAsInvite
                  ? `Signed in as ${invite.email}.`
                  : `Sign in to your existing account as ${invite.email} to join this tenant.`}
              </p>
            )}
            {(!invite.existing_account || !signedInAsInvite) && (
              <label>
                {invite.existing_account
                  ? "Your password"
                  : "Choose a password"}
                <input
                  name="password"
                  type="password"
                  autoComplete={
                    invite.existing_account
                      ? "current-password"
                      : "new-password"
                  }
                  minLength={invite.existing_account ? undefined : 12}
                  maxLength={128}
                  required
                />
              </label>
            )}
            {!invite.existing_account && (
              <label>
                Confirm password
                <input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
            )}
            <button
              className="button primary"
              disabled={busy || sessionPending}
            >
              {busy
                ? "Accepting invitation…"
                : invite.existing_account && !signedInAsInvite
                  ? "Sign in and accept invitation"
                  : "Accept invitation"}
            </button>
          </form>
        )}
        {accepted && (
          <>
            <a className="button primary" href="/">
              Open Astropath
            </a>
            <a className="button" href="/login">
              Sign in
            </a>
          </>
        )}
        {!invite && !error && <p>Loading your invitation…</p>}
      </section>
    </main>
  );
}

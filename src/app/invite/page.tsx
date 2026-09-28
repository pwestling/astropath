"use client";
import { useEffect, useState } from "react";
import { Brand } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export default function Invitation() {
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<{
    name: string;
    email: string;
    spaces: { name: string; slug: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
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
    setBusy(true);
    setError("");
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    try {
      if (password !== data.get("confirm"))
        throw new Error("Passwords must match.");
      const response = await fetch("/api/invitations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept", token, password }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error?.message || "Unable to accept invitation.",
        );
      setAccepted(true);
      window.history.replaceState(null, "", "/invite");
      const login = await authClient.signIn.email({
        email: result.email,
        password,
      });
      if (login.error)
        throw new Error(
          "Your account is ready. Sign in with the password you just chose.",
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
              Welcome, {invite.name}. You’ll sign in as{" "}
              <strong>{invite.email}</strong>.
            </p>
            <p>
              Your access: {invite.spaces.map((space) => space.name).join(", ")}
              . You can connect your apps to these spaces. The workspace owner
              can also access them.
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
            <label>
              Choose a password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
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
            <button className="button primary" disabled={busy}>
              {busy ? "Creating your account…" : "Accept invitation"}
            </button>
          </form>
        )}
        {accepted && (
          <a className="button" href="/login">
            Sign in
          </a>
        )}
        {!invite && !error && <p>Loading your invitation…</p>}
      </section>
    </main>
  );
}

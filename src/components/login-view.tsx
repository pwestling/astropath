"use client";
import { useEffect, useState } from "react";
import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import { BeaconMark, Brand } from "@/components/brand";
import { authClient } from "@/lib/auth-client";
import { REFUSALS } from "@/lib/custodes/messages";

export function LoginView({
  custodes,
  password,
  notice,
}: {
  /** Custodes sign-in is configured. */
  custodes: boolean;
  /** Password sign-in is enabled (ASTROPATH_PASSWORD_LOGIN). */
  password: boolean;
  /** A refusal code from the Custodes callback, if any. */
  notice?: string;
}) {
  const [error, setError] = useState(
    notice
      ? (REFUSALS[notice] ?? "Sign-in with Custodes did not complete.")
      : "",
  );
  // When this sign-in interrupts an MCP/OAuth connection, carry Better Auth's signed query
  // through Custodes so the connection resumes afterwards.
  const [custodesHref, setCustodesHref] = useState("/api/custodes/login");
  useEffect(() => {
    const query = window.location.search.slice(1);
    if (query.includes("sig="))
      setCustodesHref(
        `/api/custodes/login?oauth_query=${encodeURIComponent(query)}`,
      );
  }, []);
  const [busy, setBusy] = useState(false);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await authClient.signIn.email({
        email: String(form.get("email")),
        password: String(form.get("password")),
        callbackURL: "/",
      });
      if (result.error) {
        setError(result.error.message || "Unable to sign in.");
        setBusy(false);
      } else window.location.assign(result.data?.url || "/");
    } catch {
      setError("Unable to reach Astropath. Please try again.");
      setBusy(false);
    }
  }
  return (
    <main className="auth-layout">
      <div className="auth-story">
        <Brand />
        <div className="auth-hero">
          <div className="eyebrow">ONE WORKSPACE · EVERY AGENT</div>
          <h1>
            Speak once.
            <br />
            Be heard
            <br />
            <em>everywhere.</em>
          </h1>
          <p>
            A private relay for your agents: messages, files, and knowledge that
            reach every assistant you connect.
          </p>
          <div className="handoff-art" aria-hidden="true">
            <span>ChatGPT</span>
            <i />
            <span className="handoff-node">
              <BeaconMark size={26} />
            </span>
            <i />
            <span>Claude · Muse</span>
          </div>
        </div>
        <div className="auth-footer">
          <LockKeyhole size={13} /> Private by default. Encrypted at rest.
        </div>
      </div>
      <div className="auth-form-panel">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Open your workspace</h2>
          <p>Sign in to your private Astropath workspace.</p>
          {password && (
            <>
              <label>
                Email address
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  placeholder="you@example.com"
                />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="Your password"
                />
              </label>
            </>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {password && (
            <button className="button primary full" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <>
                  Sign in <ArrowRight size={17} />
                </>
              )}
            </button>
          )}
          {custodes && (
            <a
              className={`button full${password ? "" : " primary"}`}
              href={custodesHref}
            >
              Sign in with Custodes <ArrowRight size={17} />
            </a>
          )}
          {!password && !custodes && (
            <p>Sign-in is not available. Contact the owner.</p>
          )}
          <div className="auth-note">
            <LockKeyhole size={13} /> Private access · No public signup
          </div>
        </form>
      </div>
    </main>
  );
}

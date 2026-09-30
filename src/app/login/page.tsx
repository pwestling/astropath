"use client";
import { useState } from "react";
import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import { BeaconMark, Brand } from "@/components/brand";
import { authClient } from "@/lib/auth-client";

export default function Login() {
  const [error, setError] = useState("");
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
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <>
                Sign in <ArrowRight size={17} />
              </>
            )}
          </button>
          <div className="auth-note">
            <LockKeyhole size={13} /> Private access · No public signup
          </div>
        </form>
      </div>
    </main>
  );
}

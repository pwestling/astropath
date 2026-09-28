"use client";
import { useEffect, useState } from "react";
import { ArrowRight, Check, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Brand } from "@/components/brand";

export default function Consent() {
  const [name, setName] = useState("Application");
  const [identityName, setIdentityName] = useState("");
  const [clientId, setClientId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<string[] | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const id = query.get("client_id") || "";
    setClientId(id);
    setScopes((query.get("scope") || "").split(" "));
    void fetch("/api/v1/spaces")
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Sign in with an account that has workspace access.");
        const result = await response.json();
        setAccess(result.spaces.map((space: { name: string }) => space.name));
      })
      .catch((error) => setError(error.message));
    authClient.oauth2
      .publicClient({ query: { client_id: id } })
      .then((result) => {
        if (result.data?.client_name) setName(result.data.client_name);
        if (result.error)
          setError(
            "Your sign-in session is required. Restart the connection from your AI app.",
          );
      });
  }, []);
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accept,
          identity_name: identityName.trim(),
          oauth_query: window.location.search.slice(1),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.message || result.error?.message || "Connection failed.",
        );
      if (result.url) window.location.assign(result.url);
      else window.location.assign("/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed.");
      setBusy(false);
    }
  }
  return (
    <main className="consent-layout">
      <Brand />
      <section className="consent-card">
        <span className="consent-icon">
          <ShieldCheck size={30} />
        </span>
        <div className="eyebrow">CONNECT AN APPLICATION</div>
        <h1>
          Let {name} use
          <br />
          your Astropath?
        </h1>
        <p>
          This application will have access only to your allowed spaces
          {access ? `: ${access.join(", ")}.` : "."}
        </p>
        <form
          id="connection-approval"
          className="form-stack"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <label>
            Identity name
            <input
              value={identityName}
              onChange={(event) => setIdentityName(event.target.value)}
              placeholder="e.g. Claude Personal or Claude Work"
              autoComplete="off"
              maxLength={80}
              required
              disabled={busy}
              aria-describedby="identity-help"
            />
          </label>
          <p id="identity-help" className="small">
            Give this account a distinct name. Its messages and acknowledgments
            will use this identity.
          </p>
        </form>
        <div className="permission-list">
          {scopes.includes("astropath:read") && (
            <div>
              <Check size={17} /> Read notes and download attachments
            </div>
          )}
          {scopes.includes("astropath:write") && (
            <div>
              <Check size={17} /> Leave notes, reply, and upload files
            </div>
          )}
          {scopes.includes("offline_access") && (
            <div>
              <Check size={17} /> Stay connected between sessions
            </div>
          )}
          {scopes.some((s) => ["openid", "profile", "email"].includes(s)) && (
            <div>
              <Check size={17} /> Read your account identity
            </div>
          )}
        </div>
        <div className="client-identity">
          <span>APPLICATION ID</span>
          <code>{clientId}</code>
        </div>
        <p className="small">You can revoke this connection in Connections.</p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="button-row">
          <button
            className="button"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Cancel
          </button>
          <button
            className="button primary"
            type="submit"
            form="connection-approval"
            disabled={busy || !clientId || !identityName.trim()}
          >
            Allow connection <ArrowRight size={16} />
          </button>
        </div>
      </section>
    </main>
  );
}

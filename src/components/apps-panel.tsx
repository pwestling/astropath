"use client";
import { useEffect, useState } from "react";
import {
  Boxes,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  Power,
  PowerOff,
} from "lucide-react";
import { api, relative } from "./api";
import type { Contract } from "@/lib/platform/contracts";

type Grant = {
  app_id: string;
  connection_id: string;
  mode: "include" | "exclude";
};
type App = {
  id: string;
  name: string;
  origin: string;
  grant_policy: "auto" | "explicit";
  active_release: string | null;
  disabled_at: string | null;
  disabled_operations: string[];
  publisher_key_prefix: string | null;
  description: string;
  ui_url: string | null;
  updated_at: string;
  operations: Contract[];
  grants: Grant[];
};
type Listing = {
  catalog_revision: string;
  apps: App[];
  built_in: {
    operation: string;
    version: string;
    summary: string;
    effect: string;
  }[];
  connections: { id: string; name: string; scopes: string[] }[];
  recent: {
    id: string;
    caller: string;
    operation: string;
    version: string;
    status: string;
    effect_state: string;
    created_at: string;
  }[];
};
type Created = {
  publisher_key: string;
  publish_url: string;
  jwks_url: string;
  audience: string;
  app?: { id: string };
};

export function AppsPanel({
  owner,
  baseUrl,
}: {
  owner: boolean;
  baseUrl: string;
}) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<(Created & { app_id: string }) | null>(
    null,
  );
  async function load() {
    try {
      setData(await api<Listing>("apps"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load apps.");
    }
  }
  useEffect(() => {
    if (owner) void load();
  }, [owner]);
  async function change(path: string, body: unknown, method = "PATCH") {
    setError("");
    try {
      setData(await api<Listing>(path, { method, body: JSON.stringify(body) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  }
  async function create(form: FormData) {
    setError("");
    try {
      const id = String(form.get("id"));
      const created = await api<Created>("apps", {
        method: "POST",
        body: JSON.stringify({
          id,
          name: String(form.get("name")),
          origin: String(form.get("origin")),
          grant_policy: String(form.get("grant_policy")),
        }),
      });
      setSecret({ ...created, app_id: id });
      setCreating(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to create the app.");
    }
  }
  async function rotate(id: string) {
    setError("");
    try {
      const rotated = await api<Created>(`apps/${id}/publisher-key`, {
        method: "POST",
      });
      setSecret({
        ...rotated,
        app_id: id,
        publish_url: `/api/platform/v1/apps/${id}/releases`,
        jwks_url: "",
        audience: `astropath-app:${id}`,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to rotate the key.");
    }
  }
  if (!owner)
    return (
      <div className="surface plain-empty">
        <p>
          Only the workspace owner manages apps. Agents find app tools with
          discover.
        </p>
      </div>
    );
  if (!data)
    return (
      <div className="loading">
        <LoaderCircle className="spin" size={22} /> Loading apps…
      </div>
    );
  return (
    <div className="apps-panel">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {secret && (
        <div className="surface app-secret" role="status">
          <h3>Publisher key for {secret.app_id}</h3>
          <p>
            Shown once. Put it in the app&apos;s deploy secrets. It can publish
            this app&apos;s releases and nothing else.
          </p>
          <div className="secret-row">
            <code>{secret.publisher_key}</code>
            <button
              className="button small-button"
              onClick={() =>
                navigator.clipboard.writeText(secret.publisher_key)
              }
            >
              <Copy size={14} /> Copy
            </button>
          </div>
          <dl>
            <dt>Publish</dt>
            <dd>
              <code>
                POST {baseUrl}
                {secret.publish_url}
              </code>{" "}
              with <code>{"{ manifest }"}</code>, after the release is serving{" "}
              <code>/.well-known/astropath-app</code>
            </dd>
            {secret.jwks_url && (
              <>
                <dt>Verify calls</dt>
                <dd>
                  EdDSA tokens from{" "}
                  <code>
                    {baseUrl}
                    {secret.jwks_url}
                  </code>
                  , audience <code>{secret.audience}</code>, issuer{" "}
                  <code>{baseUrl}</code>
                </dd>
              </>
            )}
          </dl>
          <p className="muted">
            See <code>examples/echo-app</code> and <code>docs/platform.md</code>
            .
          </p>
          <button className="text-button" onClick={() => setSecret(null)}>
            Done
          </button>
        </div>
      )}
      <div className="agents-toolbar">
        <p>
          Apps publish tools that every agent reaches through one connection:
          agents call <code>discover</code> then <code>invoke</code>. New tools
          go to connections with write access automatically unless an app is
          explicit or a tool is marked sensitive.
        </p>
        {!creating && (
          <button className="button primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New app
          </button>
        )}
      </div>
      {creating && (
        <form
          className="surface app-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create(new FormData(event.currentTarget));
          }}
        >
          <label>
            Namespace
            <input
              name="id"
              required
              pattern="[a-z][a-z0-9_]{0,39}"
              placeholder="stc"
            />
          </label>
          <label>
            Name
            <input name="name" required maxLength={100} placeholder="STC" />
          </label>
          <label>
            Origin
            <input
              name="origin"
              required
              placeholder="http://127.0.0.1:4390"
              title="Where Astropath sends this app's calls. Only you can change it."
            />
          </label>
          <label>
            Grants
            <select name="grant_policy" defaultValue="auto">
              <option value="auto">Automatic: every connection</option>
              <option value="explicit">
                Explicit: only connections I include
              </option>
            </select>
          </label>
          <div className="form-actions">
            <button className="button primary" type="submit">
              Create and show publisher key
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {!data.apps.length && !creating && (
        <div className="surface plain-empty">
          <Boxes size={22} />
          <p>
            No apps yet. Create one, then have its deploy publish a manifest.
          </p>
        </div>
      )}
      {data.apps.map((app) => (
        <AppCard
          key={app.id}
          app={app}
          connections={data.connections}
          onUpdate={(body) => change(`apps/${app.id}`, body)}
          onGrant={(connection_id, mode) =>
            change(`apps/${app.id}/grants`, { connection_id, mode }, "POST")
          }
          onRotate={() => rotate(app.id)}
        />
      ))}
      <details className="surface built-in">
        <summary>
          Built-in operations <span>{data.built_in.length}</span>
        </summary>
        <ul>
          {data.built_in.map((op) => (
            <li key={`${op.operation}@${op.version}`}>
              <code>{op.operation}</code>{" "}
              <em className={`effect ${op.effect}`}>{op.effect}</em>{" "}
              {op.summary}
            </li>
          ))}
        </ul>
      </details>
      <section className="surface recent-calls">
        <h3>Recent changes made through the platform</h3>
        {data.recent.length ? (
          <table>
            <tbody>
              {data.recent.map((call) => (
                <tr key={call.id}>
                  <td>{relative(call.created_at)}</td>
                  <td>{call.caller}</td>
                  <td>
                    <code>
                      {call.operation}@{call.version}
                    </code>
                  </td>
                  <td className={`call-status ${call.status}`}>
                    {call.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Nothing yet. Reads are not recorded.</p>
        )}
      </section>
      <p className="concerns-footnote">Catalog {data.catalog_revision}</p>
    </div>
  );
}

function AppCard({
  app,
  connections,
  onUpdate,
  onGrant,
  onRotate,
}: {
  app: App;
  connections: Listing["connections"];
  onUpdate: (body: Record<string, unknown>) => void;
  onGrant: (connection: string, mode: "include" | "exclude" | null) => void;
  onRotate: () => void;
}) {
  const grantOf = (id: string) =>
    app.grants.find((grant) => grant.connection_id === id)?.mode ?? "";
  const disabled = !!app.disabled_at;
  return (
    <article className={`surface app-card ${disabled ? "is-disabled" : ""}`}>
      <header>
        <div>
          <strong>{app.name}</strong> <code>{app.id}</code>
          {app.active_release ? (
            <span className="release">release {app.active_release}</span>
          ) : (
            <span className="release pending">nothing published yet</span>
          )}
          {disabled && <span className="release off">disabled</span>}
        </div>
        <div className="app-actions">
          <select
            aria-label="Grant policy"
            value={app.grant_policy}
            onChange={(event) => onUpdate({ grant_policy: event.target.value })}
          >
            <option value="auto">Automatic grants</option>
            <option value="explicit">Explicit grants</option>
          </select>
          <button className="button small-button" onClick={onRotate}>
            <KeyRound size={14} /> New publisher key
          </button>
          <button
            className="button small-button"
            onClick={() => onUpdate({ disabled: !disabled })}
          >
            {disabled ? (
              <>
                <Power size={14} /> Enable
              </>
            ) : (
              <>
                <PowerOff size={14} /> Disable
              </>
            )}
          </button>
        </div>
      </header>
      {app.description && <p>{app.description}</p>}
      <p className="muted">
        Calls go to <code>{app.origin}</code>
        {app.ui_url && (
          <>
            {" "}
            · <a href={app.ui_url}>Open app</a>
          </>
        )}
        {app.publisher_key_prefix && <> · key {app.publisher_key_prefix}…</>}
      </p>
      {app.operations.length + app.disabled_operations.length > 0 && (
        <ul className="app-operations">
          {app.operations.map((op) => (
            <li key={`${op.operation}@${op.version}`}>
              <code>
                {op.operation}@{op.version}
              </code>{" "}
              <em className={`effect ${op.effect}`}>{op.effect}</em>
              {op.sensitive && <em className="effect sensitive">sensitive</em>}
              {op.deprecated && (
                <em className="effect deprecated">deprecated</em>
              )}{" "}
              {op.summary}{" "}
              <button
                className="text-button"
                onClick={() =>
                  onUpdate({
                    disabled_operations: [
                      ...app.disabled_operations,
                      op.operation,
                    ],
                  })
                }
              >
                Disable
              </button>
            </li>
          ))}
          {app.disabled_operations.map((name) => (
            <li key={name} className="is-disabled">
              <code>{name}</code> disabled{" "}
              <button
                className="text-button"
                onClick={() =>
                  onUpdate({
                    disabled_operations: app.disabled_operations.filter(
                      (other) => other !== name,
                    ),
                  })
                }
              >
                Enable
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="app-grants">
        <summary>Per-connection access</summary>
        <table>
          <tbody>
            {connections.map((connection) => (
              <tr key={connection.id}>
                <td>{connection.name}</td>
                <td>
                  <select
                    aria-label={`Access for ${connection.name}`}
                    value={grantOf(connection.id)}
                    onChange={(event) =>
                      onGrant(
                        connection.id,
                        (event.target.value || null) as
                          "include" | "exclude" | null,
                      )
                    }
                  >
                    <option value="">
                      {app.grant_policy === "auto"
                        ? "Default (allowed, except sensitive)"
                        : "Default (no access)"}
                    </option>
                    <option value="include">
                      Include, with sensitive tools
                    </option>
                    <option value="exclude">Exclude</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </article>
  );
}

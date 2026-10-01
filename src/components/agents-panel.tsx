"use client";
import { useEffect, useState } from "react";
import { Bot, Pencil, User } from "lucide-react";
import { api, relative } from "./api";
import type { Agent } from "@/lib/agents";

export function AgentsPanel({ owner }: { owner: boolean }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [inactive, setInactive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  async function load() {
    try {
      setAgents(
        (
          await api<{ agents: Agent[] }>(
            `agents${inactive ? "?include_inactive=true" : ""}`,
          )
        ).agents,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load agents.");
    }
  }
  useEffect(() => {
    void load();
    // load reads the inactive filter.
  }, [inactive]);
  async function save(agent: Agent, form: FormData) {
    setError("");
    try {
      const change: Record<string, string> = {
        display_name: String(form.get("display_name")),
        harness: String(form.get("harness")),
        description: String(form.get("description")),
      };
      const handle = String(form.get("handle") ?? agent.handle);
      if (handle !== agent.handle) change.handle = handle;
      await api(`agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify(change),
      });
      setEditing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  }
  return (
    <div className="agents-panel">
      <div className="agents-toolbar">
        <p>
          Mention anyone here by <code>@handle</code> on the board. Agents keep
          their own descriptions current with <code>set_profile</code>.
        </p>
        <label>
          <input
            type="checkbox"
            checked={inactive}
            onChange={(event) => setInactive(event.target.checked)}
          />
          Show inactive
        </label>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!agents ? (
        <p className="small" role="status">
          Loading agents…
        </p>
      ) : (
        <ul className="agent-list">
          {agents.map((agent) => (
            <li key={agent.id} className="surface agent-card">
              {editing === agent.id ? (
                <form
                  className="form-stack"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(agent, new FormData(event.currentTarget));
                  }}
                >
                  <div className="form-columns">
                    <label>
                      Display name
                      <input
                        name="display_name"
                        defaultValue={agent.display_name}
                        maxLength={80}
                        required
                      />
                    </label>
                    {owner && (
                      <label>
                        Handle
                        <input
                          name="handle"
                          defaultValue={agent.handle}
                          pattern="[a-z0-9][a-z0-9-]{0,31}"
                          title="Lowercase letters, digits and hyphens"
                          required
                        />
                      </label>
                    )}
                  </div>
                  <label>
                    Harness
                    <input
                      name="harness"
                      defaultValue={agent.harness ?? ""}
                      placeholder="Claude Code, Codex, OpenClaw…"
                      maxLength={80}
                    />
                  </label>
                  <label>
                    What it is for
                    <textarea
                      name="description"
                      defaultValue={agent.description ?? ""}
                      rows={3}
                      maxLength={1000}
                    />
                  </label>
                  <div className="button-row">
                    <button className="button primary small-button">
                      Save
                    </button>
                    <button
                      type="button"
                      className="button small-button"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <span className="agent-icon">
                    {agent.kind === "human" ? (
                      <User size={18} />
                    ) : (
                      <Bot size={18} />
                    )}
                  </span>
                  <div className="agent-body">
                    <div className="agent-name">
                      <strong>{agent.display_name}</strong>
                      <code>@{agent.handle}</code>
                      {!agent.active && <em>inactive</em>}
                    </div>
                    <small>
                      {agent.kind === "human"
                        ? "Person"
                        : agent.harness || "Agent"}
                      {agent.last_active_at &&
                        ` · last active ${relative(agent.last_active_at).replace("Just now", "just now")}`}
                    </small>
                    {agent.description ? (
                      <p>{agent.description}</p>
                    ) : (
                      agent.kind === "agent" && (
                        <p className="muted">
                          No description yet. The agent can add one with
                          set_profile.
                        </p>
                      )
                    )}
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Edit ${agent.display_name}`}
                    onClick={() => setEditing(agent.id)}
                  >
                    <Pencil size={15} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Eye,
  History,
  LoaderCircle,
  MessagesSquare,
  OctagonPause,
  RefreshCw,
} from "lucide-react";
import { api, relative } from "./api";
import type { Concern } from "@/lib/concerns";

type SpaceConcerns = {
  space: string;
  generated_at: string | null;
  model: string | null;
  concerns: Concern[];
  considered: { topics: number; memories: number } | null;
  running: boolean;
  stale: boolean;
  error?: string;
};
type ConcernList = {
  configured: boolean;
  enabled: boolean;
  model: string;
  spaces: SpaceConcerns[];
};
const groups = [
  { status: "needs_you", label: "Needs you", icon: CircleAlert },
  { status: "blocked", label: "Blocked", icon: OctagonPause },
  { status: "in_progress", label: "In progress", icon: CircleDot },
  { status: "watching", label: "Watching", icon: Eye },
] as const;

export function ConcernsPanel({
  owner,
  spaces,
  onOpenTopic,
  onOpenSession,
}: {
  owner: boolean;
  spaces: { slug: string; name: string }[];
  onOpenTopic: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [data, setData] = useState<ConcernList | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const autoRefreshed = useRef(false);
  async function refresh(force = false) {
    setRefreshing(true);
    setError("");
    try {
      setData(
        await api<ConcernList>("concerns/refresh", {
          method: "POST",
          body: JSON.stringify({ force }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to refresh.");
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    api<ConcernList>("concerns")
      .then((result) => {
        setData(result);
        // Visiting the page keeps it current: regenerate when stale.
        if (
          result.configured &&
          result.enabled &&
          !autoRefreshed.current &&
          result.spaces.some((space) => space.stale && !space.running)
        ) {
          autoRefreshed.current = true;
          void refresh(false);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  async function setEnabled(enabled: boolean) {
    setError("");
    try {
      await api("concerns/settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      const result = await api<ConcernList>("concerns");
      setData(result);
      if (enabled) void refresh(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  }
  if (!data)
    return (
      <div className="loading">
        <LoaderCircle className="spin" size={22} /> Loading concerns…
      </div>
    );
  if (!data.configured)
    return (
      <div className="surface plain-empty">
        <h3>Active concerns are not set up on this installation.</h3>
        <p>
          An operator sets <code>ASTROPATH_AI_BASE_URL</code> to an OpenAI
          Responses API endpoint to enable them.
        </p>
      </div>
    );
  if (!data.enabled)
    return (
      <div className="surface concerns-optin">
        <h3>Turn on active concerns</h3>
        <p>
          Astropath can read this workspace&apos;s recent board topics and
          memories and write a short list of what needs your attention, what is
          blocked and what is in progress, with links to the sources.
        </p>
        <p className="muted">
          To do that it sends excerpts of the last few weeks of topics and
          memories to <strong>{data.model}</strong> through this
          installation&apos;s AI gateway. Nothing is sent until the workspace
          owner turns this on.
        </p>
        {owner ? (
          <button className="button primary" onClick={() => setEnabled(true)}>
            Turn on for this workspace
          </button>
        ) : (
          <p>Ask the workspace owner to turn this on.</p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  const nameOf = (slug: string) =>
    spaces.find((space) => space.slug === slug)?.name ?? slug;
  return (
    <div className="concerns-panel">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data.spaces.map((space) => {
        const active = space.concerns.filter((c) => c.status !== "resolved");
        const resolved = space.concerns.filter((c) => c.status === "resolved");
        return (
          <section key={space.space} className="concerns-space">
            <header className="concerns-meta">
              {data.spaces.length > 1 && <h2>{nameOf(space.space)}</h2>}
              <span>
                {space.running || refreshing ? (
                  <>
                    <LoaderCircle size={13} className="spin" /> Updating…
                  </>
                ) : space.generated_at ? (
                  <>
                    Updated {relative(space.generated_at).toLowerCase()}
                    {space.considered &&
                      ` from ${space.considered.topics} topics and ${space.considered.memories} memories`}
                    {space.model && ` · ${space.model}`}
                  </>
                ) : (
                  "Not generated yet"
                )}
              </span>
              <button
                className="text-button"
                disabled={refreshing || space.running}
                onClick={() => refresh(true)}
              >
                <RefreshCw size={13} /> Refresh
              </button>
            </header>
            {space.error && (
              <p className="error" role="alert">
                The last update failed: {space.error}
              </p>
            )}
            {!active.length &&
            !resolved.length &&
            (space.running || refreshing) ? (
              <div className="surface plain-empty">
                <LoaderCircle size={20} className="spin" />
                <p>
                  Reading recent topics and memories. This usually takes under a
                  minute.
                </p>
              </div>
            ) : !active.length && !resolved.length ? (
              <div className="surface plain-empty">
                {space.generated_at
                  ? "Nothing needs attention right now."
                  : "Concerns appear here once agents have posted topics or memories."}
              </div>
            ) : (
              groups.map(({ status, label, icon: Icon }) => {
                const items = active.filter((c) => c.status === status);
                if (!items.length) return null;
                return (
                  <div key={status} className={`concern-group ${status}`}>
                    <h3>
                      <Icon size={15} /> {label} <span>{items.length}</span>
                    </h3>
                    {items.map((concern) => (
                      <ConcernCard
                        key={concern.key}
                        concern={concern}
                        onOpenTopic={onOpenTopic}
                        onOpenSession={onOpenSession}
                      />
                    ))}
                  </div>
                );
              })
            )}
            {resolved.length > 0 && (
              <details className="concern-group resolved">
                <summary>
                  <CheckCircle2 size={15} /> Recently resolved{" "}
                  <span>{resolved.length}</span>
                </summary>
                {resolved.map((concern) => (
                  <ConcernCard
                    key={concern.key}
                    concern={concern}
                    onOpenTopic={onOpenTopic}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </details>
            )}
          </section>
        );
      })}
      {owner && (
        <p className="concerns-footnote">
          Written by {data.model} from excerpts of recent topics and memories.{" "}
          <button className="text-button" onClick={() => setEnabled(false)}>
            Turn off
          </button>
        </p>
      )}
    </div>
  );
}

function ConcernCard({
  concern,
  onOpenTopic,
  onOpenSession,
}: {
  concern: Concern;
  onOpenTopic: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <article className="surface concern-card">
      <div className="concern-head">
        <strong>{concern.title}</strong>
        <time dateTime={concern.last_activity}>
          {relative(concern.last_activity)}
        </time>
      </div>
      <p>{concern.summary}</p>
      {concern.next_step && (
        <p className="concern-next">
          <span>Next</span> {concern.next_step}
        </p>
      )}
      <div className="concern-foot">
        {concern.agents.map((handle) => (
          <em key={handle} className="concern-agent">
            @{handle}
          </em>
        ))}
        {concern.sources.map((source) =>
          source.type === "topic" ? (
            <button
              key={source.id}
              className="concern-source"
              onClick={() => onOpenTopic(source.topic_id ?? source.id)}
              title={source.title}
            >
              <MessagesSquare size={12} /> {source.title}
            </button>
          ) : source.session_id ? (
            <button
              key={source.id}
              className="concern-source"
              onClick={() => onOpenSession(source.session_id!)}
              title={source.title}
            >
              <History size={12} /> {source.title}
            </button>
          ) : null,
        )}
      </div>
    </article>
  );
}

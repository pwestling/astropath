"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, History, Search } from "lucide-react";
import { api, relative } from "./api";
import type { Memory, MemorySession } from "@/lib/memory";

type SessionPage = { sessions: MemorySession[]; next_before: string | null };
type MemoryPage = { memories: Memory[]; next_before: string | null };
// Account entries have no session; they are grouped per account instead.
type Selection = { session_id: string | null; principal_id: string };

function sessionTitle(item: {
  session_name: string | null;
  session_id: string | null;
}) {
  return (
    item.session_name ?? (item.session_id ? "Unnamed session" : "Account notes")
  );
}
function when(date: string) {
  return new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function MemoryPanel({
  spaces,
}: {
  spaces: { slug: string; name: string }[];
}) {
  const [space, setSpace] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [sessions, setSessions] = useState<SessionPage>({
    sessions: [],
    next_before: null,
  });
  const [entries, setEntries] = useState<MemoryPage>({
    memories: [],
    next_before: null,
  });
  const [busy, setBusy] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const version = useRef(0);
  useEffect(() => {
    const sync = () => {
      const params = new URLSearchParams(window.location.search);
      const session = params.get("session");
      const account = params.get("account");
      setSelected(
        session
          ? { session_id: session, principal_id: "" }
          : account
            ? { session_id: null, principal_id: account }
            : null,
      );
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function open(next: Selection | null) {
    setSelected(next);
    setQuery("");
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    url.searchParams.delete("account");
    if (next?.session_id) url.searchParams.set("session", next.session_id);
    else if (next) url.searchParams.set("account", next.principal_id);
    window.history.pushState(null, "", url);
  }
  function memoryParams(before?: string | null) {
    const params = new URLSearchParams({ limit: "50" });
    if (space) params.set("space", space);
    if (query.trim()) params.set("q", query.trim());
    else if (selected?.session_id)
      params.set("session_id", selected.session_id);
    else if (selected) {
      params.set("principal_id", selected.principal_id);
      params.set("no_session", "true");
    }
    if (before) params.set("before", before);
    return params;
  }
  const searching = !!query.trim();
  useEffect(() => {
    const current = ++version.current;
    setBusy(true);
    setError("");
    const timer = setTimeout(
      () => {
        const load =
          searching || selected
            ? api<MemoryPage>(`memories?${memoryParams()}`).then((page) => {
                if (current !== version.current) return;
                setEntries(page);
              })
            : api<SessionPage>(
                `memory-sessions?${new URLSearchParams({
                  limit: "30",
                  ...(space ? { space } : {}),
                })}`,
              ).then((page) => {
                if (current === version.current) setSessions(page);
              });
        load
          .catch((e: Error) => {
            if (current === version.current) setError(e.message);
          })
          .finally(() => {
            if (current === version.current) setBusy(false);
          });
      },
      searching ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [space, query, selected?.session_id, selected?.principal_id]);
  async function loadMore() {
    setMore(true);
    try {
      if (searching || selected) {
        const page = await api<MemoryPage>(
          `memories?${memoryParams(entries.next_before)}`,
        );
        setEntries({
          memories: [...entries.memories, ...page.memories],
          next_before: page.next_before,
        });
      } else {
        const page = await api<SessionPage>(
          `memory-sessions?${new URLSearchParams({
            limit: "30",
            before: sessions.next_before!,
            ...(space ? { space } : {}),
          })}`,
        );
        setSessions({
          sessions: [...sessions.sessions, ...page.sessions],
          next_before: page.next_before,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load memories.");
    } finally {
      setMore(false);
    }
  }
  const head = entries.memories[0];
  // A session reads top to bottom, so its log is shown oldest first.
  const log = searching ? entries.memories : [...entries.memories].reverse();
  return (
    <div className="memory-panel">
      <div className="memory-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search memories"
            placeholder="Search every session's memories…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {spaces.length > 1 && (
          <select
            aria-label="Filter by space"
            value={space}
            onChange={(event) => setSpace(event.target.value)}
          >
            <option value="">All spaces</option>
            {spaces.map((item) => (
              <option key={item.slug} value={item.slug}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selected && !searching && (
        <header className="memory-session-head">
          <button className="text-button" onClick={() => open(null)}>
            <ArrowLeft size={14} /> All sessions
          </button>
          {head && (
            <>
              <h2>{sessionTitle(head.author)}</h2>
              {head.author.session_context && (
                <small className="memory-context">
                  {head.author.session_context}
                </small>
              )}
              <p>
                <Bot size={14} /> {head.author.name}
                {head.author.session_key && (
                  <code title="Session key reported by the agent">
                    {head.author.session_key}
                  </code>
                )}
              </p>
            </>
          )}
        </header>
      )}
      {busy ? (
        <p className="small" role="status">
          Loading memories…
        </p>
      ) : searching || selected ? (
        <>
          <div className="memory-heading">
            <h3>
              {searching
                ? `Memories matching “${query.trim()}”`
                : `${entries.memories.length}${entries.next_before ? "+" : ""} entries`}
            </h3>
            <span className="small">
              {searching ? "Newest first" : "Oldest first"}
            </span>
          </div>
          {!searching && entries.next_before && (
            <div className="load-more">
              <button className="button" disabled={more} onClick={loadMore}>
                Load earlier entries
              </button>
            </div>
          )}
          {log.length ? (
            <ol className="memory-log">
              {log.map((item) => (
                <li key={item.id} className="memory-entry">
                  <time dateTime={item.created_at} title={item.created_at}>
                    {when(item.created_at)}
                  </time>
                  <div>
                    <p className="memory-body">{item.body}</p>
                    {searching && (
                      <button
                        className="text-button memory-source"
                        onClick={() =>
                          open({
                            session_id: item.author.session_id,
                            principal_id: item.author.principal_id,
                          })
                        }
                      >
                        {item.author.name} · {sessionTitle(item.author)}
                      </button>
                    )}
                    {item.legacy && (
                      <small className="memory-legacy">
                        From topic {item.legacy.path.join(" / ")} ·{" "}
                        {item.legacy.kind}
                      </small>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="surface plain-empty">
              {searching
                ? "No memories match that search."
                : "This session has no memories yet."}
            </div>
          )}
          {searching && entries.next_before && (
            <div className="load-more">
              <button className="button" disabled={more} onClick={loadMore}>
                Load more
              </button>
            </div>
          )}
        </>
      ) : sessions.sessions.length ? (
        <>
          <div className="memory-heading">
            <h3>Sessions</h3>
            <span className="small">Most recently active first</span>
          </div>
          <ul className="memory-sessions">
            {sessions.sessions.map((item) => (
              <li key={`${item.space}:${item.session_id ?? item.principal_id}`}>
                <button
                  className="surface memory-session"
                  onClick={() =>
                    open({
                      session_id: item.session_id,
                      principal_id: item.principal_id,
                    })
                  }
                >
                  <span className="memory-session-top">
                    <strong>{sessionTitle(item)}</strong>
                    <time dateTime={item.last_at} title={item.last_at}>
                      {relative(item.last_at)}
                    </time>
                  </span>
                  <span className="memory-session-meta">
                    <Bot size={13} /> {item.author_name}
                    <span>·</span>
                    {item.count} {item.count === 1 ? "entry" : "entries"}
                    {spaces.length > 1 && (
                      <>
                        <span>·</span>
                        {item.space}
                      </>
                    )}
                  </span>
                  {item.context && (
                    <small className="memory-context">{item.context}</small>
                  )}
                  <span className="memory-preview">{item.latest}</span>
                </button>
              </li>
            ))}
          </ul>
          {sessions.next_before && (
            <div className="load-more">
              <button className="button" disabled={more} onClick={loadMore}>
                Load more sessions
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="surface plain-empty">
          <History size={25} />
          <h3>No memories yet.</h3>
          <p>
            Connected agents add to this log whenever they would write a memory.
            Each session keeps its own running record.
          </p>
        </div>
      )}
    </div>
  );
}

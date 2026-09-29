"use client";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Folder,
  Plus,
  Search,
} from "lucide-react";
import { api, relative } from "./api";
import type { Topic, TopicNote } from "@/lib/knowledge";

type Note = TopicNote & { topic: Topic };
type TopicPage = { topics: Topic[]; next_cursor: string | null };
type NotePage = { notes: Note[]; next_before: string | null };
const kinds = [
  "note",
  "progress",
  "milestone",
  "decision",
  "question",
  "handoff",
] as const;

export function KnowledgePanel({
  spaces,
}: {
  spaces: { slug: string; name: string }[];
}) {
  const [topicId, setTopicId] = useState("");
  const [topic, setTopic] = useState<Topic | null>(null);
  const [space, setSpace] = useState("");
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [topics, setTopics] = useState<TopicPage>({
    topics: [],
    next_cursor: null,
  });
  const [notes, setNotes] = useState<NotePage>({
    notes: [],
    next_before: null,
  });
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<(typeof kinds)[number]>("note");
  const requestVersion = useRef(0);
  const retry = useRef<{ payload: string; key: string } | null>(null);
  useEffect(() => {
    const sync = () =>
      setTopicId(
        new URLSearchParams(window.location.search).get("topic") ?? "",
      );
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function select(id: string) {
    setTopicId(id);
    setQuery("");
    setBody("");
    setCreating(false);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("topic", id);
    else url.searchParams.delete("topic");
    window.history.replaceState(null, "", url);
  }
  function params(type: "topics" | "notes") {
    const search = new URLSearchParams({
      limit: "30",
      include_archived: String(archived),
    });
    if (space && !topicId) search.set("space", space);
    if (query.trim()) search.set("q", query.trim());
    if (topicId)
      search.set(type === "topics" ? "parent_id" : "topic_id", topicId);
    // An explicitly opened archived topic always keeps its retained history readable.
    if (type === "notes" && topic?.effective_archived)
      search.set("include_archived", "true");
    return search;
  }
  useEffect(() => {
    const version = ++requestVersion.current;
    setBusy(true);
    setError("");
    const timer = setTimeout(
      () => {
        const common = new URLSearchParams({
          limit: "30",
          include_archived: String(archived),
        });
        if (space && !topicId) common.set("space", space);
        if (query.trim()) common.set("q", query.trim());
        const children = new URLSearchParams(common);
        if (topicId) children.set("parent_id", topicId);
        void (async () => {
          const selected = topicId
            ? (await api<{ topic: Topic }>(`topics/${topicId}`)).topic
            : null;
          if (topicId) common.set("topic_id", topicId);
          if (selected?.effective_archived) {
            common.set("include_archived", "true");
            children.set("include_archived", "true");
          }
          const [topicPage, notePage] = await Promise.all([
            api<TopicPage>(`topics?${children}`),
            api<NotePage>(`topic-notes?${common}`),
          ]);
          if (version !== requestVersion.current) return;
          setTopic(selected);
          setTopics(topicPage);
          setNotes(notePage);
        })()
          .catch((error) => {
            if (version === requestVersion.current)
              setError(
                error instanceof Error
                  ? error.message
                  : "Unable to load knowledge.",
              );
          })
          .finally(() => {
            if (version === requestVersion.current) setBusy(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      requestVersion.current++;
    };
  }, [topicId, space, query, archived, revision]);

  async function more(type: "topics" | "notes") {
    const version = requestVersion.current;
    setBusy(true);
    setError("");
    try {
      const search = params(type);
      if (type === "topics") {
        search.set("after", topics.next_cursor!);
        if (topic?.effective_archived) search.set("include_archived", "true");
        const next = await api<TopicPage>(`topics?${search}`);
        if (version === requestVersion.current)
          setTopics((old) => ({
            topics: [...old.topics, ...next.topics],
            next_cursor: next.next_cursor,
          }));
      } else {
        search.set("before", notes.next_before!);
        const next = await api<NotePage>(`topic-notes?${search}`);
        if (version === requestVersion.current)
          setNotes((old) => ({
            notes: [...old.notes, ...next.notes],
            next_before: next.next_before,
          }));
      }
    } catch (error) {
      if (version === requestVersion.current)
        setError(
          error instanceof Error ? error.message : "Unable to load more.",
        );
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }
  async function create(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ topic: Topic }>("topics", {
        method: "POST",
        body: JSON.stringify({
          space: topic?.space || space || spaces[0]?.slug,
          path: [...(topic?.path.map((part) => part.name) ?? []), name.trim()],
        }),
      });
      setName("");
      select(result.topic.id);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to create topic.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function archive() {
    if (!topic) return;
    setSaving(true);
    setError("");
    try {
      await api(`topics/${topic.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: !topic.archived_at }),
      });
      setRevision((value) => value + 1);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to archive topic.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function append(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!topic) return;
    setSaving(true);
    setError("");
    const input = { topic_id: topic.id, kind, body: body.trim() };
    const payload = JSON.stringify(input);
    if (retry.current?.payload !== payload)
      retry.current = { payload, key: crypto.randomUUID() };
    try {
      await api("topic-notes", {
        method: "POST",
        body: JSON.stringify({ ...input, idempotency_key: retry.current.key }),
      });
      setBody("");
      retry.current = null;
      setRevision((value) => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to save note.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="knowledge-panel">
      <div className="knowledge-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Search knowledge"
            placeholder="Search topics and notes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!topicId && (
          <select
            aria-label="Knowledge space"
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
        <label className="knowledge-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />{" "}
          Include archived
        </label>
      </div>
      {error && (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <div className="button-row">
            <button
              className="button"
              onClick={() => setRevision((value) => value + 1)}
            >
              Reload
            </button>
            <button
              className="button"
              onClick={() => {
                select("");
                setRevision((value) => value + 1);
              }}
            >
              All topics
            </button>
          </div>
        </div>
      )}
      {busy && (
        <p className="small" role="status">
          Loading knowledge…
        </p>
      )}
      {!busy && !error && (
        <>
          <nav className="knowledge-breadcrumbs" aria-label="Topic path">
            <button className="text-button" onClick={() => select("")}>
              <ArrowLeft size={14} /> All topics
            </button>
            {topic?.path.map((part) => (
              <span key={part.id}>
                <ChevronRight size={14} />
                <button
                  className="text-button"
                  onClick={() => select(part.id)}
                  aria-current={part.id === topic.id ? "page" : undefined}
                >
                  {part.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="knowledge-heading">
            <div>
              <h2>{topic?.name ?? "Areas of interest"}</h2>
              <p>
                {topic
                  ? `${topic.space} · Notes here and in its subtopics`
                  : "Broad subjects that grow with your work. Notes can live at any depth."}
              </p>
            </div>
            <div className="button-row">
              {topic && (
                <button
                  className="button"
                  disabled={
                    saving || (!!topic.effective_archived && !topic.archived_at)
                  }
                  onClick={() => void archive()}
                >
                  <Archive size={15} />
                  {topic.archived_at ? "Restore topic" : "Archive topic"}
                </button>
              )}
              {!topic?.effective_archived && (
                <button
                  className="button"
                  disabled={saving || (topic?.path.length ?? 0) >= 32}
                  onClick={() => setCreating((value) => !value)}
                >
                  <Plus size={15} />
                  {topic ? "New subtopic" : "New topic"}
                </button>
              )}
            </div>
          </div>
          {topic?.effective_archived && (
            <p className="knowledge-archive">
              This branch is archived. Its history is preserved.{" "}
              {topic.archived_at
                ? "Restore it to add notes or subtopics."
                : "Restore the archived ancestor to add notes or subtopics."}
            </p>
          )}
          {creating && (
            <form className="surface knowledge-form" onSubmit={create}>
              <label>
                Topic name
                <input
                  autoFocus
                  required
                  maxLength={100}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={topic ? "e.g. Materials" : "e.g. 3D printing"}
                />
              </label>
              {!topic && (
                <label>
                  Space
                  <select
                    value={space || spaces[0]?.slug || ""}
                    required
                    onChange={(event) => setSpace(event.target.value)}
                  >
                    {spaces.map((item) => (
                      <option key={item.slug} value={item.slug}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                className="button primary"
                disabled={saving || !name.trim()}
              >
                Create topic
              </button>
            </form>
          )}
          <div className="knowledge-topics">
            {topics.topics.map((item) => (
              <button
                key={item.id}
                className="surface knowledge-topic"
                onClick={() => select(item.id)}
              >
                <Folder size={22} />
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {query
                      ? item.path.map((part) => part.name).join(" / ")
                      : item.space}
                  </small>
                  {item.effective_archived && <small>Archived</small>}
                </span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {!topics.topics.length && (
            <p className="small">
              {query
                ? "No matching topics."
                : topic
                  ? "No subtopics yet. Notes can stay right here."
                  : "Create your first topic, or let an agent find or create one as it works."}
            </p>
          )}
          {topics.next_cursor && (
            <button className="button" onClick={() => void more("topics")}>
              More topics
            </button>
          )}
          {topic && !topic.effective_archived && (
            <form className="surface knowledge-form" onSubmit={append}>
              <h3>Leave a note</h3>
              <label>
                Kind
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as typeof kind)
                  }
                >
                  {kinds.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
              <label>
                Note
                <textarea
                  required
                  rows={4}
                  maxLength={20000}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="A useful discovery, decision, question, or milestone…"
                />
              </label>
              <div className="knowledge-heading">
                <span className="small">
                  Saved with your account's authorship.
                </span>
                <button
                  className="button primary"
                  disabled={saving || !body.trim()}
                >
                  Save note
                </button>
              </div>
            </form>
          )}
          <div className="knowledge-heading">
            <h3>
              {query
                ? "Matching notes"
                : topic
                  ? "Topic history"
                  : "Recent knowledge"}
            </h3>
            <span className="small">
              Newest first{topic ? " · includes subtopics" : ""}
            </span>
          </div>
          <div className="knowledge-notes">
            {notes.notes.map((note) => (
              <article className="surface knowledge-note" key={note.id}>
                <header>
                  <span className="knowledge-kind">{note.kind}</span>
                  <time title={new Date(note.created_at).toLocaleString()}>
                    {relative(note.created_at)}
                  </time>
                </header>
                <button
                  className="text-button knowledge-note-path"
                  onClick={() => select(note.topic_id)}
                >
                  {note.topic.path.map((part) => part.name).join(" / ")}
                </button>
                <p className="knowledge-body">{note.body}</p>
                <footer>
                  <strong>{note.author.name}</strong>
                  {note.author.session_id ? (
                    <details>
                      <summary>{note.author.session_name}</summary>
                      <span>Session: {note.author.session_key}</span>
                      <span>Astropath session: {note.author.session_id}</span>
                      <span>Connection: {note.author.principal_id}</span>
                    </details>
                  ) : (
                    <span>Account note</span>
                  )}
                </footer>
              </article>
            ))}
            {!notes.notes.length && (
              <div className="surface plain-empty">
                {query
                  ? "No matching notes."
                  : "As work progresses, agents leave their discoveries and milestones here, with the session that wrote each note."}
              </div>
            )}
          </div>
          {notes.next_before && (
            <button className="button" onClick={() => void more("notes")}>
              Older notes
            </button>
          )}
        </>
      )}
    </div>
  );
}

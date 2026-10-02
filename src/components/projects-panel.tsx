"use client";
import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  History,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
} from "lucide-react";
import { api, relative } from "./api";
import type { Project } from "@/lib/projects";

type SpaceProjects = {
  space: string;
  generated_at: string | null;
  model: string | null;
  projects: Project[];
  considered: { topics: number; memories: number } | null;
  running: boolean;
  stale: boolean;
  error?: string;
};
type Overview = {
  configured: boolean;
  enabled: boolean;
  model: string;
  spaces: SpaceProjects[];
};
type OverrideKind = "archived" | "unarchived" | "silenced";
const kindLabel: Record<Project["latest"]["kind"], string> = {
  blocked: "Blocked",
  needs_you: "Needs you",
  progress: "Progress",
  decision: "Decision",
  shipped: "Shipped",
  question: "Question",
};
const when = (date: string) => relative(date).replace("Just now", "just now");

export function ProjectsPanel({
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
  const [data, setData] = useState<Overview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const autoRefreshed = useRef(false);
  async function refresh(force = false) {
    setRefreshing(true);
    setError("");
    try {
      setData(
        await api<Overview>("projects/refresh", {
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
    api<Overview>("projects")
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
  async function override(
    space: string,
    key: string,
    kind: OverrideKind,
    set = true,
  ) {
    setError("");
    try {
      setData(
        await api<Overview>("projects/overrides", {
          method: "POST",
          body: JSON.stringify({ space, key, kind, set }),
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  }
  async function setEnabled(enabled: boolean) {
    setError("");
    try {
      await api("projects/settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled }),
      });
      setData(await api<Overview>("projects"));
      if (enabled) void refresh(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    }
  }
  if (!data)
    return (
      <div className="loading">
        <LoaderCircle className="spin" size={22} /> Loading projects…
      </div>
    );
  if (!data.configured)
    return (
      <div className="surface plain-empty">
        <h3>The Projects overview is not set up on this installation.</h3>
        <p>
          An operator sets <code>ASTROPATH_AI_BASE_URL</code> to an OpenAI
          Responses API endpoint to enable it.
        </p>
      </div>
    );
  if (!data.enabled)
    return (
      <div className="surface concerns-optin">
        <h3>Turn on the Projects overview</h3>
        <p>
          Astropath can read this workspace&apos;s recent board topics and
          memories, work out which projects you have in flight, and show the
          latest important thing in each, with links to the sources.
        </p>
        <p className="muted">
          To do that it sends excerpts of the last six weeks of topics and
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
        const live = space.projects.filter((p) => !p.archived);
        const attention = live.filter((p) => p.alert && !p.silenced);
        const others = live.filter((p) => !(p.alert && !p.silenced));
        const archived = space.projects.filter((p) => p.archived);
        const busy = space.running || refreshing;
        const card = (project: Project) => (
          <ProjectCard
            key={project.key}
            project={project}
            onOpenTopic={onOpenTopic}
            onOpenSession={onOpenSession}
            onOverride={(kind, set) =>
              override(space.space, project.key, kind, set)
            }
          />
        );
        return (
          <section key={space.space} className="concerns-space">
            <header className="concerns-meta">
              {data.spaces.length > 1 && <h2>{nameOf(space.space)}</h2>}
              <span>
                {busy ? (
                  <>
                    <LoaderCircle size={13} className="spin" /> Updating…
                  </>
                ) : space.generated_at ? (
                  <>
                    Updated {when(space.generated_at)}
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
                disabled={busy}
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
            {!space.projects.length ? (
              <div className="surface plain-empty">
                {busy ? (
                  <>
                    <LoaderCircle size={20} className="spin" />
                    <p>
                      Reading recent topics and memories. This usually takes a
                      minute or two.
                    </p>
                  </>
                ) : space.generated_at ? (
                  "No projects found in recent activity."
                ) : (
                  "Projects appear here once agents have posted topics or memories."
                )}
              </div>
            ) : (
              <>
                {attention.length > 0 && (
                  <div className="concern-group needs_you">
                    <h3>
                      <Bell size={15} /> Needs attention{" "}
                      <span>{attention.length}</span>
                    </h3>
                    {attention.map(card)}
                  </div>
                )}
                {others.length > 0 && (
                  <div className="concern-group in_progress">
                    <h3>
                      Projects <span>{others.length}</span>
                    </h3>
                    {others.map(card)}
                  </div>
                )}
                {archived.length > 0 && (
                  <details className="concern-group resolved">
                    <summary>
                      <Archive size={15} /> Archived{" "}
                      <span>{archived.length}</span>
                    </summary>
                    {archived.map(card)}
                  </details>
                )}
              </>
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

function ProjectCard({
  project,
  onOpenTopic,
  onOpenSession,
  onOverride,
}: {
  project: Project;
  onOpenTopic: (id: string) => void;
  onOpenSession: (sessionId: string) => void;
  onOverride: (kind: OverrideKind, set: boolean) => void;
}) {
  const [allSources, setAllSources] = useState(false);
  const sources = allSources ? project.sources : project.sources.slice(0, 4);
  return (
    <article
      className={`surface concern-card project-card ${project.archived ? "is-archived" : ""}`}
    >
      <div className="concern-head">
        <strong>{project.name}</strong>
        <time dateTime={project.last_activity}>
          {when(project.last_activity)}
        </time>
      </div>
      {project.alert && !project.silenced && !project.archived && (
        <p className={`project-alert ${project.alert.kind}`}>
          <Bell size={13} />
          {project.alert.text}
        </p>
      )}
      <p className="project-latest">
        <span className={`latest-kind ${project.latest.kind}`}>
          {kindLabel[project.latest.kind]}
        </span>
        <strong>{project.latest.headline}</strong>
      </p>
      {project.latest.detail && <p>{project.latest.detail}</p>}
      <p className="project-summary">{project.summary}</p>
      {(project.archived ||
        project.kept_active ||
        project.resumed ||
        project.silenced) && (
        <p className="project-flags">
          {project.archived_by === "ai" && (
            <span>
              Archived by the AI
              {project.ai_archived?.reason
                ? `: ${project.ai_archived.reason}`
                : ""}
            </span>
          )}
          {project.archived_by === "you" && <span>Archived by you</span>}
          {project.kept_active && <span>Kept active by you</span>}
          {project.resumed && <span>Back from your archive: new activity</span>}
          {project.silenced && <span>Alert silenced</span>}
        </p>
      )}
      <div className="concern-foot">
        {project.agents.map((handle) => (
          <em key={handle} className="concern-agent">
            @{handle}
          </em>
        ))}
        {sources.map((source) =>
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
        {!allSources && project.sources.length > 4 && (
          <button
            className="concern-source"
            onClick={() => setAllSources(true)}
          >
            +{project.sources.length - 4} more
          </button>
        )}
      </div>
      <div className="project-actions">
        {project.archived ? (
          <button
            className="button small-button"
            onClick={() => onOverride("unarchived", true)}
          >
            <ArchiveRestore size={14} /> Unarchive
          </button>
        ) : (
          <button
            className="button small-button"
            onClick={() => onOverride("archived", true)}
          >
            <Archive size={14} /> Archive
          </button>
        )}
        {project.kept_active && (
          <button
            className="text-button"
            onClick={() => onOverride("unarchived", false)}
          >
            Let the AI decide
          </button>
        )}
        {project.alert &&
          !project.archived &&
          (project.silenced ? (
            <button
              className="button small-button"
              onClick={() => onOverride("silenced", false)}
            >
              <Bell size={14} /> Unsilence
            </button>
          ) : (
            <button
              className="button small-button"
              onClick={() => onOverride("silenced", true)}
            >
              <BellOff size={14} /> Silence alert
            </button>
          ))}
      </div>
    </article>
  );
}

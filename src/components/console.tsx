"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleDot,
  Copy,
  File,
  FileImage,
  FileText,
  Folder,
  History,
  Inbox,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  MessagesSquare,
  Telescope,
  Bot,
  MoreHorizontal,
  Paperclip,
  Plus,
  RadioTower,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Upload,
  Sparkles,
  Star,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { Brand } from "./brand";
import { api, bytes, relative } from "./api";
import { authClient } from "@/lib/auth-client";
import { MemberSettings } from "./member-settings";
import { TenantSwitcher, PlatformTenants } from "./tenant-switcher";
import { PublicFilesPanel } from "./public-files-panel";
import { MemoryPanel } from "./memory-panel";
import { AgentsPanel } from "./agents-panel";
import { ProjectsPanel } from "./projects-panel";
import type { Message, Attachment } from "@/lib/store";

// Board posts carry their author and @mentions as handles.
type Post = Omit<Message, "mentions"> & {
  author?: {
    handle: string | null;
    display_name: string;
    kind: string;
    session?: { ref: string; name: string; context?: string };
  };
  mentions?: string[];
};
type Section =
  | "projects"
  | "inbox"
  | "agents"
  | "memory"
  | "public-files"
  | "starred"
  | "archive"
  | "connections"
  | "activity"
  | "settings";
interface Connection {
  id: string;
  name: string;
  kind: "token" | "oauth";
  token_prefix: string | null;
  scopes: string[];
  spaces: string[] | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}
interface Activity {
  id: number;
  actor: string;
  action: string;
  detail: string | null;
  created_at: string;
}
interface Overview {
  total: number;
  unread: number;
  files: number;
  pinned: number;
  storage_bytes: string;
  connections: Connection[];
  activity: Activity[];
}
interface Space {
  slug: string;
  name: string;
}
const sectionTitle: Record<Section, string> = {
  projects: "Projects",
  inbox: "Board",
  agents: "Agents",
  memory: "Memory",
  "public-files": "Public files",
  starred: "Starred",
  archive: "Archive",
  connections: "Connections",
  activity: "Activity",
  settings: "Settings",
};

export function Console({
  ownerName,
  owner,
  baseUrl,
  tenantId,
}: {
  ownerName: string;
  owner: boolean;
  baseUrl: string;
  tenantId?: string;
}) {
  const [section, setSection] = useState<Section>("projects");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("session") || params.has("account")) setSection("memory");
  }, []);
  const [mobileNav, setMobileNav] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [space, setSpace] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [messages, setMessages] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [tokenModal, setTokenModal] = useState(false);
  const [notice, setNotice] = useState("");
  const latestList = useRef(0);
  const refreshOverview = useCallback(async () => {
    try {
      const [o, s] = await Promise.all([
        api<Overview>("overview"),
        api<{ spaces: Space[] }>("spaces"),
      ]);
      setOverview(o);
      setSpaces(s.spaces);
    } catch (e) {
      setError(message(e));
    }
  }, []);
  const loadMessages = useCallback(
    async (next?: string) => {
      const requestId = ++latestList.current;
      setBusy(true);
      setError("");
      const query = new URLSearchParams({ limit: "30" });
      if (space) query.set("space", space);
      if (search) query.set("q", search);
      if (section === "archive") query.set("archived", "true");
      if (section === "starred") query.set("pinned", "true");
      if (filter === "unread") query.set("unread", "true");
      if (filter === "mentions") query.set("mentioning", "me");
      if (filter === "files") query.set("with_files", "true");
      if (next) query.set("cursor", next);
      try {
        const result = await api<{
          messages: Post[];
          next_cursor: string | null;
        }>(`messages?${query}`);
        if (requestId === latestList.current) {
          setMessages((old) =>
            next ? [...old, ...result.messages] : result.messages,
          );
          setCursor(result.next_cursor);
        }
      } catch (e) {
        if (requestId === latestList.current) setError(message(e));
      } finally {
        if (requestId === latestList.current) setBusy(false);
      }
    },
    [space, search, section, filter],
  );
  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);
  useEffect(() => {
    const timer = setTimeout(() => void loadMessages(), search ? 250 : 0);
    return () => clearTimeout(timer);
  }, [loadMessages, search]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const refresh = () => {
    void refreshOverview();
    void loadMessages();
  };
  function navigate(value: Section) {
    setSection(value);
    setSelected(null);
    setMobileNav(false);
    setSearch("");
    setFilter("all");
  }
  async function togglePin(item: Post) {
    try {
      await api(`messages/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ pinned: !item.pinned }),
      });
      refresh();
    } catch (e) {
      setError(message(e));
    }
  }
  const activeConnections =
    overview?.connections.filter(
      (c) =>
        !c.revoked_at && (!c.expires_at || new Date(c.expires_at) > new Date()),
    ) || [];
  const listSection = ["inbox", "starred", "archive"].includes(section);
  const visibleMessages = messages;
  return (
    <div className="app-shell" data-tenant-id={tenantId ?? ""}>
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <Brand />
        <TenantSwitcher />
        <div className="nav-label">BROWSE</div>
        <nav aria-label="Main navigation">
          {(
            [
              {
                id: "projects",
                icon: Telescope,
                label: "Projects",
                count: undefined,
              },
              {
                id: "inbox",
                icon: MessagesSquare,
                label: "Board",
                count: overview?.unread,
              },
              {
                id: "starred",
                icon: Star,
                label: "Starred",
                count: overview?.pinned,
              },
              {
                id: "memory",
                icon: History,
                label: "Memory",
                count: undefined,
              },
              {
                id: "public-files",
                icon: Upload,
                label: "Public files",
                count: undefined,
              },
              {
                id: "archive",
                icon: Archive,
                label: "Archive",
                count: undefined,
              },
            ] as const
          ).map(({ id, icon: Icon, label, count }) => (
            <button
              key={id}
              className={`nav-item ${section === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {!!count && <b>{count}</b>}
            </button>
          ))}
        </nav>
        <div className="nav-label">MANAGE</div>
        <nav aria-label="Management">
          {(
            [
              { id: "agents", icon: Bot, label: "Agents" },
              { id: "connections", icon: Link2, label: "Connections" },
              { id: "activity", icon: CircleDot, label: "Activity" },
              { id: "settings", icon: Settings, label: "Settings" },
            ] as const
          ).map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              className={`nav-item ${section === id ? "active" : ""}`}
              onClick={() => navigate(id)}
            >
              <Icon size={18} />
              <span>{label}</span>
              {id === "connections" && activeConnections.length > 0 && (
                <span
                  className="connection-dot"
                  title={`${activeConnections.length} active`}
                />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-note">
            <span>
              <span className="status-dot" /> Workspace storage
            </span>
            <strong>{bytes(overview?.storage_bytes || 0)}</strong>
            <small>Original files, kept private.</small>
          </div>
          <button className="user-button" onClick={() => navigate("settings")}>
            <span className="user-avatar">{ownerName.slice(0, 1)}</span>
            <span>
              <strong>{ownerName}</strong>
              <small>{owner ? "Workspace owner" : "Workspace member"}</small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      {mobileNav && (
        <button
          aria-label="Close navigation"
          className="nav-scrim"
          onClick={() => setMobileNav(false)}
        />
      )}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={19} />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{sectionTitle[section]}</strong>
          </div>
          <span className="private-badge">
            <ShieldCheck size={14} /> Private workspace
          </span>
        </header>
        <div className="page-content">
          <div className="page-heading">
            <div>
              <h1>
                {sectionTitle[section]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {section === "projects"
                  ? "Everything you have in flight, and the latest important thing in each, from your agents' board and memories."
                  : section === "inbox"
                    ? "Topics posted by your agents and you. @mentions flag who each is for; agents catch up when they choose."
                    : section === "public-files"
                      ? "Publish a file and share a permanent link anyone can download."
                      : section === "memory"
                        ? "What your agents chose to remember, logged session by session."
                        : section === "agents"
                          ? "Everyone who can post here, and what each is for."
                          : section === "connections"
                            ? "The agents and apps that can reach this workspace, and what they can touch."
                            : section === "activity"
                              ? "A record of what arrived and who sent it."
                              : section === "settings"
                                ? "Spaces, members, and your account."
                                : section === "starred"
                                  ? "Topics worth keeping within reach."
                                  : "Topics set aside."}
              </p>
            </div>
            {listSection ? (
              <button
                className="button primary"
                onClick={() => setComposer(true)}
              >
                <Plus size={17} /> New topic
              </button>
            ) : section === "connections" ? (
              <button
                className="button primary"
                onClick={() => setTokenModal(true)}
              >
                <Plus size={17} /> Create API token
              </button>
            ) : null}
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={refresh}>
                Try again
              </button>
            </div>
          )}
          {listSection && (
            <>
              <div className="stats-row">
                <Stat
                  label="TOPICS"
                  value={overview?.total}
                  icon={<Inbox size={17} />}
                  caption="Across every space you can reach"
                />
                <Stat
                  label="UNREAD"
                  value={overview?.unread}
                  icon={<CircleDot size={17} />}
                  caption="Topics you have not opened"
                />
                <Stat
                  label="CONNECTED APPS"
                  value={activeConnections.length}
                  icon={<Link2 size={17} />}
                  caption="Agents and apps with access"
                />
              </div>
              <div className="inbox-panel">
                <div className="inbox-toolbar">
                  <div className="tabs">
                    {[
                      ["all", "All topics"],
                      ["mentions", "Mentions me"],
                      ["unread", "Unread"],
                      ["files", "With files"],
                    ].map(([id, label]) => (
                      <button
                        key={id}
                        className={filter === id ? "selected" : ""}
                        onClick={() => setFilter(id)}
                      >
                        {label}
                        {id === "all" && <span>{overview?.total || 0}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="list-tools">
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="Search topics"
                        placeholder="Search topics…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </label>
                    <select
                      aria-label="Filter by space"
                      value={space}
                      onChange={(e) => setSpace(e.target.value)}
                    >
                      <option value="">All spaces</option>
                      {spaces.map((s) => (
                        <option key={s.slug} value={s.slug}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="list-heading">
                  <span>TOPIC</span>
                  <span>AUTHOR / SPACE</span>
                  <span>POSTED</span>
                  <span />
                </div>
                {busy && !messages.length ? (
                  <div className="loading">
                    <LoaderCircle size={22} className="spin" /> Loading the
                    board…
                  </div>
                ) : visibleMessages.length ? (
                  visibleMessages.map((message) => (
                    <div
                      key={message.id}
                      className={`message-row ${message.unread ? "unread" : ""}`}
                    >
                      <button
                        className="message-main"
                        onClick={() => setSelected(message.id)}
                      >
                        <span
                          className={`file-icon ${Number(message.attachment_count) > 0 ? "file-icon-blue" : ""}`}
                        >
                          {Number(message.attachment_count) > 0 ? (
                            <FileImage size={20} />
                          ) : (
                            <FileText size={20} />
                          )}
                        </span>
                        <span className="message-text">
                          <strong>
                            {message.title}
                            {message.unread && <i className="unread-dot" />}
                          </strong>
                          <span>
                            {message.body.replace(/[#*`]/g, "").slice(0, 105) ||
                              `${message.attachment_count} attached file${message.attachment_count === 1 ? "" : "s"}`}
                          </span>
                          <span className="message-tags">
                            {message.tags.slice(0, 3).map((tag) => (
                              <em key={tag}>{tag}</em>
                            ))}
                            {!!message.attachment_count && (
                              <small>
                                <Paperclip size={11} />
                                {message.attachment_count}
                              </small>
                            )}
                            {!!message.reply_count && (
                              <small>
                                {message.reply_count}{" "}
                                {message.reply_count === 1
                                  ? "reply"
                                  : "replies"}
                              </small>
                            )}
                          </span>
                        </span>
                      </button>
                      <div className="message-origin">
                        <Byline post={message} />
                        <small>
                          <Folder size={11} />
                          {spaces.find((s) => s.slug === message.space)?.name ||
                            message.space}
                          <Mentions handles={message.mentions} />
                        </small>
                      </div>
                      <time
                        title={new Date(message.created_at).toLocaleString()}
                      >
                        {relative(message.created_at)}
                      </time>
                      <button
                        className={`icon-button star-button ${message.pinned ? "is-pinned" : ""}`}
                        aria-label={
                          message.pinned ? "Unstar topic" : "Star topic"
                        }
                        onClick={() => togglePin(message)}
                      >
                        <Star
                          size={16}
                          fill={message.pinned ? "currentColor" : "none"}
                        />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <div className="empty-illustration">
                      <div />
                      <div />
                      <span>
                        <Inbox size={32} strokeWidth={1.35} />
                        <i />
                      </span>
                    </div>
                    <span className="eyebrow">THE CHANNEL IS QUIET</span>
                    <h2>
                      {search
                        ? "Nothing matched that search."
                        : filter === "unread"
                          ? "You’re all caught up."
                          : section === "archive"
                            ? "Nothing archived yet."
                            : filter === "mentions"
                              ? "Nobody has mentioned you yet."
                              : "No topics yet."}
                    </h2>
                    <p>
                      {search
                        ? "Try another phrase or look in a different space."
                        : "Start a topic, or connect an agent. Agents post findings and hand off context here, and @mention whoever it may be for."}
                    </p>
                    <div className="button-row">
                      <button
                        className="button"
                        onClick={() => setComposer(true)}
                      >
                        <Plus size={16} /> Send a message
                      </button>
                      <button
                        className="text-button"
                        onClick={() => navigate("connections")}
                      >
                        Connect an app <ArrowRight size={14} />
                      </button>
                    </div>
                  </div>
                )}
                {cursor && (
                  <div className="load-more">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => loadMessages(cursor)}
                    >
                      Load more
                    </button>
                  </div>
                )}
                <div className="panel-footer">
                  <span>
                    <LockDot /> Access is limited to each space’s members and
                    connected apps
                  </span>
                  <span>RELAYED PRIVATELY</span>
                </div>
              </div>
              <div className="inbox-bottom">
                <span>
                  <Sparkles size={15} /> Sent by one agent. Picked up by the
                  next.
                </span>
                <button
                  className="text-button"
                  onClick={() => navigate("connections")}
                >
                  View your connections <ArrowRight size={13} />
                </button>
              </div>
            </>
          )}
          {section === "public-files" && <PublicFilesPanel spaces={spaces} />}
          {section === "memory" && <MemoryPanel spaces={spaces} />}
          {section === "agents" && <AgentsPanel owner={owner} />}
          {section === "projects" && (
            <ProjectsPanel
              owner={owner}
              spaces={spaces}
              onOpenTopic={(id) => setSelected(id)}
              onOpenSession={(sessionId) => {
                const url = new URL(window.location.href);
                url.searchParams.set("session", sessionId);
                window.history.pushState(null, "", url);
                navigate("memory");
              }}
            />
          )}
          {section === "connections" && (
            <Connections
              baseUrl={baseUrl}
              defaultSpace={spaces[0]?.slug || "general"}
              connections={overview?.connections || []}
              onCreate={() => setTokenModal(true)}
              onRevoke={async (id) => {
                try {
                  await api(`connections/${id}`, { method: "DELETE" });
                  refresh();
                  setNotice("Connection revoked.");
                } catch (e) {
                  setError(message(e));
                }
              }}
            />
          )}
          {section === "activity" && (
            <div className="surface activity-list">
              {overview?.activity.length ? (
                overview.activity.map((item) => (
                  <div className="activity-row" key={item.id}>
                    <span className="activity-icon">
                      <CircleDot size={17} />
                    </span>
                    <div>
                      <strong>{item.actor}</strong> {item.action}{" "}
                      {item.detail && <b>{item.detail}</b>}
                      <small>
                        {new Date(item.created_at).toLocaleString()}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <div className="plain-empty">
                  Activity will appear as you and your apps use Astropath.
                </div>
              )}
            </div>
          )}
          {section === "settings" && (
            <SettingsPanel
              owner={owner}
              spaces={spaces}
              onRefresh={refresh}
              onNotice={setNotice}
            />
          )}
        </div>
      </main>
      {composer && (
        <Composer
          initialSpace={
            space ||
            spaces.find((item) => item.slug === "general")?.slug ||
            spaces[0]?.slug ||
            "general"
          }
          spaces={spaces}
          onClose={() => setComposer(false)}
          onCreated={() => {
            setComposer(false);
            refresh();
            setNotice("Message sent.");
          }}
        />
      )}
      {selected && (
        <MessageDetail
          id={selected}
          onClose={() => setSelected(null)}
          onChange={refresh}
          onNotice={setNotice}
        />
      )}
      {tokenModal && (
        <TokenModal
          owner={owner}
          spaces={spaces}
          onClose={() => setTokenModal(false)}
          onCreated={refresh}
        />
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
    </div>
  );
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
function LockDot() {
  return <ShieldCheck size={12} />;
}
function Stat({
  label,
  value,
  icon,
  caption,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  caption: string;
}) {
  return (
    <div className="stat">
      <div>
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value ?? "—"}</strong>
      <small>{caption}</small>
    </div>
  );
}
function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-value">
      <code>{value}</code>
      <button
        className="icon-button"
        aria-label="Copy to clipboard"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function Connections({
  baseUrl,
  defaultSpace,
  connections,
  onCreate,
  onRevoke,
}: {
  baseUrl: string;
  defaultSpace: string;
  connections: Connection[];
  onCreate: () => void;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <>
      <div className="integration-grid">
        <div className="integration-card">
          <span className="integration-symbol">
            <RadioTower size={22} />
          </span>
          <span className="eyebrow">CHATGPT & CLAUDE</span>
          <h2>Connect with MCP</h2>
          <p>
            Add this address as a custom connector, then sign in to Astropath
            and approve access.
          </p>
          <CopyValue value={`${baseUrl}/mcp`} />
          <small>
            <ShieldCheck size={13} /> OAuth · Your account stays in control
          </small>
        </div>
        <div className="integration-card">
          <span className="integration-symbol terminal">
            <Terminal size={23} />
          </span>
          <span className="eyebrow">MUSE & HTTP CLIENTS</span>
          <h2>A simple HTTP API</h2>
          <p>
            Create a token and send it in the Authorization header. Notes and
            files use the same inbox.
          </p>
          <CopyValue value={`${baseUrl}/api/v1`} />
          <small>
            <KeyRound size={13} /> Authorization: Bearer ap_…
          </small>
        </div>
      </div>
      <div className="section-subheading">
        <h2>
          Connected applications{" "}
          <span>{connections.filter((c) => !c.revoked_at).length}</span>
        </h2>
      </div>
      <div className="surface">
        {connections.length ? (
          connections.map((connection) => (
            <div className="connection-row" key={connection.id}>
              <span className="connection-avatar">
                {connection.name.slice(0, 1)}
              </span>
              <div className="connection-info">
                <strong>
                  {connection.name}
                  <span className="pill">
                    {connection.kind === "oauth" ? "MCP / OAuth" : "API token"}
                  </span>
                </strong>
                <small>
                  {connection.scopes.includes("astropath:write")
                    ? "Read / write"
                    : "Read only"}{" "}
                  ·{" "}
                  {connection.spaces === null
                    ? "All spaces"
                    : connection.spaces.length
                      ? connection.spaces.join(", ")
                      : "No current space access"}{" "}
                  ·{" "}
                  {connection.last_used_at
                    ? `Last used ${relative(connection.last_used_at)}`
                    : "Not used yet"}
                </small>
              </div>
              <span
                className={`connection-status ${connection.revoked_at ? "revoked" : ""}`}
              >
                {connection.revoked_at
                  ? "Revoked"
                  : connection.expires_at &&
                      new Date(connection.expires_at) < new Date()
                    ? "Expired"
                    : "Active"}
              </span>
              {!connection.revoked_at &&
                (confirm === connection.id ? (
                  <div className="button-row">
                    <button
                      className="button danger small-button"
                      onClick={() => {
                        void onRevoke(connection.id);
                        setConfirm(null);
                      }}
                    >
                      Revoke access
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Cancel revocation"
                      onClick={() => setConfirm(null)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ) : (
                  <button
                    className="icon-button"
                    title="Revoke connection"
                    aria-label={`Revoke ${connection.name}`}
                    onClick={() => setConfirm(connection.id)}
                  >
                    <Trash2 size={16} />
                  </button>
                ))}
            </div>
          ))
        ) : (
          <div className="plain-empty">
            <Link2 size={25} />
            <h3>No connections yet.</h3>
            <p>
              Connect ChatGPT or Claude over MCP above, or create an API token
              for any HTTP client.
            </p>
            <button className="button" onClick={onCreate}>
              <Plus size={15} /> Create your first token
            </button>
          </div>
        )}
      </div>
      <details className="api-example">
        <summary>
          HTTP quick start <span>Notes · file uploads · retrieval</span>
        </summary>
        <p>Send a note using your token:</p>
        <CopyValue
          value={`curl -X POST '${baseUrl}/api/v1/messages' -H 'Authorization: Bearer YOUR_TOKEN' -H 'Content-Type: application/json' -d '{"title":"A note from Muse","body":"Pick this up in Claude.","space":"${defaultSpace}"}'`}
        />
        <p>
          List messages with <code>GET /api/v1/messages</code>. Read one with{" "}
          <code>GET /api/v1/messages/ID</code>. Upload small files through{" "}
          <code>POST /api/v1/files/inline</code>, or request a direct upload at{" "}
          <code>POST /api/v1/files/uploads</code>.
        </p>
        <a
          className="text-link"
          href="/openapi.json"
          target="_blank"
          rel="noreferrer"
        >
          Open the API specification <ArrowRight size={13} />
        </a>
      </details>
    </>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const previous = document.activeElement;
    panel.current?.focus();
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = panel.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", key);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Byline({ post }: { post: Post }) {
  const name = post.author?.display_name ?? post.sender;
  return (
    <span className="sender">
      <span className="sender-avatar">{name.slice(0, 1)}</span>
      {name}
      {post.author?.handle && (
        <code className="handle">
          @{post.author.handle}
          {post.author.session && `#${post.author.session.ref}`}
        </code>
      )}
      {post.author?.session && (
        <small className="session-name" title={post.author.session.context}>
          {post.author.session.name}
        </small>
      )}
    </span>
  );
}

function Mentions({ handles }: { handles?: string[] }) {
  if (!handles?.length) return null;
  return (
    <span className="mentions" aria-label="Mentions">
      {handles.map((handle) => (
        <em key={handle}>@{handle}</em>
      ))}
    </span>
  );
}

function Composer({
  initialSpace,
  spaces,
  onClose,
  onCreated,
}: {
  initialSpace: string;
  spaces: Space[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [files, setFiles] = useState<globalThis.File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [space, setSpace] = useState(initialSpace);
  const [people, setPeople] = useState<
    { handle: string; display_name: string; kind: string }[]
  >([]);
  const [mentions, setMentions] = useState<string[]>([]);
  useEffect(() => {
    api<{
      agents: { handle: string; display_name: string; kind: string }[];
    }>("agents")
      .then((result) => setPeople(result.agents))
      .catch(() => {});
  }, []);
  const submissionKey = useRef(crypto.randomUUID());
  const uploaded = useRef<{ space: string; ids: string[] } | null>(null);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (!uploaded.current || uploaded.current.space !== space) {
        const ids: string[] = [];
        for (const file of files) {
          setStatus(`Uploading ${file.name}…`);
          const upload = await api<{
            file_id: string;
            upload_url: string;
            headers: Record<string, string>;
          }>("files/uploads", {
            method: "POST",
            body: JSON.stringify({
              name: file.name,
              content_type: file.type || "application/octet-stream",
              size: file.size,
              space,
            }),
          });
          const transfer = await fetch(upload.upload_url, {
            method: "PUT",
            headers: upload.headers,
            body: file,
          });
          if (!transfer.ok) throw new Error(`Upload failed for ${file.name}.`);
          await api(`files/${upload.file_id}/complete`, {
            method: "POST",
            body: "{}",
          });
          ids.push(upload.file_id);
        }
        uploaded.current = { space, ids };
      }
      setStatus("Posting…");
      await api("messages", {
        method: "POST",
        headers: { "Idempotency-Key": submissionKey.current },
        body: JSON.stringify({
          title: form.get("title"),
          body: form.get("body"),
          space,
          mentions,
          tags: String(form.get("tags") || "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          attachment_ids: uploaded.current.ids,
        }),
      });
      onCreated();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      setStatus("");
    }
  }
  return (
    <Modal
      title="Start a topic"
      subtitle="Share context, a finding or a question with every agent in this space."
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form onSubmit={submit} className="form-stack">
        <label>
          Title
          <input
            name="title"
            placeholder="What is this about?"
            maxLength={200}
            required
            disabled={busy}
          />
        </label>
        <label>
          Post
          <textarea
            name="body"
            rows={7}
            placeholder="The context, a useful link, or what should happen next. Write @handle to mention someone."
            maxLength={200000}
            disabled={busy}
          />
        </label>
        <div className="form-columns">
          <label>
            Space
            <select
              value={space}
              onChange={(e) => setSpace(e.target.value)}
              disabled={busy}
            >
              {spaces.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {people.length > 0 && (
          <fieldset className="mention-picker" disabled={busy}>
            <legend>
              Mention{" "}
              <span className="optional">
                optional · flags who it may be for
              </span>
            </legend>
            {people.map((person) => {
              const on = mentions.includes(person.handle);
              return (
                <button
                  type="button"
                  key={person.handle}
                  className={`mention-chip ${on ? "selected" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setMentions((current) =>
                      on
                        ? current.filter((h) => h !== person.handle)
                        : [...current, person.handle],
                    )
                  }
                >
                  @{person.handle}
                </button>
              );
            })}
          </fieldset>
        )}
        <label>
          Tags <span className="optional">optional · separated by commas</span>
          <input
            name="tags"
            placeholder="research, design, next-step"
            disabled={busy}
          />
        </label>
        <label className="upload-zone">
          <Paperclip size={18} />
          <span>
            <strong>Add original files</strong>
            <small>Images, documents, and more · Up to 100 MB each</small>
          </span>
          <input
            type="file"
            multiple
            disabled={busy}
            onChange={(event) => {
              setFiles(Array.from(event.target.files || []));
              uploaded.current = null;
              submissionKey.current = crypto.randomUUID();
            }}
          />
          <Plus size={18} />
        </label>
        {files.map((file, i) => (
          <div className="file-chip" key={`${file.name}-${i}`}>
            <File size={15} />
            <span>{file.name}</span>
            <small>{bytes(file.size)}</small>
          </div>
        ))}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <span>
            {status || "Only visible to connections with access to this space."}
          </span>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Send size={16} />
            )}{" "}
            Post topic
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MessageDetail({
  id,
  onClose,
  onChange,
  onNotice,
}: {
  id: string;
  onClose: () => void;
  onChange: () => void;
  onNotice: (message: string) => void;
}) {
  const [detail, setDetail] = useState<{
    message: Post;
    attachments: Attachment[];
    replies: Post[];
  } | null>(null);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    try {
      setDetail(await api(`messages/${id}`));
    } catch (e) {
      setError(message(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!detail) return;
    for (const file of detail.attachments) {
      if (
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          file.content_type,
        )
      ) {
        api<{ url: string }>(`files/${file.id}/download`)
          .then((result) =>
            setPreview((p) => ({ ...p, [file.id]: result.url })),
          )
          .catch(() => {});
      }
    }
  }, [detail]);
  async function act(path: string, body: unknown, method = "POST") {
    try {
      await api(path, { method, body: JSON.stringify(body) });
      await load();
      onChange();
    } catch (e) {
      setError(message(e));
    }
  }
  async function submitReply(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    setBusy(true);
    try {
      await api("messages", {
        method: "POST",
        body: JSON.stringify({
          title: `Re: ${detail.message.title}`.slice(0, 200),
          body: reply,
          space: detail.message.space,
          parent_id: detail.message.id,
        }),
      });
      setReply("");
      await load();
      onChange();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Topic" onClose={onClose} wide>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {detail ? (
        <div className="detail">
          <div className="detail-meta">
            <span className="pill">
              <Folder size={12} />
              {detail.message.space}
            </span>
            <time>{new Date(detail.message.created_at).toLocaleString()}</time>
          </div>
          <h1>{detail.message.title}</h1>
          <div className="detail-sender">
            <Byline post={detail.message} />
            <Mentions handles={detail.message.mentions} />
          </div>
          <div className="note-content">
            {detail.message.body || (
              <span className="muted">No note attached.</span>
            )}
          </div>
          {detail.attachments.length > 0 && (
            <div className="attachment-list">
              {detail.attachments.map((file) => (
                <div className="attachment-card" key={file.id}>
                  {preview[file.id] && (
                    <img src={preview[file.id]} alt={file.name} />
                  )}
                  <div>
                    <File size={18} />
                    <span>
                      <strong>{file.name}</strong>
                      <small>
                        {bytes(file.size)} · {file.content_type}
                      </small>
                    </span>
                    <button
                      className="icon-button"
                      aria-label={`Download ${file.name}`}
                      onClick={async () => {
                        try {
                          const result = await api<{ url: string }>(
                            `files/${file.id}/download`,
                          );
                          window.open(
                            result.url,
                            "_blank",
                            "noopener,noreferrer",
                          );
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      <ArrowDownToLine size={17} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="detail-actions">
            <button
              className="button small-button"
              onClick={() =>
                act(`messages/${id}/acknowledge`, {}).then(() =>
                  onNotice("Marked read for your account."),
                )
              }
            >
              <Check size={14} /> Mark read
            </button>
            <button
              className="button small-button"
              onClick={() =>
                act(
                  `messages/${id}`,
                  { pinned: !detail.message.pinned },
                  "PATCH",
                )
              }
            >
              <Star size={14} />
              {detail.message.pinned ? "Unstar" : "Star"}
            </button>
            <button
              className="button small-button"
              onClick={() =>
                act(
                  `messages/${id}`,
                  { archived: !detail.message.archived_at },
                  "PATCH",
                )
              }
            >
              <Archive size={14} />
              {detail.message.archived_at ? "Restore" : "Archive"}
            </button>
          </div>
          <div className="replies">
            <h3>
              Replies <span>{detail.replies.length}</span>
            </h3>
            {detail.replies.map((item) => (
              <div className="reply" key={item.id}>
                <div>
                  <Byline post={item} />
                  <Mentions handles={item.mentions} />
                  <small>{relative(item.created_at)}</small>
                </div>
                <p>{item.body}</p>
              </div>
            ))}
            <form onSubmit={submitReply}>
              <textarea
                aria-label="Reply"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Reply… write @handle to mention someone"
                rows={3}
                required
              />
              <button className="button primary small-button" disabled={busy}>
                <Send size={14} /> Reply
              </button>
            </form>
          </div>
        </div>
      ) : (
        <div className="loading">
          <LoaderCircle className="spin" /> Loading topic…
        </div>
      )}
    </Modal>
  );
}

function TokenModal({
  owner,
  spaces,
  onClose,
  onCreated,
}: {
  owner: boolean;
  spaces: Space[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<
    { id: string; handle: string; display_name: string; kind: string }[]
  >([]);
  useEffect(() => {
    api<{
      agents: {
        id: string;
        handle: string;
        display_name: string;
        kind: string;
      }[];
    }>("agents?include_inactive=true")
      .then((result) =>
        setExisting(result.agents.filter((agent) => agent.kind === "agent")),
      )
      .catch(() => {});
  }, []);
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ token: string }>("connections", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          scopes:
            form.get("access") === "read"
              ? ["astropath:read"]
              : ["astropath:read", "astropath:write"],
          spaces: form.get("space") ? [form.get("space")] : null,
          expires_in_days: Number(form.get("expiry")),
          ...(form.get("agent") ? { agent_id: form.get("agent") } : {}),
        }),
      });
      setToken(result.token);
      onCreated();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={token ? "Your token is ready" : "Create an API token"}
      subtitle={
        token
          ? "Copy it now. You won’t be able to see it again."
          : "Give an app its own identity and access."
      }
      onClose={onClose}
    >
      {token ? (
        <div className="form-stack">
          <div className="success-note">
            <ShieldCheck size={18} /> Store this token in your app’s connection
            settings.
          </div>
          <CopyValue value={token} />
          <p className="small">
            Send it as <code>Authorization: Bearer {"<token>"}</code>. You can
            revoke access at any time.
          </p>
          <button className="button primary" onClick={onClose}>
            Done <Check size={16} />
          </button>
        </div>
      ) : (
        <form className="form-stack" onSubmit={submit}>
          <label>
            Application name
            <input name="name" placeholder="Muse" maxLength={80} required />
          </label>
          {existing.length > 0 && (
            <label>
              Agent
              <select name="agent" defaultValue="">
                <option value="">New agent, or the one with this name</option>
                {existing.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.display_name} (@{agent.handle})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Access
            <select name="access">
              <option value="write">Read and write</option>
              <option value="read">Read only</option>
            </select>
          </label>
          <div className="form-columns">
            <label>
              Space
              <select name="space">
                <option value="">
                  {owner ? "All spaces" : "All my spaces"}
                </option>
                {spaces.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Expires in
              <select name="expiry" defaultValue="90">
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </select>
            </label>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <KeyRound size={16} />
            )}{" "}
            Create token
          </button>
        </form>
      )}
    </Modal>
  );
}

function SettingsPanel({
  owner,
  spaces,
  onRefresh,
  onNotice,
}: {
  owner: boolean;
  spaces: Space[];
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function changePassword(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError("");
    try {
      const result = await authClient.changePassword({
        currentPassword: String(data.get("current")),
        newPassword: String(data.get("new")),
        revokeOtherSessions: true,
      });
      if (result.error) throw new Error(result.error.message);
      form.reset();
      onNotice("Password updated. Other sessions were signed out.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function addSpace(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setError("");
    try {
      await api("spaces", {
        method: "POST",
        body: JSON.stringify({
          name: data.get("name"),
          slug: data.get("slug"),
        }),
      });
      form.reset();
      onRefresh();
      onNotice("Space created.");
    } catch (e) {
      setError(message(e));
    }
  }
  return (
    <div className="settings-grid">
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <section className="surface settings-card">
        <h2>Spaces</h2>
        <p>
          {owner
            ? "Keep related context together. Assign member and connection access by space."
            : "These are the spaces you can use. Your connections can only access these spaces."}
        </p>
        <div className="space-list">
          {spaces.map((s) => (
            <div key={s.slug}>
              <Folder size={16} />
              <strong>{s.name}</strong>
              <code>{s.slug}</code>
            </div>
          ))}
        </div>
        {owner && (
          <form className="form-stack" onSubmit={addSpace}>
            <div className="form-columns">
              <label>
                Name
                <input
                  name="name"
                  placeholder="Research"
                  required
                  maxLength={80}
                />
              </label>
              <label>
                Identifier
                <input
                  name="slug"
                  placeholder="research"
                  pattern="[a-z0-9][a-z0-9-]{0,47}"
                  required
                />
              </label>
            </div>
            <button className="button">
              <Plus size={15} /> Create space
            </button>
          </form>
        )}
      </section>
      {owner && <MemberSettings spaces={spaces} onNotice={onNotice} />}
      <PlatformTenants />
      <section className="surface settings-card">
        <h2>Your password</h2>
        <p>
          Use at least 12 characters. Changing it signs out your other sessions.
        </p>
        <form onSubmit={changePassword} className="form-stack">
          <label>
            Current password
            <input
              name="current"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            New password
            <input
              name="new"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
            />
          </label>
          <button className="button" disabled={busy}>
            <KeyRound size={15} /> Update password
          </button>
        </form>
      </section>
      <section className="surface settings-card">
        <h2>Sign out</h2>
        <p>Your connected apps will stay connected.</p>
        <button
          className="button"
          onClick={async () => {
            await authClient.signOut();
            window.location.assign("/login");
          }}
        >
          <LogOut size={15} /> Sign out of Astropath
        </button>
      </section>
    </div>
  );
}

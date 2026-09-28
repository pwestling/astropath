"use client";
import { useCallback, useEffect, useState } from "react";
import { Copy, Plus, Users } from "lucide-react";
import { api } from "./api";

type Space = { slug: string; name: string };
type Member = {
  id: string;
  name: string;
  email: string;
  spaces: string[];
  role: "owner" | "member";
  user_id: string | null;
  disabled_at: string | null;
  invite_expires_at: string | null;
};

export function MemberSettings({
  spaces,
  onNotice,
}: {
  spaces: Space[];
  onNotice: (message: string) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setMembers((await api<{ members: Member[] }>("members")).members);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to load members.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ invite_url?: string }>(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (result.invite_url) setInvite(result.invite_url);
      await load();
      onNotice(
        result.invite_url
          ? "Invitation ready. Share the link privately."
          : "Member access updated.",
      );
      return true;
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to update member.",
      );
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface settings-card member-settings">
      <h2>
        <Users size={18} /> Members
      </h2>
      <p>
        Invite someone to a space. They can read, write, and connect their apps
        there. You keep access to all spaces.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {invite && (
        <div className="form-stack">
          <strong>Private invitation link</strong>
          <div className="copy-value">
            <code>{invite}</code>
            <button
              className="icon-button"
              aria-label="Copy invitation link"
              onClick={async () => {
                await navigator.clipboard.writeText(invite);
                onNotice("Invitation link copied.");
              }}
            >
              <Copy size={16} />
            </button>
          </div>
          <p className="small">
            Valid for seven days and one use. Share it directly; anyone with the
            link can set up this account.
          </p>
          <button className="text-button" onClick={() => setInvite("")}>
            Dismiss link
          </button>
        </div>
      )}
      <div className="member-list">
        {members.map((member) => (
          <div key={member.id} className="member-card">
            <strong>{member.name}</strong>
            <span className="small">{member.email}</span>
            <span className="pill">
              {member.role === "owner"
                ? "Tenant owner"
                : member.disabled_at
                  ? "Disabled"
                  : member.user_id
                    ? "Active"
                    : "Invitation pending"}
            </span>
            {member.role === "owner" ? (
              <p className="small">Access to all spaces in this tenant.</p>
            ) : (
              <form
                className="form-stack"
                onSubmit={async (event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  await action(`members/${member.id}`, "PATCH", {
                    spaces: [String(data.get("space"))],
                  });
                }}
              >
                <label>
                  Assigned space
                  <select
                    key={member.spaces.join(",")}
                    name="space"
                    defaultValue={member.spaces[0]}
                    aria-label={`Space for ${member.name}`}
                  >
                    {spaces.map((space) => (
                      <option key={space.slug} value={space.slug}>
                        {space.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="button-row">
                  <button className="button small-button" disabled={busy}>
                    Save access
                  </button>
                  <button
                    type="button"
                    className="button small-button"
                    disabled={busy}
                    onClick={() =>
                      void action(`members/${member.id}`, "PATCH", {
                        disabled: !member.disabled_at,
                      })
                    }
                  >
                    {member.disabled_at ? "Enable" : "Disable"}
                  </button>
                  {!member.user_id && !member.disabled_at && (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() =>
                        void action(`members/${member.id}/invite`, "POST")
                      }
                    >
                      New invite link
                    </button>
                  )}
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
      <form
        className="form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          if (
            await action("members", "POST", {
              name: data.get("name"),
              email: data.get("email"),
              spaces: [data.get("space")],
            })
          )
            form.reset();
        }}
      >
        <h3>Invite a member</h3>
        <label>
          Name
          <input name="name" required maxLength={80} placeholder="Their name" />
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            required
            maxLength={254}
            placeholder="you@example.com"
          />
        </label>
        <label>
          Space
          <select name="space" required>
            {spaces.map((space) => (
              <option key={space.slug} value={space.slug}>
                {space.name}
              </option>
            ))}
          </select>
        </label>
        <button className="button" disabled={busy || !spaces.length}>
          <Plus size={15} /> Create invitation
        </button>
      </form>
    </section>
  );
}

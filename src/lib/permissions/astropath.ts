import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownerEmail } from "../config";
import { AppError } from "../errors";
import type { Database, Queryable } from "../db";
import { hash } from "../policy";
import type { Actor, PermissionAdapter } from "./adapter";
import {
  canonical,
  PermissionError,
  stateSchema,
  type CatalogPage,
  type Change,
  type Manifest,
  type State,
  type Target,
} from "./protocol";

export const SCHEMA_REVISION = "astropath-1";
const UNLINKED =
  "This person has no linked Astropath account. They must sign in to Astropath once with a linked account, or accept an invitation, before their access can be changed.";
const uuid = z.uuid();
const SPACE = /^([0-9a-f-]{36})\/([a-z0-9][a-z0-9-]{0,47})$/;

export function buildManifest(appId: string): Manifest {
  return {
    protocolVersion: 1,
    appId,
    revision: SCHEMA_REVISION,
    catalogs: [
      { id: "tenants", label: "Workspaces (tenants)", inspectable: true },
      { id: "spaces", label: "Spaces", inspectable: false },
      { id: "invites", label: "Pending invitations", inspectable: false },
    ],
    actions: [
      {
        id: "add-to-tenant",
        label: "Add to workspace",
        description:
          "Makes the person a member of a workspace with access to the chosen spaces. Re-enables a removed member. Members can read and write those spaces and connect their agents to them.",
        target: { kind: "subject" },
        destructive: false,
        fields: [
          {
            id: "tenant",
            label: "Workspace",
            type: "reference",
            catalog: "tenants",
            required: true,
          },
          {
            id: "spaces",
            label: "Spaces",
            description: "Spaces of the chosen workspace.",
            type: "references",
            catalog: "spaces",
            required: true,
          },
        ],
      },
      {
        id: "set-member-spaces",
        label: "Change member spaces",
        description:
          "Replaces the spaces a member can reach. Their agent connections are limited to these spaces as well. Owners always reach every space.",
        target: { kind: "subject" },
        destructive: false,
        fields: [
          {
            id: "tenant",
            label: "Workspace",
            type: "reference",
            catalog: "tenants",
            required: true,
          },
          {
            id: "spaces",
            label: "Spaces",
            type: "references",
            catalog: "spaces",
            required: true,
          },
        ],
      },
      {
        id: "remove-from-tenant",
        label: "Remove from workspace",
        description:
          "Ends their membership. Their web access to the workspace and every agent connection they authorized there stops immediately; content they wrote stays.",
        target: { kind: "subject" },
        destructive: true,
        fields: [
          {
            id: "tenant",
            label: "Workspace",
            type: "reference",
            catalog: "tenants",
            required: true,
          },
        ],
      },
      {
        id: "make-owner",
        label: "Make workspace owner",
        description:
          "Owners manage members and spaces and reach every space in the workspace.",
        target: { kind: "subject" },
        destructive: false,
        fields: [
          {
            id: "tenant",
            label: "Workspace",
            type: "reference",
            catalog: "tenants",
            required: true,
          },
        ],
      },
      {
        id: "make-member",
        label: "Make ordinary member",
        description:
          "Removes owner rights; they keep the spaces recorded on their membership. A workspace's last owner cannot be demoted.",
        target: { kind: "subject" },
        destructive: true,
        fields: [
          {
            id: "tenant",
            label: "Workspace",
            type: "reference",
            catalog: "tenants",
            required: true,
          },
        ],
      },
      {
        id: "revoke-invite",
        label: "Revoke an invitation",
        description:
          "Deletes a pending invitation so its link stops working and the email can be invited again.",
        target: { kind: "entity", catalog: "tenants" },
        destructive: true,
        fields: [
          {
            id: "invite",
            label: "Pending invitation",
            type: "reference",
            catalog: "invites",
            required: true,
          },
        ],
      },
    ],
  };
}

const reject = (message: string, status: 403 | 404 | 409 | 422 = 422) =>
  new PermissionError(message, status);
function assertActor({ actor }: Actor) {
  // Custodes supplies `user:ID` or `tailnet:LOGIN`; anything else is not a dashboard administrator.
  if (!/^(user|tailnet):.+/.test(actor))
    throw reject("Unsupported management actor", 403);
}
const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

interface Membership {
  tenant_id: string;
  tenant: string;
  tenant_disabled: boolean;
  role: "owner" | "member";
  spaces: string[];
  disabled_at: Date | null;
}

/**
 * Astropath's permissions as the Custodes dashboard sees them. Enforcement stays in
 * access.ts/policy.ts: this adapter only reads and mutates the same ap_members rows (role,
 * spaces, disabled_at) that those functions evaluate on every request, through the privileged
 * directory connection that already owns membership administration (members.ts, tenants.ts).
 * Agent connections need no separate handling: connectionSpaces() re-reads membership on each
 * call, so a removal here revokes them at once.
 */
export class AstropathPermissions implements PermissionAdapter {
  private manifest: Manifest;
  constructor(
    private database: Database,
    private issuer: string,
    appId = "astropath",
  ) {
    this.manifest = buildManifest(appId);
  }

  async describe(actor: Actor) {
    assertActor(actor);
    return this.manifest;
  }

  private async revision(q: Queryable) {
    const row = (
      await q.query<{ revision: string }>(
        "SELECT revision::text AS revision FROM ap_permission_revision WHERE id=1",
      )
    ).rows[0];
    if (!row) throw new Error("Permission revision is not initialized");
    return row.revision;
  }
  private async localUser(q: Queryable, subject: string) {
    return (
      (
        await q.query<{ id: string; name: string; email: string }>(
          `SELECT u.id,u.name,u.email FROM ap_custodes_identities i JOIN "user" u ON u.id=i.user_id WHERE i.issuer=$1 AND i.subject=$2`,
          [this.issuer, subject],
        )
      ).rows[0] ?? null
    );
  }

  async list(
    catalog: string,
    query: { q: string; cursor?: string },
    actor: Actor,
  ): Promise<CatalogPage> {
    assertActor(actor);
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .catch(0)
      .parse(query.cursor ?? 0);
    const like = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    let rows: { id: string; label: string }[];
    if (catalog === "tenants")
      rows = (
        await this.database.query<{ id: string; label: string }>(
          `SELECT id::text AS id,name AS label FROM ap_tenants WHERE disabled_at IS NULL AND name ILIKE $1 ORDER BY created_at,id LIMIT 101 OFFSET $2`,
          [like, offset],
        )
      ).rows;
    else if (catalog === "spaces")
      rows = (
        await this.database.query<{ id: string; label: string }>(
          `SELECT (s.tenant_id::text || '/' || s.slug) AS id,(t.name || ' / ' || s.name) AS label FROM ap_spaces s JOIN ap_tenants t ON t.id=s.tenant_id
           WHERE t.disabled_at IS NULL AND (s.name ILIKE $1 OR s.slug ILIKE $1 OR t.name ILIKE $1) ORDER BY t.created_at,t.id,s.slug LIMIT 101 OFFSET $2`,
          [like, offset],
        )
      ).rows;
    else
      rows = (
        await this.database.query<{ id: string; label: string }>(
          `SELECT m.id::text AS id,(m.email || ' → ' || t.name) AS label FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id
           WHERE m.user_id IS NULL AND m.disabled_at IS NULL AND m.invite_expires_at>now() AND t.disabled_at IS NULL AND (m.email ILIKE $1 OR t.name ILIKE $1)
           ORDER BY m.created_at,m.id LIMIT 101 OFFSET $2`,
          [like, offset],
        )
      ).rows;
    return {
      items: rows.slice(0, 100).map((r) => ({
        id: r.id,
        label: clip(r.label, 200),
      })),
      ...(rows.length > 100 ? { nextCursor: String(offset + 100) } : {}),
    };
  }

  async read(target: Target, actor: Actor): Promise<State> {
    assertActor(actor);
    return this.stateFor(this.database, target);
  }

  private async stateFor(q: Queryable, target: Target): Promise<State> {
    const version = await this.revision(q);
    if (target.kind === "application") return this.applicationState(q, version);
    if (target.kind === "subject") return this.subjectState(q, target, version);
    if (target.catalog !== "tenants") throw reject("Unknown catalog", 404);
    return this.tenantState(q, target, version);
  }

  private async applicationState(
    q: Queryable,
    version: string,
  ): Promise<State> {
    const owners = (
      await q.query<{
        tenant_id: string;
        tenant: string;
        user_id: string;
        name: string;
        email: string;
      }>(
        `SELECT m.tenant_id::text AS tenant_id,t.name AS tenant,m.user_id,m.name,m.email FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id
         WHERE m.role='owner' AND m.user_id IS NOT NULL AND m.disabled_at IS NULL AND t.disabled_at IS NULL ORDER BY t.created_at,t.id,m.name,m.user_id LIMIT 500`,
      )
    ).rows;
    const counts = (
      await q.query<{
        tenants: string;
        members: string;
        pending: string;
        linked: string;
      }>(
        `SELECT (SELECT count(*) FROM ap_tenants WHERE disabled_at IS NULL)::text AS tenants,
                (SELECT count(*) FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id WHERE m.user_id IS NOT NULL AND m.disabled_at IS NULL AND t.disabled_at IS NULL)::text AS members,
                (SELECT count(*) FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id WHERE m.user_id IS NULL AND m.disabled_at IS NULL AND m.invite_expires_at>now() AND t.disabled_at IS NULL)::text AS pending,
                (SELECT count(*) FROM ap_custodes_identities WHERE issuer=$1)::text AS linked`,
        [this.issuer],
      )
    ).rows[0];
    return {
      target: { kind: "application" },
      version,
      title: "Astropath",
      facts: [
        { label: "Workspaces", value: counts.tenants },
        { label: "Active members", value: counts.members },
        { label: "Pending invitations", value: counts.pending },
        { label: "People linked to Custodes", value: counts.linked },
        {
          label: "Platform administrator",
          value: ownerEmail()
            ? "Set by the OWNER_EMAIL environment variable (not editable here)"
            : "Not configured",
        },
      ],
      access: owners.map((o) => ({
        id: clip(`owner:${o.tenant_id}:${o.user_id}`, 256),
        label: clip(`${o.name} (${o.email})`, 200),
        scope: clip(`Owner of ${o.tenant}`, 500),
        origin: { kind: "direct" as const },
      })),
      actions: [],
    };
  }

  private async memberships(q: Queryable, userId: string) {
    return (
      await q.query<Membership>(
        `SELECT m.tenant_id::text AS tenant_id,t.name AS tenant,(t.disabled_at IS NOT NULL) AS tenant_disabled,m.role,m.spaces,m.disabled_at
         FROM ap_members m JOIN ap_tenants t ON t.id=m.tenant_id WHERE m.user_id=$1 ORDER BY t.created_at,t.id`,
        [userId],
      )
    ).rows;
  }
  private async ownerCount(q: Queryable, tenantId: string) {
    return Number(
      (
        await q.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ap_members WHERE tenant_id=$1 AND role='owner' AND user_id IS NOT NULL AND disabled_at IS NULL`,
          [tenantId],
        )
      ).rows[0].n,
    );
  }

  private async subjectState(
    q: Queryable,
    target: Extract<Target, { kind: "subject" }>,
    version: string,
  ): Promise<State> {
    const user = await this.localUser(q, target.id);
    if (!user)
      return {
        target,
        version,
        title: "Not linked to Astropath",
        facts: [{ label: "Local account", value: UNLINKED }],
        access: [],
        actions: [],
      };
    const rows = await this.memberships(q, user.id);
    const active = rows.filter((m) => !m.disabled_at && !m.tenant_disabled);
    const access: State["access"] = active.map((m) => ({
      id: clip(`member:${m.tenant_id}`, 256),
      label: m.role === "owner" ? "Owner" : "Member",
      scope: clip(
        m.role === "owner"
          ? `${m.tenant} — all spaces`
          : `${m.tenant} — spaces: ${m.spaces.join(", ")}`,
        500,
      ),
      origin: { kind: "direct" as const },
    }));
    const platformAdmin =
      !!ownerEmail() && user.email.toLowerCase() === ownerEmail();
    if (platformAdmin)
      access.push({
        id: "platform-admin",
        label: "Platform administrator",
        scope: "Tenant directory (set by OWNER_EMAIL)",
        origin: { kind: "direct" },
      });
    const facts: State["facts"] = [
      { label: "Local account", value: `${user.name} <${user.email}>` },
    ];
    for (const m of rows.filter((m) => m.disabled_at || m.tenant_disabled))
      facts.push({
        label: "No access",
        value: clip(
          `${m.tenant}: ${m.tenant_disabled ? "workspace disabled" : "removed"}`,
          2000,
        ),
      });
    const connections = (
      await q.query<{ tenant: string; n: string }>(
        `SELECT t.name AS tenant,count(*)::text AS n FROM ap_connections c JOIN ap_tenants t ON t.id=c.tenant_id
         WHERE (c.created_by_user_id=$1 OR c.oauth_user_id=$1) AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>now())
         GROUP BY t.id,t.name,t.created_at ORDER BY t.created_at,t.id LIMIT 20`,
        [user.id],
      )
    ).rows;
    for (const c of connections)
      facts.push({
        label: "Agent connections",
        value: clip(
          `${c.tenant}: ${c.n} (limited to this person's access)`,
          2000,
        ),
      });
    const eligible = Number(
      (
        await q.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ap_tenants t WHERE t.disabled_at IS NULL AND NOT EXISTS(
             SELECT 1 FROM ap_members m WHERE m.tenant_id=t.id AND m.user_id=$1 AND m.disabled_at IS NULL)`,
          [user.id],
        )
      ).rows[0].n,
    );
    const defaults = (list: Membership[]): Record<string, string> =>
      list.length === 1 ? { tenant: list[0].tenant_id } : {};
    const members = active.filter((m) => m.role === "member");
    const owners = active.filter((m) => m.role === "owner");
    const actions: State["actions"] = [];
    if (eligible) actions.push({ id: "add-to-tenant", values: {} });
    if (members.length)
      actions.push({ id: "set-member-spaces", values: defaults(members) });
    if (active.length)
      actions.push({ id: "remove-from-tenant", values: defaults(active) });
    if (members.length)
      actions.push({ id: "make-owner", values: defaults(members) });
    if (owners.length)
      actions.push({ id: "make-member", values: defaults(owners) });
    return {
      target,
      version,
      title: clip(user.name, 200),
      facts: facts.slice(0, 50),
      access: access.slice(0, 500),
      actions,
    };
  }

  private async tenantState(
    q: Queryable,
    target: Extract<Target, { kind: "entity" }>,
    version: string,
  ): Promise<State> {
    if (!uuid.safeParse(target.id).success)
      throw reject("Workspace not found", 404);
    const tenant = (
      await q.query<{ name: string; disabled: boolean }>(
        "SELECT name,(disabled_at IS NOT NULL) AS disabled FROM ap_tenants WHERE id=$1",
        [target.id],
      )
    ).rows[0];
    if (!tenant) throw reject("Workspace not found", 404);
    const members = (
      await q.query<{
        user_id: string;
        name: string;
        email: string;
        role: string;
        spaces: string[];
      }>(
        `SELECT user_id,name,email,role,spaces FROM ap_members WHERE tenant_id=$1 AND user_id IS NOT NULL AND disabled_at IS NULL ORDER BY role DESC,name,user_id LIMIT 500`,
        [target.id],
      )
    ).rows;
    const invites = (
      await q.query<{ email: string; expires_at: Date }>(
        `SELECT email,invite_expires_at AS expires_at FROM ap_members WHERE tenant_id=$1 AND user_id IS NULL AND disabled_at IS NULL AND invite_expires_at>now() ORDER BY created_at,id`,
        [target.id],
      )
    ).rows;
    const spaces = Number(
      (
        await q.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM ap_spaces WHERE tenant_id=$1",
          [target.id],
        )
      ).rows[0].n,
    );
    const facts: State["facts"] = [
      ...(tenant.disabled
        ? [
            {
              label: "Status",
              value: "Workspace disabled by the platform administrator",
            },
          ]
        : []),
      { label: "Members", value: String(members.length) },
      { label: "Spaces", value: String(spaces) },
      { label: "Pending invitations", value: String(invites.length) },
      ...invites.slice(0, 40).map((i) => ({
        label: "Invited",
        value: `${i.email} (expires ${i.expires_at.toISOString().slice(0, 10)})`,
      })),
    ];
    return {
      target,
      version,
      title: clip(tenant.name, 200),
      facts,
      access: members.map((m) => ({
        id: clip(`member:${m.user_id}`, 256),
        label: clip(`${m.name} (${m.email})`, 200),
        scope: clip(
          m.role === "owner"
            ? "Owner — all spaces"
            : `Member — spaces: ${m.spaces.join(", ")}`,
          500,
        ),
        origin: { kind: "direct" as const },
      })),
      actions: invites.length ? [{ id: "revoke-invite", values: {} }] : [],
    };
  }

  // ---- writes ----

  private fingerprint(change: Change) {
    return hash(
      canonical({
        schemaRevision: change.schemaRevision,
        expectedVersion: change.expectedVersion,
        target: change.target,
        actionId: change.actionId,
        values: change.values,
      }),
    );
  }
  private async receipt(q: Queryable, change: Change, actor: string) {
    const row = (
      await q.query<{
        actor: string;
        fingerprint: string;
        outcome: "applied" | "rejected";
        state: unknown;
        error_status: number | null;
        error_message: string | null;
      }>(
        "SELECT actor,fingerprint,outcome,state,error_status,error_message FROM ap_permission_requests WHERE request_id=$1",
        [change.requestId],
      )
    ).rows[0];
    if (!row) return undefined;
    if (row.actor !== actor || row.fingerprint !== this.fingerprint(change))
      throw reject(
        "This request id was already used for a different change.",
        409,
      );
    if (row.outcome === "rejected")
      throw reject(
        row.error_message ?? "The change was rejected.",
        ([403, 404, 409, 422].includes(row.error_status ?? 0)
          ? row.error_status
          : 422) as 403 | 404 | 409 | 422,
      );
    return stateSchema.parse(row.state);
  }

  async replay(change: Change, actor: Actor) {
    assertActor(actor);
    return this.receipt(this.database, change, actor.actor);
  }

  async apply(change: Change, { actor }: Actor): Promise<State> {
    assertActor({ actor });
    const result = await this.database.transaction(async (tx) => {
      // Serializes concurrent writers (and duplicate request ids); re-check everything under it.
      await tx.query(
        "SELECT pg_advisory_xact_lock(hashtext('astropath-permissions'))",
      );
      const prior = await this.receipt(tx, change, actor);
      if (prior) return { state: prior } as const;
      const fail = async (status: number, message: string) => {
        await tx.query(
          `INSERT INTO ap_permission_requests(request_id,actor,fingerprint,target,action_id,outcome,error_status,error_message)
           VALUES($1,$2,$3,$4,$5,'rejected',$6,$7)`,
          [
            change.requestId,
            actor,
            this.fingerprint(change),
            JSON.stringify(change.target),
            change.actionId,
            status,
            message,
          ],
        );
        return { rejected: { status, message } } as const;
      };
      if ((await this.revision(tx)) !== change.expectedVersion)
        return fail(
          409,
          "Permissions changed since you opened this view. Reload before editing.",
        );
      await tx.query("SAVEPOINT permission_change");
      try {
        await this.execute(tx, change, actor);
      } catch (error) {
        if (error instanceof PermissionError || error instanceof AppError) {
          await tx.query("ROLLBACK TO SAVEPOINT permission_change");
          return fail(
            error instanceof PermissionError ? error.status : 422,
            error.message,
          );
        }
        throw error;
      }
      const state = await this.stateFor(tx, change.target);
      await tx.query(
        `INSERT INTO ap_permission_requests(request_id,actor,fingerprint,target,action_id,outcome,state)
         VALUES($1,$2,$3,$4,$5,'applied',$6)`,
        [
          change.requestId,
          actor,
          this.fingerprint(change),
          JSON.stringify(change.target),
          change.actionId,
          JSON.stringify(state),
        ],
      );
      return { state } as const;
    });
    if ("rejected" in result)
      throw reject(
        result.rejected.message,
        ([403, 404, 409, 422].includes(result.rejected.status)
          ? result.rejected.status
          : 422) as 403 | 404 | 409 | 422,
      );
    return result.state;
  }

  private async audit(
    tx: Queryable,
    actor: string,
    tenantId: string | null,
    action: string,
    details: unknown,
  ) {
    await tx.query(
      "INSERT INTO ap_custodes_audit(actor,tenant_id,action,details) VALUES($1,$2,$3,$4)",
      [
        actor,
        tenantId,
        action,
        JSON.stringify({ ...(details as object), via: "custodes" }),
      ],
    );
  }

  /** The chosen workspace, which must exist and be enabled. */
  private async tenant(tx: Queryable, value: unknown) {
    const id = uuid.safeParse(value);
    const row = id.success
      ? (
          await tx.query<{ id: string; name: string }>(
            "SELECT id::text AS id,name FROM ap_tenants WHERE id=$1 AND disabled_at IS NULL FOR UPDATE",
            [id.data],
          )
        ).rows[0]
      : undefined;
    if (!row) throw reject("Choose an existing, enabled workspace.");
    return row;
  }
  /** Space ids from the catalog (`<tenant>/<slug>`) must all belong to this workspace and exist. */
  private async spaces(tx: Queryable, tenantId: string, value: unknown) {
    if (!Array.isArray(value) || !value.length)
      throw reject("Choose at least one space.");
    const slugs: string[] = [];
    for (const item of value) {
      const match = typeof item === "string" ? SPACE.exec(item) : null;
      if (!match || match[1] !== tenantId)
        throw reject("Choose spaces that belong to the chosen workspace.");
      slugs.push(match[2]);
    }
    const found = await tx.query(
      "SELECT slug FROM ap_spaces WHERE tenant_id=$1 AND slug=ANY($2::text[])",
      [tenantId, slugs],
    );
    if (found.rows.length !== new Set(slugs).size)
      throw reject("Choose existing spaces.");
    return [...new Set(slugs)];
  }

  private async execute(tx: Queryable, change: Change, actor: string) {
    const { target, values } = change;
    if (target.kind === "entity") {
      // Only revoke-invite targets a tenant entity.
      const invite = uuid.safeParse(values.invite);
      if (!invite.success || !uuid.safeParse(target.id).success)
        throw reject("Choose a pending invitation.");
      const revoked = await tx.query(
        `DELETE FROM ap_members WHERE id=$1 AND tenant_id=$2 AND user_id IS NULL AND role='member' AND invite_hash IS NOT NULL RETURNING id`,
        [invite.data, target.id],
      );
      if (!revoked.rows.length)
        throw reject("That invitation is not pending in this workspace.");
      await this.audit(tx, actor, target.id, "revoke_invite", {
        id: invite.data,
      });
      return;
    }
    if (target.kind !== "subject")
      throw reject("Unsupported permission operation");
    const user = await this.localUser(tx, target.id);
    if (!user) throw reject(UNLINKED);
    const tenant = await this.tenant(tx, values.tenant);
    const member = (
      await tx.query<{
        id: string;
        role: "owner" | "member";
        disabled_at: Date | null;
      }>(
        "SELECT id,role,disabled_at FROM ap_members WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE",
        [tenant.id, user.id],
      )
    ).rows[0];
    const active = !!member && !member.disabled_at;
    const guardLastOwner = async () => {
      if (
        member?.role === "owner" &&
        (await this.ownerCount(tx, tenant.id)) <= 1
      )
        throw reject(
          "A workspace's last owner cannot be removed or demoted. Make someone else an owner first.",
        );
    };
    switch (change.actionId) {
      case "add-to-tenant": {
        const spaces = await this.spaces(tx, tenant.id, values.spaces);
        if (active)
          throw reject(
            "They are already a member of that workspace. Use Change member spaces.",
          );
        if (member) {
          await tx.query(
            `UPDATE ap_members SET disabled_at=NULL,role='member',spaces=$2,invite_hash=NULL,invite_expires_at=NULL WHERE id=$1`,
            [member.id, spaces],
          );
        } else {
          const email = user.email.toLowerCase();
          const taken = await tx.query(
            "SELECT 1 FROM ap_members WHERE tenant_id=$1 AND email=$2",
            [tenant.id, email],
          );
          if (taken.rows.length)
            throw reject(
              "That email already has a pending invitation or another membership in this workspace. Revoke the invitation first.",
              409,
            );
          await tx.query(
            `INSERT INTO ap_members(id,tenant_id,email,name,user_id,spaces,role) VALUES($1,$2,$3,$4,$5,$6,'member')`,
            [randomUUID(), tenant.id, email, user.name, user.id, spaces],
          );
        }
        await this.audit(tx, actor, tenant.id, "add_member", {
          userId: user.id,
          spaces,
        });
        return;
      }
      case "set-member-spaces": {
        if (!active)
          throw reject("They are not an active member of that workspace.");
        if (member.role === "owner")
          throw reject(
            "Owners reach every space; their spaces cannot be changed.",
          );
        const spaces = await this.spaces(tx, tenant.id, values.spaces);
        await tx.query("UPDATE ap_members SET spaces=$2 WHERE id=$1", [
          member.id,
          spaces,
        ]);
        await this.audit(tx, actor, tenant.id, "set_member_spaces", {
          userId: user.id,
          spaces,
        });
        return;
      }
      case "remove-from-tenant": {
        if (!active)
          throw reject("They are not an active member of that workspace.");
        await guardLastOwner();
        await tx.query(
          "UPDATE ap_members SET disabled_at=now(),invite_hash=NULL,invite_expires_at=NULL WHERE id=$1",
          [member.id],
        );
        await this.audit(tx, actor, tenant.id, "remove_member", {
          userId: user.id,
          role: member.role,
        });
        return;
      }
      case "make-owner": {
        if (!active)
          throw reject("They are not an active member of that workspace.");
        if (member.role === "owner")
          throw reject("They already own that workspace.");
        await tx.query("UPDATE ap_members SET role='owner' WHERE id=$1", [
          member.id,
        ]);
        await this.audit(tx, actor, tenant.id, "make_owner", {
          userId: user.id,
        });
        return;
      }
      case "make-member": {
        if (!active || member.role !== "owner")
          throw reject("They are not an owner of that workspace.");
        await guardLastOwner();
        await tx.query("UPDATE ap_members SET role='member' WHERE id=$1", [
          member.id,
        ]);
        await this.audit(tx, actor, tenant.id, "make_member", {
          userId: user.id,
        });
        return;
      }
      default:
        throw reject("Unsupported permission operation");
    }
  }
}

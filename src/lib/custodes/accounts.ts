import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Database, Queryable } from "../db";
import { AppError } from "../errors";
import { userPrincipal } from "../access";
import type { MemberStore } from "../members";
import { hash } from "../policy";
import { REFUSALS } from "./messages";
import type { CustodesIdentity } from "./oidc";

export const FLOW_MINUTES = 10;
/** Only these destinations are honoured after sign-in; anything else becomes "/". */
const DESTINATIONS = new Set(["/", "/?custodes=linked"]);
export const safeNext = (value: unknown) =>
  typeof value === "string" && DESTINATIONS.has(value) ? value : "/";

export type FlowPurpose = "login" | "link";
export interface Flow {
  purpose: FlowPurpose;
  state: string;
  nonce: string;
  verifier: string;
  userId: string | null;
  sessionId: string | null;
  inviteHash: string | null;
  oauthQuery: string | null;
}
/** The Astropath web session the browser holds right now. */
export interface CurrentSession {
  sessionId: string;
  userId: string;
}
export interface Completed {
  userId: string;
  identity: CustodesIdentity;
  linked: boolean;
  joined: boolean;
  /** Tenant the person just joined through an invitation, if any. */
  tenantId?: string;
}

const random = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const refuse = (code: string, message: string, status = 403) =>
  new AppError(status, code, message);

export { REFUSALS };

export class CustodesAccounts {
  constructor(
    private database: Database,
    private members: MemberStore,
  ) {}

  async startFlow(input: {
    purpose: FlowPurpose;
    userId?: string;
    sessionId?: string;
    inviteToken?: string;
    oauthQuery?: string;
  }) {
    const flowId = random();
    const flow = { state: random(), nonce: random(), verifier: random() };
    await this.database.query(
      `INSERT INTO ap_custodes_flows(flow_hash,state,nonce,verifier,purpose,user_id,session_id,invite_hash,oauth_query,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(mins=>$10))`,
      [
        hash(flowId),
        flow.state,
        flow.nonce,
        flow.verifier,
        input.purpose,
        input.userId ?? null,
        input.sessionId ?? null,
        input.inviteToken ? hash(input.inviteToken) : null,
        input.oauthQuery && input.oauthQuery.length <= 4096
          ? input.oauthQuery
          : null,
        FLOW_MINUTES,
      ],
    );
    if (Math.random() < 0.05)
      await this.database.query(
        "DELETE FROM ap_custodes_flows WHERE expires_at<now()-interval '1 day'",
      );
    return { flowId, ...flow };
  }

  /** Atomically consumes the flow: a second use, an expired flow or a wrong state all fail. */
  async consumeFlow(
    flowId: string | undefined,
    state: string | undefined,
  ): Promise<Flow> {
    if (!flowId || !state)
      throw refuse(
        "custodes_flow_invalid",
        REFUSALS.custodes_flow_invalid,
        400,
      );
    const row = (
      await this.database.query<{
        purpose: FlowPurpose;
        state: string;
        nonce: string;
        verifier: string;
        user_id: string | null;
        session_id: string | null;
        invite_hash: string | null;
        oauth_query: string | null;
      }>(
        `UPDATE ap_custodes_flows SET consumed_at=now()
         WHERE flow_hash=$1 AND consumed_at IS NULL AND expires_at>now()
         RETURNING purpose,state,nonce,verifier,user_id,session_id,invite_hash,oauth_query`,
        [hash(flowId)],
      )
    ).rows[0];
    if (!row || !same(row.state, state))
      throw refuse(
        "custodes_flow_invalid",
        REFUSALS.custodes_flow_invalid,
        400,
      );
    return {
      purpose: row.purpose,
      state: row.state,
      nonce: row.nonce,
      verifier: row.verifier,
      userId: row.user_id,
      sessionId: row.session_id,
      inviteHash: row.invite_hash,
      oauthQuery: row.oauth_query,
    };
  }

  async linkedUser(q: Queryable, issuer: string, subject: string) {
    return (
      (
        await q.query<{ user_id: string }>(
          "SELECT user_id FROM ap_custodes_identities WHERE issuer=$1 AND subject=$2",
          [issuer, subject],
        )
      ).rows[0]?.user_id ?? null
    );
  }
  /** The link shown in settings for a local user. */
  async identityFor(userId: string, issuer: string) {
    return (
      (
        await this.database.query<{ subject: string; linked_at: Date }>(
          "SELECT subject,linked_at FROM ap_custodes_identities WHERE user_id=$1 AND issuer=$2",
          [userId, issuer],
        )
      ).rows[0] ?? null
    );
  }

  private async audit(
    tx: Queryable,
    actor: string,
    action: string,
    details: Record<string, unknown>,
  ) {
    await tx.query(
      "INSERT INTO ap_custodes_audit(actor,tenant_id,action,details) VALUES($1,NULL,$2,$3)",
      [actor, action, JSON.stringify(details)],
    );
  }

  /** Inserts a mapping; the unique keys make concurrent or conflicting links fail closed. */
  private async insertMapping(
    tx: Queryable,
    identity: CustodesIdentity,
    userId: string,
    via: "session" | "invitation",
    sessionId: string | null,
  ) {
    if (await this.linkedUser(tx, identity.issuer, identity.subject))
      throw refuse(
        "custodes_already_linked",
        REFUSALS.custodes_already_linked,
        409,
      );
    const byUser = (
      await tx.query(
        "SELECT 1 FROM ap_custodes_identities WHERE issuer=$1 AND user_id=$2",
        [identity.issuer, userId],
      )
    ).rows.length;
    if (byUser)
      throw refuse("custodes_user_linked", REFUSALS.custodes_user_linked, 409);
    const inserted = await tx.query(
      `INSERT INTO ap_custodes_identities(issuer,subject,user_id,linked_via,linked_email,linked_session_id)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING subject`,
      [
        identity.issuer,
        identity.subject,
        userId,
        via,
        identity.email,
        sessionId,
      ],
    );
    if (!inserted.rows.length)
      throw refuse(
        "custodes_already_linked",
        REFUSALS.custodes_already_linked,
        409,
      );
    await this.audit(tx, userId, "link_custodes", {
      issuer: identity.issuer,
      subject: identity.subject,
      via,
      email: identity.email,
    });
  }

  /**
   * Decides what a verified Custodes identity may do. Email never links accounts: an unmapped
   * identity can only be linked by (a) a flow started from a valid Astropath session of the
   * user it links to, or (b) accepting an invitation addressed to its verified email, which
   * creates a brand-new local user. Everything else is refused; nobody is auto-provisioned.
   */
  async complete(
    identity: CustodesIdentity,
    flow: Flow,
    current: CurrentSession | null,
  ): Promise<Completed> {
    if (flow.purpose === "link") {
      if (
        !current ||
        current.sessionId !== flow.sessionId ||
        current.userId !== flow.userId ||
        !flow.userId
      )
        throw refuse("custodes_link_session", REFUSALS.custodes_link_session);
      const userId = flow.userId;
      let linked = false;
      await this.database.transaction(async (tx) => {
        const existing = await this.linkedUser(
          tx,
          identity.issuer,
          identity.subject,
        );
        if (existing === userId) return; // idempotent re-link of the same pair
        await this.insertMapping(
          tx,
          identity,
          userId,
          "session",
          current.sessionId,
        );
        linked = true;
      });
      return { userId, identity, linked, joined: false };
    }

    let joined: { tenant_id: string } | undefined;
    let linked = false;
    let userId = await this.linkedUser(
      this.database,
      identity.issuer,
      identity.subject,
    );
    if (!userId) {
      if (!flow.inviteHash)
        throw refuse("custodes_unlinked", REFUSALS.custodes_unlinked);
      ({ userId, joined } = await this.createFromInvitation(
        identity,
        flow.inviteHash,
      ));
      linked = true;
    } else if (flow.inviteHash) {
      const id = userId;
      const inviteHash = flow.inviteHash;
      joined = await this.database.transaction((tx) =>
        this.members.acceptExistingIn(tx, inviteHash, id),
      );
    }
    // Sign-in requires an active membership in an enabled tenant; a bare account has no access.
    if (!(await userPrincipal(this.database, userId))?.tenantId)
      throw refuse("custodes_no_access", REFUSALS.custodes_no_access);
    await this.database.query(
      "UPDATE ap_custodes_identities SET last_login_at=now() WHERE issuer=$1 AND subject=$2",
      [identity.issuer, identity.subject],
    );
    return {
      userId,
      identity,
      linked,
      joined: !!joined,
      tenantId: joined?.tenant_id,
    };
  }

  private async createFromInvitation(
    identity: CustodesIdentity,
    inviteHash: string,
  ) {
    return this.database.transaction(async (tx) => {
      const invite = await this.members.pendingByHash(tx, inviteHash, true);
      if (!identity.email || identity.email !== invite.email.toLowerCase())
        throw refuse("custodes_invite_email", REFUSALS.custodes_invite_email);
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `account-email:${invite.email}`,
      ]);
      if (
        (
          await tx.query('SELECT 1 FROM "user" WHERE lower(email)=$1', [
            invite.email.toLowerCase(),
          ])
        ).rows.length
      )
        throw refuse(
          "custodes_invite_account_exists",
          REFUSALS.custodes_invite_account_exists,
          409,
        );
      // A passwordless account: the person signs in through Custodes only.
      const userId = randomUUID();
      await tx.query(
        `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())`,
        [userId, invite.name, invite.email.toLowerCase()],
      );
      await this.insertMapping(tx, identity, userId, "invitation", null);
      const joined = await this.members.acceptExistingIn(
        tx,
        inviteHash,
        userId,
      );
      return { userId, joined };
    });
  }

  /**
   * Back-channel logout: ends exactly the web sessions created by that Custodes session (sid).
   * Without a sid the token only names the user, so every Custodes-created web session of that
   * identity ends. Astropath's own OAuth/MCP tokens and connections are not touched.
   * Returns how many sessions ended.
   */
  async endSessions(issuer: string, input: { sid?: string; subject?: string }) {
    const rows = (
      await this.database.query<{ session_id: string }>(
        input.sid
          ? "SELECT session_id FROM ap_custodes_sessions WHERE issuer=$1 AND sid=$2"
          : "SELECT session_id FROM ap_custodes_sessions WHERE issuer=$1 AND subject=$2",
        [issuer, input.sid ?? input.subject],
      )
    ).rows;
    const ids = rows.map((r) => r.session_id);
    if (!ids.length) return 0;
    await this.database.transaction(async (tx) => {
      await tx.query('DELETE FROM "session" WHERE id=ANY($1::text[])', [ids]);
      await tx.query(
        "DELETE FROM ap_custodes_sessions WHERE session_id=ANY($1::text[])",
        [ids],
      );
    });
    return ids.length;
  }
}

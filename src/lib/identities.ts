import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db";
import { AppError } from "./errors";
import { identityName } from "./validation";
import { appUrl } from "./config";

// The namespace follows this instance's OAuth origin; it is not a network endpoint.
export const CONNECTION_CLAIM = `${appUrl()}/connection`;

export function oauthConnectionClaim(claims: Record<string, unknown>) {
  return claims[CONNECTION_CLAIM];
}

export async function reserveIdentityName(tx: Queryable, name: string) {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtext('identity-name:' || lower($1)))",
    [name],
  );
  const existing = await tx.query(
    "SELECT id FROM ap_connections WHERE lower(name)=lower($1) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
    [name],
  );
  if (existing.rows.length)
    throw new AppError(
      409,
      "identity_name_taken",
      "That name is already in use. Choose a distinct name, such as Claude Work.",
    );
}

export class IdentityStore {
  constructor(private database: Database) {}

  async approve(input: {
    name: string;
    userId: string;
    clientId: string;
    approvalKey: string;
    scopes: string[];
    spaces?: string[] | null;
  }) {
    const name = identityName.parse(input.name);
    return this.database.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `oauth-approval:${input.approvalKey}`,
      ]);
      const prior = await tx.query<{
        id: string;
        name: string;
        revoked_at: Date | null;
        oauth_user_id: string;
        oauth_authorization_client_id: string;
      }>(
        "SELECT id,name,revoked_at,oauth_user_id,oauth_authorization_client_id FROM ap_connections WHERE oauth_approval_key=$1",
        [input.approvalKey],
      );
      const found = prior.rows[0];
      if (found) {
        if (found.revoked_at)
          throw new AppError(
            403,
            "connection_revoked",
            "This connection was revoked. Restart authorization to create a new identity.",
          );
        if (
          found.name !== name ||
          found.oauth_user_id !== input.userId ||
          found.oauth_authorization_client_id !== input.clientId
        )
          throw new AppError(
            409,
            "approval_used",
            "This approval has already been used. Restart authorization.",
          );
        return found.id;
      }
      await reserveIdentityName(tx, name);
      const id = randomUUID();
      await tx.query(
        `INSERT INTO ap_connections(id,name,kind,scopes,oauth_authorization_client_id,oauth_user_id,oauth_approval_key,spaces,created_by_user_id)
         VALUES($1,$2,'oauth',$3,$4,$5,$6,$7,$5)`,
        [
          id,
          name,
          input.scopes,
          input.clientId,
          input.userId,
          input.approvalKey,
          input.spaces ?? null,
        ],
      );
      return id;
    });
  }
}

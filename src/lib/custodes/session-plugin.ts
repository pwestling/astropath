import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Queryable } from "../db";

/**
 * Server-only Better Auth endpoint that turns an already-verified Custodes identity into a
 * normal Astropath web session (the same cookie, table and expiry as password sign-in, and
 * subject to the same workspace-access hook). It is never registered on the HTTP router:
 * callers must be trusted server code that has validated the OIDC reply and the account
 * mapping first.
 */
export function custodesSession(queryable: () => Queryable) {
  return {
    id: "custodes-session",
    endpoints: {
      createCustodesSession: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({
            userId: z.string().min(1),
            issuer: z.string().min(1),
            subject: z.string().min(1),
            sid: z.string().min(1).nullable(),
            /**
             * Better Auth's signed authorization query, when sign-in interrupted an MCP/OAuth
             * connection. Its hooks verify the signature and then resume the authorization.
             */
            oauth_query: z.string().max(4096).optional(),
            /** A previous session to retire (rotation when linking). */
            replace: z
              .object({
                sessionId: z.string().min(1),
                token: z.string().min(1),
              })
              .optional(),
          }),
        },
        async (ctx) => {
          const { userId, issuer, subject, sid, replace } = ctx.body;
          const adapter = ctx.context.internalAdapter;
          const user = await adapter.findUserById(userId);
          if (!user)
            throw new APIError("FORBIDDEN", { message: "Unknown user" });
          const session = await adapter.createSession(userId, false);
          if (!session) throw new APIError("INTERNAL_SERVER_ERROR");
          const db = queryable();
          try {
            await db.query(
              "INSERT INTO ap_custodes_sessions(session_id,user_id,issuer,subject,sid) VALUES($1,$2,$3,$4,$5)",
              [session.id, userId, issuer, subject, sid],
            );
            if (replace)
              await db.query(
                "DELETE FROM ap_custodes_sessions WHERE session_id=$1",
                [replace.sessionId],
              );
          } catch (error) {
            // A session whose sid we cannot record could not be ended by back-channel logout.
            await adapter.deleteSession(session.token);
            throw error;
          }
          if (replace) await adapter.deleteSession(replace.token);
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ sessionId: session.id });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

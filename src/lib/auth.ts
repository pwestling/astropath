import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { pool, systemDb as db } from "./db";
import { appUrl, SCOPES } from "./config";
import { oauthIdentityOptions } from "./oauth-identities";
import { userPrincipal } from "./access";
import { APIError } from "better-auth/api";

export function createAuth(bootstrap = false) {
  const base = appUrl();
  return betterAuth({
    appName: "Astropath",
    baseURL: base,
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      minPasswordLength: 12,
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    trustedOrigins: [base],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            // Owner bootstrap creates its user and session in Better Auth's transaction;
            // the separate application pool cannot see that user until commit.
            if (!bootstrap && !(await userPrincipal(db, session.userId)))
              throw new APIError("FORBIDDEN", {
                message:
                  "This account does not have workspace access. Contact the owner.",
              });
          },
        },
      },
    },
    plugins: [
      jwt(),
      mcp({
        ...oauthIdentityOptions,
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${base}/mcp`,
        scopes: ["openid", "profile", "email", "offline_access", ...SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 900,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}

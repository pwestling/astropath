import { createHash } from "node:crypto";
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { AppError } from "../errors";
import type { CustodesConfig } from "./config";

export interface CustodesIdentity {
  issuer: string;
  subject: string;
  /** Present only when Custodes asserts it as verified. */
  email: string | null;
  name: string;
  /** Custodes session id; present because the client registers a back-channel logout URI. */
  sid: string | null;
}

interface Endpoints {
  authorization: string;
  token: string;
  keys: JWTVerifyGetKey;
}
export interface OidcOptions {
  fetch?: typeof fetch;
  /** Test seam: replaces the JWKS fetched from the discovery document. */
  keys?: JWTVerifyGetKey;
}

export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

const fail = (message: string) =>
  new AppError(401, "custodes_rejected", message);

/** OIDC authorization-code + PKCE client for the Custodes issuer. */
export class CustodesOidc {
  private endpoints: Endpoints | null = null;
  private readonly fetcher: typeof fetch;
  constructor(
    readonly config: CustodesConfig,
    private options: OidcOptions = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
  }

  private async discover(): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    const response = await this.fetcher(
      `${this.config.origin}/.well-known/oauth-authorization-server/api/auth`,
      { redirect: "error", signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok)
      throw new Error(`Custodes discovery failed with ${response.status}`);
    const document = (await response.json()) as Record<string, unknown>;
    if (document.issuer !== this.config.issuer)
      throw new Error("Custodes discovery returned an unexpected issuer");
    const urls = ["authorization_endpoint", "token_endpoint", "jwks_uri"].map(
      (key) => {
        const value = document[key];
        if (
          typeof value !== "string" ||
          new URL(value).origin !== this.config.origin
        )
          throw new Error(
            "Custodes discovery returned an endpoint on another origin",
          );
        return value;
      },
    );
    this.endpoints = {
      authorization: urls[0],
      token: urls[1],
      keys: this.options.keys ?? createRemoteJWKSet(new URL(urls[2])),
    };
    return this.endpoints;
  }

  async authorizationUrl(flow: {
    state: string;
    nonce: string;
    verifier: string;
  }) {
    const endpoints = await this.discover();
    const url = new URL(endpoints.authorization);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope,
      resource: this.config.resource,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge_method: "S256",
      code_challenge: pkceChallenge(flow.verifier),
    }).toString();
    return url.toString();
  }

  /** Exchanges the code and fully validates the ID token (signature, issuer, audience, expiry, nonce). */
  async exchange(
    code: string,
    flow: { verifier: string; nonce: string },
  ): Promise<CustodesIdentity> {
    const endpoints = await this.discover();
    const basic = Buffer.from(
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
    ).toString("base64");
    const response = await this.fetcher(endpoints.token, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: flow.verifier,
        resource: this.config.resource,
      }),
    });
    if (!response.ok) throw fail("Custodes did not accept the sign-in code.");
    const tokens = (await response.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== "string")
      throw fail("Custodes returned no ID token.");
    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, endpoints.keys, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: ["EdDSA"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError)
        throw fail("The Custodes ID token was not valid.");
      throw error;
    }
    if (payload.nonce !== flow.nonce)
      throw fail("The Custodes ID token nonce does not match.");
    if (typeof payload.sub !== "string" || !payload.sub)
      throw fail("The Custodes ID token has no subject.");
    const email =
      typeof payload.email === "string" && payload.email_verified === true
        ? payload.email.trim().toLowerCase()
        : null;
    return {
      issuer: this.config.issuer,
      subject: payload.sub,
      email,
      name:
        typeof payload.name === "string" && payload.name.trim()
          ? payload.name.trim().slice(0, 100)
          : (email ?? "Astropath member"),
      sid: typeof payload.sid === "string" && payload.sid ? payload.sid : null,
    };
  }

  /** Verified keys for logout tokens (same JWKS as ID tokens). */
  async keys() {
    return (await this.discover()).keys;
  }
}

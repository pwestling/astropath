import { getAuth } from "../auth";
import { appUrl } from "../config";
import { accounts, custodesOidc, members } from "./runtime";
import type { WebDeps } from "./web";

export function webDeps(): WebDeps {
  return {
    appOrigin: appUrl(),
    oidc: custodesOidc(),
    accounts,
    async currentSession(headers) {
      const session = await getAuth().api.getSession({ headers });
      return session
        ? {
            sessionId: session.session.id,
            userId: session.user.id,
            token: session.session.token,
          }
        : null;
    },
    createSession: (input) =>
      getAuth().api.createCustodesSession({ body: input, asResponse: true }),
    async checkInvite(token) {
      await members.inspect(token);
    },
  };
}

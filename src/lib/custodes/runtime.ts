import { systemDb } from "../db";
import { MemberStore } from "../members";
import { CustodesAccounts } from "./accounts";
import { custodesConfig } from "./config";
import { CustodesOidc } from "./oidc";

const globalState = globalThis as unknown as {
  astropathCustodes?: { key: string; oidc: CustodesOidc | null };
};
/** The sign-in client, or null when the CUSTODES_* settings are not configured. */
export function custodesOidc(): CustodesOidc | null {
  const config = custodesConfig();
  const key = JSON.stringify(config);
  if (globalState.astropathCustodes?.key !== key)
    globalState.astropathCustodes = {
      key,
      oidc: config ? new CustodesOidc(config) : null,
    };
  return globalState.astropathCustodes.oidc;
}
export const members = new MemberStore(systemDb);
export const accounts = new CustodesAccounts(systemDb, members);

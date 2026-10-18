import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionPrincipal } from "@/lib/security";
import { appUrl } from "@/lib/config";
import {
  custodesConfig,
  custodesIssuer,
  passwordLoginEnabled,
} from "@/lib/custodes/config";
import { accounts } from "@/lib/custodes/runtime";
import { Console } from "@/components/console";

export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await sessionPrincipal(await headers());
  if (!principal) redirect("/login");
  const configured = !!custodesConfig();
  const issuer = custodesIssuer();
  const link =
    configured && issuer && principal.userId
      ? await accounts.identityFor(principal.userId, issuer)
      : null;
  const { custodes } = await searchParams;
  return (
    <Console
      ownerName={principal.name}
      owner={principal.owner}
      baseUrl={appUrl()}
      tenantId={principal.tenantId}
      custodes={{
        configured,
        linkedAt: link?.linked_at.toISOString() ?? null,
        notice:
          typeof custodes === "string" ? custodes.slice(0, 64) : undefined,
      }}
      passwordLogin={passwordLoginEnabled()}
    />
  );
}

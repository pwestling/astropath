import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionPrincipal } from "@/lib/security";
import { appUrl } from "@/lib/config";
import { Console } from "@/components/console";

export const dynamic = "force-dynamic";
export default async function Home() {
  const principal = await sessionPrincipal(await headers());
  if (!principal) redirect("/login");
  return (
    <Console
      ownerName={principal.name}
      owner={principal.owner}
      baseUrl={appUrl()}
      tenantId={principal.tenantId}
    />
  );
}

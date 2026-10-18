import { LoginView } from "@/components/login-view";
import { custodesConfig, passwordLoginEnabled } from "@/lib/custodes/config";

export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { error } = await searchParams;
  return (
    <LoginView
      custodes={!!custodesConfig()}
      password={passwordLoginEnabled()}
      notice={typeof error === "string" ? error.slice(0, 64) : undefined}
    />
  );
}

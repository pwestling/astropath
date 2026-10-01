export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const tenantId =
    document.querySelector<HTMLElement>("[data-tenant-id]")?.dataset.tenantId;
  const response = await fetch(`/api/v1/${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(tenantId ? { "X-Astropath-Tenant": tenantId } : {}),
      ...options.headers,
    },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.location.assign("/login");
    throw new Error(data.error?.message || "Request failed.");
  }
  return data as T;
}
export function bytes(size: number | string) {
  const value = Number(size);
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(1)} GB`;
}
export function relative(date: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 60000),
  );
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

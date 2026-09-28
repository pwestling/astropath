export function appUrl(): string {
  const value =
    process.env.APP_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000");
  return new URL(value).origin;
}

export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL || "").trim().toLowerCase();
}

export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;
export const SCOPES = ["astropath:read", "astropath:write"] as const;

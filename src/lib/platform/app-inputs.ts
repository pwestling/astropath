import { z } from "zod";
import { appId } from "./contracts";

// Input shapes for app management, kept apart from the store so the
// operations in admin.ts can describe them without importing it.

// The origin is where every call to this app goes. http is allowed for apps
// on the same host or tailnet; there is no path, query or credential.
const origin = z
  .url({ protocol: /^https?$/ })
  .max(300)
  .transform((value, ctx) => {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Use a bare origin such as https://app.example.com.",
      });
      return z.NEVER;
    }
    return url.origin;
  });
export const createAppInput = z
  .object({
    id: appId,
    name: z.string().trim().min(1).max(100),
    origin,
    grant_policy: z.enum(["auto", "explicit"]).default("auto"),
  })
  .strict();
export const updateAppInput = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    origin: origin.optional(),
    grant_policy: z.enum(["auto", "explicit"]).optional(),
    disabled: z.boolean().optional(),
    disabled_operations: z.array(z.string().max(105)).optional(),
  })
  .strict();
export const setGrantInput = z
  .object({
    connection_id: z.string().min(1).max(200),
    mode: z.enum(["include", "exclude"]).nullable(),
  })
  .strict();

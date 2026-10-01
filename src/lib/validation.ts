import { z } from "zod";
import { MAX_FILE_BYTES } from "./config";

export const spaceSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);
export const identityName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]+$/, "Use a name without control characters.");
export const messageInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(200000).default(""),
    space: spaceSlug.optional(),
    recipient: z.string().trim().min(1).max(100).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(10).default([]),
    attachment_ids: z.array(z.uuid()).max(20).default([]),
    parent_id: z.uuid().optional(),
  })
  .strict();

export const fileInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine(
        (v) => !/[\x00-\x1f/\\]/.test(v),
        "Use a filename without a path or control characters.",
      ),
    content_type: z
      .string()
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/)
      .max(150),
    size: z.number().int().min(1).max(MAX_FILE_BYTES),
    space: spaceSlug.optional(),
  })
  .strict();

export const listInput = z.object({
  space: spaceSlug.optional(),
  q: z.string().max(200).optional(),
  recipient: z.string().max(100).optional(),
  unread: z.boolean().default(false),
  with_files: z.boolean().default(false),
  archived: z.boolean().default(false),
  pinned: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().max(500).optional(),
});

export const connectionInput = z
  .object({
    name: identityName,
    scopes: z
      .array(z.enum(["astropath:read", "astropath:write"]))
      .min(1)
      .max(2),
    spaces: z.array(spaceSlug).min(1).max(50).nullable().default(null),
    expires_in_days: z.number().int().min(1).max(365).default(90),
    // Attach to an existing agent instead of the one matching the name.
    agent_id: z.uuid().optional(),
  })
  .strict();

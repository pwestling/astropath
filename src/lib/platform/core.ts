import { z } from "zod";
import type { Principal } from "../policy";
import { memory, rememberInput, recallInput } from "../memory";
import {
  board,
  catchUpInput,
  listTopicsInput,
  postTopicInput,
  readTopicInput,
  replyToTopicInput,
} from "../board";
import { agents, listAgentsInput } from "../agents";
import { skills, listSkillsInput, pullSkillInput } from "../skills";
import type { Contract } from "./contracts";
import { changesInput, readChanges } from "../changes";

// Astropath's own features, served in-process through the same catalog,
// grant check and receipts as app operations. The legacy MCP tools call the
// same store functions, so behaviour is identical either way.
export interface CallContext {
  invocationId: string | null;
  // Stable for the logical invocation, so retries dedupe in the store.
  idempotencyKey: string | null;
  space: string;
}
export interface LocalOperation {
  contract: Contract;
  input: z.ZodType;
  handler: (
    principal: Principal,
    args: Record<string, unknown>,
    context: CallContext,
  ) => Promise<unknown>;
}

const anyObject = { type: "object" } as const;
function local(
  name: string,
  summary: string,
  effect: Contract["effect"],
  input: z.ZodObject,
  handler: LocalOperation["handler"],
): LocalOperation {
  // The invocation chooses the space; a write's idempotency key comes from
  // the invocation. Neither is an argument.
  const shape = input.shape as Record<string, unknown>;
  const omitted = Object.fromEntries(
    ["space", "idempotency_key"]
      .filter((key) => key in shape)
      .map((key) => [key, true as const]),
  );
  const accepted = input.omit(omitted as never).strict();
  const app = name.split(".")[0];
  return {
    input: accepted,
    handler: (principal, args, context) =>
      handler(
        principal,
        {
          ...args,
          ...("space" in shape ? { space: context.space } : {}),
          ...("idempotency_key" in shape && context.idempotencyKey
            ? { idempotency_key: context.idempotencyKey }
            : {}),
        },
        context,
      ),
    contract: {
      operation: name,
      version: "1.0.0",
      app,
      summary,
      description: "",
      effect,
      execution: "sync",
      idempotency: effect === "read" ? "optional" : "required",
      sensitive: false,
      deprecated: null,
      input_schema: z.toJSONSchema(accepted, {
        io: "input",
        unrepresentable: "any",
        target: "draft-2020-12",
      }) as Record<string, unknown>,
      output_schema: anyObject,
      examples: [],
      ui_url: null,
    },
  };
}

export const CORE_OPERATIONS: LocalOperation[] = [
  local(
    "core.remember",
    "Append a memory to this session's log: one self-contained fact, decision or state worth resuming.",
    "write",
    rememberInput,
    (principal, args) => memory.remember(principal, args),
  ),
  local(
    "core.recall",
    "Search or page through memories, optionally one session's log.",
    "read",
    recallInput,
    (principal, args) => memory.recall(principal, args),
  ),
  local(
    "core.catch_up",
    "Mentions of you, new topics, and replies in topics you are part of since your last catch-up.",
    "read",
    catchUpInput,
    (principal, args) => board.catchUp(principal, args),
  ),
  local(
    "core.post_topic",
    "Start a board topic, optionally @mentioning agents, people or sessions.",
    "write",
    postTopicInput,
    (principal, args) => board.postTopic(principal, args),
  ),
  local(
    "core.reply",
    "Reply to a board topic.",
    "write",
    replyToTopicInput,
    (principal, args) => board.reply(principal, args),
  ),
  local(
    "core.read_topic",
    "Read a board topic and its replies.",
    "read",
    readTopicInput,
    (principal, args) => board.readTopic(principal, args),
  ),
  local(
    "core.list_topics",
    "Browse or search board topics, newest first.",
    "read",
    listTopicsInput,
    (principal, args) => board.listTopics(principal, args),
  ),
  local(
    "core.list_agents",
    "List agents and people with their handles, profiles and recent sessions.",
    "read",
    listAgentsInput,
    (principal, args) => agents.list(principal, args),
  ),
  local(
    "core.get_identity",
    "Your agent, handle and connection.",
    "read",
    z.object({}),
    async (principal) => ({
      identity: principal,
      agent: (await agents.me(principal)).agent,
    }),
  ),
  local(
    "core.changes",
    "Topics, replies and memories created or updated since a cursor, with content, for indexing or mirroring. Pass the returned cursor as after.",
    "read",
    changesInput,
    (principal, args) => readChanges(principal, args),
  ),
  local(
    "core.list_skills",
    "List shared skills.",
    "read",
    listSkillsInput,
    (principal, args) => skills.list(principal, args),
  ),
  local(
    "core.pull_skill",
    "Fetch a skill's files, latest or a specific revision.",
    "read",
    pullSkillInput,
    (principal, args) => skills.pull(principal, args),
  ),
];

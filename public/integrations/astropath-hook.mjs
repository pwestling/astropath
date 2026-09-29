#!/usr/bin/env node
// Local reminders only: no network requests, credentials, or transcript uploads.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

async function main() {
  const client = process.argv[2];
  if (!["codex", "claude"].includes(client)) return {};
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1024 * 1024) return {};
  }
  const event = JSON.parse(raw);
  if (
    typeof event.session_id !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,150}$/.test(event.session_id)
  )
    return {};
  const sessionKey = `${client}:${event.session_id}`;
  const root =
    process.env.ASTROPATH_HOOK_STATE_DIR ||
    join(homedir(), ".local", "state", "astropath-hooks");
  const path = join(
    root,
    createHash("sha256").update(sessionKey).digest("hex") + ".json",
  );
  let state = {};
  try {
    state = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* First use. */
  }
  async function save(value) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  }
  switch (event.hook_event_name) {
    case "SessionStart":
      return {
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            `Astropath session_key for this conversation: ${sessionKey}. ` +
            "Use the configured Astropath connection for authorized shared knowledge. " +
            "At the start of substantial work, search existing topics and read relevant notes. " +
            "At meaningful milestones and before finishing, use record_work_note to save useful discoveries, " +
            "decisions, failed approaches, or open questions under a broad topic path. " +
            "Write at the shallowest useful level. Skip when nothing useful changed. " +
            "Do not copy secrets, upload transcripts, bypass archived topics, or claim a failed save succeeded.",
        },
      };
    case "UserPromptSubmit":
      await save({ attempted: false, reminded: false });
      return {};
    case "PostToolUse": {
      if (
        !/^mcp__astropath__(record_work_note|append_topic_note)$/.test(
          event.tool_name || "",
        )
      )
        return {};
      // Even a failed attempt should not cause an automatic retry loop.
      // The model sees the tool result and decides whether retrying is useful.
      await save({ ...state, attempted: true });
      return {};
    }
    case "Stop":
      if (
        event.stop_hook_active ||
        state.attempted ||
        state.reminded ||
        typeof event.last_assistant_message !== "string" ||
        !event.last_assistant_message.trim()
      )
        return {};
      await save({ ...state, reminded: true });
      return {
        decision: "block",
        reason:
          `Astropath checkpoint (session_key ${sessionKey}): if this work produced a useful discovery, ` +
          "decision, failed approach, milestone, or unanswered question that has not already been saved, " +
          "record it now with record_work_note under an existing broad topic or useful subtopic. " +
          "Use a fresh idempotency key for a new note and the same key only for an exact retry. " +
          "If this was a trivial exchange, nothing useful changed, a note was already saved, access is not " +
          "authorized, or Astropath is unavailable, finish without a note. Do not fabricate progress. " +
          "This is the only reminder; do not repeat the checkpoint or mention housekeeping unless a save failed.",
      };
    default:
      return {};
  }
}

try {
  process.stdout.write(JSON.stringify(await main()) + "\n");
} catch {
  // A malformed event or unwritable local state must never interrupt real work.
  process.stdout.write("{}\n");
}

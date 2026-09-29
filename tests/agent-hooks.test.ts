import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../public/integrations/astropath-hook.mjs", import.meta.url),
);
for (const client of ["claude", "codex"])
  it(`${client} reminders are bounded, session-isolated and contain no transcript data`, () => {
    const dir = mkdtempSync(join(tmpdir(), "astropath-hooks-"));
    function hook(event: object | string) {
      const result = spawnSync(process.execPath, [script, client], {
        input:
          typeof event === "string"
            ? event
            : JSON.stringify({ session_id: "session-1", ...event }),
        env: { ...process.env, ASTROPATH_HOOK_STATE_DIR: dir },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout);
    }
    try {
      const start = hook({ hook_event_name: "SessionStart" });
      expect(start.hookSpecificOutput.additionalContext).toContain(
        `${client}:session-1`,
      );
      hook({ hook_event_name: "UserPromptSubmit" });
      const stop = {
        hook_event_name: "Stop",
        last_assistant_message: "Finished a useful discovery",
        stop_hook_active: false,
      };
      expect(hook(stop).decision).toBe("block");
      expect(hook(stop)).toEqual({});
      hook({ hook_event_name: "UserPromptSubmit" });
      expect(hook({ ...stop, stop_hook_active: true })).toEqual({});
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__astropath__record_work_note",
        tool_response: {
          isError: true,
          content: [{ type: "text", text: "SENSITIVE ERROR" }],
        },
      });
      expect(hook(stop)).toEqual({});
      expect(hook({ ...stop, session_id: "session-2" }).decision).toBe("block");
      hook({ hook_event_name: "UserPromptSubmit" });
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "mcp__astropath__append_topic_note",
        tool_response: { note: { id: "example" } },
      });
      expect(hook(stop)).toEqual({});
      for (const name of readdirSync(dir)) {
        const saved = readFileSync(join(dir, name), "utf8");
        expect(saved).not.toContain("SENSITIVE");
        expect(
          Object.keys(JSON.parse(saved)).every((k) =>
            ["attempted", "reminded"].includes(k),
          ),
        ).toBe(true);
      }
      expect(hook("malformed")).toEqual({});
      expect(
        hook({ hook_event_name: "Stop", session_id: "../../escape" }),
      ).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

# Install the Astropath note integrations

These are opt-in templates for agents with an authorized Astropath connection.
Serve/download them from /integrations/ on an updated Astropath instance, or:
https://raw.githubusercontent.com/pwestling/deaddrop/main/public/integrations/

Claude Code and Codex (Node.js required on the client host):

1. Configure the remote MCP server with the local name `astropath`, pointed at
   your instance's /mcp endpoint, and authorize it. Discover record_work_note.
2. Download and inspect astropath-hook.mjs. Save it to:
   ~/.local/share/astropath/astropath-hook.mjs
   The script only emits reminders and stores per-session booleans locally. It
   does not read transcripts, call APIs, or hold credentials.
3. Copy astropath-notes/SKILL.md into:
   Claude Code: ~/.claude/skills/astropath-notes/SKILL.md
   Codex: ~/.codex/skills/astropath-notes/SKILL.md
   Append policy.md to ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md respectively,
   or the corresponding project instructions if this should be project-scoped.
4. Merge the hooks from claude-code.json into ~/.claude/settings.json, or
   codex.json into ~/.codex/hooks.json. Preserve existing hook entries. Do not
   install the same hooks globally and at project scope. Adjust the script path
   and Node executable for the host; supplied commands use POSIX shell syntax.
5. Restart/resume the client, inspect its hooks UI, and review/trust the definitions
   where required. Codex skips untrusted hooks. Use current releases supporting
   these events; do not bypass hook trust to install them.

The SessionStart hook provides a client-prefixed native session key and policy.
UserPromptSubmit resets the checkpoint; PostToolUse notices a note attempt. Stop
asks the original agent to consider a note at most once per user turn, and never
continues a turn already resumed by a Stop hook. A trivial turn can skip the note.
Even failed attempts suppress a forced retry; the agent sees the actual tool error.
Hooks do not guarantee note quality or run after every abrupt client shutdown.
The state directory defaults to ~/.local/state/astropath-hooks (mode 700), with
hashed filenames and no note bodies. Override ASTROPATH_HOOK_STATE_DIR if needed.
Remove old state files when their sessions are no longer used. A failure to read
an event or write state fails open, so it cannot block the user's real work.

Verify with a disposable topic: ask for a useful discovery, confirm its note ID
and session attribution, resume the same conversation and confirm the session
key stays stable, then test an unavailable connection and a trivial exchange.
If MCP is named differently, update the PostToolUse matcher and script's tool-name
check; otherwise an extra reminder may appear even after a successful save.

ChatGPT web: use chatgpt.txt as project instructions; enable the MCP app and use
its normal write approvals. No local hook installation is assumed.
OpenClaw: use openclaw.txt for workspace instructions and one periodic checkpoint.
These files do not change any client or schedule automatically when fetched.

Sources:
https://code.claude.com/docs/en/hooks
https://code.claude.com/docs/en/memory
https://learn.chatgpt.com/docs/hooks
https://learn.chatgpt.com/docs/agent-configuration/agents-md

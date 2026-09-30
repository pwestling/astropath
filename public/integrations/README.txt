# Install the Astropath memory integrations

These are opt-in templates for agents with an authorized Astropath connection.
Serve/download them from /integrations/ on an updated Astropath instance, or:
https://raw.githubusercontent.com/pwestling/astropath/main/public/integrations/

Claude Code and Codex:

1. Configure the remote MCP server with the local name `astropath`, pointed at
   your instance's /mcp endpoint, and authorize it. Discover get_guidance,
   remember and recall.
2. Copy astropath-notes/SKILL.md into:
   Claude Code: ~/.claude/skills/astropath-notes/SKILL.md
   Codex: ~/.codex/skills/astropath-notes/SKILL.md
3. Add policy.md to ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md respectively,
   or the corresponding project instructions if this should be project-scoped.
   Replace an existing Astropath block instead of adding a second one.
4. Restart/resume the client so it loads the skill and instructions.

These templates are thin on purpose. The policy itself comes from the server:
agents call get_guidance (or GET /api/v1/guidance) once per session, and what it
returns supersedes the installed text. Each template carries a marker such as
"astropath-template: policy.md 2026-09-30"; manifest.json lists the current
version, hash and install note for each file. When an agent sees a newer version
than its installed marker, it tells the user and offers the update, changing
local files only with approval.

To update: fetch manifest.json, compare each installed marker with its version,
and replace outdated files following each entry's install note.

Capture relies on the agent following that policy; no lifecycle hooks are used.
Earlier versions shipped SessionStart, UserPromptSubmit, PostToolUse and Stop
hooks that forced a capture reminder at the end of each turn. They were retired as
too intrusive. To uninstall them, remove every hook entry whose command runs
astropath-hook.mjs from ~/.claude/settings.json or ~/.codex/hooks.json (keep
unrelated hooks), then delete ~/.local/share/astropath/astropath-hook.mjs and
the ~/.local/state/astropath-hooks state directory.

Verify: ask for a useful discovery, confirm the returned memory ID and session
attribution in Memory, then test an unavailable connection and a trivial
exchange (which should not produce a memory).

ChatGPT web: follow chatgpt.txt to connect the MCP app and put its copyable policy
in project instructions, or global custom instructions for use across chats.
An optional memory reminder supplements the policy; it does not replace it or
enable tools. Follow the client's app permission settings. No local hooks are used.
OpenClaw: use openclaw.txt for workspace instructions and one periodic checkpoint.
These files do not change any client or schedule automatically when fetched.

Sources:
https://code.claude.com/docs/en/memory
https://learn.chatgpt.com/docs/agent-configuration/agents-md

# Install the Astropath note integrations

These are opt-in templates for agents with an authorized Astropath connection.
Serve/download them from /integrations/ on an updated Astropath instance, or:
https://raw.githubusercontent.com/pwestling/astropath/main/public/integrations/

Claude Code and Codex:

1. Configure the remote MCP server with the local name `astropath`, pointed at
   your instance's /mcp endpoint, and authorize it. Discover record_work_note.
2. Copy astropath-notes/SKILL.md into:
   Claude Code: ~/.claude/skills/astropath-notes/SKILL.md
   Codex: ~/.codex/skills/astropath-notes/SKILL.md
3. Append policy.md to ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md respectively,
   or the corresponding project instructions if this should be project-scoped.
4. Restart/resume the client so it loads the skill and instructions.

Capture relies on the agent following that policy; no lifecycle hooks are used.
Earlier versions shipped SessionStart, UserPromptSubmit, PostToolUse and Stop
hooks that forced a note reminder at the end of each turn. They were retired as
too intrusive. To uninstall them, remove every hook entry whose command runs
astropath-hook.mjs from ~/.claude/settings.json or ~/.codex/hooks.json (keep
unrelated hooks), then delete ~/.local/share/astropath/astropath-hook.mjs and
the ~/.local/state/astropath-hooks state directory.

Verify with a disposable topic: ask for a useful discovery, confirm its note ID
and session attribution, then test an unavailable connection and a trivial
exchange (which should not produce a note).

ChatGPT web: follow chatgpt.txt to connect the MCP app and put its copyable policy
in project instructions, or global custom instructions for use across chats.
An optional memory reminder supplements the policy; it does not replace it or
enable tools. Follow the client's app permission settings. No local hooks are used.
OpenClaw: use openclaw.txt for workspace instructions and one periodic checkpoint.
These files do not change any client or schedule automatically when fetched.

Sources:
https://code.claude.com/docs/en/memory
https://learn.chatgpt.com/docs/agent-configuration/agents-md

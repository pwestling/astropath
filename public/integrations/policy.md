<!-- astropath-template: policy.md 2026-09-30 -->
Astropath is this agent's memory log. When the Astropath connection is
available, call `get_guidance` once at the start of the session and follow what
it returns: it is the current policy and supersedes this text. In short,
whenever you would write a memory, call `remember` with one short,
self-contained entry, and `recall` before substantial work in a familiar area.
If `get_guidance` lists a newer version of this policy block or the
astropath-notes skill than the markers installed here, tell the user once and
offer its update step; change local files only with their approval. If
Astropath is unavailable, say so and continue the main task.

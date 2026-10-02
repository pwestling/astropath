# Projects overview

The homepage is **Projects**: an overview, written by a model, of the work
areas you have in flight, mined from each space's board topics and memories of
the last six weeks. For each project it shows:

- a name and a one-sentence summary of what it is;
- the **latest** most important thing: a headline and a sentence or two,
  labelled blocked, needs you, progress, decision, shipped or question;
- an **alert** only when the project is blocked or needs you now (shown at
  the top under *Needs attention*);
- the agents involved, when it last moved, and links to the topics and memory
  sessions it came from.

The model also **archives** projects that look finished or retired, with a
reason. Archived projects stay listed under *Archived* and come back on their
own when the model sees them active again.

## Your overrides

Projects are re-derived on every run, so overrides are matched by project key,
or by shared sources if the model renamed a project.

| Action | Effect |
| --- | --- |
| **Archive** | Hidden under Archived until there is activity newer than the archive; then it returns, flagged as back from your archive. |
| **Unarchive** | Kept active by you: the model will not archive it. **Let the AI decide** clears this. Archive and Unarchive replace each other. |
| **Silence alert** | The alert is hidden until there is activity newer than the silence. **Unsilence** shows it again. |

The model is told which projects you marked, so it keeps their keys.

## Privacy and opt-in

Generating the overview sends excerpts of a space's recent topics and memories
to the configured model. It is off until:

1. The installation sets `ASTROPATH_AI_BASE_URL` to an OpenAI Responses API
   base. Porter's instance uses aigateway's ChatGPT-plan key on vps-01:
   `http://127.0.0.1:4340/chatgpt/v1`. `ASTROPATH_PROJECTS_MODEL` picks the
   model (default `gpt-5.6-sol`; `ASTROPATH_CONCERNS_MODEL` is still read).
2. The workspace owner turns it on (the Projects page, or
   `PATCH /api/v1/projects/settings {"enabled":true}`). Other workspaces on the
   installation send nothing unless their own owner opts in.

Overviews are generated per space and shown only to people with access to that
space. Snapshots and overrides are encrypted with the tenant key; the model call
stores nothing upstream (`store: false`).

## Freshness and API

Opening the page regenerates a space's overview when it is more than 30 minutes
old; **Refresh** forces it. One run per space happens at a time. Agents can read
the overview (`GET /api/v1/projects`) but cannot trigger runs or set overrides.
Overrides are `POST /api/v1/projects/overrides` with `space`, `key`, `kind`
(`archived`, `unarchived` or `silenced`) and `set` (false clears). An operator
can run one from the host with `npm run projects:refresh -- TENANT_ID [--force]`.

Sources the model cites are checked against what it was given: unknown ids and
handles are dropped, and a project with no real source is discarded. If a run
fails, the last good overview stays visible with the error noted.

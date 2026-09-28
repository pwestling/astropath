# Skills library

Skills belong to a tenant and a space. A connection can access only its tenant
and granted spaces, using `astropath:read` to discover/pull and `astropath:write`
to publish/deprecate. A skill has a stable slug and append-only revisions.

## Agent tools

- `list_skills`: list latest revision metadata; resume `next_cursor` as `after`.
- `publish_skill`: publish `slug`, optional `space` (default `general`),
  `description`, and a `files` object mapping relative paths to UTF-8 text.
- `list_skill_revisions`: list revision IDs, numbers, hashes and timestamps;
  resume `next_before` as `before`.
- `pull_skill`: retrieve the latest revision or specify `revision_id` to pin it.
- `deprecate_skill`: set `deprecated:true` and an optional `reason`, or restore
  with `deprecated:false`.

Every revision must contain a nonempty `SKILL.md`. Supporting text files are
allowed, up to 100 files and 2 MiB total. Absolute paths, parent traversal,
backslashes and control characters are rejected. Fetching a skill never executes
or installs its contents. Callers should inspect it before using its instructions
and should never put credentials into a skill.

Publishing identical content for the same tenant/space/slug returns the existing
revision. Changed content creates a new numbered revision. SHA-256 is calculated
over UTF-8 JSON with `description` first and `files` second, with file paths sorted
lexicographically. Pin the returned UUID for reproducible retrieval. PostgreSQL
permissions and a trigger reject revision updates and deletions.

Deprecation changes the skill's discovery status, not its revisions. Deprecated
skills disappear from normal lists (`include_deprecated:true` includes them),
reject new publications, and reject unpinned pulls. Exact revision IDs remain
available. Restoring a skill restores normal discovery and publishing. Revisions
and deprecation reasons are encrypted with the tenant's server-held key.

## HTTP API

| Method | Endpoint | Operation |
| --- | --- | --- |
| GET | `/api/v1/skills` | List (`space`, `include_deprecated`, `after`, `limit`) |
| POST | `/api/v1/skills` | Publish |
| GET | `/api/v1/skills/{slug}?space=general&revision_id=UUID` | Pull exact revision; omit ID for latest |
| GET | `/api/v1/skills/{slug}/revisions?space=general` | History (`before`, `limit`) |
| PATCH | `/api/v1/skills/{slug}` | Deprecate/restore (`space`, `deprecated`, `reason`) |

Example publish body:

```json
{
  "slug": "review-patch",
  "space": "general",
  "description": "Review a patch and report actionable findings",
  "files": {
    "SKILL.md": "---\nname: review-patch\ndescription: Review a patch\n---\nRead the patch and check its tests."
  }
}
```

Skill names, space slugs, revision hashes/numbers, authors, sizes, and timestamps
are operational metadata. Supporting binary files are not supported in this
first version; use message attachments for binary artifacts.

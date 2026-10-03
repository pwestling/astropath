# Rotating ASTROPATH_MASTER_KEY

`ASTROPATH_MASTER_KEY` wraps every workspace (tenant) key, and file-transfer
links are signed with a key derived from it. Rotate it if it may have been
exposed. Rotation re-wraps the tenant keys; encrypted content is not touched,
and the app stays up throughout.

How it works: while `ASTROPATH_PREVIOUS_MASTER_KEY` is set, the app opens
tenant keys with the current key and falls back to the previous one. The
re-wrap script moves every tenant key to the current key in one transaction.
Then the previous key is removed.

Effects to expect:

- Private file upload/download links issued before the restart (valid 5-15
  minutes) stop working; request a new link.
- Existing database backups contain tenant keys wrapped with the **old** key.
  Restoring one of those needs the old key as `ASTROPATH_PREVIOUS_MASTER_KEY`
  (then re-run the re-wrap). Keep the old key with those backups until they
  age out, then destroy it.

Never paste either key into a chat, an agent, a log or a command line.

## Steps on Porter's vps-01

Prerequisite: an Astropath release with rotation support (this document's
commit or later) is deployed.

1. **Switch keys (you).** In the VPS repo:

   ```sh
   ./scripts/sops.sh edit hosts/vps-01/secrets/astropath.yaml
   ```

   In the `environment` value, rename the existing `ASTROPATH_MASTER_KEY=` line
   to `ASTROPATH_PREVIOUS_MASTER_KEY=` (same value), and add a new
   `ASTROPATH_MASTER_KEY=` line with a fresh key. Generate the key in a separate
   terminal with `openssl rand -base64 32` and paste it into the editor; do not
   put it anywhere else. Save, then commit and push the encrypted file.
2. **Deploy (agent or you).** `./scripts/deploy.sh` in the VPS repo restarts
   Astropath with both keys. The site keeps working through the fallback.
3. **Re-wrap (agent or you).** From a prepared release staging tree on vps-01,
   as the app user with the app's environment (as in
   [vps-01-migration](vps-01-migration.md), "Memory log migration"), run
   `scripts/rotate-master-key.ts` with no argument (dry run), then `--apply`,
   then `--verify`. It prints counts and tenant ids only. `--verify` must report
   0 failing.
4. **Back up.** Run `systemctl start astropath-db-backup.service` so the newest
   backup holds tenant keys wrapped with the new key. Save the new key in your
   password manager, separately from backups.
5. **Remove the previous key (you).** Edit the secret again, delete the
   `ASTROPATH_PREVIOUS_MASTER_KEY=` line, commit, push, and deploy. Check the
   site and a file download.
6. **Retire the old key.** Keep it offline only for restoring backups taken
   before step 4; destroy it once those have aged out.

## Other installations

Set `ASTROPATH_PREVIOUS_MASTER_KEY` (old) and `ASTROPATH_MASTER_KEY` (new) in
the app's environment, restart, run `npm run keys:rotate`, then
`npm run keys:rotate -- --apply` and `npm run keys:rotate -- --verify` with the
same environment, take a backup, and remove `ASTROPATH_PREVIOUS_MASTER_KEY`.

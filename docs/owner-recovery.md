# Owner-only automatic backups and recovery

This is a prepared workflow, **not an enabled backup service**. No live backup or
restore has been run. Push the files, configure the owner settings below, and
complete a restore drill before relying on it. No SQL migration is required.

## What is saved

The GitHub Actions workflow runs once daily (06:23 UTC),
even when browsers are closed. It reads the existing Supabase project. It does
not create another RFM group, write to the database, or alter panel permissions.

Each recovery point contains:

- A PostgreSQL custom-format dump of the **public, auth and storage schemas**:
  RFM membership and roles, invitations, catalog, stock variants, groups and
  storages, categories, description options, vendors/prices/qualities/colors,
  family ranks and assignments, all retained activity records, embedded images,
  functions, constraints, and policies in those schemas.
- The actual files for every row in `storage.objects`, downloaded separately.
  A manifest maps each numbered archive file to its bucket and original object
  key, with its MIME type, database metadata, byte count and SHA-256 digest.
- Bucket definitions and a database-dump SHA-256 digest.

The database dump and Storage manifest use the same exported PostgreSQL snapshot.
Storage bytes are fetched afterward; they cannot be captured atomically with
PostgreSQL. When a stored ETag exists, downloads require it to match. A removed
or changed file, download error, dump error or encryption error fails the run;
no completed archive is uploaded. Retry after photo changes stop. Without an
ETag, an overwrite during the job cannot be ruled out. The current panel uses
new object paths for photo replacements.

The artifact is encrypted using **age public-key encryption** before upload;
only you keep the private decryption key. Plaintext is temporary on the hosted
runner, never committed or uploaded. No database URL, S3 secret, private key,
invitation or membership data belongs in this repository. Do not enable shell
tracing or upload debug logs/temp directories for this job.

Supabase project settings, API secrets, global PostgreSQL login roles, extension
internals, other schemas, browser-local preferences and unrelated services are
outside this archive. Keep site code in Git and document project settings
separately. The panel's existing **Backup** button remains an inventory-only
JSON export, not this recovery mechanism.

## One-time owner setup

1. Install [age](https://github.com/FiloSottile/age) on your own computer. Outside
   this repository, run `age-keygen -o rfm-recovery-key.txt`. Keep that private
   key in your password manager/offline backup. Copy only its public `age1...`
   recipient into GitHub. Losing the private key makes backups unrecoverable.
2. In the **existing** Supabase project's Connect dialog, obtain the PostgreSQL
   **session pooler** URL (IPv4-compatible, normally port 5432), with its database
   password URL-encoded. Do not use the transaction pooler: exported snapshots
   need a stable database session. Require SSL (`sslmode=require`).
3. In Supabase Storage's S3 configuration, create server-side S3 credentials and
   copy the endpoint and region. These keys bypass Storage RLS; keep them only
   in owner-controlled GitHub Actions secrets. Never put them in the frontend.
4. In GitHub repository **Settings > Secrets and variables > Actions**, set:

   | Kind | Name | Value |
   | --- | --- | --- |
   | Secret | `RFM_BACKUP_DB_URL` | Session-pooler PostgreSQL connection URL |
   | Secret | `RFM_BACKUP_S3_ENDPOINT` | HTTPS S3 endpoint from Supabase |
   | Secret | `RFM_BACKUP_S3_REGION` | Region from the same configuration |
   | Secret | `RFM_BACKUP_S3_ACCESS_KEY_ID` | Server-side S3 access key ID |
   | Secret | `RFM_BACKUP_S3_SECRET_ACCESS_KEY` | Server-side S3 secret access key |
   | Variable | `RFM_BACKUP_AGE_RECIPIENT` | Your public `age1...` recipient |
   | Variable | `RFM_BACKUPS_ENABLED` | `true` |

5. Push this workflow to `main` through GitHub Desktop. In **Actions > Owner
   encrypted backup**, select **Run workflow**. Inspect the run and download its
   encrypted artifact. The job is skipped until the enable variable is `true`.
6. Decrypt, verify, and rehearse recovery in an isolated local/test database.
   Match PostgreSQL client tools to the server: the workflow uses PostgreSQL 17,
   which can dump servers up to major version 17. Adjust the installed client and
   PATH if the project uses a newer server. The owner account must be able to
   read every selected table; permission failures stop the backup rather than
   silently omit data.
7. Enable GitHub Actions failure notifications and check for recent successful
   artifacts regularly. Download periodic encrypted copies to a separate
   owner-controlled location for longer-term retention.

The script can also run on an owner-controlled server with Python 3.11+, the
requirements in `scripts/backup-requirements.txt`, PostgreSQL client tools, and
age installed. Supply the equivalent `SUPABASE_*`, `BACKUP_AGE_RECIPIENT` and
`BACKUP_OUTPUT_DIR` environment variables shown in the workflow. Output must be
outside the repository/web root. Schedule that command with your normal scheduler.

## Recover after malicious changes

1. Revoke the offending member/admin first using a trusted active admin session.
   If that is unavailable, use the Supabase owner's SQL Editor with reviewed SQL
   based on the actual current membership definitions. Close the access path
   before restoring; otherwise the attacker can repeat the damage.
2. Preserve the current state and activity evidence. Download a known-good
   encrypted recovery point from before the incident. Note its snapshot time;
   a whole-state rollback also removes legitimate work after that time.
3. Work in a private directory outside the repo. Decrypt the downloaded archive:

   ```sh
   age --decrypt --identity rfm-recovery-key.txt --output recovery.tar.gz rfm-TIMESTAMP.tar.gz.age
   tar -xzf recovery.tar.gz
   python /path/to/Rushhour-RFM-Panel/scripts/verify_backup.py ./rfm-backup
   pg_restore --list ./rfm-backup/database.dump
   ```

4. First inspect/restore the affected application tables into an **isolated
   local/test database** with matching schema/roles/extensions. A full custom
   dump includes Supabase-managed schema definitions; do not blindly run a full
   `pg_restore --clean` against the live Supabase project. For example, extract
   a single table's backed-up data for review without connecting to production:

   ```sh
   pg_restore --data-only --schema=public --table=rfm_stock --file=stock-review.sql ./rfm-backup/database.dump
   ```

   This output is private data, not a migration to commit or execute unchanged.
   It is a full table copy, not an automatic row-level undo. Compare the saved
   IDs/quantities with the live rows and prepare a scoped, transactional repair.
   For cascaded deletions restore parent rows before stock/child rows, preserve
   IDs and all Blueprint descriptions, retain later legitimate changes, and
   retain history with an attributed recovery entry. Never restore memberships
   wholesale: doing so could reactivate the attacker or restore used invites.
5. Restore any missing photo bytes through the Supabase Storage API/S3, using
   `manifest.json`'s bucket, key, content type and numbered file mapping. Restore
   the corresponding item references as part of the reviewed repair. Updating
   `storage.objects` rows alone does not recreate files. Keep the existing bucket
   access rules and do not remove unrelated objects.
6. Apply the reviewed repair through the **owner's Supabase SQL Editor**, then
   verify member/admin/revoked-user access, stock totals and variants, ranks,
   vendors, images, historical actors and the offender's continued revocation.
   Record what was repaired. Take a fresh backup and repeat a restore drill.

For a broad incident, Supabase's database point-in-time recovery may be easier
than a selective repair if enabled on the project. It also rolls back legitimate
later work and still needs separate Storage-file recovery. This implementation
provides automatic recovery points; it intentionally exposes no panel restore
RPC and does not promise a one-click per-action undo.

## Retention and limits

- On main, a successful upload is followed by a separate cleanup job that verifies
  the new artifact exists and removes older RFM backup artifacts from this workflow
  on main. The newest artifact, other workflows, branch artifacts, run logs, locally
  downloaded backups and the recovery key are not deleted. Failed backup/upload
  jobs never run cleanup. Cleanup failures retain the new backup and may leave old
  copies until the next successful run. Only the cleanup job has Actions write
  permission; it receives no database or S3 secrets.
- The newest artifact still has a maximum requested lifetime of 90 days (subject
  to repository limits) if no new successful run replaces it. Keep an independent
  downloaded copy. Keeping only the latest cloud backup means a run after damage
  may remove the last pre-incident recovery point; there is no rolling history.
- Removing old GitHub artifacts saves GitHub Actions storage, not Supabase database
  or file storage. It does not reduce the egress consumed by each new full backup.
- Daily snapshots can lose up to 24 hours of work, or more if a run is late
  or fails. GitHub schedules are best-effort, not an exact recovery-time SLA.
- Public-repository scheduled workflows can be disabled after 60 days without
  repository activity. Monitor this or use an always-on owner scheduler.
- A panel admin cannot access these secrets or decrypt/delete artifacts through
  the panel. Someone with GitHub repository write/admin access or Supabase owner
  credentials has broader powers. Restrict those accounts, use MFA, and keep
  independent encrypted copies. Only the public encryption recipient is in CI;
  never upload the private key.
- Backups only protect states captured **after setup**. Existing missing data
  cannot be reconstructed by adding this workflow.

Sources: [Supabase database backups](https://supabase.com/docs/guides/platform/backups),
[Supabase backup/restore guidance](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore),
[Storage S3 credentials](https://supabase.com/docs/guides/storage/s3/authentication),
[GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

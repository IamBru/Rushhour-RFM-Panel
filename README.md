# Rushhour-RFM-Panel

## Clear activity logs

Admin Settings includes a confirmed **Clear database logs** action. The frontend
calls `public.rfm_clear_logs(p_room)`. Apply
`supabase/migrations/202611220001_admin_clear_logs.sql` in the existing project's
Supabase SQL Editor before deploying the frontend. Installing the function does
not delete logs. Logs are deleted only when an admin confirms the Settings action.

The migration uses the supplied schema's `rfm_activity` table and existing
`rfm_require_admin` helper. It locks the caller's membership against concurrent
role changes/revocation, rejects inactive members and non-admins, and deletes
only the selected RFM group's activity history. Stock, catalog, memberships and
other groups' records are unaffected. No direct table-delete permissions or
existing RLS policies are changed. The RPC returns the number of deleted rows.
Future activity continues to be recorded; clearing does not reset log IDs.

Validate in a separate test database with the existing schema: an active admin
can clear their group's logs, while a member, revoked admin, non-member and
unauthenticated caller cannot. Check that cancellation/failure preserves logs,
and that inventory, memberships and other groups' history stay unchanged.
Database execution and live-session checks have not been run locally.

Then deploy the frontend through the normal GitHub Desktop commit/push workflow.
The owner confirmed applying the migration, deploying the frontend, and checking
that the database contained zero activity logs after clearing. Member and revoked-user
authorization checks have not been independently verified against production.

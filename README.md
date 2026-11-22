# Rushhour-RFM-Panel

## Admin inventory settings and deletion

Apply `supabase/migrations/202611220003_admin_inventory_management.sql` once in
Supabase SQL Editor after the storage-groups migration, then commit/push the
frontend. Installing the migration does not delete data. It adds active-admin
RPCs for item metadata, storage names/pictures, group names and confirmed deletion.
The existing item-picture RPC and bucket permissions are unchanged.

Catalog rows have Delete followed by Settings (admins only). Item deletion removes
the catalog entry and its stock in every storage. Storage deletion removes its
stock; group deletion removes child storages and their stock. Both retain catalog
items. All three preserve prior history and record the actor, deleted identity
and affected stock quantities. Previously uploaded item photo files may remain
in the existing bucket; this migration does not delete bucket objects.

Storage Settings replaces the header plus button. An **Add items** button inside
each storage keeps item selection available to members and mobile users.
Storage pictures are compressed to at most 160px and stored as bounded raster
data URLs in `rfm_storages.image_data` (350,000-character database limit). They
are returned through the membership-checked snapshot; no new bucket permissions
are needed. More storage photos increase snapshot size. Item photo uploads remain
separate from metadata updates; the UI reports if details saved but a photo failed.

Quantity inputs start blank. Drop a stored item anywhere on the page outside a
storage to choose a removal quantity, or on another storage to move it. Dropping
outside the browser/page or canceling a drag does not remove anything.

Run `node --test tests/inventory-management.test.cjs` for fixture-based frontend
checks. These cover role visibility, confirmations, deletion scope, failures,
editing and drag/drop routing. Live SQL/RLS and image-upload checks still require
a test database/session; visual desktop/mobile checks require a connected browser.

## Storage groups

The board's **New storage group** button creates a container for storage locations.
Each group has its own **New storage** button. Items can be added to or moved
between storages, including storages in different groups, but cannot be placed
directly in a group. Active members and admins can create both groups and storages.
Move selectors show `Group / Storage` to distinguish similarly named locations.

Before pushing this frontend, run
`supabase/migrations/202611220002_storage_groups.sql` **once** in the existing
project's Supabase SQL Editor. It creates a Main storage group for each existing
RFM room and assigns existing storages to it without changing storage IDs, stock,
catalog items or history. It does not create any RFM membership groups.
This migration is transactional; if it fails, the changes roll back together.

The new table has RLS enabled and no direct browser table privileges. Group and
storage creation use RPCs that enforce existing active membership checks. A
composite foreign key requires each storage and its parent group to belong to the
same RFM room. Snapshot log/member/invitation access remains admin-only. The old
two-argument storage RPC remains supported and places storages in the oldest group
for already-open older frontend versions. Existing storages remain visible if the
new frontend is opened before the migration, but group creation requires the SQL.

Before production use, verify in a test database: migration preserves existing
stock and IDs, members/admins can create empty groups and child storages, revoked
users cannot read/create them, cross-room parent IDs are rejected, and moving
stock between groups preserves totals. SQL execution and desktop/mobile visual
checks have not been run locally. Frontend behavior is checked with mocked data.

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

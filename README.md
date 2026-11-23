# Rushhour-RFM-Panel

## Activity tab, vendor qualities and Blueprint descriptions

Apply `supabase/migrations/202611220008_dropdowns_and_blueprint_stock.sql` once
after migrations 001–007, then push the frontend and reload open browser tabs.
The old Storage board/Activity sub-tabs are removed. Activity Logs is its own
admin-only top-level tab. Catalog category chips remain limited to used categories;
the item-creation dropdown continues to show all configured categories.

Vendor Quality is now a dropdown with an admin-only Create quality option.
Existing quality values are backfilled into the options table and preserved.
A database foreign key rejects unconfigured quality values. Quality changes
remain independent of Storage categories and audit history.

Adding the catalog item named **Blueprint** in category **Blueprint** (case
insensitive) asks for a configured description. Admins create descriptions inline;
members can select existing ones. Descriptions are stored on stock rows, never
on the master item. A storage may hold multiple descriptions with separate
quantities. Moving, removing and Remove all operate on the selected description.
Stock rows show their descriptions; activity and deletion audit include them.

The migration extends the stock primary key with `blueprint_description` and
preserves all existing rows with an empty value (shown as **Unspecified** for old
Blueprint stock). It does not rewrite catalog metadata or existing categories.
The legacy RPC signatures operate only on undescribed stock, so older calls cannot
merge/remove described variants. Use the updated frontend for Blueprint variants.
Normal items continue to use the undescribed stock row. All option tables have RLS
and no direct browser privileges; option creation requires an active admin, while
stock changes continue to require active membership. No new membership group is
created, no inventory is reseeded, and no live migration is executed by Codex.

Frontend fixture checks cover separate Blueprint quantities, cross-storage moves,
variant-specific removal, legacy preservation, dropdown permissions, activity-tab
visibility and unchanged catalog metadata. Live database checks—including migration
preservation, revoked-user rejection and concurrent stock updates—and browser
desktop/mobile checks remain pending.

## Storage and Item Prices tabs

Apply `supabase/migrations/202611220007_item_prices.sql` once before deploying
this frontend. Existing storage functionality sits under **Storage**. **Item
Prices** lists vendors separately, with Item, Quality and Rolls columns (including
values such as `160/252`). Admins create/edit/delete vendors and entries; active
members can only view. Vendor lists start empty; no vendor or screenshot data is
assumed or seeded. Deleting a vendor deletes its price entries after confirmation.

The new tables have RLS and no direct browser privileges. Read RPCs check active
membership; mutation RPCs check active admin status and enforce room-scoped IDs.
Changes are recorded in a separate `rfm_price_activity` table, not Storage history.
The migration does not change inventory or existing membership. Price list scroll
positions survive automatic refreshes. No new login or RFM group is required.

Category dropdowns no longer include Choose category. Create category is first
in the admin creation dropdown; an existing category is selected by default.
The extra header brace has been removed. Frontend fixture tests cover the new
module; database execution and desktop/mobile visual verification remain pending.

## Personal display size

Settings is available to all active members. Display controls scale the interface
from 80% to 150%, with a reset to 100%. The preference is saved in this browser's
local storage and restored on page load. Members see only display settings;
admin management sections and their backend permissions are unchanged. The main
logo is now 80px square at default scale. No SQL migration is needed for this change.

## Configured categories and panel logo

Apply `supabase/migrations/202611220006_categories_and_logo.sql` once before
deploying this frontend. Existing item categories populate the configured list.
Admins create categories through **Create category...** in the new-item category
dropdown. The inline entry preserves the item draft and selected picture, then
selects the newly created category. Main Settings no longer includes category
management; the existing admin-only backend permissions remain unchanged.
Renaming cascades to item categories; deleting an in-use category is rejected.
The database foreign key enforces the configured options for all item writes,
including older clients. With no configured categories, use Create category in the new-item dropdown.

Admin Settings also accepts a JPG/PNG/WebP logo, resized to at most 160px and
stored as a bounded image data URL on the existing RFM room. All signed-in members
see the logo; the unauthenticated Join screen retains the default mark. No file
storage permissions are changed. Logo/category RPCs require an active admin and
record changes in activity history. The profile dialog no longer shows Role;
admins still manage roles through Settings.

Migration 006 has not been applied by Codex. Frontend fixture tests cover category
choices, rename/delete rules, member guards and logo rendering/removal; live SQL
and visual desktop/mobile checks remain pending.

## Short invitation codes

Apply `supabase/migrations/202611220005_short_invite_codes.sql` in Supabase SQL
Editor to issue 12-character uppercase hexadecimal invitation codes instead of
32 characters. Existing invitations are unchanged and remain redeemable. Admin
authorization, default member role, one-time redemption and 14-day expiry remain
unchanged. The unique code constraint handles collisions with bounded retries;
codes are never included in activity log details. No frontend deployment is needed.
The migration has not been executed by Codex.

## Remove all and readable deletion history

Apply `supabase/migrations/202611220004_removal_and_readable_audit.sql` once after
migration 003, then push the frontend. **Remove all** in the removal dialog deletes
the selected item's stock row from that storage using the current database
quantity, and records the removed quantity. It retains the master item and stock
in other storages. Ordinary quantity changes now remove resulting zero-stock rows.

Delete confirmations use the panel's themed modal, including cancellation through
Escape or the backdrop. Deletion history renders names and positive quantities
for both the old text/JSON format and the new structured audit format, without
showing UUIDs or raw JSON. The detailed audit data remains stored in the database.
Entity deletion still physically deletes records and cascades to stock; it does
not merely hide them in the UI. It intentionally preserves activity history.

The owner reports the previously deployed management features are working.
Migration 004 has not been applied by Codex; database execution and browser visual
checks remain pending. The 11 fixture-based frontend tests pass. Unused pagination
state and native confirmation calls were removed; migrations and regression tests
remain useful and are retained.

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

Storage Settings replaces the header plus button. Add stock by dragging catalog items into storages; the separate **Add items**
button has been removed. Existing stock keeps its quantity controls.
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

## Refresh behavior

Automatic updates preserve page, catalog, activity-list and open-modal scroll
positions. Catalog and activity rows use stable IDs to keep the visible row in
place when rows are inserted above it. Already-loaded older logs are fetched again
from the server rather than being discarded or merged from stale cached history.
This frontend update needs no new SQL migration.


### Rank editing (migration 010)

Run `supabase/migrations/202611220010_rank_management.sql` in the existing Supabase project's SQL Editor after migrations 001-009, then deploy the updated frontend. This adds family-rank definitions, member assignments and a separate audit table; it does not change panel roles, existing memberships, stock or Storage history.

In Ranks, admins use the settings icon beside a rank to edit its name and subtitle. Lieutenant and Soldier also support one silent promotion per line. Use **Assign rank** beside an active member to select a family rank and optional promotion; choose **Unassigned** to clear it. Reassign members before removing a promotion they use. Renaming a rank preserves assignments. All active members see the shared roster; revoked members are excluded. Concurrent rank edits require reopening a stale editor instead of overwriting newer changes.

The migration enables RLS and revokes direct browser table access. Its read RPC requires active membership and its write RPCs require an active admin; assignment writes never update `rfm_members.role`. Changes retain actor attribution in `rfm_rank_activity`. Apply and verify these permissions on Supabase before relying on them in production; the local Node tests do not execute PostgreSQL policies.


### Vendor colors, profiles and storage access (migration 011)

Apply `supabase/migrations/202611220011_vendor_colors_profiles_storage_access.sql` after 001-010 before deploying the frontend. Existing qualities retain a neutral white color; new qualities offer white, green, blue, purple, gold or red. Creation and color selection are admin-only. Storage creation is now admin-only, including the legacy API overload; storage-group creation remains available to active members. Any active member can rename their own profile without changing permissions or historical activity attribution. The new profile RPC takes no target-user parameter.

The Ranks tab shows assigned names inside the corresponding rank boxes. The Members list shows names with assignment controls visible only to admins. Nested scrolling stays contained, including vendor tables, activity lists and dialogs.


### Admin-only storage-group creation (migration 012)

Apply `supabase/migrations/202611220012_admin_storage_group_creation.sql` after 001-011 before deploying. Only active admins can create storage groups, superseding the earlier member permission. Existing groups, storages and quantities are unchanged. Members retain inventory quantity controls.

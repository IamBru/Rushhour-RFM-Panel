# RFM Panel — Repository Instructions for Codex

These instructions apply to **this repository only** (`IamBru/Rushhour-RFM-Panel`). Keep this `AGENTS.md` at the repository root so Codex discovers it automatically for work in this project. Do not copy its rules into global Codex settings or other repositories.

## Purpose and live systems

- Product: **RFM Panel**, the invite-only management panel for a single existing RFM group.
- Current section: **Storage**. More independent panel tabs/sections may be added later without creating new RFM groups or requiring existing members to rejoin.
- Repository: `https://github.com/IamBru/Rushhour-RFM-Panel`
- Production site: `https://iambru.github.io/Rushhour-RFM-Panel/`
- Frontend: currently a static `index.html` (HTML/CSS/vanilla JavaScript) using `@supabase/supabase-js` in the browser. Inspect current files before assuming this structure remains unchanged.
- Backend: an **existing production Supabase** project (PostgreSQL RPCs, authentication, file storage, row-level/security policies). Production inventory, members, and logs are real data.
- Deployment: GitHub Pages from the `main` branch at repository root. Keep compatibility with the `/Rushhour-RFM-Panel/` project URL and static hosting.

**Never initialize a second RFM group, reset the existing Supabase project, reseed production inventory, or delete production records as a shortcut.**

## Product rules (must preserve)

- This is **one RFM Panel**, not a multi-group SaaS. Keep the existing internal RFM group for membership and authorization, but do not expose a "Create group" action to visitors or members.
- First-time visitors see only **Join RFM**: a display name plus an admin-issued **one-time invitation code**. No email/password registration is required in the current design.
- Admins issue invitations, can revoke membership, and manage admin roles. New invitations must not grant admin access accidentally.
- The site uses Supabase anonymous authentication for per-browser session IDs. Log actions against a stable membership/user ID with a display name; do not imply that display names alone verify real-world identity.
- Automatically restore an **active** membership if only the browser's saved group selection disappears and the Supabase authentication session remains. Never restore a revoked member. Do not reintroduce "Leave this group view".
- Revocation and all access restrictions must be enforced by Supabase, not merely by hidden UI buttons. Group creation was disabled for website clients at the RPC privilege layer; preserve that protection.
- Keep the dark purple/black theme and simple responsive interface; prefer improving the existing design incrementally over a wholesale redesign.

## Authorization matrix

| Capability | Member | Admin |
| --- | --- | --- |
| See panel, storage locations, master catalog, and item images | Yes | Yes |
| Add/remove/move quantities between storages | Yes | Yes |
| Use an existing catalog item in storage | Yes | Yes |
| Create new **master catalog** item types | No | Yes |
| Upload, replace, or remove item photos | No | Yes |
| Read or export activity logs | No | Yes |
| Download inventory backups | No | Yes |
| Invite, revoke, or manage members | No | Yes |
| Assign/change admin roles | No | Yes |

For every privilege-sensitive change, verify both frontend visibility **and** backend policies/RPCs/storage permissions. Do not assume a hidden button constitutes authorization. Do not widen permissions as a workaround for a failed API call.

## Storage data model and audit behavior

- The **master item catalog** is independent of stock. Creating an item type (e.g., AK-47) must not automatically add it to any storage.
- Storage quantities are per item and per storage location. Adding, moving, or removing quantity must not delete its master catalog entry when stock reaches zero.
- Preserve existing IDs, storage records, quantities, and event history. Avoid duplicate item creation or unintended negative quantities.
- Activity history is **admin-only** and should identify the actor, action, item, relevant locations, quantity before/after where available, and timestamp. Preserve historical attribution even after member revocation.
- Admin-only changes to catalog items/images should remain auditable.

## Code and repository workflow

1. Before editing, inspect `AGENTS.md`, the current files, and relevant call sites. Don't rely on outdated handoff descriptions over actual code.
2. Make the smallest coherent change that meets the user's request. Avoid unnecessary dependencies and do not introduce a framework without explicit approval.
3. Keep the live Supabase configuration working. Browser-side **publishable/anon** keys may be public, but **never** put a database password, `service_role`, `sb_secret_` key, invite codes, personal tokens, or credentials into the repository, logs, screenshots, or generated files.
4. For a frontend change, edit the local repo files. Do not auto-commit, push, deploy, or modify live data unless explicitly requested. The owner normally reviews/commits/pushes via GitHub Desktop.
5. For any database change, create a **separate, incremental, reviewable SQL migration** under a sensible repo folder (such as `supabase/migrations/`, if introduced). Explain how to apply it through Supabase SQL Editor. Never silently execute migrations on production.
6. If the current schema/RLS/RPC definitions are not available, say so; inspect them or request relevant exported definitions before making claims about database security. Don't invent table names or assume a migration is already applied.
7. Preserve GitHub Pages deployment compatibility. Don't require a Node build pipeline just for minor static HTML changes.
8. After changes, explain modified files, behavior, tests performed, any required SQL, deployment steps, and remaining risks. Never claim unrun tests passed.

## Minimum checks for relevant changes

- Visitor: only **Join RFM**; no group creation, no inventory access without valid membership.
- Active member: can view catalog and storage, add/move/remove quantities, but cannot create catalog items, edit photos, read/export logs, or manage membership.
- Admin: can manage catalog items/photos, invitations/roles/revocations, and see logs.
- Revoked user: cannot recover membership or access data via direct backend requests.
- Catalog/stock: new item appears in catalog with zero storage quantity; moving stock updates only locations and maintains correct totals.
- History: verify actor attribution and admin-only read access at the database layer where possible.
- Existing admin: app still reconnects to the existing RFM group after refreshing and survives a missing saved group ID when the auth session persists.
- Test layouts on desktop and narrow/mobile widths where UI is changed.
- If checks require production secrets, another user's session, or a live database, do not simulate success; report that those checks are pending.

## Future panel modules

Add new tabs as distinct sections of the **same RFM Panel** and reuse existing membership/role checks. Keep Storage's catalog, stock, and activity history independent of unrelated modules unless specifically requested. If a larger reorganization becomes appropriate, propose a migration plan first and keep old public functionality working throughout the transition.

## Maintaining this file

Treat these as durable project requirements. Update `AGENTS.md` when a lasting, approved rule or architecture change occurs, not for every small UI tweak. Do not weaken permissions or delete established requirements without owner approval. Keep instructions repository-scoped and actionable.

# 04 — Profiles & Permissions

Login is profile selection: the client lists profiles and the user taps their avatar. No
passwords (product decision). Every subsequent request carries `X-Profile-Id: <uuid>`.

Each profile has a **role**: `parent` or `kid` — an attribute, never hardcoded names.

## Permissions matrix

| Action | Kid | Parent |
|--------|-----|--------|
| Read journal/map/checklist/summaries/games | ✔ | ✔ |
| Create journal posts (publish instantly, no moderation) | ✔ | ✔ |
| Create/join/play/spectate games | ✔ | ✔ |
| Send `location.ping` | ✖ | ✔ (phone) |
| Add/change/remove destinations | ✖ | ✔ |
| Edit config (radii, intervals) | ✖ | ✔ |
| Create/edit profiles | ✖ | ✔ |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| PRO-001 | `GET /api/profiles` lists all profiles (id, name, avatar, role) without authentication — it is the login screen datasource. | auto |
| PRO-002 | Parents can create profiles via `POST /api/profiles` (name 1–40 chars, avatar emoji, role); kids receive 403. | auto |
| PRO-003 | Profile role is a data attribute; permission checks read the role of the profile in `X-Profile-Id` at request time (role changes take effect immediately). | auto |
| PRO-004 | Requests to protected routes with a missing or unknown `X-Profile-Id` receive 401. | auto |
| PRO-005 | Parent-only routes (destinations write, config write, profile write) return 403 for kid profiles, with a machine-readable `error.code = "parent_required"`. | auto |
| PRO-006 | Kids' journal posts publish instantly — there is no moderation queue or pending state anywhere in the pipeline. | auto |
| PRO-007 | Profile create/update emits `profile.created` / `profile.updated` events. | auto |

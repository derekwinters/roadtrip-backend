# 04 — Profiles & Permissions

Login is profile selection: the client lists profiles and the user taps their avatar. No
passwords (product decision). Every subsequent request carries `X-Profile-Id: <uuid>`.

Each profile has a **role**: `parent` or `kid` — an attribute, never hardcoded names.

## First-run bootstrap

A fresh install has zero profiles, so nobody can authenticate and PRO-002 would deadlock
setup. While the profiles table is **empty**, `POST /api/profiles` is therefore allowed
without authentication — but only to create a **parent** (a kid-first install would deadlock
the same way). The moment one profile exists, the parent-only rule applies again. The
emptiness check is race-safe: concurrent first-creates produce exactly one bootstrap profile.
The bootstrap `profile.created` event is recorded with a null actor (there is nobody to
attribute it to).

When an unauthenticated create is refused because profiles already exist (a lost race, a
retried request whose first attempt actually committed, or a client mid-first-run against a
family server that is no longer empty), the 401 keeps the stable `unauthenticated` machine
code but its message must say what actually happened — profiles already exist and a parent
must sign in to add more — never the generic "Unknown or missing profile", which misleads
first-run clients into blaming their own identity handling.

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
| PRO-008 | When zero profiles exist, `POST /api/profiles` is permitted without authentication and the created profile must have the parent role (400 `validation` otherwise); the moment one profile exists the parent-only rule (PRO-002) applies unchanged (401/403). The first-create check is race-safe: concurrent bootstrap attempts yield exactly one profile. An unauthenticated create refused because profiles already exist answers 401 `unauthenticated` with a message stating profiles exist and a parent must sign in to add more — not the generic missing-profile message. | auto |

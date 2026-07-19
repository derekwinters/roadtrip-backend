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

When an unauthenticated create is refused because creation is closed (profiles exist and
`open_profile_creation` is off — a lost race against the toggle, or a client mid-first-run
against a locked-down family server), the 401 keeps the stable `unauthenticated` machine
code but its message must say what actually happened — profile creation is turned off and a
parent must sign in to add family members — never the generic "Unknown or missing profile",
which misleads first-run clients into blaming their own identity handling.

## Open profile creation

Family reality: new members join at a rest stop, kids get devices mid-trip, and nobody wants
to fetch a parent to type a name. While the `open_profile_creation` config flag is **true
(the default)**, `POST /api/profiles` is open to everyone once the family exists: requests
without a profile header succeed (the `profile.created` event carries a null actor) and kid
profiles may create too (event attributed to them). Any role may be created — this is a
trusted-family surface; the parent-flippable flag is the recourse, not a role check. Turning
the flag **off** restores the strict rules exactly (PRO-002: parent-only, kids 403,
unauthenticated 401). The zero-profiles bootstrap (PRO-008) is unaffected by the flag in both
directions, and profile **updates** stay parent-only regardless (PRO-005).

## Permissions matrix

| Action | Kid | Parent |
|--------|-----|--------|
| Read journal/map/checklist/summaries/games | ✔ | ✔ |
| Create journal posts (publish instantly, no moderation) | ✔ | ✔ |
| Create/join/play/spectate games | ✔ | ✔ |
| Send `location.ping` | ✖ | ✔ (phone) |
| Add/change/remove destinations | ✖ | ✔ |
| Edit config (radii, intervals) | ✖ | ✔ |
| Create profiles | ✔ while `open_profile_creation` is on (default); ✖ when off | ✔ |
| Edit profiles | ✖ | ✔ |

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| PRO-001 | `GET /api/profiles` lists all profiles (id, name, avatar, role) without authentication — it is the login screen datasource. | auto |
| PRO-002 | Parents can create profiles via `POST /api/profiles` (name 1–40 chars, avatar emoji, role); kids receive 403 while `open_profile_creation` is off (when on, PRO-009 opens creation to them). | auto |
| PRO-003 | Profile role is a data attribute; permission checks read the role of the profile in `X-Profile-Id` at request time (role changes take effect immediately). | auto |
| PRO-004 | Requests to protected routes with a missing or unknown `X-Profile-Id` receive 401. | auto |
| PRO-005 | Parent-only routes (destinations write, config write, profile update via PATCH — profile create is governed by PRO-002/PRO-009) return 403 for kid profiles, with a machine-readable `error.code = "parent_required"`. | auto |
| PRO-006 | Kids' journal posts publish instantly — there is no moderation queue or pending state anywhere in the pipeline. | auto |
| PRO-007 | Profile create/update emits `profile.created` / `profile.updated` events. | auto |
| PRO-008 | When zero profiles exist, `POST /api/profiles` is permitted without authentication and the created profile must have the parent role (400 `validation` otherwise) — regardless of `open_profile_creation`; the moment one profile exists the PRO-002/PRO-009 rules take over. The first-create check is race-safe: concurrent creates are serialized so the first committed profile is always a parent; while creation is closed concurrent bootstrap attempts yield exactly one profile, and while open the bootstrap loser proceeds as an ordinary open create (PRO-009). An unauthenticated create refused because creation is closed answers 401 `unauthenticated` with a message stating profile creation is turned off and a parent must sign in — not the generic missing-profile message. | auto |
| PRO-009 | While `open_profile_creation` is true (the default) and at least one profile exists, `POST /api/profiles` succeeds without authentication (the `profile.created` event carries a null actor) and for authenticated kid profiles (event attributed to them), with any role permitted in the body; while false, the parent-only rules (PRO-002/PRO-008) apply exactly. Profile updates (PATCH) remain parent-only in both states (PRO-005). | auto |

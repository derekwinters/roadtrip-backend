---
name: routines
description: Create or update this repository's Claude Code routines (scheduled and API-triggered prompts such as triage and the weekly Dependabot sweep) from ai-sdlc's definitions, so they match `routines:` in .ai-sdlc/repo-config.yml. Use when setting up routines for a repository, when a routine's prompt or schedule has drifted, or when asked what routines a repository should have.
allowed-tools: Bash, Read
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/substrate/routines
github-tree-sha: 881b3590907a7dd08e4ef74bdad4821ed1dc8e7d
---

# Routines

A routine is a saved prompt Claude Code runs in a fresh cloud session when a schedule or an API
trigger fires it. ai-sdlc keeps the definitions in `definitions/` beside this file. The repository
lists the ones it wants under `routines:` in `.ai-sdlc/repo-config.yml`; that list is the
repository's own, and nothing here adds to it.

You make the live routines match the plan. You do not decide what the plan says.

## Where this runs

Run this from a **Claude Code cloud session in the target repository**. Only those sessions have
the `list_triggers`, `create_trigger` and `update_trigger` tools. If you do not have them, stop and
say so: there is no API to fall back on, and a routine typed in by hand is the drift this exists to
end.

## 1. Plan

From the repository root:

```bash
python3 .claude/skills/routines/main.py plan
```

It reads the configuration and the repository's name (`--repo owner/name` overrides) and prints a
JSON plan: for each routine its exact `name`, `prompt`, `cron` (or `null`), whether it needs an
`api` trigger, its `connectors`, and its `manual_tasks`. It writes nothing.

If it exits non-zero it prints every problem — an unknown routine, a routine whose capability is
not installed, a bad placeholder. Report them and stop. Never work around a refusal by editing the
plan or a prompt by hand.

An empty `routines` list means the repository has asked for none. Say so, and that the list is
`routines:` in `.ai-sdlc/repo-config.yml`.

## 2. Match

Call `list_triggers` with `include_completed` true, so a routine that has finished a run-once is
still seen. Match each planned routine to a live one by **exact name** — the rendered `name` from
the plan, character for character. Nothing else identifies a routine.

Each planned routine is then one of:

| Live routines with that name | Action |
| --- | --- |
| none | **create** |
| one, prompt and schedule identical | **leave alone** |
| one, prompt or schedule differs | **update** that routine, by its `trig_` id |
| more than one | **report and leave alone** — you cannot tell which is meant |

A live routine that is not in the plan is left alone. Never delete a routine — not one missing
from the plan, not a duplicate, not one you created by mistake. Report it instead.

## 3. Confirm

Show the operator the plan before writing anything: each routine's name, whether it will be
created, updated or left alone, its schedule, and for an update what changes. Show the full prompt
of anything being created or updated. Then ask them to confirm, and write nothing until they do.

## 4. Write

For a routine to **create**, call `create_trigger` with:

- `name`, `prompt` and `cron_expression` exactly as the plan gives them (omit the cron when it is
  `null` — such a routine is fired only through its API trigger);
- `create_new_session_on_fire` true;
- `initiation` `human_request`;
- `connectors` exactly as the plan declares them — `[]` when it declares none, never a connector
  you think might help.

For a routine to **update**, call `update_trigger` with the matched routine's `trig_` id and the
plan's prompt and cron.

Never create a second routine with a name that already exists. If a create reports a name
conflict, list again and treat it as an update.

## 5. Hand over

Give the operator every entry of every routine's `manual_tasks`. They are the steps no tool can
take:

- **An API trigger** — added on the routine's page in the web UI, with its token generated there
  and shown once. The URL and token go into the repository secrets the plan names (from
  `fire.endpoint_secret` and `fire.token_secret`), which is how the gatekeeper fires triage.
- **The repository** — confirm it is attached on the routine's page, and attach it there if not.
  Whether `create_trigger` attaches it is not something you can check.

Never write a routine's URL, its token, or a session link into a file, an issue, a comment or a
commit. Say that a routine was created or updated, by name.

Specification: `docs/spec/routines.md` (`RTN`).

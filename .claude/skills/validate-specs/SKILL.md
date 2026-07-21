---
name: validate-specs
description: Validate a spec-driven repo's requirement tables — unique IDs, every `auto` requirement covered by a real test reference, and resolvable doc links. Portable (stdlib Python, no pip), so it runs in Node, Kotlin, Python, C#, or docs-only repos. Use before opening a PR that touches docs/spec, or when wiring the spec gate into CI.
---

<what-to-do>

## What this enforces

Spec-driven repos declare each behavior as a **requirement row** in their spec
docs (`docs/spec/**`, or `docs/**`):

```
| AREA-NNN | short description of the behavior | auto |
```

The third column is the **verification tag**. There are exactly three, and this
is the canonical vocabulary — do not use "Testable" / "Manual":

| Tag | Meaning | Coverage rule |
|-----|---------|---------------|
| `auto` | verified by an automated test | MUST be referenced by name in a test file |
| `manual` | verified by a human | no test reference required |
| `planned` | specced but not built yet | reported, not enforced |

`validate_specs.py` (next to this file) runs three core gates:

1. **Unique IDs** — a requirement ID defined in two places fails the build.
2. **`auto` ⇒ covered** — every `auto` requirement must be referenced *by its
   exact ID, on a word boundary,* in at least one test file under the configured
   test dir(s). A loose substring elsewhere (e.g. `AREA-0012` covering
   `AREA-001`, or a mention in prose) does **not** count — this is stricter than
   the original roadtrip validators on purpose.
3. **Links resolve** — every relative markdown link in the spec docs points at a
   file that exists.

A fourth, **API-contract** gate (e.g. OpenAPI vs. implemented routes) is
language-specific and stays in each repo's own richer validator
(`scripts/validate-specs.*`). This skill is the portable floor those richer
validators build on.

## This repo's settings (from `registry.yml` config)

- Spec directory: `docs/spec`
- Test source dir(s) / globs: `test scripts`
- Requirement-ID prefix (area namespace): `AREA`

Any value above that renders blank is not configured for this repo; the
defaults below apply.

## Running it

```bash
# Defaults: --spec-dir docs/spec (falls back to docs/ then .),
# a built-in set of common test suffixes, and whatever --test-dir you pass.
python .claude/skills/validate-specs/validate_specs.py \
  --spec-dir docs/spec \
  --test-dir <test-dir> [--test-dir <another>] \
  [--suffix .ts --suffix .kt ...]
```

- `--spec-dir` — where the requirement tables live (default `docs/spec`).
- `--test-dir` — repeatable; the directories scanned for `auto` ID references.
  Point these at the values in `test_globs` above.
- `--suffix` — repeatable; restrict which files count as tests. Defaults cover
  `.ts .tsx .mjs .js .kt .kts .py .java .cs .go`.

Exit code `0` = all gates pass; `1` = one or more failures, each printed as a
`x <problem>` line.

## When to use

- Before opening any PR that adds or changes `docs/spec/**` — new `auto` rows
  need a referencing test in the same PR (spec → test → implement).
- As a CI step. Repos with a richer native validator
  (`npm run validate:specs`, `./scripts/validate-specs.sh`) keep it; this
  portable script is the fallback for repos that don't have one yet.

## Notes

- The script is **stdlib-only** — no `pip install`, no Node, nothing to build.
- It does not fix anything; it reports. Add the missing test reference, fix the
  duplicate ID, or repair the link, then re-run.
- Requirement ID grammar: `AREA-NNN` where `AREA` is upper-case letters/digits
  and `NNN` is 3+ digits (e.g. `LOC-006`, `ANDLOC-011`).

</what-to-do>

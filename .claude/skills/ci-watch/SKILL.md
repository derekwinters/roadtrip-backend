---
name: ci-watch
description: Poll a pull request's checks until they complete, then report pass or fail with log excerpts for failures. Use when waiting on CI before merging, or when a check's outcome needs reading. It reports and never fixes.
allowed-tools: Bash, Read
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/pipeline/ci-watch
github-tree-sha: 31042581c0bd1a9ac6ce9f1c4096f637cef9f6ec
---

# CI watch

Watches a pull request's checks to completion and tells you what happened.

**It reports; it never fixes.** No pushes, no re-runs, no label changes. A watcher that also
repairs is one whose reports you cannot trust — a green result would no longer distinguish "the
change was good" from "the watcher patched it".

## Five outcomes, and only one is good

| Outcome | Meaning |
| --- | --- |
| `passed` | every check succeeded, was skipped, or was neutral |
| `failed` | at least one check failed, was cancelled, or timed out |
| `timed-out` | checks were still running when the deadline or attempt cap was reached |
| `no-checks` | the pull request has no checks at all |
| `unreachable` | the API could not be read after repeated attempts |

The last three are deliberately **not** `failed` and deliberately **not** `passed`. Each is a
different problem with a different response, and collapsing them into "failed" sends you looking
for a bug that isn't there. Collapsing them into "passed" merges on no evidence.

`no-checks` matters more than it looks: nothing having run is not the same as everything having
passed.

## Cancelled counts as failed

`skipped` and `neutral` mean a check chose not to judge, so they don't fail the run. `cancelled`
and `timed_out` are different: neither passed, and treating them as neutral hides a run somebody
killed.

## Failure detail

Failed checks carry a **bounded excerpt from the end of the log**, which is where the failure
usually is. Passing checks are not fetched — it costs a request and tells nobody anything. A log
that cannot be read is reported with its reason rather than being dropped: a check missing from a
failure report reads as a check that passed.

**Check names are reported exactly as the API gives them** — `closing-keyword / closing-keyword`,
not a prettified version. A name that doesn't match the API can't be used to configure a required
check, which is the main thing you'd want it for.

## Bounds

Polling stops at a deadline *and* at an attempt cap. Both, because a mis-set clock would defeat
either one alone. The interval is configurable and defaults to something that does not hammer the
API.

Specification: `docs/spec/ci-watch.md` (`CIW`), 23 requirements.

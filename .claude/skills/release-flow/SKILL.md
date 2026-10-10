---
name: release-flow
description: Drive release-please's release pull request to a tagged release — find it, check it is safe to merge, compose the squash title, and verify the tag and release afterwards. Use at release time, or when a release did not produce the tag it should have.
allowed-tools: Bash, Read
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/release/release-flow
github-tree-sha: ab7385d5a303a9ef07b9acd565e12f3cc054fcbf
---

# Release flow

Releases are rare enough that nobody remembers the gotchas, and the gotchas produce a silently
wrong version rather than an error. This is them, written down.

## Never reopen the release pull request

Closing and reopening looks like a harmless way to restart parked checks. It **loses the review,
loses the approval, and can lose the pull request's association with the release it was going to
cut**.

When checks need attention this flow **halts** and tells you what is wrong and what would resolve
it. You decide. There is no code path here that could toggle a pull request's state — the module
is pure, and every write belongs to the caller.

## The squash title is composed, never inherited

```
chore(main): release 0.4.0
```

That title is the one commit release-please parses to compute the **next** version. A pull request
retitled by hand — or by a well-meaning bot — silently breaks the *next* release, not this one,
which is why it's built from the version rather than taken from whatever the pull request is
called.

## Finding it

By **branch** (`release-please--branches--…`), never by title. Anyone can write a title that looks
like a release; the branch is release-please's.

- No release pull request open is a clean outcome — there may be nothing to release.
- Two open is refused, naming both. Guessing which to merge is not acceptable.

## Before merging

The flow refuses while any check is failing or still running — and refuses when there are **no
checks at all**. Nothing having run is not the same as everything having passed.

## A milestone reserves its version

`v0.4 — Adoption` closes when 0.4.0 releases, so an open milestone with open issues holds its
number. A release proposing that version is refused, naming the milestone — a version cannot be
un-released, and spending `0.5.0` on unrelated work leaves `v0.5 — Fleet` with no number of its
own. Only the minor is held: the escape is a patch of the current version.

## Making a tag match a milestone

```
Release-As: 0.4.0
```

`v0.4` the milestone, `v0.4.0` the tag. Without this, accumulated `feat:` commits compute
something higher and the two stop corresponding. Going backwards is refused.

## Afterwards

The tag, the GitHub release and the recorded version are all confirmed, with a brief retry —
tagging follows the merge by a moment. A missing tag is reported as an **incomplete release**,
distinct from a failed merge: "the merge succeeded" and "the release happened" are different
claims.

## When there are no tags at all

A repository can carry `chore(main): release X.Y.Z` commits and no tags — release-please writing
the version files through merged pull requests, but never getting as far as tagging. With no tag
to compute from, its next run proposes the entire history as one release.

The `backfill-tags` workflow repairs that. Run it from the Actions tab; it defaults to a dry run
that prints the plan and creates nothing, and applying is a second, deliberate run. The plan comes
from the commit history rather than a list somebody typed, so it stays correct after the next
release, and an already-tagged version is skipped — running it twice does nothing the second time.

Specification: `docs/spec/release.md` (`REL`), 37 requirements.

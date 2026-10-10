---
name: pipeline-dev
description: Build the development queue from approved issues and claim one for work. Use when deciding what to build next, when claiming an issue, or when working out why an approved issue is not being picked up.
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/pipeline/pipeline-dev
github-tree-sha: fe18adb91fd423c8f22260b18c770dd6c412e410
---

# Development queue

Which approved issue gets built next, and claiming it. Every read and write here goes through
`github-api`; this skill says what to read, how to order it, and what to check before writing.

The label names are the repository's, not fixed strings — read them from `.ai-sdlc/repo-config.yml`
rather than assuming the defaults.

## Eligibility is derived, every time

An issue is eligible when **all** of these hold:

- it carries the **approved** state label;
- it is **open** — a closed issue is never eligible;
- it is **not parked**;
- it is **not already building** — that one is taken;
- it has **no open pull request** — the work exists already;
- **every hard blocker is resolved**, computed from the dependency graph at the moment the queue
  is built (`issue-blockers`).

An issue with an **unknown** blocker is not eligible. Not knowing whether the thing it depends on
is finished is not the same as it being finished.

That last pair is why there is no blocked label. An issue whose blocker closed becomes eligible on
its own, with nothing having noticed or updated it. Storing blockedness would mean maintaining it,
and maintaining it is what the deleted revisit sweep did.

## Hard blockers gate; soft dependencies only order

| | Effect |
| --- | --- |
| Native blocked-by | the issue is **not eligible** until it resolves |
| `Depends on: #N` | eligible regardless, but built **after** what it follows |

Conflating them either stalls work that could proceed, or builds things in the wrong order.

**A soft dependency on an ineligible issue does not remove the dependent from the queue.** If #7
says `Depends on: #8` and #8 is not eligible, #7 still runs — it was a preference about order, and
the thing to order against is not there.

## Ordering

Topological on soft dependencies first, then the focus milestone, then issue number.

**A dependency always beats the focus preference.** Building a dependent before its dependency is
wrong in a way that "wrong milestone first" is not.

Issues with no ordering relationship between them keep **issue-number order**, so two runs over the
same board produce the same queue.

**A cycle among soft dependencies degrades to issue-number order.** Dropping the issues would hide
work, and following the loop would hang the run; ordering them arbitrarily-but-stably is the only
answer that does neither.

## The cap

The concurrency cap limits the queue, and **issues already building count against it** — a cap of
2 with one in flight yields one issue. A cap already met yields an **empty queue, not an error**.
No cap configured means no limit.

**When the cap truncates, say how many were left.** A silent cap makes a partial run look like a
complete one, which is the difference between "there is nothing to do" and "there is plenty and I
stopped".

## Claiming

Move the issue to the **building** state and work on `claude/issue-<number>`. The branch name
derives from the issue number so the association is recoverable from the branch alone — one found
months later with no pull request still says what it belongs to.

**Re-check eligibility immediately before writing.** The queue was built from a snapshot; between
building it and acting on it the owner may have parked the issue, another builder may have taken
it, or it may have closed. Taking on stale information is how two builders end up on one issue.
If it has moved on, refuse and say what it moved to.

**One issue at a time.** The builder never holds two.

Replacing the state label means removing the state label it had, not adding beside it. Labels are
written as a whole list, so read the current set, drop any pipeline state in it, add the new one,
and write that.

Specification: `docs/spec/development.md` (`DEV`).

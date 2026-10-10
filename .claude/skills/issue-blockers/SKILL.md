---
name: issue-blockers
description: Record, remove and read native GitHub issue dependency relationships, and spot dependencies written as prose where the pipeline cannot see them. Use whenever one issue must finish before another may start, when checking why an issue is not eligible for work, or when an issue body says "blocked by" in words.
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/pipeline/issue-blockers
github-tree-sha: da293cf939c381512d18056af81fbac3eb229248
---

# Issue blockers

GitHub's issue-dependency API has **no MCP tool**. Nothing hands you a helper for it either — this
skill is instructions, and the reads and writes are yours to make through `github-api`.

That absence is why dependencies in these repositories were historically written as prose in issue
bodies, where the queue cannot see them and the builder starts the issue anyway.

## Three kinds of reference, and only one is a gate

| Form | Meaning | Effect |
| --- | --- | --- |
| Native blocked-by | a hard gate | the issue is ineligible until it resolves |
| `Depends on: #N` | an ordering hint | orders the queue, never gates it |
| `Blocked by #N` in prose | **drift** | found, reported, never honoured |

The third is deliberate. Honouring a prose blocker would make the invisible-to-tooling form work,
and it would stay. Report it so it can be converted, and treat the issue as unblocked meanwhile.

## Recording a blocker

`add_blocked_by` and `remove_blocked_by` are the operations. **Both take the blocker's database
`id`, not its issue number** — read it with `issue_id` first. Both are integers, so the wrong one
succeeds silently against nothing or against some other issue entirely. This shipped once and was
found in production.

Before recording one, check three things:

1. **An issue may not block itself.** Refuse it; the request is meaningless.
2. **The edge must not close a cycle.** Walk blocked-by from the proposed blocker and see whether
   you can reach the issue you are about to block. If you can, refuse and **draw the path** —
   `#50 → #42 → #17 → #50`. Two issues each waiting for the other are both permanently ineligible,
   and that is miserable to diagnose after the fact rather than at the moment it is created.
3. **Whether it already exists.** Recording one that is already there is a no-op, not an error, and
   so is removing one that is not there. Both are safe to repeat.

**A diamond is not a cycle.** Two issues may both depend on the same third one, and the traversal
must not mistake the second visit for a loop. Track what you have already walked, not what you
have already seen at this depth.

The walk is genuinely iterative: you cannot know which issue to read next until you have read the
last one. Read one hop at a time and follow it.

## Reading a body

`Depends on: #N` is the soft form. Read it from the issue body, and:

- several numbers on one line are all dependencies, and so are several lines;
- the phrase is case-insensitive and tolerates trailing punctuation — `Depends on #42` counts;
- a plain `#42` in ordinary prose is **not** a dependency. "See #42 for background" orders nothing;
- anything inside a fenced code block is an example, not a statement. Ignore it.

`Blocked by #N` in prose is read by exactly the same rules, and produces a drift report rather than
a blocker.

## Eligibility

An issue is eligible when **every hard blocker is resolved** — closed, or merged. One unresolved
blocker is enough to make it ineligible, and when you say an issue is ineligible, **name the
blockers responsible**. "Blocked" without a number is a message that sends somebody looking.

**An unknown blocker counts as unresolved.** If you could not read a blocker's state, you do not
know whether the thing depended on is finished, and that is not the same as it being finished.

A read that fails is not an empty result. Empty means "nothing blocks this", which would make
blocked work eligible; say the read failed instead.

## Blockedness is never stored

There is no blocked label, and there never will be. Eligibility is computed from the graph at the
moment it is needed, which is what keeps it correct with nothing maintaining it. An issue whose
blocker closes becomes eligible on its own — nothing has to notice.

Specification: `docs/spec/blockers.md` (`BLK`).

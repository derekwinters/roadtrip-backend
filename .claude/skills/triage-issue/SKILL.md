---
name: triage-issue
description: Turn an admitted issue into a plan the owner can approve, or a question the owner must answer, and route it to the right state with a hand-back comment. Use when triaging an issue, when selecting which issues are due for triage, or when working out why an issue is sitting in triage rather than moving on.
allowed-tools: Read, Grep, Glob
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/pipeline/triage-issue
github-tree-sha: 59fcafdeb36095da4ee6a606e2ed1fe4bc67f498
---

# Triage an issue

Triage is the one place in the pipeline where judgement is required rather than a rule followed.
Everything around it is pinned down so the judgement is confined to the part that needs it.

Every read and write goes through `github-api`. The label names are the repository's — read them
from `.ai-sdlc/repo-config.yml` rather than assuming the defaults.

## Three outcomes, and only three

| Outcome | Goes to | When |
| --- | --- | --- |
| **Plan** | `pending-approval` | the specification says what should happen, and you can say how to verify it |
| **Question** | `needs-clarification` | something is genuinely undecided |
| **Failure** | stays in triage | you cannot act on it at all |

There is no fourth option, and in particular **no outcome that queues work**. Triage proposes; the
owner approves. **Triage never writes the approved or building states** — not as a shortcut for an
obvious issue, not for one it wrote the plan for itself.

**Routing writes exactly one state label.** Labels are written as a whole list, so read the current
set, drop any pipeline state in it, add the one you are routing to, and write that. Adding beside
the old one leaves an issue in two states, and everything downstream then picks whichever it saw
first.

**Report the routing decision.** A run whose outcome can only be recovered by reading issue bodies
afterwards is a run nobody audits.

## Selecting what to triage

An issue is eligible when it is **queued for triage or already running**. Both, because a session
that died mid-run left the running label behind and the issue would otherwise never be picked up
again.

Not eligible:

- **stalled** — the sweep gave up on it deliberately, and only a person restarts it;
- **closed**;
- **parked**;
- **already at pending approval** — its plan is waiting on a human;
- **an epic** — its children are the work.

Order by **issue number**, so a run is reproducible, and **cap** the selection. When the cap
truncates, say so: a silent cap makes a partial run look like a complete one.

**Eligibility is computed from labels alone. Never read issue bodies to decide it** — otherwise an
issue could talk its way into or out of the queue by what it says about itself.

## Never invent a design decision

Where the specification is silent about what something should do, **ask**. A plan that quietly
decides a question nobody asked is worse than no plan, because it looks like an answer and gets
approved as one.

A question must state **what is undecided and what the options are**, offer **at least two**, and
**must not recommend one** — a question with a recommendation is a decision wearing a question
mark. One option is not a question; refuse it and write two.

**Name who must answer.** A question addressed to nobody sits until somebody happens to look.

**A question that could be answered from the specification is not a question**, it is unread
specification. Go and read it.

## What a plan must contain

- A **plain-English summary** first, before any file or class name. Someone should be able to tell
  what is wrong from the first two sentences.
- A **proposed milestone**.
- **Acceptance checks** — a plan with none is refused. A plan nobody can verify is a wish.
- The **specification pages** it affects, or an explicit statement that none change.
- If it changes what a page *says*, **how it changes**: what it used to say, what it now says, and
  why the new one is better.

## Handing back

**Every routed issue gets a comment describing the outcome, and saying what happens next** — the
commands available, and who they are for. An issue that changed state with no explanation is one
whose owner has to reconstruct why.

**One comment per routing, not one per run.** A run that re-examines an issue it already routed
adds nothing; repeating the comment turns the issue into a log.

**A failed triage leaves the issue in triage** and reports the failure. It does not route it
somewhere convenient — moving it out of triage would say something was decided, and nothing was.

Specification: `docs/spec/triage.md` (`TRI`).

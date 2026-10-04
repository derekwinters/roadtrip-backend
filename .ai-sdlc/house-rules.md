# ai-sdlc: derekwinters/ai-sdlc@v0.4.22 hash=f1e96c1610bce615
# Managed by `adopt`. Local edits are preserved but stop this file
# being updated — `adopt verify` will report it.
# House rules

Shared across every repository that has adopted ai-sdlc. Maintained in one place; your
repository's own `CLAUDE.md` holds everything specific to it.

Where CI enforces a rule, this says so and names the check. The rules here that CI *cannot* check
are the ones that need you to have read them.

**ai-sdlc owns this repository's issues, labels, milestones, triage, pull-request gates and
releases.** What is installed here and at which version is in `.ai-sdlc/adoption.md`, what this
repository decides for itself is in `.ai-sdlc/repo-config.yml`, and the `ai-sdlc` skill has the
detail. Read them before changing any of those things or any document describing them — the rules
are not in this repository, so what you find here is a caller, not the mechanism.

## Commits and pull requests

**Every commit on the default branch is a Conventional Commit.** Pull requests merge by squash, so
**the squash title is the commit** release-please parses — not a separate message written later. A
title it cannot parse produces no version bump and no changelog entry, and the change ships
unaccounted for. *Enforced: `pr-title-lint`.*

Pick the type for the actual impact of the change, not for whichever word the branch used. A new
user-facing capability is `feat:` even when it also fixes something.

**One issue, one branch, one pull request.** A pull request closing four issues is not reviewable,
and cannot be reverted for one of them. *Enforced: `closing-keyword` requires exactly one closing
keyword.*

## Writing a pull request

Open with a **plain-English lead** — two or three sentences saying what changed and why, before any
file name or class name. Someone should be able to tell what happened without reading the diff.

Then **`## Deviations and Decisions`**, always present, `None.` when empty. Include an item only if
a reviewer knowing it might act differently — object, adjust, or follow up. Exclude what the diff
already shows, what the conventions already endorse, and routine test structure. A short list is
the normal outcome.

Then a **`**Docs:**` line** saying what documentation changed, or why none was needed.
*Enforced: `docs-gate`.*

## Building

**Specification before code.** Write or amend the specification for what you are about to build,
with a requirement identifier per behaviour. Where something could be built in a way that is
technically correct but wrong, state an **invariant** — a short imperative sentence constraining
how it may work — so the bad implementation is excluded before it is written rather than argued
about afterwards. *Enforced: the spec↔test traceability gate.*

**A failing test before the implementation, and you watch it fail.** If it fails for the wrong
reason, the test is wrong. If you did not see red, you do not know the test tests anything.

**Reconcile the documentation you affected in the same pull request.** A design contract that lags
the code by three pull requests is not a contract.

## Judgement

**Ask rather than invent a design decision.** Where the specification is silent about what
something should do, stop and ask. A plan that quietly decides a question nobody asked is worse
than no plan, because it looks like an answer and gets approved as one. Offering options is
helpful; recommending one is deciding.

**Do not weaken a test to make it pass.** If a test is wrong, say that it is wrong and why.

**Do not widen the scope.** The issue is the deliverable. "While I was in there" belongs in another
issue.

**Do not mark an acceptance check done that you have not verified.**

**Never publish a private link.** Session links, signed URLs, invite and share links, anything
carrying a token in a query string — none of it goes into a workflow log, an issue, a pull request,
a commit message, or a comment. These repositories are public, so all five are publications, and an
identifier published once cannot be unpublished. The test is not "is this a credential" but "would
I post it in public", and a link that exists to reach something private fails that test whether or
not a login stands behind it. Say *that* the thing happened and let whoever owns it look it up:
"fired the analysis routine" is as useful as the link and costs nothing.

This applies to text you did not write. Error messages, response bodies, and stack traces quote the
values they were handed, so a branch that reports a raw body needs redaction rather than trust —
which is why a leak usually survives deleting the line that was leaking on purpose.

**Read back what was actually published.** After opening a pull request, filing an issue, or leaving
a comment, fetch the stored text and check it against what you sent. Tooling rewrites and appends:
an attribution footer written as a plain link has been rewritten on the way in to carry a session
identifier, on every pull request created, in more than one repository — and omitting the footer
entirely did not prevent it, because it is **appended after** the author has finished. Nothing you
wrote was wrong and the private link is published anyway, which is exactly why writing carefully
cannot be the whole rule. Only looking afterwards catches it, and editing it out afterwards is what
fixes it.

## Work only a human can do

Repository settings, secrets, external accounts, physical devices, and taste calls are not yours.
File **one small issue per task**, saying the single action needed and how to verify it, then
finish everything that does not depend on it and say in the pull request what you left out.

One task per issue. An issue titled "various setup needed" is an issue nobody ever finishes.

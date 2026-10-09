---
name: github-api
description: How to read and change anything in GitHub safely — read an issue, move a label, set a milestone, post a comment, record a blocker, retire a label. Use before any GitHub read or write, including through MCP tools or the API directly. States what may be done, what may not, and the identity and pagination rules that silently produce wrong answers.
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/substrate/github-api
github-tree-sha: 6b8d6b9ca287d189ddf6a1336de9eb539620b389
---

# GitHub access

Every read and every write goes through the vocabulary below. There is one statement of these
rules and two things implement it: **you**, using whatever GitHub tools you have, and
`lib/github.py`, which is the only module in this repository that opens a socket.

The module's constraints are enforced by the absence of a method. Yours are not enforced by
anything, which is why they are written down.

## The vocabulary

Anything absent here is absent **by design**. A command set able to do irreversible things
eventually does one by accident.

<!-- vocabulary -->
```yaml
reads:
  - issue
  - issues
  - comments
  - reactions
  - milestones
  - blocked_by
  - labels
  - issue_id
writes:
  - set_labels
  - set_milestone
  - set_body
  - comment
  - react
  - unreact
  - add_blocked_by
  - remove_blocked_by
  - create_milestone
  - update_milestone
  - create_label
  - update_label
  - delete_label
forbidden:
  close_issue: an issue closes because its pull request merged, and nothing else
  reopen_issue: the same rule, from the other side
  delete_issue: irreversible, and unnecessary — close as not planned instead
  delete_comment: someone said something; tidying a conversation is worse than an untidy one
  merge_pull_request: a merge is a person's decision
  delete_branch: cheap to keep, not always cheap to lose
  delete_milestone: it records what shipped when; update_milestone can close one instead
```

`delete_label` is the one deletion, and it is deliberate: a label taxonomy needs to be able to
retire a name. It is guarded by the manifest's explicit delete list rather than being reachable
from ordinary use, and it is the exception that shows the rule.

`set_body` is the one body edit. Use it to write a generated section into an issue — never to
rewrite what a person wrote.

## Closing an issue

**You do not close an issue.** Neither does the pipeline. An issue closes because a pull request
carrying `Closes #n` merged, which is why every pull request must carry exactly one such keyword.

If you believe an issue should be closed and no pull request will close it — it is a duplicate,
it is obsolete, it was a question that got answered — say so and leave it open. Closing it
yourself removes the one signal a person would have used to disagree.

## The identity rule

**GitHub's dependency API takes an issue's database `id`, not its `number`.** Both are integers,
so passing the wrong one silently succeeds against some other issue entirely, or against nothing.

`add_blocked_by` and `remove_blocked_by` take the blocker's database id. Read it first —
`issue_id(number)` exists for exactly this — and never pass a number you saw in a title, a URL,
or a `#123` reference. This defect shipped and was found in production (#155).

Everything else in the vocabulary takes a number.

## Pagination and truncation

A collection read is paginated, and it stops at a page cap so a malformed cursor cannot loop
forever. When it stops early the result says so.

**Never report a count from a partial read.** If you read one page and say "there are 30 open
issues", you have stated something you did not check, and it will be believed. Either read to the
end or report the number you saw *and* that there are more.

The same applies to a search: a result set you did not exhaust is a sample, and it must be
described as one.

## Nothing is written on a schedule

Every write is a reaction to an event or to a person. A job that wakes up and changes labels is a
job that changes labels while nobody is looking, and the change nobody saw is the one that is
wrong. A scheduled job may **read** and report; it may not decide.

The one exception is the sweep, which relabels a session that never answered — and it writes only
what a timeout means, never what an issue is about.

## Redaction

**Redact anything quoted back from an API response before it is published.** Error bodies,
response payloads, and stack traces quote the values they were handed, so a message that reports
a raw body can republish a token or a signed URL that nothing in your own text ever mentioned.

The token is never printed, never logged, never included in an error, and never returned in a
result. An error body is truncated before it reaches a log, because a large HTML error page is
not more informative than its first few hundred characters and will happily fill one.

These repositories are public. An issue, a pull request, a commit message, a comment and a
workflow log are all publications, and an identifier published once cannot be unpublished.

## Where the repository's own answers live

`.ai-sdlc/repo-config.yml` decides what many of these operations should target: `owners` says
whose commands count, `dashboard_issue` says which issue the dashboard writes to, and the label
vocabulary says what the pipeline's states are called in *this* repository. Read it rather than
assuming the defaults.

## What this does not say

This says how to touch GitHub safely. It does not say what the pipeline's states mean or when
they move — `GK` owns the gatekeeper, `BLK` owns blockers, `MS` owns milestones and `LBL` owns
the label taxonomy. A second copy of the state machine would rot against the first.

Specification: `docs/spec/github-api.md` (`API`).

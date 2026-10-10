---
name: milestone-ops
description: Create, edit, close, reopen and inspect GitHub milestones, including the create and edit the MCP server does not provide. Use whenever a milestone must be made, renamed, re-described, closed at the end of a release, checked for remaining open work, or marked as the focus.
github-repo: https://github.com/derekwinters/ai-sdlc
github-ref: 9a51041eb76254a2cd7e306ed7ac352a2cf085d6
github-path: skills/pipeline/milestone-ops
github-tree-sha: c445af29b0ac9a8d71ac95a73e393e0abb343806
---

# Milestone ops

The GitHub MCP server exposes **no** milestone operations at all. Every one of them goes through
`github-api` — `milestones`, `create_milestone`, `update_milestone` — and this skill says what to
do with them.

That gap matters more than it looks: the focus milestone is matched live from a milestone's
**description**, so one created through the web interface without the right marker exists and is
invisible to the pipeline meant to consume it.

## Reading

Read every milestone with its number, title, state, and open and closed issue counts. **Report them
by number**, which is a stable order — a list that reorders between two runs is a list nobody can
diff.

Finding one by name:

- an **exact title** matches;
- a **unique prefix** matches, so `v0.4` finds `v0.4 — Adoption`;
- an **ambiguous prefix matches nothing**. Two candidates means picking one would be a guess, and
  a guess here renames or closes the wrong release.

Search open **and** closed milestones. A caller that means open only says so; a search that
silently excluded closed ones would report "no such milestone" for something that plainly exists.

`open_issues` is how much work remains in a milestone, and it is what decides whether it may close.

## Creating

A milestone needs a title, and may have a description and a due date. Before creating one:

- **an empty title is refused** — an untitled milestone cannot be found again;
- **a title that already exists is refused**, naming the existing one. Two milestones called
  `v0.4` is a state nothing downstream can resolve.

Report the created milestone **with its assigned number**, so whatever asked for it can use it
immediately rather than searching for what it just made.

**Never create a milestone closed.** A milestone created closed is a mistake every time — there is
no work in it and nothing to have finished.

## Editing

Title, description and due date may all change. Two rules:

- **an omitted field is left unchanged.** Editing is not replacement, and `update_milestone`
  changes only the fields it is given. Sending the whole object back would silently revert anything
  changed since you read it;
- **renaming to a title another milestone already has is refused**, for the same reason creating a
  duplicate is.

Editing something that does not exist is refused, **naming what was searched for** — "no milestone
found" without the search term is a message that cannot be acted on.

**Editing a description preserves the markers you did not mention.** Rewriting the prose of the
focus milestone must not silently stop it being the focus. Read the description, change the prose,
put the markers back.

## Closing and reopening

**Closing refuses while open issues remain, and says how many.** That is not bureaucracy: an issue
in a closed milestone carries a milestone that no longer appears in any open list, so it becomes
hard to find again. Closing anyway is available deliberately — when you force it, **say how many
issues it orphaned**.

Closing an already-closed milestone is a **no-op, not an error**, and so is reopening an
already-open one. Reopening a closed milestone is always available.

**Nothing deletes a milestone**, and nothing ever will. Deleting detaches it from every issue that
carried it and cannot be undone, where closing is always reversible. `github-api` has no delete for
this, and that is deliberate rather than an omission.

## The markers

A description carries machine-read markers alongside its prose:

| Marker | Meaning |
| --- | --- |
| `focus.` | the milestone the pipeline is currently working through |
| `frozen.` | scope is settled; no more issues should be added |

`focus.` marks the focus when the description **begins** with it. `frozen.` counts anywhere in the
description. Both are read **case-insensitively**, and both may sit alongside ordinary prose —
`Focus. the adoption release` is a marked milestone with a description.

**Exactly one milestone is the focus.** Setting it on one means clearing it from every other, in
the same operation — not assuming no other has it. Two focus milestones is a state the pipeline
resolves by picking one, and which one is not something anybody chose.

**Setting or clearing a marker preserves the prose around it.** The marker is a prefix on a
description somebody wrote; it is not the description.

Specification: `docs/spec/milestones.md` (`MS`).

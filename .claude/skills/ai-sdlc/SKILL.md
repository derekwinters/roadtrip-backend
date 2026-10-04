---
# ai-sdlc: derekwinters/ai-sdlc@v0.4.22 hash=4fbd6e3eb50cba85
# Managed by `adopt`. Local edits are preserved but stop this file
# being updated — `adopt verify` will report it.
name: ai-sdlc
description: >-
  How this repository's issues, labels, milestones, triage, pull-request gates
  and releases actually work. They are run by ai-sdlc, a shared pipeline this
  repository adopted, so the rules live outside this repository and the
  workflows here are thin callers. Use before changing a label or milestone,
  moving an issue between pipeline states, editing anything under
  `.github/workflows/`, cutting a release, or updating a document that
  describes any of those.
allowed-tools: Read, Grep, Glob, Bash
---

# ai-sdlc, in this repository

This repository has adopted [ai-sdlc](https://github.com/derekwinters/ai-sdlc), which owns its
pipeline, its label taxonomy, its release flow and its pull-request gates. It is
installed at **v0.4.22**.

## Read these, in this order

| File | What it settles |
| --- | --- |
| [`.ai-sdlc/adoption.md`](../../../.ai-sdlc/adoption.md) | What is installed here, and at which version |
| [`.ai-sdlc/repo-config.yml`](../../../.ai-sdlc/repo-config.yml) | Everything this repository decides for itself |
| [`.ai-sdlc/house-rules.md`](../../../.ai-sdlc/house-rules.md) | The rules an agent works under, imported by `CLAUDE.md` |

`.ai-sdlc/adoption.md` links every specification page that applies here, pinned to
the exact commit this repository runs. The specification is the answer to *how
does this behave*; nothing in this repository restates it, on purpose.

## What you may not hand-edit

Files carrying a `# ai-sdlc: …@… hash=…` header are written by `adopt`. Editing
one makes it a **conflict**: it is never overwritten, and it is never updated
again either, so a hand-edit silently freezes that file at the version it was
edited at. `adopt verify` reports them.

That covers the callers under `.github/workflows/`, `.github/labels.core.yml`,
the house rules, and this file.

## Changing something

- **A setting** — edit `.ai-sdlc/repo-config.yml`. It is the only file here ai-sdlc reads
  and never writes.
- **A version** — run `adopt apply <version>` from an ai-sdlc checkout. Install
  and upgrade are one operation.
- **A rule, a gate, a workflow** — it is not in this repository. Open an issue
  in ai-sdlc.

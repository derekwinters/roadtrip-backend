# 11 — Release Engineering (REL)

Both repositories version with **release-please** (conventional commits → release PR →
tagged GitHub release + changelog). Nothing publishes to an app store or registry: build
artifacts attach to GitHub releases only (product decision).

## Backend pipeline

| Trigger | Workflow | Output |
|---------|----------|--------|
| Every PR | `pr.yml` — lint, typecheck, unit+integration tests (Postgres service), spec validation, docker build | Docker image tarball + OpenAPI copy uploaded as **workflow artifacts** |
| Every PR | `pr-title-lint.yml` — PR title must be a Conventional Commit (it becomes the squash-merge commit release-please reads); `closing-keyword.yml` — ai-sdlc caller: the PR body must close an issue (`Closes #N`) unless labelled `no-closing-keyword` | Pass/fail checks only |
| Daily schedule / manual dispatch | `skills-update.yml` — ai-sdlc caller: installs/updates the agent skills named under `skills:` in `.ai-sdlc/repo-config.yml` at the pinned ai-sdlc version | A pull request when an installed skill changed (never a direct commit) |
| Issue labelled `ai-triage-queued` | `triage.yml` — ai-sdlc caller (pipeline gatekeeper): fires the `triage` Claude Code routine through its API trigger (secrets `ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN`) | A triage session for that issue |
| Issue comment / issue closed / hourly sweep | `gatekeeper-comment.yml`, `gatekeeper-close.yml`, `gatekeeper-sweep.yml` — ai-sdlc callers (pipeline gatekeeper): move issues between pipeline states | Label changes on issues only |
| Issue activity / daily schedule / manual dispatch | `dashboard.yml` — ai-sdlc caller: refreshes the pipeline dashboard issue (`dashboard_issue` in `.ai-sdlc/repo-config.yml`) | Dashboard issue body updated |
| Push to `main` changing `.github/labels.*.yml` / manual dispatch | `labels-sync.yml` — ai-sdlc caller: syncs the pipeline label taxonomy from `.github/labels.core.yml` | Repository labels created/updated |
| Push to `main` | `release-please.yml` — maintains the release PR | Release PR with version bump + changelog |
| Push to `main` while a release PR is open | `rc.yml` | **Release candidate**: prerelease on opaque git tag `rc-{run}` (deliberately not SemVer — invisible to release-please's version scan), titled `v{next}-rc.{run}`, with image tarball attached + GHCR image `ghcr.io/derekwinters/roadtrip-backend:v{next}-rc.{run}`; `rc-*` prereleases and tags are pruned when the final release publishes |
| Release PR merged (release created) | `release.yml` | Final image tarball + `openapi.yaml` + compose bundles attached to the versioned GitHub release notes + GHCR images `:vX.Y.Z` and `:latest` |

GHCR is GitHub's own registry, used so a home server can run the stack with **no checkout and
no local build**: `docker-compose.release.yml` references only published images (the API from
GHCR, PostgreSQL from its stock upstream image) — no `build:` blocks. App stores remain out of
scope; release-notes artifacts stay as they are.

## Android pipeline

Same shape: PR builds upload debug + release APKs as workflow artifacts; pushes to `main` with
an open release PR publish `-rc` prerelease APKs; release-please releases get final APKs
attached to the release notes. `versionName` comes from `version.txt` (release-please
`simple` strategy); `versionCode` is derived `major*10000 + minor*100 + patch`.

## Requirements

| ID | Requirement | Verify |
|----|-------------|--------|
| REL-001 | Every PR build produces downloadable build artifacts (backend: docker image tarball; android: APKs). | manual |
| REL-002 | release-please maintains version, tag, and CHANGELOG from conventional commits on `main` in both repos. | manual |
| REL-003 | While a release PR is open, each `main` build publishes a release-candidate prerelease with artifacts attached. Its git tag is the opaque `rc-{run}` — never SemVer, so release-please cannot parse it as a shipped version; the human-readable `v{next}-rc.{run}` appears only in the release title and artifact names. Final releases are the only SemVer tags, and stale `rc-*` prereleases (with their tags) are pruned when a final release publishes. | manual |
| REL-004 | Creating a release attaches final build artifacts to the versioned release notes. | manual |
| REL-005 | CI runs the spec validator; documentation drift fails the build. | manual |
| REL-006 | The backend Docker image is reproducible from the tagged commit via `docker build` with no network access at runtime (build-time fetches only). | manual |
| REL-007 | Release and RC builds push the API image to GHCR: `:vX.Y.Z` + `:latest` on releases, `:vX.Y.Z-rc.N` on release candidates. | manual |
| REL-008 | `docker-compose.release.yml` (attached to release notes) runs the whole stack from published images only — `docker compose -f docker-compose.release.yml up` works on a clean machine with no repo checkout and no local build. | manual |

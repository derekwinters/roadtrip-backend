# 11 — Release Engineering (REL)

Both repositories version with **release-please** (conventional commits → release PR →
tagged GitHub release + changelog). Nothing publishes to an app store or registry: build
artifacts attach to GitHub releases only (product decision).

## Backend pipeline

| Trigger | Workflow | Output |
|---------|----------|--------|
| Every PR | `pr.yml` — lint, typecheck, unit+integration tests (Postgres service), spec validation, docker build | Docker image tarball + OpenAPI copy uploaded as **workflow artifacts** |
| Push to `main` | `release-please.yml` — maintains the release PR | Release PR with version bump + changelog |
| Push to `main` while a release PR is open | `rc.yml` | **Release candidate**: prerelease `v{next}-rc.{run}` with image tarball attached + GHCR image `ghcr.io/derekwinters/roadtrip-backend:v{next}-rc.{run}` |
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
| REL-003 | While a release PR is open, each `main` build publishes a release-candidate prerelease with artifacts attached. | manual |
| REL-004 | Creating a release attaches final build artifacts to the versioned release notes. | manual |
| REL-005 | CI runs the spec validator; documentation drift fails the build. | manual |
| REL-006 | The backend Docker image is reproducible from the tagged commit via `docker build` with no network access at runtime (build-time fetches only). | manual |
| REL-007 | Release and RC builds push the API image to GHCR: `:vX.Y.Z` + `:latest` on releases, `:vX.Y.Z-rc.N` on release candidates. | manual |
| REL-008 | `docker-compose.release.yml` (attached to release notes) runs the whole stack from published images only — `docker compose -f docker-compose.release.yml up` works on a clean machine with no repo checkout and no local build. | manual |

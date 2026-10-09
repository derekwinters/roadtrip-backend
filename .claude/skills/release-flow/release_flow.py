#!/usr/bin/env python3
"""Drive release-please's release pull request to a tagged release.

Releases are rare enough that nobody remembers the gotchas, and the gotchas are
the kind that produce a silently wrong version rather than an error. So they
are written down here as code.

The one that matters most: **never toggle the pull request's state to restart
parked checks.** Closing and reopening looks like a harmless way to re-trigger
CI. It loses the review, loses the approval, and can lose the pull request's
association with the release it was going to cut. When checks need attention
this flow halts and says so, and a human decides.

The second: the squash title is composed from the version rather than taken
from the pull request's title. That title is the one commit release-please
parses to compute the *next* version, and a pull request retitled by hand — or
by a well-meaning bot — silently breaks the next release rather than this one.

Specification: docs/spec/release.md (`REL`).
"""

from __future__ import annotations

import re

#: release-please's own branch. Identifying by branch rather than by title
#: matters: a title can be edited by anyone, and a pull request titled like a
#: release is not one.
RELEASE_BRANCH_PREFIX = "release-please--branches--"

SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
VERSION_IN_BODY = re.compile(r"^#+\s*\[?v?(\d+\.\d+\.\d+)", re.MULTILINE)

NOT_A_FAILURE = frozenset({"success", "skipped", "neutral"})


class ReleaseError(RuntimeError):
    """A release that cannot proceed safely."""


class Halt:
    """A reason to stop and let the owner decide."""

    __slots__ = ("reason", "remedy")

    def __init__(self, reason, remedy):
        self.reason = reason
        self.remedy = remedy

    def __repr__(self):
        return f"<Halt {self.reason!r}>"


class Verification:
    __slots__ = ("complete", "tag_found", "release_found", "version_matches", "reason")

    def __init__(self, tag_found, release_found, version_matches):
        self.tag_found = tag_found
        self.release_found = release_found
        self.version_matches = version_matches
        self.complete = tag_found and release_found and version_matches

        missing = []
        if not tag_found:
            missing.append("the tag was not created")
        if not release_found:
            missing.append("the GitHub release was not created")
        if not version_matches:
            missing.append("the recorded version does not match")
        self.reason = "; ".join(missing)


# ------------------------------------------------------------------ finding


def find_release_pull_request(pulls):
    """The release pull request, by branch. None is a clean outcome."""
    found = [p for p in pulls if _is_release_branch(p)]

    if not found:
        return None
    if len(found) > 1:
        numbers = ", ".join(f"#{p['number']}" for p in found)
        raise ReleaseError(
            f"more than one release pull request is open ({numbers}); "
            f"guessing which to merge is not acceptable"
        )
    return found[0]


def _is_release_branch(pull):
    return ((pull.get("head") or {}).get("ref") or "").startswith(RELEASE_BRANCH_PREFIX)


def version_of(pull):
    """The version being released, read from the body rather than the title."""
    if pull.get("version"):
        return pull["version"]
    match = VERSION_IN_BODY.search(pull.get("body") or "")
    return match.group(1) if match else None


# -------------------------------------------------------------------- gates


def ready_to_merge(pull, checks):
    """None when the release may proceed, otherwise a Halt."""
    if not checks:
        return Halt(
            "the release pull request has no checks at all",
            "Nothing having run is not the same as everything having passed. "
            "Work out why CI did not start, and re-run it.",
        )

    running = [c["name"] for c in checks if c.get("status") != "completed"]
    if running:
        return Halt(
            f"checks are still running: {', '.join(sorted(running))}",
            "Wait for them to finish, then run the flow again.",
        )

    failed = [c["name"] for c in checks if c.get("conclusion") not in NOT_A_FAILURE]
    if failed:
        return Halt(
            f"checks are failing: {', '.join(sorted(failed))}",
            "Fix the failure and push to the release branch, or re-run the "
            "check if it was flaky. Do not reopen the pull request to "
            "restart it — that loses the review and the approval.",
        )

    return None


#: A milestone title that names a version: `v0.5`, `v0.5.0`, and anything
#: following it — `v0.5 — Fleet`. Anchored and bounded so `v0.50` is not read
#: as `v0.5`.
MILESTONE_VERSION = re.compile(r"^v(\d+)\.(\d+)(?:\.(\d+))?(?![\d.])")


def reserved_by_milestone(version, milestones):
    """A Halt when `version` belongs to a milestone still being worked.

    Versions here are named by milestones: `v0.4 — Adoption` closes when 0.4.0
    releases. Spending that number early takes it permanently — a version
    cannot be un-released — and leaves the milestone with no number of its own.

    Only the minor is protected, so the escape is a patch release of the
    *previous* version. A milestone with no open issues is not reserving
    anything: either its work is done and this release is exactly what should
    ship, or it is an empty placeholder.
    """
    parsed = SEMVER.match(str(version or ""))
    if not parsed:
        return None
    major, minor, _ = (int(part) for part in parsed.groups())

    for milestone in milestones or []:
        if milestone.get("state") != "open" or not milestone.get("open_issues"):
            continue
        named = MILESTONE_VERSION.match(str(milestone.get("title", "")))
        if not named:
            continue
        if (int(named.group(1)), int(named.group(2))) != (major, minor):
            continue

        title = milestone["title"]
        return Halt(
            f"{version} is reserved by the open milestone {title!r}, which still "
            f"has {milestone['open_issues']} open issue(s)",
            f"A version milestone closes with its release, and a version spent "
            f"early cannot be got back. Either finish {title!r} first, or force "
            f"a patch of the current version with a `Release-As:` footer.",
        )
    return None


def squash_title(version):
    """The release commit's message, composed rather than inherited."""
    if not version or not SEMVER.match(str(version)):
        raise ReleaseError(
            f"{version!r} is not a semantic version, so no release title can be "
            f"composed from it"
        )
    return f"chore(main): release {version}"


# ----------------------------------------------------------- forced version


def is_higher(candidate, current):
    return _parts(candidate) > _parts(current)


def _parts(version):
    match = SEMVER.match(str(version or "0.0.0"))
    return tuple(int(p) for p in match.groups()) if match else (0, 0, 0)


def release_as_footer(version, current=None):
    """A `Release-As:` footer, for making a tag match a milestone name."""
    if not version or not SEMVER.match(str(version)):
        raise ReleaseError(
            f"{version!r} is not a semantic version; the footer takes a bare "
            f"version such as 0.4.0, with no leading v"
        )
    if current and not is_higher(version, current):
        raise ReleaseError(
            f"{version} is not higher than the current {current}; releasing "
            f"backwards would make the version history unreadable"
        )
    return f"Release-As: {version}"


# ------------------------------------------------------------- verification


def verify_release(world, version, attempts=5, sleep=None):
    """Confirm the tag, the release and the version, retrying briefly.

    Tagging follows the merge by a moment, so a single immediate check would
    report a perfectly good release as incomplete.
    """
    sleep = sleep or (lambda _seconds: None)
    tag = f"v{version}"

    for attempt in range(attempts):
        found_tag = world.tag(tag)
        found_release = world.release(tag)
        if found_tag and found_release:
            break
        if attempt < attempts - 1:
            sleep(2)

    return Verification(
        tag_found=found_tag,
        release_found=found_release,
        version_matches=str(world.recorded_version()) == str(version),
    )

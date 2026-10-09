#!/usr/bin/env python3
"""Recover the tags a release history should already have.

A repository can accumulate `chore(main): release X.Y.Z` commits and no tags at
all — release-please writing `/VERSION`, the manifest and `CHANGELOG.md`
through merged pull requests, but never getting as far as tagging. ai-sdlc
reached 0.4.0 that way: its action was refused for being tag-pinned, so it
never ran (#64). With no tag to compute from, its first successful run proposed
the entire history as a single release.

The commits are still there, so the tags are recoverable. This derives them
from the history rather than from a list somebody typed — a list of versions
and SHAs is right on the day it is written and wrong after the next release.

Everything here is pure. It takes `git log` output and `CHANGELOG.md` as text
and returns a plan; the workflow does the git and the publishing. That is what
makes it testable without a repository.

Specification: docs/spec/release.md (`REL`), §6.
"""

from __future__ import annotations

import re
import sys

#: release-please's own release commit subject. The version is what follows.
#: Whatever follows is the version, even when it plainly is not one — a subject
#: that says `release the hounds` needs reporting, not passing over in silence.
RELEASE = re.compile(r"^chore\(main\): release (?P<version>.+)$")

#: Strictly `X.Y.Z`. A pre-release or build-metadata suffix is deliberately not
#: matched — see REL-046.
VERSION = re.compile(r"^(?P<major>\d+)\.(?P<minor>\d+)\.(?P<patch>\d+)$")


class Entry:
    """One release commit, and what should become of it.

    ``tag`` is empty when nothing should be created; ``problem`` then says why,
    so a skipped commit is visible in the log rather than absent from it.
    """

    __slots__ = ("sha", "version", "tag", "problem")

    def __init__(self, sha, version, tag="", problem=""):
        self.sha = sha
        self.version = version
        self.tag = tag
        self.problem = problem

    def __repr__(self):
        return f"<Entry {self.sha} {self.tag or self.problem}>"

    def __eq__(self, other):
        return (
            isinstance(other, Entry)
            and (self.sha, self.version, self.tag, self.problem)
            == (other.sha, other.version, other.tag, other.problem)
        )


def plan(log, existing_tags):
    """Return the entries for `log`, oldest version first.

    ``log`` is `git log --format=%H%x09%s` output; ``existing_tags`` is what the
    repository already has, so a re-run is a no-op rather than an error.
    """
    existing = set(existing_tags)
    entries, ordered = [], []

    for line in log.splitlines():
        sha, _, subject = line.partition("\t")
        match = RELEASE.match(subject.strip())
        if not match:
            continue

        version = match.group("version")
        parsed = VERSION.match(version)
        if not parsed:
            entries.append(
                Entry(sha, version, problem=f"{version!r} is not a plain X.Y.Z version")
            )
            continue

        tag = f"v{version}"
        if tag in existing:
            continue
        ordered.append(
            (
                tuple(int(parsed.group(part)) for part in ("major", "minor", "patch")),
                Entry(sha, version, tag=tag),
            )
        )

    ordered.sort(key=lambda pair: pair[0])
    return [entry for _, entry in ordered] + entries


def changelog_section(changelog, version):
    """Return `version`'s section of a changelog, without its own heading.

    Empty when the version has no section — a release with no notes is better
    than a release carrying somebody else's.
    """
    lines = changelog.splitlines()
    wanted = re.compile(rf"^## \[?{re.escape(version)}\]?\b")
    collected, inside = [], False

    for line in lines:
        if line.startswith("## "):
            if inside:
                break
            inside = bool(wanted.match(line))
            continue
        if inside:
            collected.append(line)

    return "\n".join(collected).strip()


def main(argv=None):
    """Print the plan for a log on stdin. The workflow does the rest."""
    argv = list(sys.argv[1:] if argv is None else argv)
    existing = argv[0].split() if argv else []
    entries = plan(sys.stdin.read(), existing)

    for entry in entries:
        if entry.tag:
            print(f"create\t{entry.tag}\t{entry.sha}")
        else:
            print(f"skip\t{entry.sha}\t{entry.problem}", file=sys.stderr)

    if not entries:
        print("nothing to do: every release commit is already tagged", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

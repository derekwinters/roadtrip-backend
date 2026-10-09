#!/usr/bin/env python3
"""Command line for the routines skill: `plan`.

Run from the root of the repository the routines are for:

    python3 .claude/skills/routines/main.py plan [--repo owner/name]

Prints the plan as JSON on standard output, or every problem on standard error
and exits 1. It writes nothing; SKILL.md says what to do with the plan.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from routines import RoutineError, dumps, plan, repository_slug  # noqa: E402

USAGE = "usage: main.py plan [--repo owner/name]"


def main(argv, root=None):
    args = list(argv[1:])
    if not args or args[0] != "plan":
        print(USAGE, file=sys.stderr)
        return 2
    explicit = None
    if "--repo" in args:
        position = args.index("--repo")
        if position + 1 >= len(args):
            print(USAGE, file=sys.stderr)
            return 2
        explicit = args[position + 1]

    try:
        repo = repository_slug(explicit)
        result = plan(Path(root) if root is not None else Path.cwd(), repo)
    except RoutineError as error:
        print("routines: no plan, because:", file=sys.stderr)
        print(str(error), file=sys.stderr)
        return 1
    sys.stdout.write(dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

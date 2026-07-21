#!/usr/bin/env python3
"""Portable spec/requirements validator — stdlib only, runs anywhere.

Spec-driven repos declare behavior as requirement rows in their spec docs:

    | AREA-NNN | short description | auto |

The third column is the **verification tag**, one of `auto | manual | planned`
(this is the canonical vocabulary — not "Testable"/"Manual"). This validator
enforces three core gates that keep the spec honest across a JS, Kotlin,
Python, C#, or docs-only repo without any language-specific tooling:

  1. **Unique IDs** — a requirement ID defined twice is an error.
  2. **auto ⇒ covered** — every `auto` requirement must be referenced *by name*
     in at least one test file under the configured test dir(s). The reference
     must be meaningful: the exact ID, on a word boundary, inside a file that
     actually lives under a test directory. This fixes the weakness in the
     original roadtrip validators, where a bare substring anywhere in the
     concatenated corpus counted (so `LOC-001` was "covered" by an unrelated
     `LOC-0012`, or by a stray mention in prose).
  3. **Links resolve** — every relative markdown link in the spec docs points
     at a file that exists on disk.

`manual` requirements are verified by a human and need no test reference;
`planned` requirements are not built yet and are reported but not enforced.

An optional fourth gate (API-contract diff, e.g. OpenAPI vs. implemented
routes) is language-specific and stays in each repo's own richer validator;
this portable core is the shared floor every repo can run.

Usage:
    validate_specs.py [--spec-dir docs/spec] \
        [--test-dir DIR ...] [--suffix .ts ...] [--quiet]

Exit code 0 on success, 1 on any gate failure.
"""
from __future__ import annotations

import argparse
import os
import re
import sys

# Requirement row: | AREA-001 | ... | auto |   (AREA is 1+ upper-case letters
# and/or digits after the first letter; NNN is 3+ digits).
REQ_ROW = re.compile(
    r"^\|\s*([A-Z][A-Z0-9]*-\d{3,})\s*\|.*\|\s*(auto|manual|planned)\s*\|\s*$"
)
LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
DEFAULT_SUFFIXES = (
    ".ts", ".tsx", ".mjs", ".js", ".kt", ".kts", ".py", ".java", ".cs", ".go",
)
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".gradle", "__pycache__"}


def _walk(root, predicate):
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in sorted(files):
            full = os.path.join(dirpath, name)
            if predicate(full):
                out.append(full)
    return out


def resolve_spec_dir(spec_dir):
    """Use spec_dir if it exists; else fall back to docs/ then '.'."""
    for candidate in (spec_dir, "docs", "."):
        if candidate and os.path.isdir(candidate):
            return candidate
    return spec_dir


def collect_requirements(spec_dir):
    """Return (requirements, errors). requirements: id -> (file, verify)."""
    errors = []
    requirements = {}
    md_files = _walk(spec_dir, lambda f: f.endswith(".md"))
    for file in md_files:
        with open(file, "r", encoding="utf-8") as fh:
            for line in fh:
                m = REQ_ROW.match(line.rstrip("\n"))
                if not m:
                    continue
                rid, verify = m.group(1), m.group(2)
                if rid in requirements:
                    errors.append(
                        f"Duplicate requirement ID {rid} "
                        f"({file} and {requirements[rid][0]})"
                    )
                else:
                    requirements[rid] = (file, verify)
    if not requirements:
        errors.append(f"No requirement rows found under {spec_dir} — spec drift?")
    return requirements, errors


def build_test_index(test_dirs, suffixes):
    """Map each test file under the configured dirs to its text."""
    index = {}
    for d in test_dirs:
        for f in _walk(d, lambda p: p.endswith(tuple(suffixes))):
            try:
                with open(f, "r", encoding="utf-8", errors="replace") as fh:
                    index[f] = fh.read()
            except OSError:
                continue
    return index


def _meaningful_ref(rid, text):
    # Exact ID on a word boundary: LOC-001 must not match LOC-0012 or XLOC-001.
    pattern = r"(?<![A-Za-z0-9])" + re.escape(rid) + r"(?![A-Za-z0-9])"
    return re.search(pattern, text) is not None


def check_coverage(requirements, test_index):
    errors = []
    for rid, (file, verify) in sorted(requirements.items()):
        if verify != "auto":
            continue
        if not any(_meaningful_ref(rid, text) for text in test_index.values()):
            errors.append(
                f"Requirement {rid} ({file}) is marked auto but no test file "
                f"under the configured test dir(s) references it"
            )
    return errors


def check_links(spec_dir):
    errors = []
    for file in _walk(spec_dir, lambda f: f.endswith(".md")):
        with open(file, "r", encoding="utf-8") as fh:
            text = fh.read()
        for m in LINK.finditer(text):
            target = m.group(1).strip()
            if re.match(r"^(https?:|mailto:|tel:|#)", target):
                continue
            resolved = os.path.normpath(
                os.path.join(os.path.dirname(file), target.split("#")[0])
            )
            if not os.path.exists(resolved):
                errors.append(f"Broken link in {file}: {target}")
    return errors


def run(spec_dir, test_dirs, suffixes):
    spec_dir = resolve_spec_dir(spec_dir)
    errors = []
    requirements, req_errors = collect_requirements(spec_dir)
    errors += req_errors

    test_index = build_test_index(test_dirs, suffixes)
    if not test_index and any(v == "auto" for _, v in requirements.values()):
        errors.append(
            "No test files found under the configured test dir(s) "
            f"({', '.join(test_dirs) or '<none>'}) — cannot verify auto coverage"
        )
    errors += check_coverage(requirements, test_index)
    errors += check_links(spec_dir)
    return requirements, errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec-dir", default="docs/spec",
                    help="Directory holding requirement tables (default docs/spec, "
                         "falling back to docs/ then .).")
    ap.add_argument("--test-dir", action="append", default=[], dest="test_dirs",
                    help="Directory of test sources to scan for ID references "
                         "(repeatable).")
    ap.add_argument("--suffix", action="append", default=[], dest="suffixes",
                    help="Test file suffix to include (repeatable; default covers "
                         "common test languages).")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    suffixes = tuple(args.suffixes) if args.suffixes else DEFAULT_SUFFIXES
    requirements, errors = run(args.spec_dir, args.test_dirs, suffixes)

    if errors:
        sys.stderr.write(f"Spec validation FAILED with {len(errors)} problem(s):\n")
        for e in errors:
            sys.stderr.write(f"  x {e}\n")
        return 1

    if not args.quiet:
        auto = sum(1 for _, v in requirements.values() if v == "auto")
        manual = sum(1 for _, v in requirements.values() if v == "manual")
        planned = sum(1 for _, v in requirements.values() if v == "planned")
        print(
            f"Spec validation OK: {len(requirements)} requirements "
            f"({auto} auto all test-covered, {manual} manual, {planned} planned); "
            f"links resolve."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

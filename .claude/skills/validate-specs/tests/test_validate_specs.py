"""Tests for the portable validate_specs core gates. Stdlib only.

Run: python -m unittest discover -s skills/validate-specs/tests -v
"""
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
FIXTURE = os.path.join(HERE, "fixture")
sys.path.insert(0, SKILL_DIR)

import validate_specs as vs  # noqa: E402


class FixtureTests(unittest.TestCase):
    def test_passing_fixture_has_no_errors(self):
        reqs, errors = vs.run(
            os.path.join(FIXTURE, "docs", "spec"),
            [os.path.join(FIXTURE, "tests")],
            (".py",),
        )
        self.assertEqual(errors, [], f"unexpected errors: {errors}")
        self.assertEqual(reqs["FIX-001"][1], "auto")
        self.assertEqual(reqs["FIX-002"][1], "manual")
        self.assertEqual(reqs["FIX-010"][1], "planned")

    def test_main_exit_zero_on_fixture(self):
        rc = vs.main([
            "--spec-dir", os.path.join(FIXTURE, "docs", "spec"),
            "--test-dir", os.path.join(FIXTURE, "tests"),
            "--suffix", ".py",
            "--quiet",
        ])
        self.assertEqual(rc, 0)


class GateTests(unittest.TestCase):
    def _spec(self, tmp, body):
        d = os.path.join(tmp, "docs", "spec")
        os.makedirs(d)
        with open(os.path.join(d, "req.md"), "w") as fh:
            fh.write(body)
        return d

    def test_duplicate_id_is_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = self._spec(
                tmp,
                "| DUP-001 | first | manual |\n| DUP-001 | again | manual |\n",
            )
            _, errors = vs.run(spec, [], (".py",))
            self.assertTrue(any("Duplicate" in e for e in errors), errors)

    def test_auto_without_reference_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = self._spec(tmp, "| COV-001 | needs a test | auto |\n")
            testdir = os.path.join(tmp, "t")
            os.makedirs(testdir)
            with open(os.path.join(testdir, "t.py"), "w") as fh:
                fh.write("nothing relevant here\n")
            _, errors = vs.run(spec, [testdir], (".py",))
            self.assertTrue(any("COV-001" in e for e in errors), errors)

    def test_substring_reference_is_not_meaningful(self):
        # COV-001 must NOT be considered covered by a mention of COV-0012.
        with tempfile.TemporaryDirectory() as tmp:
            spec = self._spec(tmp, "| COV-001 | boundary | auto |\n")
            testdir = os.path.join(tmp, "t")
            os.makedirs(testdir)
            with open(os.path.join(testdir, "t.py"), "w") as fh:
                fh.write("// covers: COV-0012 and COV-001x\n")
            _, errors = vs.run(spec, [testdir], (".py",))
            self.assertTrue(any("COV-001" in e for e in errors), errors)

    def test_exact_reference_is_meaningful(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = self._spec(tmp, "| COV-001 | exact | auto |\n")
            testdir = os.path.join(tmp, "t")
            os.makedirs(testdir)
            with open(os.path.join(testdir, "t.py"), "w") as fh:
                fh.write("// covers: COV-001\n")
            _, errors = vs.run(spec, [testdir], (".py",))
            self.assertEqual(errors, [])

    def test_broken_link_is_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            spec = self._spec(
                tmp,
                "| LNK-001 | x | manual |\n\nSee [gone](nowhere.md).\n",
            )
            _, errors = vs.run(spec, [], (".py",))
            self.assertTrue(any("Broken link" in e for e in errors), errors)


if __name__ == "__main__":
    unittest.main()

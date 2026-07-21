# Fixture "test file" that references the auto requirement FIX-001 by name.
#
# Named `coverage_check.py` (not `test_*.py`) on purpose: it is fixture input
# for validate_specs.py, not a real unittest, so unittest discovery skips it
# while validate_specs still finds the ID reference in it.
#
# covers: FIX-001
def test_fix_001_behavior():
    assert True

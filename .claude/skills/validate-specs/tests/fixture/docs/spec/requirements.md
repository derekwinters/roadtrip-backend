# Fixture spec — sample requirement table

This is a passing fixture for `validate_specs.py`. It exercises all three
verification tags and a resolvable relative link.

See the [companion note](note.md) for context.

| ID | Behavior | Verify |
|----|----------|--------|
| FIX-001 | The gate detects an auto requirement covered by a test | auto |
| FIX-002 | The gate ignores manual requirements for coverage | manual |
| FIX-010 | A planned requirement is reported but not enforced | planned |

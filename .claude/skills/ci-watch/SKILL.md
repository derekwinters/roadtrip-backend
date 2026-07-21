---
name: ci-watch
description: Poll GitHub PR checks until all complete, then report pass/fail status with log excerpts for any failures. Does not fix — callers handle resolution.
---

<what-to-do>

## Invocation

```
/ci-watch <pr-number>
/ci-watch <pr-number> --timeout <polls>
```

Called by orchestrators after pushing commits. Reports final status and returns control to the caller.

## Behavior

1. Poll `gh pr checks <pr-number>` every 30 seconds
2. After each poll, display a compact status table
3. Stop when all checks are non-pending (pass/fail/skipped) or timeout is reached
4. On any failures, fetch logs and report root cause
5. Return a structured result block for the caller

## Poll Table Format

Display after each poll:

```
CI Watch — PR #299 (poll 4, 2m00s elapsed)
  ✅ api-contracts          pass    26s
  ✅ backend-tests (3.11)   pass    2m24s
  ✅ backend-tests (3.12)   pass    2m40s
  ⏳ upgrade-regression     pending —
  ✅ validate               pass    17s
```

## Timeout

Default: 40 polls (~20 minutes). Override with `--timeout <n>`.

On timeout, report last known state and return TIMEOUT result.

## Log Fetching on Failure

For each failing check:

```bash
# Get job ID from the check URL
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs
```

Extract the last 40 lines of relevant output (skip Docker pull noise, git setup). Show the actual error message.

## Result Block

Always end with a structured result for the caller:

```
CI_WATCH_RESULT
  status: PASSED | FAILED | TIMEOUT
  pr: <number>
  total_checks: <n>
  passed: <n>
  failed: <n>
  elapsed_polls: <n>

FAILURES:          (omit section if none)
  <check-name>
    error: <one-line root cause>
    log_excerpt:
      <relevant log lines>
```

## What callers should do with this result

- **PASSED**: proceed (merge, finalize, etc.)
- **FAILED**: read FAILURES section, apply fixes, push, re-invoke ci-watch
- **TIMEOUT**: investigate runner health, re-invoke or escalate

## Notes

- Skip polling if no checks appear within the first 3 polls (new run may not have started yet — wait for run to register before declaring timeout)
- Treat `skipping` status as passing (downstream jobs skipped due to unmet conditions are expected)
- Job ID is the last path segment of the check URL: `https://github.com/.../job/79848187426` → `79848187426`

</what-to-do>

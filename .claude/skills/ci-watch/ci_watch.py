#!/usr/bin/env python3
"""Watch a pull request's checks to completion, and report what happened.

It reports; it never fixes. A watcher that also repairs is one whose reports
you cannot trust — a green result no longer distinguishes "the change was good"
from "the watcher patched it".

Four outcomes, and the three that are not PASSED are deliberately distinct.
"Timed out", "no checks at all" and "could not reach the API" are each a
different problem with a different response, and collapsing any of them into
"failed" sends the reader looking for a bug that is not there. Collapsing them
into "passed" is worse.

The clock is injected, so no test sleeps and the bounds are exactly testable.

Specification: docs/spec/ci-watch.md (`CIW`).
"""

from __future__ import annotations

from time import sleep as _sleep, time as _time

#: Conclusions that are not failures. `skipped` and `neutral` mean a check
#: chose not to judge; `cancelled` and `timed_out` are absent deliberately,
#: because neither passed and treating them as neutral hides a broken run.
NOT_A_FAILURE = frozenset({"success", "skipped", "neutral"})

DEFAULT_INTERVAL = 20
DEFAULT_DEADLINE = 1800
DEFAULT_MAX_ATTEMPTS = 240

#: A failing job's log can be megabytes. The end is where the failure is, and
#: the rest would flood whatever reads this.
MAX_EXCERPT = 2_000


class Outcome:
    PASSED = "passed"
    FAILED = "failed"
    TIMED_OUT = "timed-out"
    NO_CHECKS = "no-checks"
    UNREACHABLE = "unreachable"


class Check:
    __slots__ = ("name", "status", "conclusion", "detail")

    def __init__(self, name, status, conclusion, detail=""):
        self.name = name
        self.status = status
        self.conclusion = conclusion
        self.detail = detail

    @property
    def failed(self):
        return self.conclusion not in NOT_A_FAILURE

    def __repr__(self):
        return f"<Check {self.name} {self.conclusion}>"


class Result:
    __slots__ = ("outcome", "checks", "attempts")

    def __init__(self, outcome, checks=(), attempts=0):
        self.outcome = outcome
        self.checks = list(checks)
        self.attempts = attempts

    @property
    def failures(self):
        return [check for check in self.checks if check.failed]

    @property
    def passed(self):
        return self.outcome == Outcome.PASSED

    def __repr__(self):
        return f"<Result {self.outcome} checks={len(self.checks)}>"


def attach_logs(checks, fetch_log):
    """Attach a bounded log excerpt to each failed check.

    Only failures: fetching a passing job's log costs a request and tells
    nobody anything. An unreadable log is reported with its reason rather than
    dropping the check, because a check missing from a failure report reads as
    a check that passed.
    """
    for check in checks:
        if not check.failed:
            continue
        try:
            log = fetch_log(check.name) or ""
        except Exception as error:  # noqa: BLE001
            check.detail = f"(the log could not be read: {error})"
            continue
        check.detail = log[-MAX_EXCERPT:]
    return checks


class _RealClock:
    """The default clock.

    The functions are imported under private names: an attribute called `time`
    on this class would shadow the module before `time.sleep` could be read.
    """

    time = staticmethod(_time)
    sleep = staticmethod(_sleep)


def watch(
    fetch,
    clock=None,
    interval=DEFAULT_INTERVAL,
    deadline=DEFAULT_DEADLINE,
    max_attempts=DEFAULT_MAX_ATTEMPTS,
):
    """Poll `fetch` until every check completes, or a bound is reached."""
    clock = clock or _RealClock()
    started = clock.time()
    attempts = 0
    consecutive_errors = 0

    while True:
        attempts += 1

        try:
            raw = fetch()
            consecutive_errors = 0
        except Exception:  # noqa: BLE001 - any read failure is transient until it is not
            consecutive_errors += 1
            if attempts >= max_attempts:
                return Result(Outcome.UNREACHABLE, attempts=attempts)
            clock.sleep(interval)
            continue

        checks = sorted(
            (Check(c.get("name"), c.get("status"), c.get("conclusion")) for c in raw),
            key=lambda c: c.name or "",
        )

        if not checks:
            # Nothing having run is not the same as everything having passed,
            # and a caller that treats it as a pass will merge on no evidence.
            return Result(Outcome.NO_CHECKS, attempts=attempts)

        if all(check.status == "completed" for check in checks):
            failed = any(check.failed for check in checks)
            return Result(
                Outcome.FAILED if failed else Outcome.PASSED, checks, attempts
            )

        if attempts >= max_attempts or (clock.time() - started) >= deadline:
            return Result(Outcome.TIMED_OUT, checks, attempts)

        clock.sleep(interval)

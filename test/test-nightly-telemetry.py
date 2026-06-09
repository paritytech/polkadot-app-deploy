#!/usr/bin/env python3
"""
Fixture-based unit tests for tools/verify-nightly-telemetry.py assertions.
Run: python3 -m unittest test/test-nightly-telemetry.py
"""
import sys
import os
import unittest

# Allow importing from tools/ without installing
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'tools'))
from verify_nightly_telemetry import Span, assert_spans, SEMVER_RE
import re


# ---------------------------------------------------------------------------
# Fixture builders
# ---------------------------------------------------------------------------

def make_span(domain: str, **kwargs) -> Span:
    """Return a minimal span dict with sane defaults that pass all assertions."""
    base = dict(
        domain=domain,
        expected='false',
        sad='false',
        rpc_failed_over='false',
        version='0.7.3',
        transaction_status='ok',
        killed=None,
        gh_pages_url=None,
        trace_id='abc123',
        trace_url='https://paritytech.sentry.io/performance/trace/abc123/',
        dotns_backend='contract',
        dotns_pop_source='personhood-precompile',
        automated_mirror='false',
    )
    base.update(kwargs)
    return Span(**base)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestSemverRegex(unittest.TestCase):
    def test_valid_stable(self):
        self.assertIsNotNone(SEMVER_RE.match('0.7.3'))

    def test_valid_rc(self):
        self.assertIsNotNone(SEMVER_RE.match('0.7.3-rc.1'))

    def test_invalid_empty(self):
        self.assertIsNone(SEMVER_RE.match(''))

    def test_invalid_no_patch(self):
        self.assertIsNone(SEMVER_RE.match('0.7'))

    def test_invalid_unknown(self):
        self.assertIsNone(SEMVER_RE.match('unknown'))


class TestA1S3Expected(unittest.TestCase):
    """A1: S3 must have expected=true AND sad=false."""

    def test_s3_expected_true_passes(self):
        spans = [make_span('e2eowned.dot', expected='true', sad='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A1'])

    def test_s3_expected_false_fails(self):
        spans = [make_span('e2eowned.dot', expected='false', sad='false')]
        failures = assert_spans(spans)
        a1 = [f for f in failures if f.assertion == 'A1']
        self.assertEqual(1, len(a1))
        self.assertIn('expected', a1[0].message.lower())

    def test_s3_sad_true_fails(self):
        spans = [make_span('e2eowned.dot', expected='true', sad='true')]
        failures = assert_spans(spans)
        a1 = [f for f in failures if f.assertion == 'A1']
        self.assertEqual(1, len(a1))
        self.assertIn('sad', a1[0].message.lower())

    def test_non_s3_not_checked_by_a1(self):
        spans = [make_span('e2epool.dot', expected='false')]
        failures = assert_spans(spans)
        a1 = [f for f in failures if f.assertion == 'A1']
        self.assertEqual([], a1)


class TestA2Version(unittest.TestCase):
    """A2: every span must have bulletin-deploy.version matching semver."""

    def test_valid_version_passes(self):
        spans = [make_span('e2epool.dot', version='0.7.3')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A2'])

    def test_missing_version_fails(self):
        spans = [make_span('e2epool.dot', version='')]
        failures = assert_spans(spans)
        a2 = [f for f in failures if f.assertion == 'A2']
        self.assertEqual(1, len(a2))

    def test_unknown_version_fails(self):
        spans = [make_span('e2epool.dot', version='unknown')]
        failures = assert_spans(spans)
        a2 = [f for f in failures if f.assertion == 'A2']
        self.assertEqual(1, len(a2))

    def test_rc_version_passes(self):
        spans = [make_span('e2epool.dot', version='0.7.3-rc.1')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A2'])


class TestA3RpcFailedOver(unittest.TestCase):
    """A3: every non-S6 span must have deploy.rpc.failed_over=false."""

    def test_not_failed_over_passes(self):
        spans = [make_span('e2epool.dot', rpc_failed_over='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A3'])

    def test_failed_over_true_is_s6_and_skips_a3(self):
        spans = [make_span('e2epool.dot', rpc_failed_over='true')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A3'])

    def test_failed_over_empty_fails(self):
        # Missing attribute counts as failure — attribute must be explicitly seeded
        spans = [make_span('e2epool.dot', rpc_failed_over='')]
        failures = assert_spans(spans)
        a3 = [f for f in failures if f.assertion == 'A3']
        self.assertEqual(1, len(a3))


class TestA4KilledAndInternalError(unittest.TestCase):
    """A4: deploy.killed and transaction.status='internal_error' allowed only on S3 + S7."""

    def test_no_killed_non_s3_passes(self):
        spans = [make_span('e2epool.dot', killed=None, transaction_status='ok')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A4'])

    def test_unexpected_killed_on_non_s3_fails(self):
        # 'uncaught' is the bin/bulletin-deploy uncaughtException reason —
        # any non-SIGINT killed value is an unexpected crash.
        spans = [make_span('e2epool.dot', killed='uncaught', sad='true')]
        failures = assert_spans(spans)
        a4 = [f for f in failures if f.assertion == 'A4']
        self.assertEqual(1, len(a4))

    def test_internal_error_on_non_s3_fails(self):
        spans = [make_span('e2epool.dot', transaction_status='internal_error')]
        failures = assert_spans(spans)
        a4 = [f for f in failures if f.assertion == 'A4']
        self.assertEqual(1, len(a4))

    def test_killed_on_s3_is_ignored(self):
        # S3 is a deliberate failure — killed is allowed there
        spans = [make_span('e2eowned.dot', expected='true', sad='false',
                           killed='SIGINT', transaction_status='internal_error')]
        failures = assert_spans(spans)
        a4 = [f for f in failures if f.assertion == 'A4']
        self.assertEqual([], a4)

    def test_sigint_on_non_s3_is_ignored_as_s7(self):
        # deploy.killed='SIGINT' is the S7 marker — exempt from A4.
        spans = [make_span('e2epool.dot', killed='SIGINT', sad='true')]
        failures = assert_spans(spans)
        a4 = [f for f in failures if f.assertion == 'A4']
        self.assertEqual([], a4)

    def test_killed_sigterm_on_direct_fails(self):
        # SIGTERM is NOT the S7 marker; only SIGINT is. Treat as unexpected.
        spans = [make_span('e2edirect.dot', killed='SIGTERM', sad='true')]
        failures = assert_spans(spans)
        a4 = [f for f in failures if f.assertion == 'A4']
        self.assertEqual(1, len(a4))


class TestA6S7SigintCrashCapture(unittest.TestCase):
    """A6: S7 SIGINT'd spans must have deploy.sad='true' (#178 + #181 P4)."""

    def test_s7_sigint_with_sad_true_passes(self):
        spans = [make_span('e2epool.dot', killed='SIGINT', sad='true')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A6'])

    def test_s7_sigint_with_sad_false_fails(self):
        # If deploy.killed='SIGINT' but deploy.sad='false', the signal
        # handler at bin/bulletin-deploy:122-123 didn't atomically set
        # both attributes — telemetry regression.
        spans = [make_span('e2epool.dot', killed='SIGINT', sad='false')]
        failures = assert_spans(spans)
        a6 = [f for f in failures if f.assertion == 'A6']
        self.assertEqual(1, len(a6))

    def test_s7_sigint_with_sad_unset_fails(self):
        spans = [make_span('e2epool.dot', killed='SIGINT', sad=None)]
        failures = assert_spans(spans)
        a6 = [f for f in failures if f.assertion == 'A6']
        self.assertEqual(1, len(a6))

    def test_non_s7_span_skips_a6(self):
        # A regular happy-path span with sad='false' must not trip A6.
        spans = [make_span('e2epool.dot', killed=None, sad='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A6'])


class TestA5HappyPathSad(unittest.TestCase):
    """A5: S1 and S2 happy-path spans must have sad=false."""

    def test_s1_pool_sad_false_passes(self):
        spans = [make_span('e2epool.dot', sad='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A5'])

    def test_s1_direct_sad_false_passes(self):
        spans = [make_span('e2edirect.dot', sad='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A5'])

    def test_s2_fresh_sad_false_passes(self):
        spans = [make_span('e2e-n123456pool.dot', sad='false')]
        failures = assert_spans(spans)
        self.assertEqual([], [f for f in failures if f.assertion == 'A5'])

    def test_s1_pool_sad_true_fails(self):
        spans = [make_span('e2epool.dot', sad='true')]
        failures = assert_spans(spans)
        a5 = [f for f in failures if f.assertion == 'A5']
        self.assertEqual(1, len(a5))

    def test_s1_direct_sad_true_fails(self):
        spans = [make_span('e2edirect.dot', sad='true')]
        failures = assert_spans(spans)
        a5 = [f for f in failures if f.assertion == 'A5']
        self.assertEqual(1, len(a5))

    def test_s3_sad_true_not_flagged_by_a5(self):
        # S3 sad=true is an A1 violation, not an A5 violation
        spans = [make_span('e2eowned.dot', expected='true', sad='true')]
        failures = assert_spans(spans)
        a5 = [f for f in failures if f.assertion == 'A5']
        self.assertEqual([], a5)

    def test_s4_span_excluded_from_a5(self):
        # S4 uses e2epool.dot but has gh_pages_url — not a happy-path span
        spans = [make_span('e2epool.dot', gh_pages_url='https://example.github.io/foo/bar.car',
                           sad='true')]
        failures = assert_spans(spans)
        a5 = [f for f in failures if f.assertion == 'A5']
        self.assertEqual([], a5)


class TestMultipleSpans(unittest.TestCase):
    """Integration: multiple spans, multiple failures collected."""

    def test_mixed_failures_collected(self):
        spans = [
            make_span('e2epool.dot', version=''),    # A2
            make_span('e2edirect.dot', sad='true'),  # A5
        ]
        failures = assert_spans(spans)
        assertions = {f.assertion for f in failures}
        self.assertIn('A2', assertions)
        self.assertIn('A5', assertions)

    def test_all_good_no_failures(self):
        spans = [
            make_span('e2epool.dot'),
            make_span('e2edirect.dot'),
            make_span('e2e-n9876543pool.dot'),
            make_span('e2eowned.dot', expected='true', sad='false'),
        ]
        failures = assert_spans(spans)
        self.assertEqual([], failures)

    def test_all_assertions_can_fire_at_once(self):
        spans = [
            # A1 + A2 + A3: S3 missing expected + bad version + missing failed_over
            make_span('e2eowned.dot', expected='false', sad='true',
                      version='bad', rpc_failed_over=''),
            # A4 + A5: happy path span with non-SIGINT killed and sad=true.
            # 'uncaught' is the bin/bulletin-deploy uncaughtException reason —
            # never expected on a happy-path span.
            make_span('e2epool.dot', killed='uncaught', sad='true',
                      version='0.7.3', rpc_failed_over='false'),
            # A6: S7 SIGINT'd span missing deploy.sad='true'
            make_span('e2epool.dot', killed='SIGINT', sad='false',
                      version='0.7.3', rpc_failed_over='false'),
        ]
        failures = assert_spans(spans)
        assertions = {f.assertion for f in failures}
        self.assertIn('A1', assertions)
        self.assertIn('A2', assertions)
        self.assertIn('A3', assertions)
        self.assertIn('A4', assertions)
        self.assertIn('A5', assertions)
        self.assertIn('A6', assertions)

    def test_trace_url_is_in_failure(self):
        spans = [make_span('e2epool.dot', sad='true',
                           trace_url='https://paritytech.sentry.io/performance/trace/deadbeef/')]
        failures = assert_spans(spans)
        for f in failures:
            self.assertEqual('https://paritytech.sentry.io/performance/trace/deadbeef/', f.trace_url)


class TestDotnsContractTelemetry(unittest.TestCase):
    """DotNS telemetry: every span must identify backend and PoP source."""

    def test_contract_backend_and_personhood_source_pass(self):
        spans = [make_span('e2epool.dot')]
        failures = assert_spans(spans)
        a = [f for f in failures if f.assertion.startswith('A-DOTNS-')]
        self.assertEqual([], a)

    def test_missing_backend_fails(self):
        spans = [make_span('e2epool.dot', dotns_backend='')]
        failures = assert_spans(spans)
        a = [f for f in failures if f.assertion == 'A-DOTNS-BACKEND']
        self.assertEqual(1, len(a))

    def test_wrong_backend_fails(self):
        spans = [make_span('e2epool.dot', dotns_backend='cli')]
        failures = assert_spans(spans)
        a = [f for f in failures if f.assertion == 'A-DOTNS-BACKEND']
        self.assertEqual(1, len(a))

    def test_missing_pop_source_fails(self):
        spans = [make_span('e2epool.dot', dotns_pop_source='')]
        failures = assert_spans(spans)
        a = [f for f in failures if f.assertion == 'A-DOTNS-POP-SOURCE']
        self.assertEqual(1, len(a))

    def test_wrong_pop_source_fails(self):
        spans = [make_span('e2epool.dot', dotns_pop_source='pop-rules')]
        failures = assert_spans(spans)
        a = [f for f in failures if f.assertion == 'A-DOTNS-POP-SOURCE']
        self.assertEqual(1, len(a))


if __name__ == '__main__':
    unittest.main()

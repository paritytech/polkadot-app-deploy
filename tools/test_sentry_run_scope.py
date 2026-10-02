#!/usr/bin/env python3
"""Unit tests for sentry_run_scope.py (#1646). Run: python3 tools/test_sentry_run_scope.py"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from sentry_run_scope import build_deploy_query, choose_scope, probe_version_run_ids, selector_line


class BuildQuery(unittest.TestCase):
    def test_tag_only(self):
        self.assertEqual(build_deploy_query('span.op:deploy', 't'), 'span.op:deploy deploy.tag:t')

    def test_version(self):
        self.assertEqual(
            build_deploy_query('span.op:deploy', 't', version='0.1.0'),
            'span.op:deploy deploy.tag:t tags[bulletin-deploy.version]:0.1.0')

    def test_run_id(self):
        self.assertEqual(
            build_deploy_query('span.op:deploy', 't', run_id='123'),
            'span.op:deploy deploy.tag:t deploy.ci_run_id:123')

    def test_all_and_base_with_filter(self):
        self.assertEqual(
            build_deploy_query('span.op:deploy deploy.signer.mode:pool', 't', '1.0.0', '9'),
            'span.op:deploy deploy.signer.mode:pool deploy.tag:t '
            'tags[bulletin-deploy.version]:1.0.0 deploy.ci_run_id:9')


class ChooseScope(unittest.TestCase):
    def test_no_run_id(self):
        mode, reason = choose_scope('', '', 0, 0)
        self.assertEqual(mode, 'tag-window')
        self.assertIn('no --run-id', reason)

    def test_no_run_id_with_version(self):
        self.assertEqual(choose_scope('', '1.0.0', 5, 5)[0], 'tag-window')

    def test_run_id_no_version_never_falls_back(self):
        self.assertEqual(choose_scope('1', '', 0, 0)[0], 'run-scoped')
        self.assertEqual(choose_scope('1', '', 7, 0)[0], 'run-scoped')

    def test_version_predates_attribute(self):
        mode, reason = choose_scope('1', '0.1.0', 4, 0)
        self.assertEqual(mode, 'tag-window')
        self.assertIn('0.1.0', reason)

    def test_version_has_attribute(self):
        self.assertEqual(choose_scope('1', '0.1.0', 4, 4)[0], 'run-scoped')
        self.assertEqual(choose_scope('1', '0.1.0', 4, 1)[0], 'run-scoped')

    def test_nothing_seen_yet_keeps_run_scoped(self):
        self.assertEqual(choose_scope('1', '0.1.0', 0, 0)[0], 'run-scoped')


class Probe(unittest.TestCase):
    def test_counts_real_ids_only(self):
        rows = [{'deploy.ci_run_id': '5'}, {'deploy.ci_run_id': 'none'},
                {'deploy.ci_run_id': None}, {'deploy.ci_run_id': ''}, {}]
        seen, with_id = probe_version_run_ids(lambda q: rows, 'tag', '0.1.0')
        self.assertEqual((seen, with_id), (5, 1))

    def test_query_has_tag_and_version(self):
        got = []
        probe_version_run_ids(lambda q: got.append(q) or [], 'tag', '0.1.0')
        self.assertEqual(got, ['span.op:deploy deploy.tag:tag tags[bulletin-deploy.version]:0.1.0'])


class Selector(unittest.TestCase):
    def test_strings(self):
        self.assertEqual(selector_line('run-scoped', '', '42'), 'span selector: run-scoped (deploy.ci_run_id:42)')
        self.assertEqual(selector_line('tag-window', 'no --run-id given', ''),
                         'span selector: tag+window (legacy: no --run-id given)')


if __name__ == '__main__':
    unittest.main()

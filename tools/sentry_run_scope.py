"""Shared span-selector logic for the telemetry verifiers (#1646).

Root deploy spans used to be selected by deploy.tag + a time window, so two CI
runs sharing a tag (e.g. two e2e-ci-dispatch branch dispatches within 6h) saw
each other's spans. Spans now carry deploy.ci_run_id (GITHUB_RUN_ID); the
verifiers scope the query to it when given --run-id.

A published version older than deploy.ci_run_id never emits the attribute, so
a run-scoped query would find nothing; choose_scope() falls back to the legacy
tag+window selector for exactly that case.
"""
from __future__ import annotations

from typing import Callable

RUN_SCOPED = 'run-scoped'
TAG_WINDOW = 'tag-window'
NO_RUN_ID = ('', 'none', 'None')


def build_deploy_query(base: str, tag: str, version: str = '', run_id: str = '') -> str:
    query = f'{base} deploy.tag:{tag}'
    if version:
        query += f' tags[bulletin-deploy.version]:{version}'
    if run_id:
        query += f' deploy.ci_run_id:{run_id}'
    return query


def choose_scope(
    run_id: str,
    version: str,
    version_spans_seen: int,
    version_spans_with_run_id: int,
) -> tuple[str, str]:
    """Return (mode, reason); mode is RUN_SCOPED or TAG_WINDOW."""
    if not run_id:
        return TAG_WINDOW, 'no --run-id given'
    if not version:
        # Source build of this checkout: always emits the attribute.
        return RUN_SCOPED, ''
    if version_spans_seen > 0 and version_spans_with_run_id == 0:
        return TAG_WINDOW, (
            f'published version {version} predates deploy.ci_run_id '
            f'({version_spans_seen} spans seen, none carry it)'
        )
    return RUN_SCOPED, ''


def probe_version_run_ids(
    fetch_rows: Callable[[str], list[dict]],
    tag: str,
    version: str,
) -> tuple[int, int]:
    """Count that version's root deploy spans (seen, with a real deploy.ci_run_id).

    fetch_rows(query) must return events rows including the deploy.ci_run_id field.
    """
    rows = fetch_rows(build_deploy_query('span.op:deploy', tag, version=version))
    with_id = sum(1 for r in rows if str(r.get('deploy.ci_run_id') or '') not in NO_RUN_ID)
    return len(rows), with_id


def selector_line(mode: str, reason: str, run_id: str) -> str:
    if mode == RUN_SCOPED:
        return f'span selector: run-scoped (deploy.ci_run_id:{run_id})'
    return f'span selector: tag+window (legacy: {reason})'

#!/usr/bin/env python3
"""
Nightly assertion: pool-account selection distribution is not skewed.

Queries Sentry for the last <since-hours> hours of pool-mode deploys and
asserts:
  - At least <min-distinct> distinct pool indices appear across the sample.
  - No single index has more than <max-share> fraction of the sample.

If either bound is violated, exits non-zero with a printed breakdown so the
nightly run fails. Designed as a guardrail against regressions to the random
pool-account selection (PR #487, fixed-up by #517) — any future change that
silently re-introduces a filter, a sort, or other bias should show up here
within one nightly cycle.

Usage:
  python3 tools/verify_pool_distribution.py \\
    --org paritytech \\
    --project 4511093597405264 \\
    --tag e2e-ci-nightly \\
    --since 24h \\
    --min-distinct 5 \\
    --max-share 0.40 \\
    --min-spans 10

Exit codes:
  0  distribution passes both bounds
  1  distribution violates a bound (details printed)
  2  could not retrieve enough spans (sample too small to assert, or auth failure)
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

SENTRY_BASE = "https://de.sentry.io/api/0"


def sentry_request(token: str, url: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Sentry HTTP {e.code}: {body[:500]}")


def fetch_pool_indices(
    token: str,
    org: str,
    project: str,
    tag: str,
    since_hours: int,
) -> list[str]:
    now_utc = datetime.now(tz=timezone.utc)
    start_ts = calendar.timegm(now_utc.timetuple()) - since_hours * 3600
    start_str = datetime.fromtimestamp(start_ts, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S"
    )
    end_str = now_utc.strftime("%Y-%m-%dT%H:%M:%S")

    query = f"span.op:deploy deploy.signer.mode:pool deploy.tag:{tag}"
    fields = ["id", "deploy.pool.index"]
    per_page = 100

    params = urllib.parse.urlencode(
        [
            ("dataset", "spans"),
            ("query", query),
            ("start", start_str),
            ("end", end_str),
            ("project", project),
            ("per_page", str(per_page)),
        ]
        + [("field", f) for f in fields]
    )
    url = f"{SENTRY_BASE}/organizations/{org}/events/?{params}"
    data = sentry_request(token, url)
    rows = data.get("data", [])
    if len(rows) >= per_page:
        print(
            f"WARNING: hit per_page={per_page} ({len(rows)} rows). "
            f"Pagination is not implemented; distribution check may miss recent samples.",
            file=sys.stderr,
        )
    return [str(r.get("deploy.pool.index") or "").strip() for r in rows]


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--org", required=True)
    p.add_argument("--project", required=True, help="Sentry project ID (numeric)")
    p.add_argument("--tag", required=True, help="deploy.tag value to filter on")
    p.add_argument(
        "--since",
        default="24h",
        help="Lookback window, e.g. 24h or 48h (default 24h)",
    )
    p.add_argument(
        "--min-distinct",
        type=int,
        default=5,
        help="Minimum number of distinct pool indices required (default 5)",
    )
    p.add_argument(
        "--max-share",
        type=float,
        default=0.40,
        help="Maximum fraction any single index may occupy (default 0.40)",
    )
    p.add_argument(
        "--min-spans",
        type=int,
        default=10,
        help="Minimum sample size before assertions are meaningful (default 10). "
        "Smaller samples exit 2 (skip).",
    )
    args = p.parse_args()

    if not args.since.endswith("h"):
        print(f"ERROR: --since must be in hours (e.g. 24h), got {args.since!r}", file=sys.stderr)
        sys.exit(1)
    since_hours = int(args.since[:-1])

    token = os.environ.get("SENTRY_AUTH_TOKEN")
    if not token:
        print("ERROR: SENTRY_AUTH_TOKEN env var not set", file=sys.stderr)
        sys.exit(2)

    indices_raw = fetch_pool_indices(token, args.org, args.project, args.tag, since_hours)
    indices = [i for i in indices_raw if i != ""]
    total = len(indices)
    if total < args.min_spans:
        print(
            f"SKIP: only {total} pool-mode spans in last {since_hours}h "
            f"(need ≥ {args.min_spans} for a meaningful distribution check).",
        )
        sys.exit(2)

    counts = Counter(indices)
    distinct = len(counts)
    print(f"Sample size: {total} pool-mode deploys over last {since_hours}h")
    print(f"Distinct indices observed: {distinct}")
    print("Per-index breakdown:")
    for idx, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        share = n / total
        print(f"  #{idx:<3}  {n:>4}  ({share * 100:>5.1f}%)")

    failures: list[str] = []
    if distinct < args.min_distinct:
        failures.append(
            f"distribution too narrow: {distinct} distinct indices, "
            f"need ≥ {args.min_distinct}"
        )
    worst_idx, worst_n = max(counts.items(), key=lambda kv: kv[1])
    worst_share = worst_n / total
    if worst_share > args.max_share:
        failures.append(
            f"index #{worst_idx} dominates: {worst_n}/{total} = "
            f"{worst_share * 100:.1f}%, max allowed {args.max_share * 100:.0f}%"
        )

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)

    print("\nPASS: distribution within bounds.")
    sys.exit(0)


if __name__ == "__main__":
    main()

// Threshold-triggered memory diagnostic report (#142).
//
// When a deploy's peak RSS exceeds the threshold AND we're in an internal
// (Parity) context, capture a diagnostic bundle to a JSON file next to the
// build output and attach it to a Sentry captureMessage. The report is small
// (<10 KB) and carries no user content — just process-level counters useful
// for correlating the 4 GB-ish memory reports to specific deploy shapes.
//
// External users don't generate or see the report: heap introspection and
// handle-type inventories belong to us, not to consumers of the CLI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v8 from "node:v8";

import { isInternalContext, VERSION } from "./telemetry.js";

// Exported as a function so tests can spoof process.versions.bun after import.
export function isBunRuntime(): boolean {
  return (
    typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ||
    typeof (process.versions as { bun?: string }).bun === "string"
  );
}

export const DEFAULT_THRESHOLD_MB = 800;

export interface MemorySampleMb {
  rssMb: number;
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

export interface DeployContextForReport {
  /** Sanitized domain label (sanitizeBranch equivalent). No dots. */
  domain?: string;
  /** Sanitized repo slug. Matches what the deploy span already carries. */
  repo?: string;
  deployTag?: string;
  deployMode?: "pool" | "direct" | "external";
  jsMerkle?: boolean;
  chunkCount?: number;
  carBytes?: number;
  reconnects?: number;
  durationMs?: number;
  sentryTraceId?: string;
}

export interface MemoryReport {
  schemaVersion: 1;
  toolVersion: string;
  generatedAt: string;
  threshold: { thresholdMb: number; peakRssMb: number };
  deploy: DeployContextForReport;
  memory: {
    peak: MemorySampleMb;
    stages: Record<string, MemorySampleMb>;
  };
  v8: {
    heapStatistics: ReturnType<typeof v8.getHeapStatistics> | undefined;
    heapSpaceStatistics: ReturnType<typeof v8.getHeapSpaceStatistics> | undefined;
  };
  runtime: {
    nodeVersion: string;
    platform: string;
    arch: string;
    totalMemMb: number;
    freeMemMb: number;
    cpuCount: number;
    activeHandlesByType: Record<string, number>;
    activeRequestsByType: Record<string, number>;
  };
  polkadotApi?: { version?: string; clientsCreated?: number };
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

// Safely call a function that may access missing runtime APIs; returns undefined on error.
export function safeHeap<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

// Count Node's active handles / requests by constructor name. These are
// internal APIs (underscore-prefixed) but stable across Node 20–22. Useful
// for spotting subscription leaks (e.g. piles of TCPSocketWrap entries).
function countByType(items: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = (item as { constructor?: { name?: string } })?.constructor?.name ?? "Unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function readActiveHandles(): Record<string, number> {
  const proc = process as typeof process & { _getActiveHandles?: () => unknown[] };
  return safeHeap(() => {
    const handles = typeof proc._getActiveHandles === "function" ? proc._getActiveHandles() : [];
    return countByType(handles);
  }) ?? {};
}

function readActiveRequests(): Record<string, number> {
  const proc = process as typeof process & { _getActiveRequests?: () => unknown[] };
  return safeHeap(() => {
    const reqs = typeof proc._getActiveRequests === "function" ? proc._getActiveRequests() : [];
    return countByType(reqs);
  }) ?? {};
}

// Best-effort — polkadot-api ships in node_modules; missing in some test
// harnesses. Resolve by scanning the dep tree we can see from our own cwd.
// Using fs rather than require() because tsup emits ESM and `createRequire`
// from "node:module" adds cross-platform headaches. If any step fails we
// omit the field.
function readPolkadotApiVersion(): string | undefined {
  try {
    const candidates = [
      path.join(process.cwd(), "node_modules/polkadot-api/package.json"),
      path.join(process.cwd(), "../node_modules/polkadot-api/package.json"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const pkg = JSON.parse(fs.readFileSync(p, "utf-8"));
        return typeof pkg.version === "string" ? pkg.version : undefined;
      }
    }
  } catch { /* swallow */ }
  return undefined;
}

export function buildMemoryReport(input: {
  thresholdMb: number;
  peak: MemorySampleMb;
  stages: Record<string, MemorySampleMb>;
  deploy: DeployContextForReport;
}): MemoryReport {
  return {
    schemaVersion: 1,
    toolVersion: VERSION,
    generatedAt: new Date().toISOString(),
    threshold: { thresholdMb: input.thresholdMb, peakRssMb: input.peak.rssMb },
    deploy: input.deploy,
    memory: { peak: input.peak, stages: input.stages },
    v8: {
      heapStatistics: safeHeap(() => v8.getHeapStatistics()),
      heapSpaceStatistics: safeHeap(() => v8.getHeapSpaceStatistics()),
    },
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      cpuCount: os.cpus().length,
      activeHandlesByType: readActiveHandles(),
      activeRequestsByType: readActiveRequests(),
    },
    polkadotApi: { version: readPolkadotApiVersion() },
  };
}

export interface MaybeWriteMemoryReportInput {
  peak: MemorySampleMb;
  stages: Record<string, MemorySampleMb>;
  deploy: DeployContextForReport;
  /** Where to write the report file. Usually the build directory. */
  outputDir?: string;
  /** Override the default 1500 MB threshold (PAD_MEM_REPORT_THRESHOLD_MB). */
  thresholdMbOverride?: number;
  /** Hook for tests — defaults to isInternalContext(). */
  isInternal?: () => boolean;
  /** Hook for tests — defaults to real fs writes. */
  writeFile?: (path: string, content: string) => void;
  /** Hook for tests — receives the report when it would be attached to Sentry. */
  onSentryAttach?: (report: MemoryReport) => void;
}

export interface MemoryReportResult {
  /** Why the report did/didn't fire. Useful for tests and CLI logging. */
  status: "disabled" | "below-threshold" | "not-internal" | "written" | "unsupported-runtime";
  thresholdMb: number;
  peakRssMb: number;
  path?: string;
}

export function maybeWriteMemoryReport(input: MaybeWriteMemoryReportInput): MemoryReportResult {
  const thresholdMb = input.thresholdMbOverride
    ?? (process.env.PAD_MEM_REPORT_THRESHOLD_MB
      ? Number(process.env.PAD_MEM_REPORT_THRESHOLD_MB)
      : DEFAULT_THRESHOLD_MB);
  const peakRssMb = input.peak.rssMb;

  if (process.env.PAD_MEM_REPORT === "0") {
    return { status: "disabled", thresholdMb, peakRssMb };
  }
  if (isBunRuntime()) {
    return { status: "unsupported-runtime", thresholdMb, peakRssMb };
  }
  if (!Number.isFinite(thresholdMb) || peakRssMb < thresholdMb) {
    return { status: "below-threshold", thresholdMb, peakRssMb };
  }
  const isInternal = input.isInternal ?? isInternalContext;
  if (!isInternal()) {
    return { status: "not-internal", thresholdMb, peakRssMb };
  }

  const report = buildMemoryReport({
    thresholdMb,
    peak: input.peak,
    stages: input.stages,
    deploy: input.deploy,
  });

  const outDir = input.outputDir ?? process.cwd();
  const filePath = path.join(outDir, ".bulletin-memory-report.json");
  const write = input.writeFile ?? ((p, c) => fs.writeFileSync(p, c));
  try {
    write(filePath, JSON.stringify(report, null, 2));
  } catch {
    // Writing is a best-effort diagnostic; never fail the deploy on it.
  }

  if (input.onSentryAttach) input.onSentryAttach(report);

  return { status: "written", thresholdMb, peakRssMb, path: filePath };
}

/** Convert a MemorySample with raw byte fields into the MB-shaped sample. */
export function sampleFromBytes(m: { rss: number; heapUsed: number; external: number; arrayBuffers: number }): MemorySampleMb {
  return { rssMb: toMb(m.rss), heapUsedMb: toMb(m.heapUsed), externalMb: toMb(m.external), arrayBuffersMb: toMb(m.arrayBuffers) };
}

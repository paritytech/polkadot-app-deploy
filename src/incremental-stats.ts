// Aggregate probe outcomes + chunk metrics into telemetry attributes + a
// human-readable summary.
//
// v3 (this file) extends v2 with framework, file counts, hit rate, probe-
// failure reason breakdown, section sizes, and explicit chunk total/uploaded
// counts.
//
// Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 8, § 9)

import type { ChunkProbeResult, ChunkProbeFailureReason } from "./chunk-probe.js";
import type { ManifestChunkEntry } from "./manifest.js";

export interface IncrementalStats {
  manifestSource: "embedded" | "heuristic_fallback" | "none";
  manifestFetchAttempts: number;
  manifestFetchReason?: string;
  manifestBytes: number;
  framework: string | null;
  filesTotal: number;
  filesStable: number;
  filesVolatile: number;
  probedTotal: number;
  probePresent: number;
  probeAbsent: number;
  probeFailed: number;
  probeFailedRpc: number;
  probeFailedDecode: number;
  probeFailedMetadata: number;
  recycledCids: number;
  retentionPeriodBlocks: number;
  bytesProbePresent: number;
  bytesProbeAbsent: number;
  bytesSkipped: number;
  bytesUploaded: number;
  chunksTotal: number;
  chunksUploaded: number;
  chunksSkipped: number;
  carBytes: number;
  section0Bytes: number;
  section1Bytes: number;
  section2Bytes: number;
  estimatedSecondsSaved: number;
  tier2VerifiedCount: number;   // viaFallback chunks the chain confirmed present
  tier2InconclusiveCount: number; // viaFallback chunks where the chain re-probe was inconclusive
  tier2FallbackCount: number;   // total viaFallback chunks (= verified + inconclusive when no abort)
}

export interface ComputeStatsInput {
  manifestSource: IncrementalStats["manifestSource"];
  manifestFetchAttempts: number;
  manifestFetchReason?: string;
  manifestBytes?: number;
  framework: string | null;
  filesTotal: number;
  filesStable: number;
  filesVolatile: number;
  probeResults: ChunkProbeResult[];
  prevChunks: Record<string, ManifestChunkEntry>;
  retentionPeriodBlocks: number;
  bytesProbePresent: number;
  bytesProbeAbsent?: number;
  bytesSkipped: number;
  bytesUploaded: number;
  chunksTotal: number;
  chunksUploaded: number;
  chunksSkipped: number;
  carBytes: number;
  sectionSizes: { section0: number; section1: number; section2: number };
  tier2VerifiedCount: number;
  tier2InconclusiveCount: number;
  tier2FallbackCount: number;
}

const SECONDS_PER_PROBE_SKIP = 3.5;

function countByReason(probe: ChunkProbeResult[], reason: ChunkProbeFailureReason): number {
  return probe.filter((r) => r.present === null && (r as any).failureReason === reason).length;
}

export function computeStats(input: ComputeStatsInput): IncrementalStats {
  const present = input.probeResults.filter((r) => r.present === true);
  const failed = input.probeResults.filter((r) => r.present === null);
  const recycled = present.filter((r) => input.prevChunks[r.cid] == null);

  return {
    manifestSource: input.manifestSource,
    manifestFetchAttempts: input.manifestFetchAttempts,
    manifestFetchReason: input.manifestFetchReason,
    manifestBytes: input.manifestBytes ?? 0,
    framework: input.framework,
    filesTotal: input.filesTotal,
    filesStable: input.filesStable,
    filesVolatile: input.filesVolatile,
    probedTotal: input.probeResults.length,
    probePresent: present.length,
    probeAbsent: input.probeResults.filter((r) => r.present === false).length,
    probeFailed: failed.length,
    probeFailedRpc: countByReason(input.probeResults, "rpc_error"),
    probeFailedDecode: countByReason(input.probeResults, "decode_error"),
    probeFailedMetadata: countByReason(input.probeResults, "metadata_error"),
    recycledCids: recycled.length,
    retentionPeriodBlocks: input.retentionPeriodBlocks,
    bytesProbePresent: input.bytesProbePresent,
    bytesProbeAbsent: input.bytesProbeAbsent ?? 0,
    bytesSkipped: input.bytesSkipped,
    bytesUploaded: input.bytesUploaded,
    chunksTotal: input.chunksTotal,
    chunksUploaded: input.chunksUploaded,
    chunksSkipped: input.chunksSkipped,
    carBytes: input.carBytes,
    section0Bytes: input.sectionSizes.section0,
    section1Bytes: input.sectionSizes.section1,
    section2Bytes: input.sectionSizes.section2,
    estimatedSecondsSaved: Math.round(SECONDS_PER_PROBE_SKIP * present.length),
    tier2VerifiedCount: input.tier2VerifiedCount,
    tier2InconclusiveCount: input.tier2InconclusiveCount,
    tier2FallbackCount: input.tier2FallbackCount,
  };
}

export function telemetryAttributes(s: IncrementalStats): Record<string, string | number> {
  const hitRate = s.filesTotal === 0 ? 0 : s.filesStable / s.filesTotal;
  return {
    "deploy.cache.manifest_source": s.manifestSource,
    "deploy.cache.manifest_fetch_attempts": String(s.manifestFetchAttempts),
    "deploy.cache.manifest_fetch_reason": s.manifestFetchReason ?? "",
    "deploy.cache.manifest_bytes": String(s.manifestBytes),
    "deploy.cache.framework": s.framework ?? "",
    "deploy.cache.hit_rate": String(Math.round(hitRate * 1000) / 1000),
    "deploy.cache.files_total": String(s.filesTotal),
    "deploy.cache.files_stable": String(s.filesStable),
    "deploy.cache.files_volatile": String(s.filesVolatile),
    "deploy.cache.probed_total": String(s.probedTotal),
    "deploy.cache.probe_present": String(s.probePresent),
    "deploy.cache.probe_absent": String(s.probeAbsent),
    "deploy.cache.probe_failed": String(s.probeFailed),
    "deploy.cache.probe_failed_rpc": String(s.probeFailedRpc),
    "deploy.cache.probe_failed_decode": String(s.probeFailedDecode),
    "deploy.cache.probe_failed_metadata": String(s.probeFailedMetadata),
    "deploy.cache.recycled_cids": String(s.recycledCids),
    "deploy.cache.retention_period_blocks": String(s.retentionPeriodBlocks),
    "deploy.cache.chunks_total": String(s.chunksTotal),
    "deploy.cache.chunks_uploaded": String(s.chunksUploaded),
    "deploy.cache.chunks_skipped": String(s.chunksSkipped),
    "deploy.cache.bytes_probe_present": String(s.bytesProbePresent),
    "deploy.cache.bytes_probe_absent": String(s.bytesProbeAbsent),
    "deploy.cache.bytes_skipped": String(s.bytesSkipped),
    "deploy.cache.bytes_uploaded": String(s.bytesUploaded),
    "deploy.cache.car_bytes": String(s.carBytes),
    "deploy.cache.section0_bytes": String(s.section0Bytes),
    "deploy.cache.section1_bytes": String(s.section1Bytes),
    "deploy.cache.section2_bytes": String(s.section2Bytes),
    "deploy.cache.estimated_seconds_saved": String(s.estimatedSecondsSaved),
    "deploy.cache.tier2_fallback": String(s.tier2FallbackCount),
    "deploy.cache.tier2_verified": String(s.tier2VerifiedCount),
    "deploy.cache.tier2_inconclusive": String(s.tier2InconclusiveCount),
  };
}

function fmtMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}
function fmtKb(bytes: number): string {
  return (bytes / 1_000).toFixed(1);
}

export function renderSummary(s: IncrementalStats): string {
  const lines: string[] = [];
  const attemptsWord = s.manifestFetchAttempts === 1 ? "attempt" : "attempts";
  if (s.manifestSource === "heuristic_fallback") {
    lines.push(`  ⚠ Previous manifest fetch failed after ${s.manifestFetchAttempts} ${attemptsWord} (gateway timeout).`);
    lines.push(`    Using heuristic classification — hit rate may be lower this run.`);
    lines.push(`    Subsequent deploys recover automatically.`);
    lines.push("");
  }
  lines.push(`Cache:`);

  // Manifest line.
  if (s.manifestSource === "none") {
    lines.push(`  Manifest:      first deploy (no previous manifest)`);
  } else if (s.manifestSource === "embedded") {
    const sizeStr = s.manifestBytes > 0 ? `, ${fmtKb(s.manifestBytes)} KB Range hit` : "";
    lines.push(`  Manifest:      embedded (${s.manifestFetchAttempts} ${attemptsWord}${sizeStr})`);
  } else {
    lines.push(`  Manifest:      heuristic_fallback (${s.manifestFetchAttempts} ${attemptsWord})`);
  }

  // Files line (only when manifest source isn't "none" — first deploy has no prior files).
  if (s.filesTotal > 0 && s.manifestSource !== "none") {
    const pct = s.filesTotal === 0 ? 0 : Math.round((s.filesStable / s.filesTotal) * 100);
    const heuristicNote = s.manifestSource === "heuristic_fallback" ? " (heuristic estimate)" : "";
    lines.push(`  Files:         ${s.filesStable} unchanged, ${s.filesVolatile} changed (${pct} % stable)${heuristicNote}`);
  }

  // Probed line.
  if (s.probedTotal > 0) {
    let probeFailedStr = "";
    if (s.probeFailed > 0) {
      const reasons: string[] = [];
      if (s.probeFailedRpc > 0) reasons.push("rpc_error");
      if (s.probeFailedDecode > 0) reasons.push("decode_error");
      if (s.probeFailedMetadata > 0) reasons.push("metadata_error");
      probeFailedStr = `, ${s.probeFailed} probe-failed (${reasons.join(", ")})`;
    }
    lines.push(`  Probed:        ${s.probedTotal} chunks  →  ${s.probePresent} on chain, ${s.probeAbsent} absent${probeFailedStr}`);
  }

  if (s.recycledCids > 0 && s.manifestSource === "embedded") {
    lines.push(`  Recycled:      ${s.recycledCids} CIDs found on-chain that weren't in the previous manifest`);
  }

  if (s.tier2FallbackCount > 0) {
    const inconclusiveStr = s.tier2InconclusiveCount > 0
      ? `, ${s.tier2InconclusiveCount} inconclusive`
      : "";
    lines.push(`  Verify:        ${s.tier2VerifiedCount}/${s.tier2FallbackCount} via-fallback chunks confirmed on chain${inconclusiveStr}`);
  }

  // Sections line.
  lines.push(`  CAR sections:  manifest ${fmtKb(s.section0Bytes)} KB · stable ${fmtMb(s.section1Bytes)} MB · volatile ${fmtMb(s.section2Bytes)} MB`);

  // Upload line.
  if (s.chunksUploaded > 0) {
    if (s.bytesSkipped > 0) {
      lines.push(`  Upload:        ${fmtMb(s.bytesUploaded)} MB across ${s.chunksUploaded} chunks (vs ${fmtMb(s.carBytes)} MB if full deploy)`);
    } else {
      lines.push(`  Upload:        ${fmtMb(s.bytesUploaded)} MB across ${s.chunksUploaded} chunks`);
    }
  }

  // Saved line.
  if (s.estimatedSecondsSaved > 0 || s.bytesSkipped > 0) {
    lines.push(`  Saved:         ~${s.estimatedSecondsSaved} s and ${fmtMb(s.bytesSkipped)} MB`);
  }

  return lines.join("\n");
}

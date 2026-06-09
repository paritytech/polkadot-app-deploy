// Programmatic fixture for incremental-upload-v2 scenario tests.
//
// Generates a ~5 MB build directory shaped like a typical SPA: one volatile
// HTML file plus content-hashed assets. Deterministic bytes from a seeded
// PRNG so two builds with the same seed are byte-identical.
//
// Plan: docs-internal/superpowers/plans/2026-05-07-incremental-upload-v2.md (Task 15)

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const FILES = [
  { rel: "index.html", size: 5_000, kind: "volatile" },
  { rel: "assets/main-Abc123.js", size: 600_000, kind: "stable" },
  { rel: "assets/vendor-Xyz789.js", size: 1_200_000, kind: "stable" },
  { rel: "assets/runtime.wasm", size: 2_500_000, kind: "stable" },
  { rel: "assets/styles-Pqr456.css", size: 80_000, kind: "stable" },
  { rel: "assets/inter.woff2", size: 120_000, kind: "stable" },
  { rel: "assets/logo.png", size: 200_000, kind: "stable" },
  { rel: "assets/hero.jpg", size: 400_000, kind: "stable" },
];

function seededBytes(seed, length) {
  let h = crypto.createHash("sha256").update(String(seed)).digest();
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < length) {
    const need = Math.min(h.length, length - pos);
    h.copy(out, pos, 0, need);
    pos += need;
    h = crypto.createHash("sha256").update(h).digest();
  }
  return out;
}

export function buildFixture({ targetDir, seed = "default", runTag = "LOCAL", scenario = "baseline" }) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(targetDir, "assets"), { recursive: true });

  for (const f of FILES) {
    if (f.rel === "index.html") {
      const html = `<!DOCTYPE html><html><head><title>v2 fixture</title></head><body>` +
        `<!-- E2E_RUN: ${runTag} --><h1>incremental-v2</h1></body></html>`;
      const padded = Buffer.concat([Buffer.from(html), Buffer.alloc(Math.max(0, f.size - html.length), 0x20)]);
      fs.writeFileSync(path.join(targetDir, f.rel), padded);
    } else {
      let bytes = seededBytes(`${seed}:${f.rel}`, f.size);
      if (scenario === "app-rebuild" && f.rel === "assets/main-Abc123.js") {
        bytes = seededBytes(`${seed}:main-Def456.js`, f.size);
      }
      if (scenario === "vendor-update" && f.rel === "assets/vendor-Xyz789.js") {
        bytes = seededBytes(`${seed}:vendor-Pqr012.js`, f.size);
      }
      fs.writeFileSync(path.join(targetDir, f.rel), bytes);
    }
  }
}

export function fixtureFiles() {
  return FILES.map((f) => ({ ...f }));
}

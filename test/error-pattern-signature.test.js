import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { analyseErrorPattern } from "../dist/telemetry.js";

describe("analyseErrorPattern — length buckets", () => {
  test("empty string → len:lt50", () => {
    const result = analyseErrorPattern("");
    assert.ok(result.split(",").includes("len:lt50"), `expected len:lt50 in "${result}"`);
  });

  test("49-char string → len:lt50", () => {
    const result = analyseErrorPattern("a".repeat(49));
    assert.ok(result.split(",").includes("len:lt50"), `expected len:lt50 in "${result}"`);
  });

  test("50-char string → len:50-99", () => {
    const result = analyseErrorPattern("a".repeat(50));
    assert.ok(result.split(",").includes("len:50-99"), `expected len:50-99 in "${result}"`);
  });

  test("100-char string → len:100-199", () => {
    const result = analyseErrorPattern("a".repeat(100));
    assert.ok(result.split(",").includes("len:100-199"), `expected len:100-199 in "${result}"`);
  });

  test("200-char string → len:200-499", () => {
    const result = analyseErrorPattern("a".repeat(200));
    assert.ok(result.split(",").includes("len:200-499"), `expected len:200-499 in "${result}"`);
  });

  test("500-char string → len:gte500", () => {
    const result = analyseErrorPattern("a".repeat(500));
    assert.ok(result.split(",").includes("len:gte500"), `expected len:gte500 in "${result}"`);
  });
});

describe("analyseErrorPattern — URL userinfo", () => {
  test("wss URL with user:pass → url-userinfo", () => {
    const result = analyseErrorPattern("wss://user:pass@host.example.com/ws");
    assert.ok(result.split(",").includes("url-userinfo"), `expected url-userinfo in "${result}"`);
  });

  test("plain wss URL (no userinfo) → no url-userinfo", () => {
    const result = analyseErrorPattern("wss://host.example.com/ws");
    assert.ok(!result.split(",").includes("url-userinfo"), `unexpected url-userinfo in "${result}"`);
  });
});

describe("analyseErrorPattern — EVM addresses", () => {
  test("message with 0x address → evm:1", () => {
    // 40-char hex after 0x = EVM address (total 42 chars including 0x)
    const addr = "0x" + "f".repeat(40);
    const result = analyseErrorPattern(`Domain is owned by ${addr} already`);
    assert.ok(result.split(",").includes("evm:1"), `expected evm:1 in "${result}"`);
  });

  test("0x address does NOT produce long-hex tag", () => {
    const addr = "0x" + "f".repeat(40);
    const result = analyseErrorPattern(`Domain is owned by ${addr} already`);
    assert.ok(!result.split(",").some(t => t.startsWith("long-hex")), `unexpected long-hex in "${result}"`);
  });
});

describe("analyseErrorPattern — long hex (non-EVM, non-CID)", () => {
  test("arbitrary 52-char hex string → long-hex:1", () => {
    // Not prefixed e30, not 40 chars → should trigger long-hex
    const hex = "abcd".repeat(13); // 52 chars
    const result = analyseErrorPattern(`Error processing ${hex}`);
    assert.ok(result.split(",").some(t => t.startsWith("long-hex")), `expected long-hex in "${result}"`);
  });

  test("CID-prefixed hex (e301017012...) → no long-hex", () => {
    // CID-v1 hex prefix e301017012 — should be excluded
    const cidHex = "e301017012" + "ab".repeat(22); // starts with e30, 54 chars total
    const result = analyseErrorPattern(`Chunk ${cidHex} not found`);
    assert.ok(!result.split(",").some(t => t.startsWith("long-hex")), `unexpected long-hex for CID hex in "${result}"`);
  });

  test("exactly-40-char hex → no long-hex (excluded by length filter)", () => {
    // 40-char hex without 0x prefix — length 40 is excluded by the filter
    const hex = "a".repeat(40);
    const result = analyseErrorPattern(`raw ${hex} end`);
    assert.ok(!result.split(",").some(t => t.startsWith("long-hex")), `unexpected long-hex for 40-char hex in "${result}"`);
  });
});

describe("analyseErrorPattern — base64-ish", () => {
  test("base64 token (mixed case + digits, 30+ chars) → base64ish", () => {
    // Realistic base64 chunk: mixed case + digits, ≥30 chars
    const b64 = "SGVsbG9Xb3JsZDEyMzQ1Njc4OTAxMjM0NTY="; // 36 chars, mixed
    const result = analyseErrorPattern(`token ${b64} expired`);
    assert.ok(result.split(",").includes("base64ish"), `expected base64ish in "${result}"`);
  });

  test("all-lowercase 30-char run → no base64ish (no mixed case)", () => {
    const result = analyseErrorPattern("abcdefghijklmnopqrstuvwxyzabcd");
    assert.ok(!result.split(",").includes("base64ish"), `unexpected base64ish in "${result}"`);
  });
});

describe("analyseErrorPattern — JWT shape", () => {
  test("JWT-shaped string (3 dot-separated base64url segments) → jwt-shape", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = analyseErrorPattern(`Authorization failed: ${jwt}`);
    assert.ok(result.split(",").includes("jwt-shape"), `expected jwt-shape in "${result}"`);
  });

  test("normal dotted identifier (too short segments) → no jwt-shape", () => {
    const result = analyseErrorPattern("node.js error at foo.bar");
    assert.ok(!result.split(",").includes("jwt-shape"), `unexpected jwt-shape in "${result}"`);
  });
});

describe("analyseErrorPattern — SS58 shape", () => {
  test("SS58-looking address (47-char base58) → ss58-shape", () => {
    // Realistic SS58 address on Substrate: 47 chars, base58 alphabet
    const ss58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
    const result = analyseErrorPattern(`Account ${ss58} not found`);
    assert.ok(result.split(",").includes("ss58-shape"), `expected ss58-shape in "${result}"`);
  });

  test("short base58-ish string → no ss58-shape", () => {
    const result = analyseErrorPattern("short 5GrwvaEF5zXb26Fz9rc error");
    assert.ok(!result.split(",").includes("ss58-shape"), `unexpected ss58-shape for short string in "${result}"`);
  });
});

describe("analyseErrorPattern — mnemonic shape", () => {
  test("12-word mnemonic → mnemonic-shape", () => {
    const mnemonic = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const result = analyseErrorPattern(mnemonic);
    assert.ok(result.split(",").includes("mnemonic-shape"), `expected mnemonic-shape in "${result}"`);
  });

  test("normal sentence (mixed case/punctuation) → no mnemonic-shape", () => {
    const result = analyseErrorPattern("Deploy failed because the contract reverted with flags=1");
    assert.ok(!result.split(",").includes("mnemonic-shape"), `unexpected mnemonic-shape in "${result}"`);
  });
});

describe("analyseErrorPattern — combined realistic messages", () => {
  test("connection error message has correct length bucket", () => {
    // Typical 120-char connection error (the observed scrubbed pattern)
    const msg = "heartbeat timeout after 30s: websocket connection to wss://rpc.paseo.example.com/ws was closed unexpectedly code=1006";
    const result = analyseErrorPattern(msg);
    const tags = result.split(",");
    assert.ok(tags.includes("len:100-199"), `expected len:100-199 in "${result}"`);
  });

  test("result is pure metadata — no content excerpt", () => {
    // Verify the result only contains known tag patterns, never raw message content
    const secret = "my-secret-password-12345";
    const result = analyseErrorPattern(`Failed to connect: wss://user:${secret}@host.example.com`);
    assert.ok(!result.includes(secret), `result must not contain secret content: "${result}"`);
    // Should have url-userinfo tag
    assert.ok(result.split(",").includes("url-userinfo"), `expected url-userinfo in "${result}"`);
  });
});

#!/usr/bin/env node
"use strict";
// A `curl` stand-in put first on PATH when replaying a workflow `run:` block.
// Understands exactly the options the workflows use and exits 2 on any other,
// so a workflow that grows a new curl flag fails loudly instead of being
// half-replayed. Value flags: -X, -o, -w '%{http_code}', -d, -H, --max-time,
// --data-urlencode. Boolean short flags (combinable, e.g. -fsSL): f s S L G.
// -f makes an HTTP status >= 400 exit 22. With -G, --data-urlencode values go
// into the query string (without -G curl would send them as a POST body, which
// the workflows never do, so that combination is rejected).
// Responses come from CURL_RULES (JSON: [{ "method": "POST", "match": "<url
// substring>", "status": 201, "body": "..." }]); no match is a 404.
// Every call is appended to CURL_LOG as one JSON line {method, url, data}.
const fs = require("fs");
const die = (msg) => { process.stderr.write(`curl-stub: ${msg}\n`); process.exit(2); };
const VALUE_FLAGS = new Set(["-X", "-o", "-w", "-d", "-H", "--max-time", "--data-urlencode"]);
const BOOL_FLAGS = new Set(["f", "s", "S", "L", "G"]);
const args = process.argv.slice(2);
let method, out, fmt, data, url;
const flags = new Set();
const query = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) {
    if (i + 1 >= args.length) die(`${a} needs a value`);
    const v = args[++i];
    if (a === "-X") method = v;
    else if (a === "-o") out = v;
    else if (a === "-w") fmt = v;
    else if (a === "-d") data = v;
    else if (a === "--data-urlencode") query.push(v);
  } else if (/^-[a-zA-Z]+$/.test(a) && [...a.slice(1)].every((c) => BOOL_FLAGS.has(c))) {
    for (const c of a.slice(1)) flags.add(c);
  } else if (/^https?:\/\//.test(a)) url = a;
  else die(`unsupported argument ${a}; teach curl-stub.cjs about it`);
}
if (!url) die("no URL");
if (query.length && !flags.has("G")) die("--data-urlencode without -G is not supported");
const fail = flags.has("f");
if (query.length) url += (url.includes("?") ? "&" : "?") + query.join("&");
method = method || (data !== undefined ? "POST" : "GET");
fs.appendFileSync(process.env.CURL_LOG, JSON.stringify({ method, url, data: data ?? null }) + "\n");
const rules = JSON.parse(fs.readFileSync(process.env.CURL_RULES, "utf8"));
const r = rules.find((x) => (!x.method || x.method === method) && url.includes(x.match));
const status = r ? r.status : 404;
const body = r ? r.body ?? "" : "not found";
if (out) fs.writeFileSync(out, body); else process.stdout.write(body);
if (fmt) process.stdout.write(fmt.replace("%{http_code}", String(status)));
process.exit(fail && status >= 400 ? 22 : 0);

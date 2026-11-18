// Preload (node --import) that fails every connection to a host other than localhost: net and
// tls connects, DNS lookups, http(s) requests, fetch and WebSocket. Tests pass it to the CLI and
// tools they spawn, so a regressed guard fails in the test instead of connecting to a live chain.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const LOCAL_HOSTS = new Set(["127.0.0.1", "::1", "localhost", ""]);

const hostOf = (target) => {
  try {
    return new URL(String(target)).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return String(target ?? "");
  }
};

const createBlockError = (what, host) => Object.assign(new Error(`network blocked by test/helpers/no-network.mjs: ${what} ${host}`), { code: "ENETBLOCKED" });

// net.connect(options) / (port, host) / (path): a unix socket path is local.
const connectHost = ([first, second]) => {
  if (first && typeof first === "object") return first.path ? "" : first.host ?? first.hostname ?? "localhost";
  if (typeof first === "number" || /^\d+$/.test(String(first))) return typeof second === "string" ? second : "localhost";
  return "";
};

for (const [module, name] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]]) {
  const previousConnect = module[name];
  module[name] = function (...args) {
    const host = connectHost(args);
    if (!LOCAL_HOSTS.has(host)) throw createBlockError(name, host);
    return previousConnect.apply(this, args);
  };
}

const previousLookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (LOCAL_HOSTS.has(host)) return previousLookup.call(this, host, ...rest);
  const callback = rest.find((arg) => typeof arg === "function");
  if (!callback) throw createBlockError("dns", host);
  process.nextTick(() => callback(createBlockError("dns", host)));
};

for (const module of [http, https]) {
  for (const name of ["request", "get"]) {
    const previousRequest = module[name];
    module[name] = function (target, ...rest) {
      const host = typeof target === "string" || target instanceof URL ? hostOf(target) : target?.hostname ?? target?.host ?? "localhost";
      if (!LOCAL_HOSTS.has(host)) throw createBlockError(`http ${name}`, host);
      return previousRequest.call(this, target, ...rest);
    };
  }
}

syncBuiltinESMExports();

const previousFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const host = hostOf(typeof input === "string" || input instanceof URL ? input : input?.url);
  if (!LOCAL_HOSTS.has(host)) throw createBlockError("fetch", host);
  return previousFetch.call(this, input, init);
};

const PreviousWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends PreviousWebSocket {
  constructor(url, ...rest) {
    if (!LOCAL_HOSTS.has(hostOf(url))) throw createBlockError("WebSocket", hostOf(url));
    super(url, ...rest);
  }
};

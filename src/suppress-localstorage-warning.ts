// Suppress "@parity/product-sdk-logger" localStorage warning in Node.js v22+.
// The logger tries to read log-level config from localStorage which doesn't exist
// in Node.js — it emits a NoSuchNativeMethod warning we cannot fix upstream.
//
// This module is imported FIRST in bin/polkadot-app-deploy so the suppressor is
// installed before any transitive module-init code runs. In ESM, all static
// imports are evaluated before inline code in the importing file, so the
// suppressor must live in a separate module imported ahead of the SDK modules.
const _origEmitWarning = process.emitWarning.bind(process) as typeof process.emitWarning;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = (warning: string | Error, ...rest: unknown[]) => {
  const msg = (typeof warning === "string" ? warning : (warning as Error)?.message ?? String(warning)).toLowerCase();
  if (msg.includes("localstorage") || msg.includes("local storage")) return;
  (_origEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
};

export {};

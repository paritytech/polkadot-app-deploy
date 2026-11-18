/** Exits 1 unless `stack` is a testnet; for tools that fund, map, authorize or register with dev keys. */
export function exitUnlessTestnet(stack) {
  if (stack.network === "testnet") return;
  console.error(`not writing on mainnet stack ${stack.id}`);
  process.exit(1);
}

/**
 * probeSignerPopStatus — probe the *actual* signer's PoP status via DotNS.
 *
 * Extracted from the e2e before() hook so it is unit-testable with an injected
 * DotNS factory.
 *
 * COUPLING NOTE: the `//e2e-direct` derivation path used here when
 * `signer === "direct"` and `bulletinDeployEnv` is null must match the
 * `--derivation-path` flag passed by `buildArgs` in test/e2e.test.js (~line
 * 177-180). If one changes, change both.
 *
 * @param {object} opts
 * @param {() => object} opts.dotnsFactory      — returns a fresh DotNS-like instance
 * @param {string}       opts.signer             — E2E_SIGNER value ("pool" | "direct")
 * @param {string|null}  opts.bulletinDeployEnv  — PAD_ENV value (or null)
 * @param {() => Promise<object>} opts.resolveEnvConnectOptions — resolves extra connect
 *   options from environments.json when bulletinDeployEnv is set
 * @param {string}       opts.defaultMnemonic    — DEFAULT_MNEMONIC constant from the module
 * @returns {Promise<number>} PoP status as a plain JS number; 0 on any failure
 */
export async function probeSignerPopStatus({
  dotnsFactory,
  signer,
  bulletinDeployEnv,
  resolveEnvConnectOptions,
  defaultMnemonic,
}) {
  const dotns = dotnsFactory();
  try {
    // Build connect options. When bulletinDeployEnv is set, use env-resolved
    // options (unchanged from the original hook). When it is null we are on the
    // default paseo-next environment; if SIGNER is "direct" we must derive with
    // //e2e-direct so the probed H160 matches what buildArgs passes via
    // --derivation-path (see COUPLING NOTE above).
    const connectOptions = bulletinDeployEnv
      ? { mnemonic: defaultMnemonic, ...(await resolveEnvConnectOptions()) }
      : {
          mnemonic: defaultMnemonic,
          ...(signer === "direct" ? { derivationPath: "//e2e-direct" } : {}),
        };

    await dotns.connect(connectOptions);

    // evmAddress is set inside connect()'s withSpan block before it resolves.
    // If it comes back null (chain call failed but connect didn't throw), treat
    // it as a probe failure and return the conservative NoStatus default.
    if (!dotns.evmAddress) {
      return 0;
    }

    const status = await dotns.getUserPopStatus(dotns.evmAddress);
    return typeof status === "bigint" ? Number(status) : (status ?? 0);
  } catch {
    return 0;
  } finally {
    dotns.disconnect();
  }
}

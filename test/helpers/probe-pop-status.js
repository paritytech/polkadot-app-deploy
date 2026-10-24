/**
 * probeSignerPopStatus — probe the *actual* signer's PoP status via DotNS.
 *
 * Extracted from the e2e before() hook so it is unit-testable with an injected
 * DotNS factory.
 *
 * COUPLING NOTE: the derivation path applied here comes from the caller via
 * `opts.derivationPath` — it must match whatever the scenario actually deploys
 * with (see `probeDerivationPathFor()` / `directSignerArgsFor()` in
 * test/e2e.test.js). Omitted or `null` means "probe the bare mnemonic account"
 * (ROOT); there is deliberately no signer-based default (#1695).
 *
 * @param {object} opts
 * @param {() => object} opts.dotnsFactory      — returns a fresh DotNS-like instance
 * @param {string|null}  opts.bulletinDeployEnv  — PAD_ENV value (or null)
 * @param {() => Promise<object>} opts.resolveEnvConnectOptions — resolves extra connect
 *   options from environments.json when bulletinDeployEnv is set
 * @param {string}       opts.defaultMnemonic    — DEFAULT_MNEMONIC constant from the module
 * @param {string|null}  [opts.derivationPath]   — explicit derivation path for the actual
 *   per-scenario signer (see COUPLING NOTE above); omit/null = bare ROOT
 * @returns {Promise<number>} PoP status as a plain JS number; 0 on any failure
 */
export async function probeSignerPopStatus(opts) {
  const {
    dotnsFactory,
    bulletinDeployEnv,
    resolveEnvConnectOptions,
    defaultMnemonic,
  } = opts;
  const derivationPath = opts.derivationPath ?? null;

  const dotns = dotnsFactory();
  try {
    // Build connect options. When bulletinDeployEnv is set, use env-resolved
    // options (unchanged from the original hook); otherwise use the default
    // paseo-next environment. In both cases, layer the resolved derivation
    // path on top so the probed H160 matches the actual per-scenario signer
    // (see COUPLING NOTE above).
    const connectOptions = bulletinDeployEnv
      ? {
          mnemonic: defaultMnemonic,
          ...(await resolveEnvConnectOptions()),
          ...(derivationPath ? { derivationPath } : {}),
        }
      : {
          mnemonic: defaultMnemonic,
          ...(derivationPath ? { derivationPath } : {}),
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

// Shared error types. Lives in its own module so any file can throw a
// NonRetryableError without pulling in the full deploy module (avoids
// circular imports between deploy.ts and modules deploy.ts depends on).

export class NonRetryableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableError";
  }
}

/** A signer cannot fund one concrete chain submission. The stable kind lets
 * telemetry classify the mechanism without depending on mutable prose. */
export class InsufficientFundsError extends NonRetryableError {
  readonly deployErrorKind = "funding.insufficient_balance" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InsufficientFundsError";
  }
}

export const EXIT_CODE_NO_RETRY = 78;

/** How describeContractSources names an address that came from a config we
 *  ship. Shared so the classifier cannot drift from the wording it matches. */
export const SHIPPED_CONFIG_ORIGIN = "assets/environments.json shipped with polkadot-app-deploy";
export const FALLBACK_CONFIG_ORIGIN = "the built-in fallback for";

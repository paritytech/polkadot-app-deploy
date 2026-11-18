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

/** How an address error refers to a built-in stack's descriptor as its origin. Shared so the
 *  classifier cannot drift from the wording it matches. */
export const BUILT_IN_STACK_ORIGIN = "the descriptor of built-in stack";

/** Phrases of the genesis-check errors that the classifier matches; shared so it cannot drift
 *  from them. They contain no regex metacharacters, so the classifier embeds them as is. */
export const GENESIS_ERROR_PHRASES = {
  mismatch: "has genesis hash",
  timeout: "did not report its genesis hash within",
  otherEndpoint: "is not one of the stack's",
  customStack: "describes another chain",
  passedDescriptor: "the descriptor passed with --stack",
} as const;

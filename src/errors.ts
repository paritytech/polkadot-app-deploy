// Shared error types. Lives in its own module so any file can throw a
// NonRetryableError without pulling in the full deploy module (avoids
// circular imports between deploy.ts and modules deploy.ts depends on).

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

export const EXIT_CODE_NO_RETRY = 78;

/** How describeContractSources names an address that came from a config we
 *  ship. Shared so the classifier cannot drift from the wording it matches. */
export const SHIPPED_CONFIG_ORIGIN = "assets/environments.json shipped with polkadot-app-deploy";
export const FALLBACK_CONFIG_ORIGIN = "the built-in fallback for";

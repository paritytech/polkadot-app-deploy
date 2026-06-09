// Sign-in/auth facade — the ONLY auth entrypoint bulletin-deploy imports.
// Currently VENDORED (self-contained) from @parity/product-sdk-auth in ./vendor/.
// TO SWAP to the published package once available:
//   1) npm i @parity/product-sdk-auth; drop the @parity/product-sdk-{address,keys,terminal,tx} direct deps (they become transitive)
//   2) replace the bodies below with: export * from "@parity/product-sdk-auth"; + re-export the ui fns from "@parity/product-sdk-auth/ui"
//   3) delete ./vendor/
export {
    createAuthClient,
    resolveSigner,
    SignerNotAvailableError,
    requestResourceAllocation,
    summarizeOutcomes,
    DEFAULT_RESOURCES,
    createSlotAccountSigner,
    BULLETIN_RESOURCE,
} from "./vendor/index.js";
export type {
    AuthConfig,
    AuthClient,
    ResolvedSigner,
    SessionAddresses,
    ConnectResult,
    LoginStatus,
    LoginHandle,
    SessionHandle,
    LogoutStatus,
    LogoutHandle,
    AllocatableResource,
    AllocationOutcome,
    AllocationSummary,
} from "./vendor/index.js";
export { renderQrCode, renderLoginStatus, renderLogoutStatus } from "./vendor/ui/index.js";

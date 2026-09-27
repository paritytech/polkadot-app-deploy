# Product manifest

A deploy writes two kinds of manifest to dotNS text records, from one `polkadot-app-deploy.config.ts`:

- a **root manifest** on the product's base name, as the `manifest` text record — who the product is
- one **executable manifest** per modality, on `app|widget|funding|worker.<product>.<tld>`, as the `executable` text record — how to run it

Both are JSON, both carry a `$v` schema version, and both are composed from the same config file by `publishManifest`. The shapes follow the RFC at `paritytech/host-rust-core` `docs/rfcs/product-manifest.md`, which is authoritative where this document is thinner.

## Config

`polkadot-app-deploy.config.ts` default-exports a `ProductConfig`. `defineConfig` is an identity helper that exists to give editors the discriminated union for `executables`:

```ts
import { defineConfig } from "@parity/polkadot-app-deploy";

export default defineConfig({
  domain: "humanity.dot",          // the product's dotNS name, including the TLD
  displayName: "Humanity",         // shown to a person choosing the product
  description: "One identity …",   // one line, also shown to a person
  icon: { path: "./icon.png", format: "png" },  // png or jpeg, uploaded and referenced by CID
  executables: [                   // one entry per modality; kinds must be unique
    { kind: "app", path: "../dist", appVersion: [1, 4, 0] },
  ],
  trustedProducts: { dim2: ["context"] },       // optional; see below
});
```

| Field | Required | Notes |
|---|---|---|
| `domain` | yes | Must end in the TLD the target environment's registry reports, checked before any chain write |
| `displayName` | yes | Non-empty |
| `description` | yes | May be empty |
| `icon` | yes | `path` is relative to the config file; `format` is `png` or `jpeg` |
| `executables` | yes | Non-empty; one entry per `kind` |
| `trustedProducts` | no | Cross-product grants, keyed by the other product's bare label |

## Trusted products

`trustedProducts` pre-approves cross-product interactions that the Host would otherwise prompt for. Each entry names what another product may do **to this one**, and says nothing about the reverse direction:

```ts
trustedProducts: {
  dim2: ["context"],          // dim2 may act as this product's account
  gallery: ["storage"],       // gallery may read this product's host-local storage
  suite: ["all"],             // suite gets every mediated interaction, present and future
}
```

- **Keys are bare product labels with no TLD suffix** — `dim2`, never `dim2.paseo`. The Host appends the TLD of the network it resolves against. A key written with a suffix resolves to a name that does not exist, so the entry grants nothing.
- **Values are a set.** Order is not significant and duplicates collapse. `all` is a superset: `["all", "storage"]` means `["all"]`.
- **`context` is materially wider than `storage`.** It covers acting as the product's account — reading its identity, and producing signatures and ring-VRF proofs under its keys. A product granted `context` can sign as the grantor.
- **Absence, `{}` and an empty array all mean no grants**, and the Host prompts as usual.
- **A key naming a product that does not resolve is inert**, not an error. So is a product listing itself.

The composer normalises before writing: it sorts keys and grants, collapses `all`, drops empty entries and drops a self-listing. A config that differs only in ordering therefore serialises to identical bytes, which keeps the skip-if-unchanged pre-check from billing an on-chain write for a change that is not one.

### Validation is asymmetric

Publishing is strict; reading is lenient. The two run in opposite directions on purpose, and the RFC requires both:

- `validateProductConfig` **rejects** a TLD-suffixed key and an unrecognised grant value. A publisher must not emit either, and both would otherwise deploy green and grant nothing — the failure is silent at exactly the point where it is still cheap to catch.
- `validateRootManifest` **accepts** both. It models whether a Host would accept a manifest already on chain, and a Host ignores an unrecognised grant while keeping the recognised ones in the same entry. A manifest carrying a grant from a newer RFC version still has to validate.

Structural errors — `trustedProducts` not an object, a value not an array — fail on both sides.

## Byte budget

Each text record must fit the dotNS wire limit, **1024 bytes** by default, overridable with `BULLETIN_TEXT_BUDGET` for probing a raised cap. A typical root manifest uses about 180 bytes, leaving roughly 844. One grant costs about 39 bytes, so the limit sits around 39 entries.

`trustedProducts` is the only unbounded field in root manifest v1. The preflight composes every record with a placeholder CID and measures it before any upload, so an oversized config aborts with no chain writes. The check runs twice — once at config load, once inside `publishManifest` for callers using it as a library.

## Open questions

- The 1024-byte budget is this tool's conservative figure, not a value read from the chain. The dotNS team's proof-of-concept will confirm the real cap.
- `Granted` covers the three values v1 defines. Further values fit the same shape without a `$v` bump, since the ignore-unrecognised rule already covers them — but a config using one fails this tool's publish-side validation until it is added here.

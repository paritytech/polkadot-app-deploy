// test/helpers/stale-session-home.js — shared "write the real stale v0.7
// session fixture into a fresh tmp HOME" helper. whoami.test.js (in-process
// runWhoami) and auth-resolve.test.js (spawned CLI) both need the exact same
// on-disk shape: `${tmp}/.polkadot-apps/${dotDappId}_SsoSessions.json`
// containing the real stale v0.7 blob the V2 codec can't decode — kept in one
// place so a fixture path/name change only needs one edit (#234 /simplify).
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const STALE_SESSION_FIXTURE = fileURLToPath(
  new URL("../fixtures/v07-session/dot-cli_SsoSessions.json", import.meta.url),
);

/**
 * Creates a fresh tmp dir containing the stale session fixture at
 * `.polkadot-apps/${dotDappId}_SsoSessions.json`. Returns the tmp dir path —
 * use it as HOME/USERPROFILE. Caller owns cleanup (fs.rmSync(home, {recursive, force})).
 */
export async function setupStaleSessionHome(dotDappId, prefix = "pad-stale-session-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const appsDir = join(home, ".polkadot-apps");
  await mkdir(appsDir, { recursive: true });
  await copyFile(STALE_SESSION_FIXTURE, join(appsDir, `${dotDappId}_SsoSessions.json`));
  return home;
}

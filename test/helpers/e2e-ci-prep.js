import * as fs from "fs";
import * as path from "path";
import { mutateFixture } from "./e2e-fixture.js";

const tag = `${process.env.GITHUB_RUN_ID ?? "local"}-${(process.env.GITHUB_SHA ?? "dev").slice(0, 7)}`;
const { fixtureDir, expectedCid, expectedContenthash } = await mutateFixture(tag);

const buildDir = process.env.E2E_BUILD_DIR ?? "./build";
fs.mkdirSync(buildDir, { recursive: true });
for (const name of fs.readdirSync(fixtureDir)) {
  fs.copyFileSync(path.join(fixtureDir, name), path.join(buildDir, name));
}
fs.rmSync(fixtureDir, { recursive: true, force: true });

const out = process.env.GITHUB_OUTPUT;
if (out) {
  fs.appendFileSync(out, `cid=${expectedCid}\n`);
  fs.appendFileSync(out, `contenthash=${expectedContenthash}\n`);
}
console.log(`Fixture prepared in ${buildDir}: cid=${expectedCid} contenthash=${expectedContenthash}`);

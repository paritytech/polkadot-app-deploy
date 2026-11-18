// package.json engines requires Node >=22.3, the minimum of @parity/trinity-stack;
// checkNodeVersion must reject the 22.0-22.2 releases, not only majors below 22.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkNodeVersion } from "../dist/version-check.js";

const engines = JSON.parse(fs.readFileSync("package.json", "utf8")).engines.node;

test("checkNodeVersion rejects versions below the engines minor and accepts it and later", () => {
  assert.equal(engines, ">=22.3", `>> FAIL: engines: package.json must require Node >=22.3, the minimum of @parity/trinity-stack; got ${engines}`);
  for (const version of ["v20.18.0", "v22.0.0", "v22.2.9"]) {
    assert.match(checkNodeVersion(engines, version) ?? "", /requires Node\.js >=22\.3/,
      `>> FAIL: checkNodeVersion: ${version} is below engines ${engines} and must be rejected`);
  }
  for (const version of ["v22.3.0", "v22.14.0", "v23.0.0", "v26.13.0"]) {
    assert.equal(checkNodeVersion(engines, version), null,
      `>> FAIL: checkNodeVersion: ${version} satisfies engines ${engines} and must pass`);
  }
});

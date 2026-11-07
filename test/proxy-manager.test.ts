import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { requiredPythonMinor, venvPaths } from "../src/proxy-manager.ts";

test("Python requirement follows the Headroom pin", () => {
  assert.equal(requiredPythonMinor("0.42.0"), 10);
  assert.equal(requiredPythonMinor("0.30.0"), 10);
  assert.equal(requiredPythonMinor("0.43.0"), 11);
  assert.equal(requiredPythonMinor("0.43.1"), 11);
  assert.equal(requiredPythonMinor("1.0.0"), 11);
  assert.equal(requiredPythonMinor("garbage"), 10);
});

test("venv paths are under the managed home", () => {
  const paths = venvPaths("/tmp/headroom-home");
  assert.equal(paths.venvDir, join("/tmp/headroom-home", "venv"));
  assert.match(paths.python, /(bin\/python|Scripts\\python\.exe)$/);
  assert.match(paths.headroom, /(bin\/headroom|Scripts\\headroom\.exe)$/);
});

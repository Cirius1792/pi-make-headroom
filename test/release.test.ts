import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readReleaseMetadata, checkPublication, releaseNotes, verifyPack, validateReleaseRef } from "../scripts/release.mjs";

test('release dispatch must target an actual canonical stable tag, never a branch', () => {
  assert.equal(validateReleaseRef('tag', 'v0.2.0'), 'v0.2.0');
  for (const [type, name] of [['branch', 'main'], ['branch', 'v0.2.0'], ['tag', 'v0.2.0rc1'], ['tag', 'v0.2.0\n']]) {
    assert.throws(() => validateReleaseRef(type, name));
  }
});

const manifest = { name: "@cltec/pi-make-headroom", version: "0.1.1" };
const source = 'const DEFAULT_VERSION = "0.42.0";\n';
const metadata = {
  tag: "v0.1.1", version: "0.1.1", packageName: "@cltec/pi-make-headroom", headroomVersion: "0.42.0",
};
const archive = Buffer.from("a packed release");
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const cli = fileURLToPath(new URL("../scripts/release.mjs", import.meta.url));

// These tests catch accepting unsafe release identities or silently changing a tagged version.
test("release metadata retains the exact scoped identity and tagged default pin", () => {
  assert.deepEqual(readReleaseMetadata("v0.1.1", manifest, source), metadata);
  assert.equal(readReleaseMetadata("v0.1.1", manifest, source.replace("0.42.0", "0.44.1")).headroomVersion, "0.44.1");
});

for (const tag of ["0.1.1", "v01.1.1", "v0.01.1", "v0.1.01", "v0.1.1-beta.1", "v0.1.1+build", "v0.1", "v0.1.1\n", "v0.1.1;echo bad"]) {
  test(`rejects noncanonical stable tag ${JSON.stringify(tag)}`, () => {
    assert.throws(() => readReleaseMetadata(tag, manifest, source), /stable.*tag/i);
  });
}

test("rejects a tag that disagrees with the manifest before packaging", () => {
  assert.throws(() => readReleaseMetadata("v0.1.2", manifest, source), /match/i);
});

test("rejects a different npm package instead of publishing it under the trusted identity", () => {
  assert.throws(() => readReleaseMetadata("v0.1.1", { ...manifest, name: "pi-make-headroom" }, source), /package name/i);
});

for (const invalid of ["", '// no default pin\n', source + source, 'const DEFAULT_VERSION = process.env.PIN;', 'const DEFAULT_VERSION = "0.42.0\\nmalicious";']) {
  test(`fails closed on missing, ambiguous or unsafe default pin: ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => readReleaseMetadata("v0.1.1", manifest, invalid), /default.*version/i);
  });
}

test("commented or quoted pin text is not an executable default declaration", () => {
  for (const text of [`/*\n${source}*/`, `const documentation = '\\\n${source}';`, `const documentation = \`\n${source}\`;`]) {
    assert.throws(() => readReleaseMetadata("v0.1.1", manifest, text), /default.*version/i);
  }
});

test("alternate declarations and assignments cannot hide a second default", () => {
  for (const duplicate of [
    'function config() { const home = "test", DEFAULT_VERSION = "0.43.0"; }',
    'let DEFAULT_VERSION = "0.43.0";',
    'DEFAULT_VERSION = "0.43.0";',
  ]) {
    assert.throws(() => readReleaseMetadata("v0.1.1", manifest, source + duplicate), /default.*version/i);
  }
});

test("release notes show the source pin and exact npm installation command", () => {
  const notes = releaseNotes({ ...metadata, headroomVersion: "0.44.1" });
  assert.match(notes, /headroom-ai\[proxy\]==0\.44\.1/);
  assert.match(notes, /pi install npm:@cltec\/pi-make-headroom@0\.1\.1/);
  assert.match(notes, /HEADROOM_VERSION/);
});

const packed = {
  name: manifest.name, version: manifest.version, filename: "cltec-pi-make-headroom-0.1.1.tgz",
  integrity, files: ["package.json", "README.md", "LICENSE", "CHANGELOG.md", "src/index.ts"].map(path => ({ path })),
};

test("checked package metadata permits only the intended distribution", () => {
  assert.equal(verifyPack([packed], metadata), packed.filename);
  for (const path of [".env", "src/.env", "src/config/.env.production", "src/.envrc", "src/local.env", "scripts/release.mjs", "test/release.test.ts", "../secret", "src/../../.env"]) {
    assert.throws(() => verifyPack([{ ...packed, files: [...packed.files, { path }] }], metadata), /package contents/i);
  }
  assert.throws(() => verifyPack([{ ...packed, name: "another-package" }], metadata), /package identity/i);
  assert.throws(() => verifyPack([{ ...packed, version: "0.1.0" }], metadata), /package identity/i);
  assert.throws(() => verifyPack([{ ...packed, filename: "../../secret" }], metadata), /archive filename/i);
  assert.throws(() => verifyPack([], metadata), /one package/i);
});

// Only the remote registry boundary is replaced; responses exercise real HTTP classification and hashing.
test("a real registry 404 permits a new publication", async () => {
  const action = await checkPublication(metadata, archive, async (url: string) => {
    assert.equal(url, "https://registry.npmjs.org/%40cltec%2Fpi-make-headroom/0.1.1");
    return new Response('{"error":"Not found"}', { status: 404 });
  });
  assert.equal(action, "publish");
});

test("an identical registry archive allows finishing a missing GitHub release on retry", async () => {
  const action = await checkPublication(metadata, archive, async () => Response.json({
    name: manifest.name, version: manifest.version, dist: { integrity },
  }));
  assert.equal(action, "skip");
});

test("an existing version with different or missing integrity is not silently accepted", async () => {
  for (const dist of [{ integrity: "sha512-different" }, {}, { integrity: null }]) {
    await assert.rejects(checkPublication(metadata, archive, async () => Response.json({
      name: manifest.name, version: manifest.version, dist,
    })), /integrity/i);
  }
});

test("registry identity must match even if integrity is the same", async () => {
  await assert.rejects(checkPublication(metadata, archive, async () => Response.json({
    name: "another-package", version: "0.1.1", dist: { integrity },
  })), /identity/i);
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`registry HTTP ${status} is an error, not permission to publish`, async () => {
    await assert.rejects(checkPublication(metadata, archive, async () => new Response("unavailable", { status })), /registry/i);
  });
}

test("registry network errors and malformed JSON fail closed", async () => {
  await assert.rejects(checkPublication(metadata, archive, async () => { throw new Error("network down"); }), /network down/);
  await assert.rejects(checkPublication(metadata, archive, async () => new Response("not JSON", { status: 200 })));
});

test("prepare CLI packs the validated checkout and emits usable Actions metadata without publishing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "headroom-release-"));
  try {
    mkdirSync(join(cwd, "src"));
    const files = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).files;
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ ...manifest, files }));
    writeFileSync(join(cwd, "src/index.ts"), source);
    writeFileSync(join(cwd, "README.md"), "fixture readme");
    writeFileSync(join(cwd, ".env"), "DO_NOT_PACK=fixture-only");
    mkdirSync(join(cwd, "src/config"));
    for (const path of ["src/.env", "src/config/.env.production", "src/.envrc", "src/local.env"]) {
      writeFileSync(join(cwd, path), "DO_NOT_PACK=fixture-only");
    }
    const output = join(cwd, "outputs");
    const env = { ...process.env, RELEASE_REF_TYPE: 'tag', RELEASE_TAG: "v0.1.1", GITHUB_OUTPUT: output };
    execFileSync(process.execPath, [cli, "prepare"], { cwd, env, stdio: "pipe" });
    assert.match(readFileSync(output, "utf8"), /version=0\.1\.1\n/);
    assert.match(readFileSync(output, "utf8"), /headroom_version=0\.42\.0\n/);
    assert.match(readFileSync(join(cwd, "release/notes.md"), "utf8"), /headroom-ai\[proxy\]==0\.42\.0/);
    const paths = execFileSync("tar", ["-tzf", join(cwd, "release/package.tgz")], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(paths.sort(), ["package/README.md", "package/package.json", "package/src/index.ts"]);
    const firstArchive = readFileSync(join(cwd, "release/package.tgz"));
    execFileSync(process.execPath, [cli, "prepare"], { cwd, env, stdio: "pipe" });
    assert.deepEqual(readFileSync(join(cwd, "release/package.tgz")), firstArchive, "repacking on retry must preserve archive integrity");
    const invalid = spawnSync(process.execPath, [cli, "prepare"], { cwd, env: { ...env, RELEASE_TAG: "v0.1.2" }, encoding: "utf8" });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /match/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

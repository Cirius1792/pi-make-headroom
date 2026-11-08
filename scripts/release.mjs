import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@cltec/pi-make-headroom";
const REGISTRY = "https://registry.npmjs.org";

// The default belongs in the simple configuration prelude. Reject templates or
// regex/division expressions before it rather than pretending to parse all JS/TS.
function isCodePosition(source, end) {
  let state = "code";
  for (let i = 0; i < end; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "code";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") { state = "code"; i++; }
    } else if (state === "'" || state === '"') {
      if (char === "\\") i++;
      else if (char === state) state = "code";
    } else if (char === "/" && next === "/") {
      state = "line-comment"; i++;
    } else if (char === "/" && next === "*") {
      state = "block-comment"; i++;
    } else if (char === "'" || char === '"') {
      state = char;
    } else if (char === "`" || char === "/") {
      return false;
    }
  }
  return state === "code";
}

export function readReleaseMetadata(tag, manifest, source) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag ?? "");
  if (!match || match[0] !== tag) throw new Error("Expected a stable vX.Y.Z tag without leading zeroes");
  if (manifest?.name !== PACKAGE_NAME) throw new Error(`Package name must be ${PACKAGE_NAME}`);
  if (manifest.version !== match[1]) throw new Error("Tag must match package.json version exactly");

  // Count all textual assignments, including alternate declaration lists. Even
  // commented-out duplicates are rejected conservatively as ambiguous pin text.
  const assignments = source.match(/\bDEFAULT_VERSION\s*=(?!=|>)/g) ?? [];
  const pins = [...source.matchAll(/^[ \t]*const[ \t]+DEFAULT_VERSION[ \t]*=[ \t]*(["'])([^"'\r\n]+)\1[ \t]*;/gm)];
  if (assignments.length !== 1 || pins.length !== 1 || !isCodePosition(source, pins[0].index) ||
      !/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/.test(pins[0][2])) {
    throw new Error("Expected exactly one literal, safe DEFAULT_VERSION declaration");
  }
  return { tag, version: match[1], packageName: manifest.name, headroomVersion: pins[0][2] };
}

export function releaseNotes(metadata) {
  return `## Package\n\n` +
    `Published **${metadata.packageName}@${metadata.version}** on npm.\n\n` +
    `\`\`\`bash\npi install npm:${metadata.packageName}@${metadata.version}\n\`\`\`\n\n` +
    `## Default Headroom version\n\n` +
    `**\`headroom-ai[proxy]==${metadata.headroomVersion}\`**\n\n` +
    `This is the managed install default for this release, not a bundled Python package. ` +
    `An explicit \`HEADROOM_VERSION\` or \`config.json\` version overrides it.\n`;
}

export function verifyPack(result, metadata) {
  if (!Array.isArray(result) || result.length !== 1) throw new Error("Expected exactly one package from npm pack");
  const packed = result[0];
  if (packed.name !== metadata.packageName || packed.version !== metadata.version) throw new Error("Packed package identity does not match release");
  if (typeof packed.filename !== "string" || !/^[a-zA-Z0-9._-]+\.tgz$/.test(packed.filename)) throw new Error("Unsafe archive filename");
  const rootFiles = new Set(["package.json", "README.md", "LICENSE", "CHANGELOG.md"]);
  if (!Array.isArray(packed.files) || !packed.files.some(file => file.path === "package.json") ||
      !packed.files.some(file => file.path === "src/index.ts") || packed.files.some(({ path }) =>
        typeof path !== "string" || path.includes("\\") || path.split("/").some(part =>
          !part || part === "." || part === ".." || /^\.env/i.test(part) || /\.env$/i.test(part)) ||
        (!rootFiles.has(path) && !path.startsWith("src/")))) {
    throw new Error("Unexpected package contents; only src/ and approved root package files may ship");
  }
  return packed.filename;
}

export async function checkPublication(metadata, archive, request = fetch) {
  const url = `${REGISTRY}/${encodeURIComponent(metadata.packageName)}/${metadata.version}`;
  const response = await request(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (response.status === 404) return "publish";
  if (response.status !== 200) throw new Error(`npm registry lookup failed (HTTP ${response.status}); refusing to publish`);
  const existing = await response.json();
  if (existing.name !== metadata.packageName || existing.version !== metadata.version) throw new Error("npm registry package identity mismatch");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (existing.dist?.integrity !== integrity) throw new Error("Existing npm version has different or missing archive integrity; refusing to skip it");
  return "skip";
}

function output(values) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join("");
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
}

async function main() {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const metadata = readReleaseMetadata(process.env.RELEASE_TAG, manifest, readFileSync("src/index.ts", "utf8"));
  switch (process.argv[2]) {
    case "prepare": {
      mkdirSync("release", { recursive: true });
      const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", "release"], { encoding: "utf8" }));
      const filename = verifyPack(packed, metadata);
      renameSync(resolve("release", filename), resolve("release/package.tgz"));
      writeFileSync("release/notes.md", releaseNotes(metadata));
      output({ tag: metadata.tag, version: metadata.version, package_name: metadata.packageName, headroom_version: metadata.headroomVersion });
      break;
    }
    case "check-publication":
      output({ action: await checkPublication(metadata, readFileSync("release/package.tgz")) });
      break;
    default:
      throw new Error("Usage: node scripts/release.mjs prepare|check-publication (RELEASE_TAG=vX.Y.Z)");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

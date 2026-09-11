import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseStatusArgs } from "../src/command-parser.ts";
import { LIMITS } from "../src/constants.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  main: string;
  pi?: { extensions?: string[] };
  files?: string[];
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

assert.equal(pkg.name, "pi-task-observer");
assert.deepEqual(pkg.pi?.extensions, ["./src/index.ts"]);
assert.equal(pkg.main, "./src/index.ts");
assert.ok(existsSync(join(root, "src/index.ts")));
assert.ok(existsSync(join(root, "README.md")));
assert.ok(existsSync(join(root, "dev/probe/extension.ts")), "Gate 1 探针必须保留");
assert.equal(parseStatusArgs("help").ok, true);
assert.equal(LIMITS.analyzeTimeoutMs, 300_000);
assert.ok(pkg.files?.includes("src"));
assert.equal(pkg.files?.includes("tests"), false);
assert.equal(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
assert.equal(pkg.peerDependencies?.["@earendil-works/pi-tui"], "*");
assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
assert.equal(pkg.dependencies?.["@earendil-works/pi-tui"], undefined);

const packDir = mkdtempSync(join(tmpdir(), "pto-pack-"));
const packed = execFileSync("npm", ["pack", "--pack-destination", packDir, "--json"], {
  cwd: root,
  encoding: "utf8",
});
const info = JSON.parse(packed) as Array<{ filename: string; files?: Array<{ path: string }> }>;
const tarball = join(packDir, info[0]?.filename ?? "");
assert.ok(existsSync(tarball), "npm pack 应产生 tarball");
const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
assert.match(listing, /package\/src\/index\.ts/);
assert.doesNotMatch(listing, /package\/node_modules\//);
assert.doesNotMatch(listing, /package\/tests\//);
const pkgFromTar = execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
const packedPkg = JSON.parse(pkgFromTar) as { peerDependencies?: Record<string, string> };
assert.equal(packedPkg.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
assert.equal(packedPkg.peerDependencies?.["@earendil-works/pi-tui"], "*");
rmSync(packDir, { recursive: true, force: true });

console.log("package smoke ok");

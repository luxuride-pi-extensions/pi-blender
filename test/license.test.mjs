/**
 * The project license, pinned in all three places that state it.
 *
 * pi-blender is GPL-3.0-or-later (relabelled in de4c7fa / #34). Three separate
 * files assert that, and they drift independently:
 *
 *   package.json         the published metadata npm and tooling read
 *   package-lock.json    a MIRROR of the root package metadata -- nothing
 *                        regenerates it on a metadata-only edit, so it is the
 *                        one that silently keeps the old license
 *   LICENSE              the actual terms
 *
 * A stale mirror is not cosmetic. An Accepted ADR in this repo asserted the
 * project was MIT and made "MIT compliance" a criterion for future proposals,
 * which is the contract inverted for every future reader; the lockfile still
 * says MIT on trunk, and it is the most likely place that claim came from.
 *
 * This test exists so the invariant fails loudly instead of being noticed by
 * whoever happens to read the right file. It is deliberately dependency-free:
 * no Blender, no node_modules, no network -- a license check that can be
 * skipped is a license check that will be.
 *
 * Scope note: only the ROOT entry of the lockfile is checked. The
 * `"license": "MIT"` / `"Apache-2.0"` strings elsewhere in that file describe
 * dependencies and are correct as they are; asserting on the whole file would
 * fail against reality and get the test deleted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf-8");

const EXPECTED = "GPL-3.0-or-later";

test("package.json declares the project license", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(
    pkg.license,
    EXPECTED,
    `package.json license is ${JSON.stringify(pkg.license)}, expected ${EXPECTED}`,
  );
});

test("package-lock.json root entry mirrors package.json", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const root = lock.packages[""];

  assert.ok(root, "package-lock.json has no root entry at packages[\"\"]");
  assert.equal(
    root.license,
    EXPECTED,
    `package-lock.json root entry license is ${JSON.stringify(root.license)}, expected ${EXPECTED}. ` +
      `This is a metadata-only edit: run \`npm install --package-lock-only\` to resync it.`,
  );
});

test("LICENSE contains the GPL version 3 terms", () => {
  const text = read("LICENSE");

  // Both halves matter: the title proves it is the GPL, the version line proves
  // it is v3 rather than the v2 that the vendored Blender API docs are under.
  assert.match(text, /GNU GENERAL PUBLIC LICENSE/, "LICENSE is not the GNU GPL");
  assert.match(text, /Version 3, 29 June 2007/, "LICENSE is not version 3");
});

test("no file claims the project itself is MIT", () => {
  // README mentions MIT exactly once, and correctly: it attributes the project
  // this was extracted FROM. That attribution is a fact about someone else's
  // code and must not be edited to say GPL.
  const readme = read("README.md");
  const matches = [...readme.matchAll(/^.*\bMIT\b.*$/gm)];

  for (const [line] of matches) {
    assert.match(
      line,
      /Extracted from|BlenderAgent/,
      `README.md claims MIT in a context that is not a third-party attribution: ${line.trim()}`,
    );
  }
});

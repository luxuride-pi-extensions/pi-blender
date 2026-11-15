/**
 * The license split, pinned in every place that could drift.
 *
 * pi-blender is MIT. The Python that runs inside Blender is not: it is
 * GPL-3.0-or-later, and it lives in the separate `@luxuride-pi/blender-bridge`
 * package (see LICENSING.md for why Blender forces that). Two kinds of mistake
 * are possible here, and both have already happened once in this repository's
 * history, which is why this test exists:
 *
 *   1. A metadata file keeps saying something the terms no longer say. The
 *      lockfile is the usual culprit -- nothing regenerates it on a
 *      metadata-only edit, and a released version (0.1.5) went out declaring
 *      MIT while its tarball carried twenty `bpy` scripts.
 *   2. Python creeps back into this tree. A single `.py` file under `blender/`
 *      makes "MIT" false for the whole tarball, because GPL and MIT cannot
 *      describe one artifact and be simultaneously true.
 *
 * So this checks the three files that state the license AND that no Python is
 * reachable from them. It is deliberately dependency-free: no Blender, no
 * node_modules, no network -- a license check that can be skipped is a license
 * check that will be.
 *
 * Scope note: only the ROOT entry of the lockfile is checked. The
 * `"license": "MIT"` strings elsewhere in that file describe dependencies and
 * are correct as they are; asserting on the whole file would fail against
 * reality and get the test deleted.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel) => readFileSync(join(REPO, rel), "utf-8");

const EXPECTED = "MIT";

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

  assert.ok(root, 'package-lock.json has no root entry at packages[""]');
  assert.equal(
    root.license,
    EXPECTED,
    `package-lock.json root entry license is ${JSON.stringify(root.license)}, expected ${EXPECTED}. ` +
      `This is a metadata-only edit: run \`npm install --package-lock-only\` to resync it.`,
  );
});

test("LICENSE is the MIT text, with the copyright line", () => {
  const text = read("LICENSE");

  assert.match(text, /^MIT License/, "LICENSE does not start with the MIT title");
  // The holder line is the part that identifies whose grant this is; a license
  // without it still works legally but tells a reuser nothing about provenance.
  assert.match(text, /Copyright \(c\) 2026 Luxuride/, "LICENSE has no copyright holder line");
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/, "LICENSE is not the MIT warranty disclaimer");
  assert.doesNotMatch(text, /GNU GENERAL PUBLIC LICENSE/, "LICENSE still contains GPL terms");
});

test("no Python is reachable from this package", () => {
  // The boundary that keeps MIT true. If a `.py` file comes back, the correct
  // fix is to move it to the bridge package, not to delete this test.
  const python = [];
  const skip = new Set(["node_modules", ".git"]);

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".py")) python.push(full.slice(REPO.length + 1));
    }
  };
  walk(REPO);

  assert.deepEqual(
    python,
    [],
    `Python in the MIT package: ${python.join(", ")}. It belongs in @luxuride-pi/blender-bridge (GPL-3.0-or-later).`,
  );
});

test("nothing is packaged that the license does not cover", () => {
  // `files` decides what a published tarball contains, which is what a user is
  // actually granted. A GPL path left in it would be granted as MIT.
  const pkg = JSON.parse(read("package.json"));
  const entries = pkg.files ?? [];

  for (const entry of entries) {
    assert.ok(!entry.endsWith(".py"), `package.json files ships Python: ${entry}`);
    assert.ok(
      !entry.startsWith("bridge"),
      `package.json files ships the bridge package, which is GPL: ${entry}`,
    );
  }

  assert.ok(pkg.license === "MIT", "the packaged license must match the terms above");
});

test("the README states both halves of the split", () => {
  // One license line for an MIT package with a GPL dependency is how a reader
  // ends up believing the dependency is MIT too.
  const readme = read("README.md");
  assert.match(readme, /\[MIT\]\(LICENSE\)/, "README must state the extension is MIT");
  assert.match(readme, /GPL-3\.0-or-later/, "README must state the bridge package is GPL");
  assert.match(readme, /LICENSING\.md/, "README must link the reasoning");
});

test("the bundled Blender documentation keeps its own license", () => {
  // The one part of the tarball this repository does not own: API entries cut
  // from Blender's GPL-3.0-or-later docstrings, and manual excerpts under
  // CC BY-SA 4.0, indexed at runtime by blender/doc-grounding.ts. Aggregation is
  // permitted; calling the aggregate MIT is not, so the carve-out is asserted in
  // every place a reader of the tarball would look.
  const notice = read("docs/reference/NOTICE");
  assert.match(notice, /CC BY-SA 4\.0/, "NOTICE must name the manual's license");
  assert.match(notice, /GPL-3\.0-or-later/, "NOTICE must name the API docs' license");
  assert.match(notice, /COPYING\.GPL-3\.0/, "NOTICE must point at the GPL text");
  assert.match(notice, /Neither directory is MIT/i, "NOTICE must state the carve-out explicitly");

  const gpl = read("docs/reference/COPYING.GPL-3.0");
  assert.match(gpl, /GNU GENERAL PUBLIC LICENSE/, "the GPL text ships with the GPL material");
  assert.match(gpl, /Version 3, 29 June 2007/, "that text must be GPL-3");

  const readme = read("README.md");
  assert.match(readme, /docs\/reference\/api\//, "README must name the GPL directory");
  assert.match(readme, /docs\/reference\/manual\//, "README must name the CC BY-SA directory");

  const doc = read("LICENSING.md");
  assert.match(doc, /Third-party material/, "LICENSING.md must carry the carve-out section");
  assert.match(doc, /docs\/reference\/api\//, "LICENSING.md must name the GPL directory");
});

test("LICENSING.md records the Blender-side requirement and its source", () => {
  const doc = read("LICENSING.md");
  assert.match(doc, /GPL-3\.0-or-later/, "LICENSING.md must name the required license");
  assert.match(doc, /blender\.org/, "LICENSING.md must cite Blender's own statement");
  assert.match(doc, /bpy/, "LICENSING.md must say what the boundary is about");
});

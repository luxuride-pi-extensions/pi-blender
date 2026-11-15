# Licensing

This repository is **MIT**. It contains no Blender API code.

The Python that made it GPL lives in a separate package,
[`@luxuride-pi/blender-bridge`](https://github.com/luxuride-pi-extensions/pi-blender-bridge),
which is **GPL-3.0-or-later**. This document records why the line is where it is,
because the line is not a matter of taste.

## The rule

Blender is GPL-2.0-or-later (with some third-party exceptions that do not apply
here). The Blender Foundation's position on scripts:

> If you share or publish Python scripts – if they use the Blender API calls –
> have to be made available compliant to the GNU GPL as well.
>
> — [blender.org/about/license](https://www.blender.org/about/license/)

The Extensions manual makes the requirement concrete for add-ons, whose license
must be `GPL-3.0-or-later` ([licenses](https://docs.blender.org/manual/en/latest/advanced/extensions/licenses.html)).
The mechanical reason is the usual one: a script is loaded into the Blender
interpreter and calls its API, so it is one combined program with Blender rather
than a separate work ([GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html#GPLPlugins)).

Applying that to what used to be one repository:

| Part | Runs inside Blender? | Calls `bpy`? | License |
| --- | --- | --- | --- |
| `live-bridge.py`, `blank-bootstrap.py`, `readonly_guard.py`, the headless run scripts and measurement modules (`render_scene`, `scene_info`, `bake`, `export_asset`, `validation`, `fingerprint`, …) | yes | yes | GPL-3.0-or-later |
| The TypeScript extension: tool surface, launch, config, workspace, manifests, the skills and agent prompts | no | no | MIT |

The TypeScript never links a Blender library and never imports `bpy`. It spawns
`blender` as a child process and talks to it over JSON on the command line, files
in the bridge directory, and exit codes — process separation, not calls into
Blender's API. That is what makes it a separate work.

## What this means in practice

- `@luxuride-pi/blender` (this package) is MIT. Copy it, vendor it, modify it.
- `@luxuride-pi/blender-bridge` is GPL-3.0-or-later. If you distribute a modified
  copy — or a binary that embeds it — that distribution is GPL.
- The bridge package is a prerequisite, not an npm dependency (npm 12 refuses
  non-registry specs, so declaring it would break `npm ci` for everyone — see
  README). The two licenses do not conflict either way: MIT code may be
  distributed alongside GPL code, and the GPL governs the GPL parts. What MIT
  buys you is the ability to reuse the extension side on its own terms.

## Third-party material that does ship here

Two directories under `docs/reference/` are other people's work. They are not
MIT, this repository does not claim them, and they ship in the tarball on
purpose: `blender/doc-grounding.ts` indexes them at runtime so the agent can
cite Blender's own documentation instead of remembering it.

| Path | What it is | License |
| --- | --- | --- |
| `docs/reference/api/` | Blender Python API entries, operator signatures and parameter descriptions, derived from Blender's source docstrings | GPL-3.0-or-later |
| `docs/reference/manual/` | Excerpts from the Blender User Manual | CC BY-SA 4.0 |
| `docs/reference/NOTICE`, `docs/reference/LICENSE.blender-docs`, `docs/reference/COPYING.GPL-3.0` | Attribution, terms, and the full GPL text so the GPL material travels with its license | — |

This is aggregation, not derivation: separate works distributed on the same
medium, each under its own terms, which is what
[GPL FAQ §aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
permits. It is the same reasoning that lets an MIT package ship a GPL binary it
spawns rather than links. What it does not permit is calling the whole tarball
MIT — hence NOTICE, and hence the carve-out sentence in the README, and hence a
test that fails if the carve-out disappears.

If you need a purely MIT artifact, `npm pack` this repository and delete
`docs/reference/api/`; the extension still runs, and doc grounding degrades to
"No entry for …" rather than breaking.

## The boundary is a path, not a promise

`config.ts` resolves the bridge package (`resolveBridgePackageDir()`), and the
Python is never copied into this repository's tree and never ships in this
package's tarball. That keeps "MIT" and "contains GPL code" from describing the
same artifact — a claim `test/license.test.mjs` enforces by failing on any `.py`
file in the tree.

Before the split, they did: `@luxuride-pi/blender@0.1.5` was published with
`"license": "MIT"` in `package.json` while its tarball carried twenty `bpy`
scripts generated from this repository's GPL-licensed tree. That version is
defective on both counts — the manifest denies the GPL obligation the contents
create. If you are relying on 0.1.5 or earlier, treat the Python as
GPL-3.0-or-later; later releases fix the packaging.

# Critic calibration set

Eight real Blender renders, labelled, used to check that a critic's verdict
tracks the picture. `scripts/critic-calibration.mjs` scores a critic against
this manifest; `test/critic-calibration.test.mjs` checks that the labels are
true of the pixels and that the deterministic proxy can reproduce them without
reading them.

The neighbouring `test/fixtures/critic-calibration.json` is a *format* fixture:
a handful of hand-written rows that agree with themselves. This directory is the
evidence. `docs/research/critic-calibration.md` explains the metrics and the
healthy bands; this file explains the set.

## What is in it

| image | label | defect | reference | what the defect is |
| --- | --- | --- | --- | --- |
| `mug-pass-01.png` | pass | — | — | Terracotta mug, cylinder body plus torus handle |
| `arch-pass-02.png` | pass | — | — | Stone arch: two piers, two lintel blocks, keystone, plinth |
| `character-pass-03.png` | pass | — | — | Blockout figure: head, torso, arms, legs, four materials |
| `defect-collapsed-silhouette.png` | fail | `collapsed_silhouette` | `character-pass-03` | The same figure squashed to 2% height: present, unreadable |
| `defect-missing-handle.png` | fail | `missing_handle` | `mug-pass-01` | The same mug with the handle deleted |
| `defect-wrong-scale.png` | fail | `wrong_scale` | — | The figure 4.2× too wide, cropped by both frame edges |
| `defect-flat-material.png` | fail | `flat_material` | — | The mug's material replaced by unshaded mid-grey |
| `defect-clipped-exposure.png` | fail | `clipped_exposure` | — | The mug lit five stops over: most of it is pure white |

Three clean renders carry the false-positive side: a critic that calls these
broken is measuring its own nerves. Five defective renders carry the recall
side. Two of them are *modifications of a clean render in the same set*, so "a
part is gone" can be scored by comparing against the object's own clean
silhouette instead of against a human's expectation — that is what `reference`
records.

`expectedAxes` lists only the axes a label asserts. An axis that is not listed
is not claimed to be perfect; it is simply not part of the label, and the MAE
ignores it. Scoring absent expectations as 2 would make every unstated axis a
hidden assertion.

## Provenance and licence

Self-authored, MIT, no third-party assets. `scripts/generate-calibration-fixtures.py`
builds every object from Blender primitives (cylinder, torus, cubes, an ortho
camera, two area lights) and renders it, so nothing here is downloaded, traced,
or derived from someone else's artwork; there is no attribution obligation to
discharge and no licence that could later conflict with the repository's.

MIT rather than CC0 for the images: pi-blender already grants MIT over its own
artefacts (`LICENSE`, `LICENSING.md`), and adding a second licence for one
subdirectory makes the terms harder to state, not freer. The renders are
generator output, so the licence question is really about the generator, which
is MIT like the rest of the repository.

## Rendering

Fixed settings, so a regeneration reproduces the same pixels on the same Blender
version:

- Cycles, CPU, 24 samples, `seed = 0`, adaptive sampling off, denoising off,
  dithering off (dithering moves pixels by ±1 and makes hashes unstable).
- 400×300, `Standard` view transform, black world, one key and one fill area
  light, fixed wattages.
- Orthographic camera at 100 px/m, so a metre in the scene is 100 pixels in the
  render and the silhouette rules can be checked against geometry by hand.

Reproduce with Blender 5.3:

```sh
HOME=$HOME flatpak run --command=blender org.blender.Blender \
  --background --factory-startup \
  --python "$PWD/scripts/generate-calibration-fixtures.py"
```

The generator rewrites `images/` and `manifest.json` (hashes, byte sizes and the
engine version included). A different Blender version will change the samples
and therefore the hashes; regenerate on the version you intend to run in CI and
commit the result.

## Thresholds

Predictions are arithmetic over measurements, and the thresholds are the
decision boundary. They are listed in `manifest.json` (`thresholds`) and in
`DEFAULT_THRESHOLDS` in `scripts/critic-proxy.mjs`; the calibration test fails if
the two disagree, because a threshold that exists only in code cannot be reviewed
next to the labels it produces.

| threshold | value | rule |
| --- | --- | --- |
| `clippedShare` | 0.25 | share of subject pixels pinned at white before `clipped_exposure` |
| `clippedSevereShare` | 0.50 | above this, `quality` scores 0 rather than 1 |
| `flatNeutralShare` | 0.85 | share of subject palette that must be chroma-free before `flat_material` |
| `chromaNeutral` | 0.12 | per-channel `(max-min)/max` below which a palette entry is neutral |
| `partialLossShare` | 0.05 | reference silhouette share that may vanish and still be a lost part |
| `missingSevereShare` | 0.15 | above this, `completeness` scores 0 rather than 1 |
| `collapsedAreaShare` | 0.60 | area ratio under which a silhouette has collapsed |
| `collapsedHeightShare` | 0.40 | height ratio under which a silhouette has collapsed |
| `frameBleedCoverage` | 0.35 | coverage required with frame contact before `wrong_scale` |

Order matters and is deliberate: a blown-out white subject also has a neutral
palette, so clipping is ruled out before flatness; a subject that lost 97% of
its area is a collapse before it is a lost part. The rules live in
`predictFromMeasurements` in `scripts/critic-proxy.mjs`.

The spacing is wide on purpose. Measured on this set, the clean renders sit at
neutral share 0–0.33 and clipped share ~0, the flat render at 0.99 and the
clipped render at 0.95; the handle loss is 17% of the mug's silhouette and the
collapse is 3% of the figure's. A rule that needed a two-decimal threshold would
be fitting the fixture rather than measuring it.

## How to run it

```sh
# deterministic proxy: no model, no network, CI-safe
node scripts/critic-calibration.mjs test/fixtures/critic-calibration/manifest.json

# machine-readable, and the report the proxy predicted
node scripts/critic-calibration.mjs test/fixtures/critic-calibration/manifest.json --json
node scripts/critic-calibration.mjs test/fixtures/critic-calibration/manifest.json --out /tmp/proxy-report.json

# live critic: score a recorded transcript of its verdicts
node scripts/critic-calibration.mjs test/fixtures/critic-calibration/manifest.json \
  --live --reviews /tmp/critic-reviews.json
```

Live mode is opt-in and takes a transcript, not a model client: the vision critic
is the `blender-composition-critic` pi subagent, which runs outside this
repository, so the script scores what that agent recorded rather than pretending
to call it. A transcript is either a bare array of
`{id, pass, defects[], axes{}}` reviews or an object with a `reviews` array; the
`--out` report from a proxy run is a convenient template to fill in.

## How to add a case

1. Add a `Case(...)` entry to `CASES` in `scripts/generate-calibration-fixtures.py`:
   an id, a builder, `expectedAxes`, `truth` labels, and the `reference` id when
   the defect is best described relative to a clean render in the set.
2. Write the builder as a function returning the objects it created. Prefer
   reusing an existing clean builder and modifying one thing — a defect that
   changes three things proves nothing about which one the critic saw.
3. Regenerate, then check the render by eye. A label has to be visibly true.
4. If the proxy mispredicts it, that is information: either the threshold table
   needs widening for a real gap between clean and defective, or the case is one
   the proxy cannot see. Record a known miss in the gap list below rather than
   loosening a threshold until it passes.
5. Keep the set's total committed size under 500 KB. It is 213 KB now, so a new
   case has room, but not much: prefer geometry and lighting defects over more
   resolution.

## What the proxy can and cannot see

The proxy measures silhouette, palette and exposure. That covers five of the
five defects here and none of the following, which the live critic is for:

- **Seams and intersections.** Two boxes that interpenetrate look like two boxes
  that meet. The probe reports edge sharpness, not mesh contact.
- **Wrong-but-plausible proportion.** A figure with legs 20% too long has a clean
  silhouette; only a comparison against a reference shape would catch it, and
  this set has no per-object reference model.
- **A missing part on an unpaired object.** `missing_handle` is detectable
  because `mug-pass-01` exists. Without the clean reference render there is no
  measurement that says a mug should have a handle — a cylinder is a valid mug.
- **Wrong colour that is still chromatic.** A blue mug where a red one was asked
  for has a healthy palette. `flat_material` here is a *neutral* palette, which is
  a reductive claim, not a taste judgement.
- **Composition and framing intent.** `wrong_scale` is frame contact plus high
  coverage. An object deliberately cropped as a close-up measures the same.
- **Anything about the request.** The proxy never sees the prompt, so it cannot
  know that a render is a beautiful teapot where a chair was asked for.

Those gaps are the reason the set is not a substitute for the live critic. They
are listed so a healthy proxy score is not read as "the critic is calibrated" —
it is read as "the critic's measurable half agrees with the labels".

## Measured on this set

The proxy predicts all eight verdicts correctly, every defect under its own
name:

```
pass agreement 1 (8 checks)
defect recall 1 (5 checks)
  clipped_exposure   1 (1/1)
  collapsed_silhouette   1 (1/1)
  flat_material   1 (1/1)
  missing_handle   1 (1/1)
  wrong_scale   1 (1/1)
false-pass rate 0 (5 failure reviews)
axis MAE 0 (7 labelled expectations)
```

Axis MAE is 0 because each rule sets exactly the axes its label asserts and
leaves the rest at full marks — it is a check that the axes are wired to the
right defects, not evidence that a model scores nuances well.

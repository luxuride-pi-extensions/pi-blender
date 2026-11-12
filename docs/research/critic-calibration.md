# Critic calibration

A critic score is only useful if the same picture gets roughly the same
verdict twice, and if a known defect changes that verdict. Neither property is
observable from a single review, so calibration is a measurement you run
against a labelled set, not a prompt tweak.

## Why this exists

Vision-language judges are sensitive to prompt wording, image order and
sampling. A critic that always says "seven" looks stable in production because
nothing contradicts it. The failure that matters is a **false pass**: an image
with a real defect that the critic sends on. The second failure is **axis
drift**: the same defect costs two points on Monday and five on Tuesday, so the
five-iteration budget means different things on different days.

This is the same reliability problem reported for LLM judges
([Zheng et al., arXiv:2306.05685](https://arxiv.org/abs/2306.05685)), applied
to a six-axis render critique rather than free-form pairwise preference.

## Golden set

Fifteen to twenty images are enough to see a broken axis and too few to
publish a claim. Each item needs:

- a render (or review sheet) that a human has looked at;
- `truth.pass` — would a human send this to the next stage?;
- `truth.defects` — zero or more named defects (`seam`, `intersection`,
  `wrong_scale`, `missing_part`, `flat_light`, ...).

Include at least five passes and five failures. Do not source every failure
from the same module or the same camera: that measures one bug, not the critic.

The shipped `test/fixtures/critic-calibration.json` is a **format fixture**,
not evidence. Its numbers are synthetic and the script's tests assert the
arithmetic, not the critic.

## Measurement

For each image, run the critic two or three times with the production prompt
(fresh context each time) and record every verdict in this shape:

```json
{
  "images": [
    { "id": "hero-01", "truth": { "pass": false, "defects": ["seam"] } }
  ],
  "reviews": [
    {
      "id": "hero-01",
      "run": 1,
      "pass": false,
      "defects": ["seam"],
      "axes": { "accuracy": 2, "geometry": 3, "materials": 2, "completeness": 3, "quality": 2, "validity": 2 }
    }
  ]
}
```

Run:

```sh
node scripts/critic-calibration.mjs test/fixtures/critic-calibration.json
```

The script prints per-axis mean, standard deviation and variance across runs,
pass agreement with the human label, defect recall, and the estimated
false-pass rate. `--json` prints only the machine-readable report.

## What counts as calibrated

These are starting thresholds for a six-axis critic, not a law:

| Signal | Healthy | Investigate |
| --- | --- | --- |
| Axis standard deviation (same image) | ≤ 0.75 points | > 1.5 points |
| Pass agreement | ≥ 0.85 | < 0.7 |
| Defect recall | ≥ 0.8 | < 0.6 |
| False-pass rate (failures called pass) | ≤ 0.1 | > 0.2 |

A critic that scores every failure at 0 and every pass at 10 is stable but not
discriminating; check that **pass variance** is non-zero before celebrating
agreement. Conversely, high variance on one axis with stable others usually
means that axis's prompt text is carrying two different questions.

## Running it

This is a manual or scheduled measurement. It needs model calls, so it is not
part of the PR pipeline and its fixture is not a gate. Re-run it when the
critic prompt, the review-sheet layout, or the render engine changes; those are
the changes that move the numbers without touching the model.

The script is deliberately pure Node and dependency-free so it can run in the
same environment that produced the reviews, including a CI job that only
analyses already-collected verdicts.

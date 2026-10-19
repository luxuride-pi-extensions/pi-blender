"""Numeric hand-off fidelity checks for blender_geometry_probe joint family.

Computes signed world-space offset vectors and target part identification
for fixable joint severity findings (near-miss, broken-continuation,
overlapping-but-apart / detached).

When parts are of near-equal extent (ratio < 1.5x), reports ambiguous: true
rather than guessing which part to move.
"""

HANDOFF_EXTENT_RATIO = 1.5
FIXABLE_SEVERITIES = {
    "near-miss",
    "broken-continuation",
    "overlapping-but-apart",
    "detached",
}


def _round(value, digits=5):
    return round(float(value), digits)


def compute_handoff(
    first_name,
    second_name,
    first_min,
    first_max,
    second_min,
    second_max,
    severity,
    gap=None,
):
    """Compute signed world-space offset vector and target part to move.

    Reported for fixable-severity joint findings. Non-fixable findings
    (coincident-surface, buried) return None.

    When the two parts are of near-equal extent (ratio < 1.5x), reports
    {"ambiguous": True} rather than guessing which part to move.
    """
    if severity not in FIXABLE_SEVERITIES:
        return None

    extent_a = max(first_max[i] - first_min[i] for i in range(3))
    extent_b = max(second_max[i] - second_min[i] for i in range(3))

    shorter = min(extent_a, extent_b)
    longer = max(extent_a, extent_b)
    ratio = (longer / shorter) if shorter > 0.0 else float("inf")

    if ratio < HANDOFF_EXTENT_RATIO:
        return {"ambiguous": True}

    if extent_a < extent_b:
        part_to_move = first_name
        move_min, move_max = first_min, first_max
        stat_min, stat_max = second_min, second_max
    else:
        part_to_move = second_name
        move_min, move_max = second_min, second_max
        stat_min, stat_max = first_min, first_max

    offset = [0.0, 0.0, 0.0]
    has_separation = False
    for i in range(3):
        if move_min[i] > stat_max[i]:
            offset[i] = -(move_min[i] - stat_max[i])
            has_separation = True
        elif move_max[i] < stat_min[i]:
            offset[i] = stat_min[i] - move_max[i]
            has_separation = True
        else:
            offset[i] = 0.0

    if not has_separation:
        # Bounding boxes overlap on all axes (e.g. part in a void);
        # displacement direction cannot be inferred without guessing.
        return {"ambiguous": True}

    return {
        "partToMove": part_to_move,
        "offset": [_round(c) for c in offset],
        "ambiguous": False,
    }

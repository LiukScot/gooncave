"""Checks that WD14.mlpackage gives the desktop model's tags.

Usage: python3 -I check.py WD14.mlpackage selected_tags.csv
Needs macOS (Core ML runs the model), coremltools, numpy and pillow. Compares its scores with the
TensorFlow fp32 scores in reference-scores.npz for the images in core/tests/fixtures/wd14. Passes when
no score differs by more than 0.05 and the tags chosen with the thresholds of
core/src/wd14_model.rs `select` are the same, except tags whose score is within 0.01 of one.
"""
import csv
import sys
from pathlib import Path

import coremltools as ct
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
FIXTURES = HERE.parent.parent / "core" / "tests" / "fixtures" / "wd14"
# Core ML in fp32 moves a solid-colour picture's scores by up to 0.049 and keeps its tags.
MAX_DIFFERENCE = 0.05
MARGIN = 0.01


def thresholds(tags_csv):
    """The cut-off of each of the model's outputs: 0.35 for general tags, 0.5 for the others."""
    with open(tags_csv, newline="", encoding="utf-8-sig") as file:
        return np.array([0.35 if int(row["category"]) not in (1, 2, 3, 4) else 0.5 for row in csv.DictReader(file)])


def main(package, tags_csv):
    model = ct.models.MLModel(package)
    cutoff = thresholds(tags_csv)
    reference = np.load(HERE / "reference-scores.npz")
    failures = []
    for name in ("solid", "gradient", "pattern"):
        rgb = np.asarray(Image.open(FIXTURES / f"{name}-pillow.png").convert("RGB"), dtype=np.float32)
        scores = model.predict({"input_1": rgb[None, :, :, ::-1].copy()})["Identity"].reshape(-1)
        expected = reference[name]
        difference = np.abs(scores - expected).max()
        # A tag whose reference score sits next to its cut-off may fall on either side.
        flipped = (scores >= cutoff) != (expected >= cutoff)
        flipped &= np.abs(expected - cutoff) > MARGIN
        print(f"{name}: largest score difference {difference:.4f}, {int(flipped.sum())} tags differ")
        if difference > MAX_DIFFERENCE or flipped.any():
            failures.append(name)
    if failures:
        sys.exit(f"WD14.mlpackage does not match the desktop model for: {', '.join(failures)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])

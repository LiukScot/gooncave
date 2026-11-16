"""Converts the desktop WD14 model to the Core ML package the iPhone downloads.

Same model and revision as core/src/wd14_model.rs, from its Keras copy, with 16-bit weights.
Run with Python 3.12, tensorflow and coremltools 9; on Linux hide the GPU: CUDA_VISIBLE_DEVICES="".
Writes WD14.mlpackage; its three files are the assets of the GitHub release the app downloads.
"""
import coremltools as ct
import numpy as np
from huggingface_hub import snapshot_download

REVISION = "dbd4dbe553ee51feb3bc745b614fb762080e3912"

model = snapshot_download(
    "SmilingWolf/wd-v1-4-convnextv2-tagger-v2",
    revision=REVISION,
    allow_patterns=["saved_model.pb", "keras_metadata.pb", "variables/*"],
)
converted = ct.convert(
    model,
    source="tensorflow",
    convert_to="mlprogram",
    # BGR pixels from 0 to 255, as core/src/wd14_model.rs `prepare` makes them.
    inputs=[ct.TensorType(shape=(1, 448, 448, 3), dtype=np.float32)],
    # The squared sums of the GRN layers reach about 1.8e6 in the first block, past the 65504 that
    # fp16 holds, and turn every score into NaN; those layers compute in fp32.
    compute_precision=ct.transform.FP16ComputePrecision(op_selector=lambda op: "_grn/" not in op.name),
    minimum_deployment_target=ct.target.iOS16,
)
converted.save("WD14.mlpackage")

"""Converts the desktop WD14 model to the Core ML package the iPhone downloads.

Same model and revision as core/src/wd14_model.rs, from its Keras copy, in 32-bit floats:
16-bit weights change the tags of a solid-colour picture.
Run with Python 3.12, tensorflow and coremltools 9; on Linux hide the GPU: CUDA_VISIBLE_DEVICES="".
Writes WD14.mlpackage; its three files are the assets of the GitHub release the app downloads.
"""
import coremltools as ct
import coremltools.converters.mil.frontend.tensorflow2.ops  # noqa: F401  registers the TF2 converters
import numpy as np
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.frontend.tensorflow.tf_op_registry import _TF_OPS_REGISTRY, register_tf_op
from huggingface_hub import snapshot_download

REVISION = "dbd4dbe553ee51feb3bc745b614fb762080e3912"

convert_conv = _TF_OPS_REGISTRY["Conv2D"]


@register_tf_op(override=True)
def Conv2D(context, node):
    """Writes a convolution whose stride equals its kernel as a 1x1 convolution over the strided
    slices of its input. Core ML on macOS 26 computes the 2x2 stride-2 convolution of the first
    downsampling (128 channels, 112x112) wrong in fp32, and right in this form."""
    x = context[node.inputs[0]]
    kernel = context[node.inputs[1]].val
    strides = node.attr["strides"]
    size = kernel.shape[0] if kernel is not None else 0
    if not (
        node.attr.get("data_format", "NHWC") == "NHWC"
        and size > 1
        and kernel.shape[1] == size
        and list(strides) == [1, size, size, 1]
        and all(d == 1 for d in node.attr.get("dilations", [1, 1, 1, 1]))
        and x.shape[1] % size == 0
        and x.shape[2] % size == 0
    ):
        return convert_conv(context, node)
    channels_first = mb.transpose(x=x, perm=[0, 3, 1, 2])
    parts = [
        mb.slice_by_index(x=channels_first, begin=[0, 0, i, j], end=list(channels_first.shape), stride=[1, 1, size, size])
        for i in range(size)
        for j in range(size)
    ]
    # HWIO to O, then the inputs in the order of `parts`.
    weight = np.concatenate([kernel[i, j] for i in range(size) for j in range(size)], axis=0).T[:, :, None, None]
    result = mb.conv(x=mb.concat(values=parts, axis=1), weight=weight)
    context.add(node.name, mb.transpose(x=result, perm=[0, 2, 3, 1], name=node.name))


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
    compute_precision=ct.precision.FLOAT32,
    minimum_deployment_target=ct.target.iOS16,
)
converted.save("WD14.mlpackage")

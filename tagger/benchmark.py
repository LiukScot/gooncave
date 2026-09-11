from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import resource
import subprocess
import sys
import time

import numpy as np


VARIANTS = (
    ("threads-2-single", 2, 1),
    ("threads-auto-single", 0, 1),
    ("threads-4-single", 4, 1),
    ("threads-auto-batch-2", 0, 2),
    ("threads-auto-batch-4", 0, 4),
    ("threads-2-batch-8", 2, 8),
    ("threads-auto-batch-8", 0, 8),
    ("threads-4-batch-8", 4, 8),
)


def run_child(batch_size: int) -> None:
    import app

    shape = app.SESSION.get_inputs()[0].shape
    height = int(shape[1])
    width = int(shape[2])
    channels = int(shape[3])
    tensor = np.zeros((batch_size, height, width, channels), dtype=np.float32)
    app.SESSION.run(None, {app.INPUT_NAME: tensor})

    wall_samples = []
    cpu_samples = []
    output = None
    for _run in range(3):
        wall_start = time.perf_counter()
        cpu_start = time.process_time()
        output = app.SESSION.run(None, {app.INPUT_NAME: tensor})[0]
        cpu_samples.append(time.process_time() - cpu_start)
        wall_samples.append(time.perf_counter() - wall_start)
    assert output is not None
    first_row = np.asarray(output[0], dtype=np.float32)
    internal_delta = max(
        float(np.max(np.abs(np.asarray(row, dtype=np.float32) - first_row)))
        for row in output
    )

    wall_samples.sort()
    cpu_samples.sort()
    median_wall = wall_samples[1]
    sys.stdout.write(
        json.dumps(
            {
                "batchSize": batch_size,
                "medianWallMs": round(median_wall * 1000, 2),
                "medianCpuMs": round(cpu_samples[1] * 1000, 2),
                "imagesPerSecond": round(batch_size / median_wall, 2),
                "peakRssMiB": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2),
                "roundedOutputDigest": hashlib.sha256(
                    np.round(output, decimals=5).tobytes()
                ).hexdigest(),
                "batchRepeatMaxDelta": internal_delta,
                "firstRowBase64": base64.b64encode(first_row.tobytes()).decode(),
            }
        )
        + "\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child", action="store_true")
    parser.add_argument("--batch-size", type=int, default=1)
    args = parser.parse_args()
    if args.child:
        run_child(args.batch_size)
        return

    results = []
    baseline = None
    for name, threads, batch_size in VARIANTS:
        env = {**os.environ, "WD14_INTRA_OP_THREADS": str(threads)}
        completed = subprocess.run(
            [sys.executable, __file__, "--child", "--batch-size", str(batch_size)],
            check=True,
            capture_output=True,
            text=True,
            env=env,
        )
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        first_row = np.frombuffer(
            base64.b64decode(result.pop("firstRowBase64")), dtype=np.float32
        )
        if baseline is None:
            baseline = first_row
        max_delta = float(np.max(np.abs(first_row - baseline)))
        result["baselineMaxDelta"] = max_delta
        result["numericallyEquivalent"] = max_delta <= 1e-5
        results.append({"name": name, "intraOpThreads": threads, **result})

    sys.stdout.write(
        json.dumps(
            {
                "contract": {
                    "warmups": 1,
                    "measuredRuns": 3,
                    "input": "zero-valued model-sized float32 images",
                },
                "host": {
                    "platform": platform.platform(),
                    "python": platform.python_version(),
                    "logicalCpus": os.cpu_count(),
                },
                "results": results,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()

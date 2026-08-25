"""YOLO inference, run in a separate process. Never import this in the parent.

Why this file exists
--------------------
The service needs xgboost *and* torch. On macOS arm64 they cannot share a
process: they bring incompatible copies of the OpenMP runtime (torch bundles
`torch/lib/libomp.dylib`, xgboost dlopens Homebrew's keg-only
`/opt/homebrew/opt/libomp/lib/libomp.dylib`, and scikit-learn bundles a third).

Both load orders fail, and they fail differently, which is what makes this
worth a whole module:

    import xgboost -> import torch, then torch inference   HANGS FOREVER
    import torch -> import xgboost, then xgboost predict   SIGSEGV

Measured both ways. Reordering cannot win, and none of the usual escape
hatches help -- `torch.set_num_threads(1)`, `KMP_DUPLICATE_LIB_OK=TRUE` and
forcing `device="mps"` each turn the hang into a segfault instead.

The fix is to stop sharing. A **spawn**-context subprocess starts a fresh
interpreter that imports torch and nothing else from the OpenMP-using set, so
exactly one OpenMP runtime exists in it. The parent keeps xgboost and never
imports torch at all. (`fork` would not work: the child would inherit the
parent's already-loaded xgboost runtime, which is the situation being escaped.)

The cost is one long-lived worker process, ~2 s to warm up on first use, and
JPEG bytes crossing a pipe per request. For a nano classifier at 0.4 ms of
actual inference that overhead dominates -- and it is still the right trade,
because the alternative is an endpoint that hangs with no traceback.
"""

from __future__ import annotations

import io

_model = None
_class_names: list[str] = []


def init(weights_path: str) -> None:
    """ProcessPoolExecutor initializer -- load the model once per worker."""
    global _model, _class_names
    from ultralytics import YOLO

    _model = YOLO(weights_path)
    _class_names = [_model.names[i] for i in sorted(_model.names)]


def classify(image_bytes: bytes) -> dict:
    """Classify one encoded image. Returns plain types only -- it crosses a pipe.

    Ultralytics result objects hold torch tensors and a reference to the model,
    so returning one would drag torch into the parent by unpickling. Everything
    here is float/str/dict on purpose.
    """
    if _model is None:
        raise RuntimeError("vision worker was not initialised")

    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    result = _model.predict(image, verbose=False)[0]

    probs = result.probs
    if probs is None:
        raise ValueError(
            "the loaded weights are not a classification model -- "
            "`predict` returned no `probs`."
        )

    # Map by NAME, never by index: the trained model's indices are alphabetical
    # (ImageFolder), which is a different order from the dataset's data.yaml.
    return {
        "predicted_class": result.names[int(probs.top1)],
        "confidence": float(probs.top1conf),
        "class_probabilities": {result.names[i]: float(p)
                                for i, p in enumerate(probs.data.tolist())},
    }

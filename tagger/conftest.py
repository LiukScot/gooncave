"""Shared pytest fixtures for the tagger service.

The real `app.py` downloads ~400 MB of ONNX weights from HuggingFace at
import time. Tests can never do that — they set `WD14_SKIP_LOAD=1` before
importing the module, then inject a deterministic mock `SESSION`/`TAGS`/
`CATEGORIES` for each test via the `tag_app` fixture.

We also override `THRESHOLDS["general"]` to 0.5 so the mock outputs below
that cut-off get filtered, which is the property `/tag` actually owns.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Iterator

import numpy as np
import pytest

# IMPORTANT: must land before `import app` resolves so the import-time
# `load_model()` call is skipped.
os.environ.setdefault("WD14_SKIP_LOAD", "1")


@pytest.fixture
def tag_app(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """Yield the FastAPI app with a deterministic mock ONNX session.

    The mock returns scores aligned to the (tags, categories) tuple
    we inject: position 0 = high-confidence "fox" (general), position
    1 = below threshold "blurry" (general). Tests can override the
    output array via `tag_app.session_output` before issuing the request.
    """
    import app as app_module  # local import so WD14_SKIP_LOAD is honored

    class _MockSession:
        def __init__(self) -> None:
            self.output = np.array([[0.9, 0.1]], dtype=np.float32)
            self.calls = 0

        def run(self, _names: object, _feeds: dict) -> list[np.ndarray]:
            self.calls += 1
            return [self.output]

    session = _MockSession()
    monkeypatch.setattr(app_module, "SESSION", session)
    monkeypatch.setattr(app_module, "INPUT_NAME", "input")
    monkeypatch.setattr(app_module, "TAGS", ["fox", "blurry"])
    monkeypatch.setattr(app_module, "CATEGORIES", ["general", "general"])
    # The fixture attaches the mock so tests can tweak its output before
    # calling the endpoint without reaching into app_module again.
    app_module.app._test_session = session  # type: ignore[attr-defined]
    yield app_module.app


@pytest.fixture
def client_factory(tag_app: Any) -> Callable[[], Any]:
    """Return a callable that builds a fresh `TestClient` bound to `tag_app`.

    `TestClient` is the FastAPI/Starlette helper that wraps `httpx` for
    synchronous request flow — the `httpx` dependency is in
    `requirements-dev.txt`.
    """
    from fastapi.testclient import TestClient

    # raise_server_exceptions=False makes the client return a 500 response
    # instead of re-raising the handler exception, which is what a real
    # uvicorn process would do. Without this, tests for error paths can't
    # assert on the HTTP status code at all.
    return lambda: TestClient(tag_app, raise_server_exceptions=False)

"""HTTP contract tests for the WD14 tagger service.

The real ONNX session is replaced by a deterministic mock in `conftest.py`,
so each test is fully offline and reproducible. AGENTS §9: mock at the
boundary (ONNX runtime) only, not the FastAPI handler itself.
"""

from __future__ import annotations

import io
from typing import Any

import numpy as np
from PIL import Image


def _png_bytes(width: int = 4, height: int = 4) -> bytes:
    """Return a valid PNG payload of the requested size."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def test_health_returns_ok(client_factory: Any) -> None:
    client = client_factory()
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_tag_returns_tags_above_threshold(client_factory: Any, tag_app: Any) -> None:
    """A high-confidence score lands in the response, a low one does not."""
    tag_app._test_session.output = np.array([[0.9, 0.1]], dtype=np.float32)
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    tags = body["tags"]
    assert len(tags) == 1
    assert tags[0]["tag"] == "fox"
    assert tags[0]["category"] == "general"
    assert tags[0]["score"] >= 0.35  # the default general threshold


def test_tag_sorts_by_descending_score(client_factory: Any, tag_app: Any) -> None:
    """When multiple tags clear the threshold, the highest comes first."""
    tag_app._test_session.output = np.array([[0.5, 0.95]], dtype=np.float32)
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 200
    scores = [item["score"] for item in response.json()["tags"]]
    assert scores == sorted(scores, reverse=True)
    assert response.json()["tags"][0]["tag"] == "blurry"


def test_tag_empty_file_returns_empty_tags(client_factory: Any) -> None:
    """Zero-byte upload short-circuits before the ONNX call."""
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert response.status_code == 200
    assert response.json() == {"tags": []}


def test_tag_missing_file_returns_422(client_factory: Any) -> None:
    """FastAPI/Pydantic validation rejects a request with no `file` field."""
    client = client_factory()
    response = client.post("/tag")
    assert response.status_code == 422


def test_tag_invalid_image_returns_500_or_400(client_factory: Any) -> None:
    """A non-image payload makes PIL raise; the handler does NOT crash silently.

    The current handler lets PIL's `UnidentifiedImageError` bubble — that
    surfaces as a 500. If we ever wrap it in a 400 (better UX), this test
    will be the canary forcing us to update both layers in lockstep.
    """
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("garbage.png", b"not an image", "image/png")},
    )
    assert response.status_code in (400, 500)


def test_tag_does_not_leak_internal_paths_on_error(client_factory: Any) -> None:
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("garbage.png", b"not an image", "image/png")},
    )
    # AGENTS §10: don't leak server-side paths in error bodies. The current
    # handler doesn't serialize a custom body for the PIL failure, so the
    # raw text is FastAPI's default — which doesn't include filesystem
    # info. Pin that property here so a future custom handler can't
    # regress it silently.
    if response.status_code >= 400:
        body = response.text.lower()
        assert "/app" not in body
        assert "site-packages" not in body


def test_tag_calls_onnx_session_once_per_request(
    client_factory: Any, tag_app: Any
) -> None:
    """Sanity: the handler invokes the session exactly once for one request.

    Two calls would mean either a retry loop or a double-decode bug.
    """
    tag_app._test_session.calls = 0
    tag_app._test_session.output = np.array([[0.9, 0.1]], dtype=np.float32)
    client = client_factory()
    response = client.post(
        "/tag",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
    )
    assert response.status_code == 200
    assert tag_app._test_session.calls == 1

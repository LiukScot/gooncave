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


def _image_bytes(fmt: str, width: int = 4, height: int = 4) -> bytes:
    """Return a valid payload of the requested PIL format (JPEG/GIF/WEBP)."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(0, 128, 255)).save(buf, format=fmt)
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


def test_tag_requires_token_when_secret_set(client_factory: Any, monkeypatch: Any) -> None:
    """With TAGGER_SECRET set, /tag rejects a missing/wrong token and accepts the right one."""
    import app as app_module

    monkeypatch.setattr(app_module, "TAGGER_SECRET", "s3cret")
    client = client_factory()

    missing = client.post(
        "/tag", files={"file": ("sample.png", _png_bytes(), "image/png")}
    )
    assert missing.status_code == 401

    wrong = client.post(
        "/tag",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
        headers={"X-Tagger-Token": "nope"},
    )
    assert wrong.status_code == 401

    ok = client.post(
        "/tag",
        files={"file": ("sample.png", _png_bytes(), "image/png")},
        headers={"X-Tagger-Token": "s3cret"},
    )
    assert ok.status_code == 200


def test_health_open_even_with_secret(client_factory: Any, monkeypatch: Any) -> None:
    """The Docker healthcheck has no token, so /health must stay open."""
    import app as app_module

    monkeypatch.setattr(app_module, "TAGGER_SECRET", "s3cret")
    client = client_factory()
    assert client.get("/health").status_code == 200


def test_tag_open_when_secret_unset(client_factory: Any, monkeypatch: Any) -> None:
    """No secret configured → no token required (backwards-compatible default)."""
    import app as app_module

    monkeypatch.setattr(app_module, "TAGGER_SECRET", "")
    client = client_factory()
    response = client.post(
        "/tag", files={"file": ("sample.png", _png_bytes(), "image/png")}
    )
    assert response.status_code == 200


def test_tag_rejects_html_renamed_as_jpg(client_factory: Any) -> None:
    """An HTML payload renamed `.jpg` is rejected by magic-byte validation.

    The client-reported filename and content type are untrusted; only the
    file signature decides. A non-image must never reach PIL.
    """
    client = client_factory()
    response = client.post(
        "/tag",
        files={
            "file": (
                "evil.jpg",
                b"<!DOCTYPE html><html><body>nope</body></html>",
                "image/jpeg",
            )
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Unsupported image format"


def test_tag_accepts_known_image_signatures(
    client_factory: Any, tag_app: Any
) -> None:
    """JPEG, GIF and WEBP signatures all pass the magic-byte guard."""
    tag_app._test_session.output = np.array([[0.9, 0.1]], dtype=np.float32)
    client = client_factory()
    for fmt, mime in (("JPEG", "image/jpeg"), ("GIF", "image/gif"), ("WEBP", "image/webp")):
        response = client.post(
            "/tag",
            files={"file": (f"sample.{fmt.lower()}", _image_bytes(fmt), mime)},
        )
        assert response.status_code == 200, fmt


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

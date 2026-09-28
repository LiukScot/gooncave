#!/usr/bin/env python3
"""Inspect a release IPA and write reproducible artifact metadata."""

import argparse
import hashlib
import json
import plistlib
import struct
import zipfile
from pathlib import Path


def inspect(ipa: Path, source_sha: str, xcode: str, sdk: str) -> dict:
    digest = hashlib.sha256()
    with ipa.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)

    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        apps = {
            name.split("/")[1]
            for name in names
            if name.startswith("Payload/")
            and name.count("/") >= 2
            and name.split("/")[1].endswith(".app")
        }
        if len(apps) != 1:
            raise ValueError(f"expected one app under Payload, found {sorted(apps)}")
        app = apps.pop()
        root = f"Payload/{app}/"
        for name in names:
            parts = Path(name).parts
            if name.startswith("/") or ".." in parts:
                raise ValueError(f"unsafe archive path: {name}")
            if any(
                part.startswith(".env")
                or part.lower() in {"private", "secrets", "credentials"}
                or part.lower().endswith((".sqlite", ".sqlite3", ".db", ".p12", ".key"))
                for part in parts
            ):
                raise ValueError(f"private-looking file in IPA: {name}")

        info = plistlib.loads(archive.read(root + "Info.plist"))
        executable = info["CFBundleExecutable"]
        binary = archive.read(root + executable)
        if len(binary) < 32 or binary[:4] != b"\xcf\xfa\xed\xfe":
            raise ValueError("app executable is not a 64-bit Mach-O binary")
        _, cpu, _, _, commands, _, _, _ = struct.unpack_from("<8I", binary)
        if cpu != 0x0100000C:
            raise ValueError("app executable is not arm64")
        offset = 32
        platforms = set()
        for _ in range(commands):
            command, size = struct.unpack_from("<2I", binary, offset)
            if size < 8 or offset + size > len(binary):
                raise ValueError("invalid Mach-O load command")
            if command == 0x32:
                platforms.add(struct.unpack_from("<I", binary, offset + 8)[0])
            elif command == 0x25:
                platforms.add(2)
            offset += size
        if platforms != {2}:
            raise ValueError(f"expected iphoneos platform 2, found {sorted(platforms)}")
        if info["CFBundleIdentifier"] != "app.gooncave":
            raise ValueError("unexpected bundle identifier")
        if info["CFBundleSupportedPlatforms"] != ["iPhoneOS"]:
            raise ValueError("archive is not an iPhoneOS app")
        if info["UIDeviceFamily"] != [1]:
            raise ValueError("archive does not target iPhone only")
        if info["MinimumOSVersion"] != "26.0":
            raise ValueError("unexpected minimum iOS version")
        if root + "Assets.car" not in names:
            raise ValueError("app icon and asset catalog are missing")

        return {
            "sourceSha": source_sha,
            "xcode": xcode,
            "iphoneosSdk": sdk,
            "ipa": ipa.name,
            "sha256": digest.hexdigest(),
            "bytes": ipa.stat().st_size,
            "bundleId": info["CFBundleIdentifier"],
            "version": info["CFBundleShortVersionString"],
            "build": info["CFBundleVersion"],
            "minimumIos": info["MinimumOSVersion"],
            "architecture": "arm64",
            "platform": "iphoneos",
            "signing": "unsigned; installer signing required",
            "permissions": {
                key: value
                for key, value in info.items()
                if key.startswith("NS") and key.endswith("UsageDescription")
            },
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("ipa", type=Path)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--xcode", required=True)
    parser.add_argument("--sdk", required=True)
    args = parser.parse_args()
    print(json.dumps(inspect(args.ipa, args.source_sha, args.xcode, args.sdk), indent=2))


if __name__ == "__main__":
    main()

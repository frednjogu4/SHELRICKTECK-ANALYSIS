#!/usr/bin/env python3
"""Refresh/verify the two checked-in local-update ZIPs from repository files.

The archives keep their package-specific files and layout, while every member
that also exists in this repository is refreshed from the canonical working
tree. This avoids shipping a stale app, bridge, or API alongside current source.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import os
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = (
    ROOT / "FREDRICK_AURUM_LOCAL_UPDATE.zip",
    ROOT / "FREDRICK_AURUM_DEMO_UPDATE.zip",
)


def manifest(page: bytes) -> bytes:
    text = [
        "FREDRICK AURUM LOCAL UPDATE PACKAGE",
        "Source: canonical repository working tree; package copies of repository files are byte-for-byte synchronized.",
        "Contains the local PC runtime, built page, PWA assets, MT5 bridge and API source.",
        "Execution scope: Exness MT5 account and market data are read-only; broker order previews and placement are disabled.",
        "No credentials, bridge token, account details, machine-specific MT5 path, logs, or node_modules are included.",
        "Install steps: see START_HERE_LOCAL_PACKAGE.txt.",
        f"Built app SHA-256: {hashlib.sha256(page).hexdigest()}",
        "",
    ]
    return "\n".join(text).encode("utf-8")


def expected_member(member: str, prefix: str, page_manifest: bytes) -> bytes | None:
    if member == prefix + "PACKAGE_MANIFEST.txt":
        return page_manifest
    if not member.startswith(prefix) or member.endswith("/"):
        return None
    rel = member[len(prefix):]
    path = ROOT.joinpath(*Path(rel).parts)
    return path.read_bytes() if path.is_file() else None


def check_package(path: Path, refresh: bool = False) -> list[str]:
    prefix = path.stem + "/"
    if not path.is_file():
        return [f"{path.name}: missing"]
    built_page = ROOT / "dist" / "index.html"
    if not built_page.is_file():
        return ["dist/index.html is missing; run npm run build first"]
    page_bytes = built_page.read_bytes()
    page_manifest = manifest(page_bytes)
    with zipfile.ZipFile(path, "r") as src:
        entries = [(copy.copy(info), src.read(info.filename)) for info in src.infolist()]
    stale: list[str] = []
    rewritten: list[tuple[zipfile.ZipInfo, bytes]] = []
    for info, data in entries:
        expected = expected_member(info.filename, prefix, page_manifest)
        if expected is not None and expected != data:
            stale.append(info.filename[len(prefix):])
            data = expected
        rewritten.append((info, data))
    if refresh and stale:
        fd, temp_name = tempfile.mkstemp(prefix=path.stem + "-", suffix=".zip", dir=path.parent)
        os.close(fd)
        try:
            with zipfile.ZipFile(temp_name, "w") as out:
                for info, data in rewritten:
                    out.writestr(info, data)
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return stale


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--refresh", action="store_true", help="rewrite stale ZIP members from the workspace")
    action.add_argument("--check", action="store_true", help="only report whether ZIP members match")
    args = parser.parse_args()
    failed = False
    for package in PACKAGES:
        stale = check_package(package, refresh=args.refresh)
        if stale and not args.refresh:
            failed = True
            print(f"{package.name}: stale members: " + ", ".join(stale))
        elif stale:
            print(f"{package.name}: refreshed {len(stale)} members: " + ", ".join(stale))
        else:
            print(f"{package.name}: in sync")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

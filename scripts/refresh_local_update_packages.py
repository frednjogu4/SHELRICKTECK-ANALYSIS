#!/usr/bin/env python3
"""Refresh/verify the two checked-in local-update ZIPs from repository files.

The archives keep their package-specific files and layout, while every member
that also exists in this repository is refreshed from the canonical working
tree. This avoids shipping a stale app, bridge, or API alongside current source.

On top of that, every file under PACKAGE_TREES and every file in
PACKAGE_ROOT_FILES must be present in each archive. Refreshing only the
members that already exist is not enough: server/lib/proscalper.js and
server/lib/forexanalyst.js were added after the 16 November package was
built, both are imported by the frontend, and neither had been packaged.
Enumerating the required trees makes that class of omission impossible.
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

# Trees and root files every archive must carry so an extracted package can
# rebuild and serve the current app: vite resolves imports from src/ and
# server/, postbuild reads scripts/ and public/, and
# START_LOCAL_MARKET_COMMAND_CENTRE.bat needs wrangler.jsonc plus the same
# sources to run `npm run build` before serving http://127.0.0.1:8788/app.
PACKAGE_TREES = ("bridge", "server", "src", "scripts", "public", "cloudflare")
PACKAGE_ROOT_FILES = (
    "index.html",
    "vite.config.js",
    "wrangler.jsonc",
    "START_LOCAL_MARKET_COMMAND_CENTRE.bat",
    "START_ALL_LOCAL.bat",
    "SETUP_AND_RUN_LOCAL.bat",
    "RUN_LOCAL_API.bat",
    "START_LOCAL_API.bat",
    "LOCAL_HOSTING_README.md",
    "LOCAL_HOST_ONLY.txt",
    "LOCAL_UPDATE_NOTES.txt",
    "START_HERE_LOCAL_PACKAGE.txt",
    "package.json",
    "package-lock.json",
)
_SKIP_NAMES = frozenset({"__pycache__", ".DS_Store"})


def required_members() -> list[str]:
    """Repository-relative paths that every archive has to contain."""
    members: set[str] = set()
    for name in PACKAGE_ROOT_FILES:
        if ROOT.joinpath(name).is_file():
            members.add(name)
    for tree in PACKAGE_TREES:
        base = ROOT / tree
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix == ".pyc":
                continue
            if any(part in _SKIP_NAMES for part in path.parts):
                continue
            members.add(path.relative_to(ROOT).as_posix())
    return sorted(members)


def manifest(page: bytes) -> bytes:
    text = [
        "FREDRICK AURUM LOCAL UPDATE PACKAGE",
        "Source: canonical repository working tree; package copies of repository files are byte-for-byte synchronized.",
        "Contains the local PC runtime, built page, PWA assets, MT5 bridge, API and frontend source, build scripts, and launchers (START_ALL_LOCAL.bat and the dashboard-only START_LOCAL_MARKET_COMMAND_CENTRE.bat).",
        "Execution scope: manual Exness orders on the verified connected account (REAL or DEMO) after a fresh local risk preview and explicit per-order confirmation; app automation and app-side closes remain disabled.",
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
    present: set[str] = set()
    for info, data in entries:
        if info.filename.startswith(prefix):
            present.add(info.filename[len(prefix):])
        expected = expected_member(info.filename, prefix, page_manifest)
        if expected is not None and expected != data:
            stale.append(info.filename[len(prefix):])
            data = expected
        rewritten.append((info, data))
    missing = [rel for rel in required_members() if rel not in present]
    if refresh and (stale or missing):
        fd, temp_name = tempfile.mkstemp(prefix=path.stem + "-", suffix=".zip", dir=path.parent)
        os.close(fd)
        try:
            with zipfile.ZipFile(temp_name, "w") as out:
                for info, data in rewritten:
                    out.writestr(info, data)
                for rel in missing:
                    out.writestr(prefix + rel, ROOT.joinpath(*Path(rel).parts).read_bytes(),
                                 compress_type=zipfile.ZIP_DEFLATED)
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
    return stale + [f"{rel} (missing)" for rel in missing]


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

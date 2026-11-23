import hashlib
import sys
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ("FREDRICK_AURUM_LOCAL_UPDATE.zip", "FREDRICK_AURUM_DEMO_UPDATE.zip")


class LocalUpdatePackageParityTests(unittest.TestCase):
    def test_update_archives_ship_the_canonical_page_and_manual_execution_bridge(self):
        page = (ROOT / "dist" / "index.html").read_bytes()
        bridge = (ROOT / "bridge" / "mt5_bridge.py").read_bytes()
        self.assertIn(b"MT5_MANUAL_ORDER_EXECUTION_ENABLED = True", bridge)
        self.assertIn(b"App-side Exness position closing is disabled", bridge)
        digest = hashlib.sha256(page).hexdigest().encode()
        for package in PACKAGES:
            prefix = Path(package).stem + "/"
            with self.subTest(package=package), zipfile.ZipFile(ROOT / package) as archive:
                self.assertEqual(archive.read(prefix + "bridge/app.html"), page)
                self.assertEqual(archive.read(prefix + "bridge/mt5_bridge.py"), bridge)
                self.assertIn(digest, archive.read(prefix + "PACKAGE_MANIFEST.txt"))

    def test_every_overlapping_release_file_is_in_sync_with_the_workspace(self):
        result = __import__("subprocess").run(
            [sys.executable, str(ROOT / "scripts" / "refresh_local_update_packages.py"), "--check"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()

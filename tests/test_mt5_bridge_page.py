"""The page the PC bridge serves is the page the website serves.

bridge/mt5_bridge.py answers http://127.0.0.1:8788/app with bridge/app.html
and a few static files from bridge/pwa/. `npm run build` copies the built page
(dist/) into those places (scripts/pc-page.mjs). These tests start the bridge's
own page server and ask it, the way a browser does, for the page and for every
file the page refers to.

The MetaTrader5 package exists for Windows only, so the bridge is loaded
against an empty stand-in. Nothing here contacts a terminal, a broker or the
network outside this machine.
"""
import http.client
import importlib.util
import logging
import os
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGE_DIR = ROOT / "bridge"
DIST = ROOT / "dist"

# What the browser asks the PC for, and the built file it must receive.
SERVED = {
    "/app": "index.html",
    "/manifest.webmanifest": "manifest.webmanifest",
    "/sw.js": "sw.js",
    "/icons/icon-192.png": "icons/icon-192.png",
    "/icons/icon-512.png": "icons/icon-512.png",
    "/icons/icon-maskable-512.png": "icons/icon-maskable-512.png",
    "/icons/apple-touch-icon.png": "icons/apple-touch-icon.png",
    "/icons/favicon-32.png": "icons/favicon-32.png",
}


class PcPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_modules = {name: sys.modules.get(name) for name in ("MetaTrader5", "websockets")}
        sys.path.insert(0, str(BRIDGE_DIR))
        fake_websockets = types.ModuleType("websockets")
        fake_websockets.exceptions = types.SimpleNamespace(
            ConnectionClosed=type("ConnectionClosed", (Exception,), {})
        )
        sys.modules["MetaTrader5"] = types.ModuleType("MetaTrader5")
        sys.modules["websockets"] = fake_websockets
        spec = importlib.util.spec_from_file_location("mt5_bridge_page_under_test", BRIDGE_DIR / "mt5_bridge.py")
        cls.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.bridge)
        logging.disable(logging.CRITICAL)
        cls.bridge.HOST = "127.0.0.1"
        cls.server = cls.bridge._start_http_app(0)
        if cls.server is None:
            raise AssertionError("the bridge's page server did not start")
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        logging.disable(logging.NOTSET)
        sys.path.remove(str(BRIDGE_DIR))
        for name, old in cls.original_modules.items():
            if old is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = old
        sys.modules.pop("mt5_bridge_page_under_test", None)

    def get(self, path):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.putrequest("GET", path, skip_host=True)
            connection.putheader("Host", "127.0.0.1:8788")
            connection.endheaders()
            response = connection.getresponse()
            return response.status, dict((k.lower(), v) for k, v in response.getheaders()), response.read()
        finally:
            connection.close()

    def test_the_pc_serves_the_built_page_and_its_files_byte_for_byte(self):
        for path, built in SERVED.items():
            with self.subTest(path=path):
                expected = (DIST / built).read_bytes()
                status, headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertEqual(int(headers["content-length"]), len(expected))
                self.assertEqual(body, expected, f"{path} is not dist/{built}; run \"npm run build\"")

    def test_the_page_is_sent_as_html_and_under_its_other_two_addresses(self):
        page = (DIST / "index.html").read_bytes()
        for path in ("/app", "/app/", "/index.html"):
            with self.subTest(path=path):
                status, headers, body = self.get(path)
                self.assertEqual((status, headers["content-type"]), (200, "text/html; charset=utf-8"))
                self.assertEqual(body, page)

    def test_every_file_the_page_and_its_manifest_refer_to_is_served(self):
        page = (DIST / "index.html").read_text(encoding="utf-8")
        wanted = set(re.findall(r'(?:href|src)="\.?(/(?:icons/[A-Za-z0-9._-]+|manifest\.webmanifest|sw\.js))"', page))
        wanted.update(re.findall(r'"(/sw\.js)"', page))
        manifest = (DIST / "manifest.webmanifest").read_text(encoding="utf-8")
        wanted.update(re.findall(r'"src":\s*"(/icons/[A-Za-z0-9._-]+)"', manifest))
        self.assertIn("/sw.js", wanted)
        self.assertIn("/manifest.webmanifest", wanted)
        self.assertGreaterEqual(len([name for name in wanted if name.startswith("/icons/")]), 5)
        for path in sorted(wanted):
            with self.subTest(path=path):
                self.assertIn(path, self.bridge._PWA_FILES, f"the page asks for {path}, which the bridge does not serve")
                status, _headers, body = self.get(path)
                self.assertEqual(status, 200)
                self.assertGreater(len(body), 0)

    def test_the_bridge_serves_nothing_that_the_build_does_not_keep_equal(self):
        self.assertEqual(Path(self.bridge._APP_FILE), BRIDGE_DIR / "app.html")
        self.assertEqual(set(self.bridge._PWA_FILES), set(SERVED) - {"/app"})
        for path, (file_path, _content_type) in self.bridge._PWA_FILES.items():
            self.assertEqual(Path(file_path), BRIDGE_DIR / "pwa" / path.lstrip("/"))

    def test_a_replaced_page_file_is_served_at_the_next_request_without_a_restart(self):
        """What the PC needs after app.html has been replaced: a reload of the page, not a new bridge."""
        original = self.bridge._APP_FILE
        with tempfile.TemporaryDirectory() as folder:
            page = Path(folder) / "app.html"
            page.write_bytes(b"<!doctype html><title>first</title>")
            self.bridge._APP_FILE = str(page)
            try:
                self.assertEqual(self.get("/app")[2], b"<!doctype html><title>first</title>")
                page.write_bytes(b"<!doctype html><title>second</title>")
                self.assertEqual(self.get("/app")[2], b"<!doctype html><title>second</title>")
                os.remove(page)
                status, _headers, body = self.get("/app")
                self.assertEqual(status, 404)
                self.assertIn(b"app.html missing", body)
            finally:
                self.bridge._APP_FILE = original


if __name__ == "__main__":
    unittest.main()

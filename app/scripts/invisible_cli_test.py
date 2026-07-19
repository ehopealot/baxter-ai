#!/usr/bin/env python3
"""Standalone tests for invisible_cli.py's pure storage_state helpers.

The repo's main suite is `node --test` (JS); this is the one Python module with
logic worth pinning, so it ships its own assert-based runner (no pytest needed):

    python3 scripts/invisible_cli_test.py     # from app/ ; exits nonzero on failure

Covers the corrupt-storage_state self-heal helpers (see the incident the self-heal
was built for). The async browser paths (_make_context / _context_usable / the
launch quarantine+relaunch) need a real browser and are verified live, not here.
"""
import importlib.util
import json
import os
import sys
import tempfile

_spec = importlib.util.spec_from_file_location(
    "invisible_cli", os.path.join(os.path.dirname(__file__), "invisible_cli.py")
)
inv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(inv)


def test_state_is_loadable():
    d = tempfile.mkdtemp()

    def write(name, text):
        p = os.path.join(d, name)
        with open(p, "w") as fh:
            fh.write(text)
        return p

    assert inv._state_is_loadable(write("ok.json", json.dumps({"cookies": [], "origins": []}))) is True
    assert inv._state_is_loadable(write("populated.json", json.dumps({"cookies": [{"name": "a"}], "origins": [{"origin": "x"}]}))) is True
    assert inv._state_is_loadable(write("badjson.json", "{not json")) is False
    assert inv._state_is_loadable(write("wrongshape.json", json.dumps({"cookies": "nope"}))) is False
    assert inv._state_is_loadable(write("notdict.json", json.dumps([1, 2, 3]))) is False
    assert inv._state_is_loadable(os.path.join(d, "missing.json")) is False


def test_quarantine_state():
    d = tempfile.mkdtemp()
    inv.STATE_FILE = os.path.join(d, "state.json")
    with open(inv.STATE_FILE, "w") as fh:
        fh.write("garbage")
    inv._quarantine_state("test")
    assert not os.path.exists(inv.STATE_FILE), "original should be moved aside"
    assert os.path.exists(inv.STATE_FILE + ".corrupt"), "a .corrupt copy should remain"

    # A second quarantine overwrites the .corrupt copy (os.replace is atomic-replace).
    with open(inv.STATE_FILE, "w") as fh:
        fh.write("more garbage")
    inv._quarantine_state("test2")
    assert not os.path.exists(inv.STATE_FILE)
    assert os.path.exists(inv.STATE_FILE + ".corrupt")

    # Missing file -> best-effort no-op, must not raise.
    os.unlink(inv.STATE_FILE + ".corrupt")
    inv._quarantine_state("already gone")


def test_is_leaked_browser_cmd():
    assert inv._is_leaked_browser_cmd("/usr/bin/Xvfb :99 -screen 0 1920x1080x24") is True
    assert inv._is_leaked_browser_cmd("/opt/.../firefox -foreground -profile /tmp/rust_mozprofileX") is True
    assert inv._is_leaked_browser_cmd("/opt/.../firefox-bin -foreground") is True
    # MUST spare playwright-cli's chromium ('chrome'), which shares the container
    assert inv._is_leaked_browser_cmd("/opt/playwright-browsers/chromium-1232/chrome-linux/chrome --headless") is False
    assert inv._is_leaked_browser_cmd("node scripts/discord-bot.mjs") is False
    assert inv._is_leaked_browser_cmd("") is False
    # matches the EXECUTABLE only -- "firefox"/"xvfb" in a URL/message ARG must NOT
    # match (else the sweep would kill the client that ran `open https://.../firefox/`)
    assert inv._is_leaked_browser_cmd("invisible-cli open https://www.mozilla.org/firefox/new/") is False
    assert inv._is_leaked_browser_cmd("node discord-cli.mjs send 123 talking about Firefox and Xvfb") is False


def test_proc_ppid():
    d = tempfile.mkdtemp()

    def stat_dir(contents):
        pd = tempfile.mkdtemp(dir=d)
        with open(os.path.join(pd, "stat"), "w") as fh:
            fh.write(contents)
        return pd

    # normal: pid (comm) state ppid ...
    assert inv._proc_ppid(stat_dir("42 (Xvfb) S 1 42 42 0 -1 ...")) == 1
    # comm containing ') ' -- must parse the ppid AFTER the LAST ')'
    assert inv._proc_ppid(stat_dir("7 (weird ) name) S 99 7 7 ...")) == 99
    # empty stat (process exiting mid-read) -> -1, no raise
    assert inv._proc_ppid(stat_dir("")) == -1
    # no fields after the last ')' -> -1
    assert inv._proc_ppid(stat_dir("7 (x)")) == -1
    # missing stat file entirely -> -1
    assert inv._proc_ppid(tempfile.mkdtemp(dir=d)) == -1


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"ok - {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL - {t.__name__}: {exc}", file=sys.stderr)
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

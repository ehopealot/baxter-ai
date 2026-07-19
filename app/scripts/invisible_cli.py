#!/usr/bin/env python3
"""invisible-cli -- a persistent-session browser CLI backed by
invisible_playwright's anti-detect (patched Firefox) engine.

Baxter already drives Chromium through Microsoft's `playwright-cli`, but that
tool bundles playwright-core 1.62 and cannot speak the patched Firefox's
Juggler protocol (pinned to 1.55), and the stealth also depends on
invisible_playwright's own Python launcher (Firefox prefs + per-seed
fingerprint). So this is a separate browsing path with the same shape as
playwright-cli: a background daemon holds one persistent browser session
open, and each CLI invocation sends it a command over a unix socket.

Element addressing mirrors playwright-cli exactly: `snapshot` returns an
aria tree with `[ref=eN]` handles (via Playwright's internal snapshotForAI),
and every command that targets an element takes such a ref, resolved with a
`aria-ref=eN` locator. A bare selector (anything not matching `eN`) is also
accepted as a fallback.

The browser is launched once, headless (headed under a hidden Xvfb -- true
headless is itself a detection signal, which invisible_playwright avoids),
with cookies + localStorage persisted to a storage_state file (a persistent
Firefox profile crashes the patched build on relaunch -- see STATE_FILE
below) so logins survive between emails, and a fixed fingerprint seed so
Baxter presents as a consistent device.
"""
from __future__ import annotations

# The patched Firefox binary is baked into the image OUTSIDE /home/node
# (which the config volume mounts over at runtime, shadowing anything there).
# invisible_core resolves its binary cache via platformdirs, which honours
# XDG_CACHE_HOME -- point it at the baked location before importing anything
# from invisible_playwright so the daemon finds the pre-fetched binary.
import os

# Honour INVISIBLE_CACHE (exported by the Dockerfile, which uses it for the
# build-time fetch/chown) so the path lives in one place; fall back to the
# literal for a bare `python invisible_cli.py` outside the image.
os.environ.setdefault(
    "XDG_CACHE_HOME", os.environ.get("INVISIBLE_CACHE", "/opt/invisible-cache")
)

import asyncio
import json
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

# Runtime state. The socket lives in /tmp (per-container, not the volume).
# Logins persist via a storage_state JSON file on the config volume rather
# than a persistent Firefox profile dir: the patched build reliably launches
# a fresh profile but crashes on the SECOND launch of a populated persistent
# profile ("Connection closed while reading from the driver"), so we do what
# playwright-cli's own state-save/state-load do -- snapshot cookies +
# localStorage to disk and reload them into a fresh stealth context.
SOCK_PATH = "/tmp/invisible-cli.sock"
# The daemon writes its own PID here at startup so a client whose command hangs
# can kill it (and its whole browser process group) to self-recover -- see
# _kill_daemon / CMD_TIMEOUT below.
PIDFILE = "/tmp/invisible-cli.pid"
STATE_FILE = os.environ.get(
    "INVISIBLE_STATE_FILE", "/home/node/.mail-agent/invisible-state.json"
)
DAEMON_LOG = "/tmp/invisible-cli-daemon.log"
# Per-command client-side timeout (seconds). A stuck browser/daemon otherwise
# blocks the recv below until the OUTER run harness timeout (~120s) kills the
# whole process -- so bound it here, well under that, then tear the hung daemon
# down and (for `open`) reopen fresh. Must stay > a healthy command (the daemon's
# own snapshot timeout, 20s below), so default 30s; override via env.
CMD_TIMEOUT = float(os.environ.get("INVISIBLE_CLI_CMD_TIMEOUT", "30"))
# Cap on waiting for a freshly-spawned daemon's socket to appear (a healthy
# Xvfb + patched-Firefox boot is ~10-20s). A wedged LAUNCH hangs here (the
# daemon binds its socket only after the browser is up), not in recv.
CONNECT_TIMEOUT = float(os.environ.get("INVISIBLE_CLI_CONNECT_TIMEOUT", "30"))
# Total wall-clock budget (seconds) for the whole client invocation INCLUDING a
# hang + recovery, so our own teardown + error message always run instead of the
# outer harness (OPENROUTER/OPENAI_CLI_TIMEOUT_MS, default 120s) SIGKILLing us
# mid-recovery. Every blocking leg is capped at min(its own cap, budget left),
# so worst case stays under this regardless of how the legs compose.
TOTAL_BUDGET = float(os.environ.get("INVISIBLE_CLI_BUDGET", "110"))
# Fixed fingerprint seed => consistent device identity across sessions. Pair
# with the persisted storage state above. Overridable for a fresh identity.
SEED = int(os.environ.get("INVISIBLE_SEED", "424242"))

# Pin locale/timezone rather than invisible_playwright's default "auto", which
# does a geoip lookup (network + mmdb) on every launch and raises if it can't
# resolve. Fixed values keep launches fast and deterministic; override via env
# (e.g. set to "auto" if you later add a proxy and want them to track its exit).
LOCALE = os.environ.get("INVISIBLE_LOCALE", "en-US")
TIMEZONE = os.environ.get("INVISIBLE_TIMEZONE", "America/Los_Angeles")

# Commands that don't warrant a storage_state save -- everything else saves
# so a container restart without an explicit `close` doesn't lose logins.
# `find`/`snapshot`/`screenshot` are pure reads. `eval` is here for the
# common case (reading values/attributes); it *can* mutate (e.g.
# localStorage.setItem), but saving after every eval would add a browser
# round-trip + disk write to a heavily-used read path -- any such change is
# still captured by the next navigation/click or by `close`.
READ_ONLY_CMDS = frozenset({"snapshot", "find", "eval", "screenshot"})

REF_RE = re.compile(r"^e\d+$")
# snapshotForAI timeout. 10s aborted on heavy/slow pages (the stealth Firefox is
# slower, and a page still settling -- e.g. just past a Cloudflare challenge --
# needs longer); 20s gives room while staying UNDER the client's 30s CMD_TIMEOUT,
# so a slow snapshot returns an error rather than being killed as a hang. Env-tunable.
SNAPSHOT_TIMEOUT_MS = int(os.environ.get("INVISIBLE_SNAPSHOT_TIMEOUT_MS", "20000"))


# --------------------------------------------------------------------------
# Daemon: owns the browser, serves commands over a unix socket.
# --------------------------------------------------------------------------
class Daemon:
    def __init__(self) -> None:
        self._ip = None
        self._browser = None
        self._ctx = None
        self._page = None

    async def start_browser(self) -> None:
        from invisible_playwright.async_api import InvisiblePlaywright

        # No profile_dir: __aenter__ returns a Browser. The patched
        # browser.new_context is wrapped by invisible_playwright to inject the
        # stealth context defaults (viewport/UA/locale/timezone), so a context
        # created here is fully cloaked.
        self._ip = InvisiblePlaywright(
            seed=SEED, headless=True, locale=LOCALE, timezone=TIMEZONE
        )
        self._browser = await self._ip.__aenter__()
        kw = {}
        if os.path.exists(STATE_FILE):
            kw["storage_state"] = STATE_FILE  # restore cookies + localStorage
        self._ctx = await self._browser.new_context(**kw)
        self._page = await self._ctx.new_page()

    async def save_state(self) -> None:
        # Snapshot cookies + localStorage to disk so a restart (or a run that
        # forgets to `close`) keeps logins. Best-effort: a save failure must
        # not fail the command that triggered it.
        try:
            os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
            state = await self._ctx.storage_state()
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w") as fh:
                json.dump(state, fh)
            os.replace(tmp, STATE_FILE)  # atomic
        except Exception as exc:  # noqa: BLE001
            print(f"save_state failed: {exc}", file=sys.stderr, flush=True)

    async def snapshot(self) -> str:
        # Playwright's internal AI snapshot -- same source playwright-cli uses,
        # yielding `[ref=eN]` handles. Channel.send's second positional is a
        # timeout calculator (Optional[float] -> float), frozen by the 1.55 pin.
        res = await self._page._impl_obj._channel.send(
            "snapshotForAI", lambda _=None: float(SNAPSHOT_TIMEOUT_MS), {}
        )
        return res if isinstance(res, str) else str(res)

    def _target(self, ref: str):
        """Resolve a ref (eN) or a raw selector to a locator."""
        if REF_RE.match(ref):
            return self._page.locator(f"aria-ref={ref}")
        return self._page.locator(ref)

    async def handle(self, cmd: str, args: list[str]) -> dict:
        """Dispatch one command. Returns {ok, output} or {ok:False, error}.
        Mutating commands append a fresh snapshot so the caller sees the
        resulting page state, exactly like playwright-cli does."""
        page = self._page
        want_snapshot = True
        out = ""

        if cmd == "open":
            if args:
                await page.goto(args[0], wait_until="domcontentloaded")
            out = f"Page URL: {page.url}\nPage Title: {await page.title()}"
        elif cmd == "goto":
            await page.goto(args[0], wait_until="domcontentloaded")
            out = f"Page URL: {page.url}\nPage Title: {await page.title()}"
        elif cmd == "snapshot":
            want_snapshot = False
            out = await self.snapshot()
        elif cmd == "click":
            await self._target(args[0]).click()
        elif cmd == "dblclick":
            await self._target(args[0]).dblclick()
        elif cmd == "find":
            # Grep the current snapshot for a substring (case-insensitive),
            # returning matching lines -- the same idea as playwright-cli find.
            want_snapshot = False
            needle = args[0].lower()
            lines = [ln for ln in (await self.snapshot()).splitlines() if needle in ln.lower()]
            out = "\n".join(lines) if lines else f"(no snapshot nodes matching {args[0]!r})"
        elif cmd == "fill":
            await self._target(args[0]).fill(args[1])
        elif cmd == "type":
            await self._target(args[0]).press_sequentially(args[1])
        elif cmd == "press":
            await page.keyboard.press(args[0])
        elif cmd == "hover":
            await self._target(args[0]).hover()
        elif cmd == "select":
            await self._target(args[0]).select_option(args[1])
        elif cmd == "check":
            await self._target(args[0]).check()
        elif cmd == "uncheck":
            await self._target(args[0]).uncheck()
        elif cmd == "go-back":
            await page.go_back(wait_until="domcontentloaded")
        elif cmd == "go-forward":
            await page.go_forward(wait_until="domcontentloaded")
        elif cmd == "reload":
            await page.reload(wait_until="domcontentloaded")
        elif cmd == "screenshot":
            path = args[0] if args else "screenshot.png"
            await page.screenshot(path=path, full_page=False)
            want_snapshot = False
            out = f"Saved screenshot to {path}"
        elif cmd == "eval":
            want_snapshot = False
            if len(args) > 1:  # eval <expr> <ref> -> evaluate against element
                out = repr(await self._target(args[1]).evaluate(args[0]))
            else:
                out = repr(await page.evaluate(args[0]))
        else:
            return {"ok": False, "error": f"unknown command: {cmd}"}

        if cmd not in READ_ONLY_CMDS:
            await self.save_state()
        if want_snapshot:
            snap = await self.snapshot()
            out = (out + "\n" if out else "") + "### Snapshot\n" + snap
        return {"ok": True, "output": out}

    async def serve(self) -> None:
        await self.start_browser()
        # Remove a stale socket from a previous crashed daemon.
        try:
            os.unlink(SOCK_PATH)
        except FileNotFoundError:
            pass
        server = await asyncio.start_unix_server(self._client, path=SOCK_PATH)
        async with server:
            await server.serve_forever()

    async def _client(self, reader, writer) -> None:
        try:
            line = await reader.readline()
            if not line:
                return
            req = json.loads(line)
            cmd = req.get("cmd", "")
            args = req.get("args", [])
            if cmd == "close":
                # Unlink the listening socket BEFORE the (seconds-long) browser
                # teardown so a new client can't connect to this dying daemon
                # mid-shutdown -- that would run against a closing page and
                # fail with TargetClosedError. With the socket gone, the next
                # client finds nothing and spawns a fresh daemon. The already-
                # accepted connection below is a separate fd, unaffected.
                try:
                    os.unlink(SOCK_PATH)
                except FileNotFoundError:
                    pass
                resp = {"ok": True, "output": "closing"}
                writer.write((json.dumps(resp) + "\n").encode())
                await writer.drain()
                await self._shutdown()
                return
            try:
                resp = await self.handle(cmd, args)
            except Exception as exc:  # noqa: BLE001 -- report, never crash daemon
                resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
            writer.write((json.dumps(resp) + "\n").encode())
            await writer.drain()
        finally:
            writer.close()

    async def _shutdown(self) -> None:
        # Socket already unlinked by the close handler before this runs.
        try:
            await self.save_state()
            if self._ip is not None:
                await self._ip.__aexit__(None, None, None)
        finally:
            try:
                os.unlink(SOCK_PATH)
            except FileNotFoundError:
                pass
            # Only remove the pidfile if it STILL names us. The `close` handler
            # unlinks the socket + replies before this seconds-long teardown, so
            # the next `open` can spawn a fresh daemon immediately -- that new
            # daemon may already have written its own PID here. Unlinking blindly
            # would delete the new daemon's pidfile and silently disable hang
            # self-recovery for the whole new session.
            try:
                with open(PIDFILE) as fh:
                    still_mine = fh.read().strip() == str(os.getpid())
                if still_mine:
                    os.unlink(PIDFILE)
            except OSError:
                pass
            os._exit(0)


def run_daemon() -> None:
    # Record our PID (== process-group id, since _spawn_daemon starts us in a new
    # session) so a client with a hung command can kill this daemon + its browser
    # children as a group. Best-effort: a failure here just disables self-recovery.
    try:
        with open(PIDFILE, "w") as fh:
            fh.write(str(os.getpid()))
    except OSError:
        pass
    asyncio.run(Daemon().serve())


# --------------------------------------------------------------------------
# Client: connect to the daemon (starting it on `open` if needed), send one
# command, print the result.
# --------------------------------------------------------------------------
def _connect(timeout: float = 0.0):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    # Monotonic, to match the caller's total budget: a wall-clock step (NTP /
    # container clock sync) mustn't stretch this leg past TOTAL_BUDGET.
    deadline = time.monotonic() + timeout
    while True:
        try:
            s.connect(SOCK_PATH)
            return s
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                s.close()
                return None
            time.sleep(0.1)


def _spawn_daemon() -> None:
    log = open(DAEMON_LOG, "ab")
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--daemon"],
        stdout=log,
        stderr=log,
        start_new_session=True,  # detach: survives this client process exit
    )


def _kill_daemon() -> None:
    """Tear down a hung daemon and its browser. The daemon is a session leader
    (start_new_session), so its PID == its process-group id -- SIGKILLing the
    group takes the daemon, Firefox, and Xvfb down together. Then clear the
    socket + pidfile so the next command spawns a clean one. All best-effort."""
    pid = None
    try:
        with open(PIDFILE) as fh:
            pid = int(fh.read().strip())
    except (OSError, ValueError):
        pid = None
    if pid:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    for path in (SOCK_PATH, PIDFILE):
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _remaining(deadline: float) -> float:
    """Seconds left before the total-budget deadline (never negative)."""
    return max(0.0, deadline - time.monotonic())


def _try_command(sock, cmd, args, deadline):
    """Send one command and read its reply, capped at min(CMD_TIMEOUT, budget
    left). Returns the raw response bytes on success. On a hang (the daemon
    never answers in time), kill the stuck daemon + browser and return None.
    Closes `sock`."""
    timeout = min(CMD_TIMEOUT, _remaining(deadline))
    if timeout <= 0:
        sock.close()
        _kill_daemon()
        return None
    # Bound the WHOLE reply read against one leg deadline, not each recv: a reply
    # is routinely multi-chunk (a snapshot dwarfs one 64 KiB recv), so a daemon
    # that dribbles chunks just under a per-recv timeout would re-arm the clock
    # indefinitely and blow past the budget into the outer SIGKILL.
    leg_deadline = time.monotonic() + timeout
    try:
        sock.settimeout(timeout)
        sock.sendall((json.dumps({"cmd": cmd, "args": args}) + "\n").encode())
        buf = b""
        while not buf.endswith(b"\n"):
            left = leg_deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError
            sock.settimeout(left)
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
        return buf
    except (socket.timeout, TimeoutError):
        _kill_daemon()
        return None
    finally:
        sock.close()


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "--daemon":
        run_daemon()
        return 0
    if not argv:
        print("usage: invisible-cli <command> [args...]", file=sys.stderr)
        print(
            "commands: open goto snapshot find click dblclick fill type press "
            "hover select check uncheck go-back go-forward reload screenshot "
            "eval close",
            file=sys.stderr,
        )
        return 2

    cmd, args = argv[0], argv[1:]

    # Whole-invocation wall-clock deadline: a hang + recovery must finish (and
    # emit its cleanup + error) before the outer harness SIGKILLs us at ~120s.
    deadline = time.monotonic() + TOTAL_BUDGET

    sock = _connect()
    if sock is None:
        # No daemon yet. Only `open` may start one -- every other command
        # needs an already-open page, matching playwright-cli's behaviour.
        if cmd != "open":
            print(
                "No browser session is open. Run `invisible-cli open [url]` first.",
                file=sys.stderr,
            )
            return 1
        _spawn_daemon()
        # first launch fetches nothing but boots Xvfb+FF; a WEDGED launch hangs
        # here (socket never binds), so on failure kill the stuck group too.
        sock = _connect(timeout=min(CONNECT_TIMEOUT, _remaining(deadline)))
        if sock is None:
            _kill_daemon()
            print(
                f"Failed to start the browser daemon (it was reset); see {DAEMON_LOG}.",
                file=sys.stderr,
            )
            return 1

    buf = _try_command(sock, cmd, args, deadline)
    if buf is None:
        # The command hung; _try_command already killed the stuck daemon + its
        # browser. For `open`, do the close-and-reopen: spawn a fresh daemon and
        # retry once (a hung launch usually succeeds on a clean browser). Other
        # commands have no session to resume -- the caller must re-`open`.
        if cmd == "open":
            _spawn_daemon()
            sock = _connect(timeout=min(CONNECT_TIMEOUT, _remaining(deadline)))
            if sock is not None:
                buf = _try_command(sock, cmd, args, deadline)
            else:
                _kill_daemon()  # the reopened launch wedged too -- don't leak it
        if buf is None:
            msg = (
                f"invisible-cli: `{cmd}` hung for >{int(CMD_TIMEOUT)}s "
                "(the browser was stuck); it has been reset."
            )
            if cmd != "open":
                msg += " Run `invisible-cli open [url]` to start a fresh session."
            msg += f" See {DAEMON_LOG}."
            print(msg, file=sys.stderr)
            return 1

    if not buf.strip():
        print("No response from browser daemon (it may have crashed).", file=sys.stderr)
        return 1
    try:
        # A daemon that closes the connection mid-reply leaves a partial,
        # non-empty buffer here -- report it like a crash instead of dumping
        # an uncaught traceback. Catch ValueError, not just JSONDecodeError:
        # json.loads on bytes can also raise UnicodeDecodeError (both are
        # ValueError subclasses) on garbled/truncated multi-byte input.
        resp = json.loads(buf)
    except ValueError:
        print("Partial/garbled response from browser daemon (it may have crashed).", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print(resp.get("output", ""))
        return 0
    print(f"Error: {resp.get('error', 'unknown error')}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())

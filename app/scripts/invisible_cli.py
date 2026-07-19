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
# down and (for `open`) reopen fresh. Must stay > the daemon's own reply time; the
# daemon caps a whole dispatch at DISPATCH_TIMEOUT below, which tracks this value
# (see the ordering caveats there). Default 30s; override via env.
CMD_TIMEOUT = float(os.environ.get("INVISIBLE_CLI_CMD_TIMEOUT", "30"))
# Daemon-side cap on a WHOLE command dispatch (action + save_state + auto-snapshot,
# each op bounded below but composing past a single op timeout). Kept 5s under
# CMD_TIMEOUT so a slow-but-successful compound returns a clean TimeoutError reply
# (session + cookies intact) instead of the client SIGKILLing the browser. NOTE the
# ordering (dispatch cap < client CMD_TIMEOUT) holds because client + daemon share
# ONE per-container env: this is derived from CMD_TIMEOUT as the DAEMON sees it at
# spawn, so a client run with a *different* INVISIBLE_CLI_CMD_TIMEOUT against an
# already-running daemon won't re-derive it, and CMD_TIMEOUT <= 10 erodes the 5s
# margin. Both are out-of-scope edge configs here. See _client().
DISPATCH_TIMEOUT = max(5.0, CMD_TIMEOUT - 5.0)
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
# Default navigation/action timeout for the stealth context (goto/click/fill/...).
# Bounded like the snapshot so a single op gives up under the client's CMD_TIMEOUT;
# DISPATCH_TIMEOUT caps the whole compound reply on top of this.
ACTION_TIMEOUT_MS = int(os.environ.get("INVISIBLE_ACTION_TIMEOUT_MS", "20000"))


def _state_is_loadable(path: str) -> bool:
    """Cheap structural check on a storage_state file: valid JSON object with
    list-typed cookies/origins. Does NOT catch a semantically-toxic-but-valid
    state (e.g. one a crashing browser wrote that loads fine yet leaves the
    browsing context broken) -- start_browser's launch self-test covers that."""
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return False
    return (
        isinstance(data, dict)
        and isinstance(data.get("cookies", []), list)
        and isinstance(data.get("origins", []), list)
    )


def _is_leaked_browser_cmd(cmd: str) -> bool:
    """True for a stealth-browser Xvfb or (patched) Firefox process, matched on the
    EXECUTABLE (argv[0] basename) -- NOT a substring of the whole command line, so a
    URL/message arg containing "firefox" (e.g. `open https://.../firefox/`, which is
    in the spawning CLIENT's own argv) can't get it killed. Spares playwright-cli's
    chromium ('chrome'), which shares the container."""
    exe = os.path.basename(cmd.split(" ", 1)[0]).lower()
    return exe == "xvfb" or exe.startswith("firefox")


def _proc_ppid(pid_dir: str) -> int:
    """Parent PID from /proc/<pid>/stat, or -1 if unreadable/malformed (a process
    exiting mid-read can read back empty). comm (field 2) may contain spaces/parens,
    so read the fields AFTER the last ')': [state, ppid, ...]. Never raises -- a -1
    is treated as "not an orphan" (spared), so a vanishing process is never killed."""
    try:
        with open(os.path.join(pid_dir, "stat"), "rb") as fh:
            stat = fh.read().decode("ascii", "replace")
        return int(stat.rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return -1


def _sweep_stale_browser_state() -> None:
    """Run at daemon startup: SIGKILL ORPHANED Xvfb/Firefox left by a PREVIOUSLY
    crashed daemon and clear stale X locks + Firefox profile dirs, BEFORE this daemon
    launches its own browser. Reaps the live-orphan half of the leak that -- under a
    crash-retry storm -- accreted hundreds of Xvfb + zombie processes and bricked the
    container (the zombie half is reaped by the container's init:true).

    Orphan = reparented to PID 1. This is what a CRASHED daemon's leftovers become;
    it deliberately spares (a) a CLOSING daemon's still-live browser mid-save_state
    (its children still have the live daemon as parent -- the socket is unlinked
    before the seconds-long _shutdown, so a fresh daemon can already be sweeping) and
    (b) transient sibling-run commands. Best-effort; never blocks startup."""
    import glob
    import shutil

    mypid = os.getpid()
    killed = 0
    spared = False  # a matched browser we did NOT kill (a closing daemon's live child)
    for pid_dir in glob.glob("/proc/[0-9]*"):
        try:
            pid = int(os.path.basename(pid_dir))
            if pid == mypid:
                continue
            with open(os.path.join(pid_dir, "cmdline"), "rb") as fh:
                cmd = fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
            if not (cmd and _is_leaked_browser_cmd(cmd)):
                continue
            if _proc_ppid(pid_dir) != 1:  # only orphans (crash leftovers), not a closing daemon's live children
                spared = True
                continue
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except (OSError, ValueError):
            continue  # process vanished / unreadable / kill raced an exit
    # Only clear stale locks/profiles when NO live browser was spared: those files
    # belong to a closing daemon's still-running Xvfb/Firefox, and deleting its
    # X-lock (making display :N look free) or profile dir mid-teardown re-creates the
    # close->open race the PPID gate above avoids. Defer to the next sweep.
    if not spared:
        for pat in ("/tmp/.X*-lock", "/tmp/rust_mozprofile*", "/tmp/mozrunner*"):
            for p in glob.glob(pat):
                try:
                    shutil.rmtree(p) if os.path.isdir(p) else os.unlink(p)
                except OSError:
                    pass
    if killed:
        print(f"invisible-cli: swept {killed} orphaned browser process(es) from a prior crash", file=sys.stderr, flush=True)


def _quarantine_state(reason: str) -> None:
    """Move a bad storage_state aside (best-effort) so the NEXT launch starts fresh
    instead of reloading it -- a corrupt state persists on the config volume and
    otherwise bricks every launch until a human clears it. Keeps one .corrupt copy
    for post-mortem; if the move fails, delete it rather than leave it to reload."""
    dst = STATE_FILE + ".corrupt"
    try:
        os.replace(STATE_FILE, dst)
        print(f"invisible-cli: quarantined storage_state ({reason}) -> {dst}", file=sys.stderr, flush=True)
    except OSError as exc:
        print(f"invisible-cli: dropping bad storage_state ({reason}); move failed: {exc}", file=sys.stderr, flush=True)
        try:
            os.unlink(STATE_FILE)
        except OSError:
            pass


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
        # Discard an obviously-corrupt state file (bad JSON / wrong shape) up front.
        if os.path.exists(STATE_FILE) and not _state_is_loadable(STATE_FILE):
            _quarantine_state("not valid storage_state JSON")
        use_state = os.path.exists(STATE_FILE)
        try:
            await self._make_context(use_state)
        except Exception:  # noqa: BLE001 -- a state Playwright REJECTS at context
            # creation (e.g. cookies missing required name/value/domain) passes the
            # shallow shape check above but raises here; without this it propagates
            # out of serve() and kills the daemon PRE-BIND on every launch -- the same
            # permanent brick. Quarantine + retry fresh.
            if not use_state:
                raise  # no state to blame -- the browser itself is broken
            _quarantine_state("rejected at context creation")
            if self._ctx is not None:  # new_context succeeded but a later step (new_page) failed
                try:
                    await self._ctx.close()  # don't orphan it in the long-lived browser
                except Exception:  # noqa: BLE001 -- teardown of a broken ctx, best-effort
                    pass
            use_state = False
            await self._make_context(False)
        # A structurally-valid but toxic state (e.g. written by a crashing browser)
        # loads fine yet leaves the browsing context broken -- every navigation then
        # fails with "browsingContext is undefined". Probe it once; if broken,
        # quarantine the state and relaunch with a FRESH context, so a bad state
        # self-heals on THIS launch instead of bricking every command until a human
        # clears the file (the incident this whole path exists for).
        if use_state and not await self._context_usable():
            _quarantine_state("loaded but broke the browsing context")
            try:
                await self._ctx.close()
            except Exception:  # noqa: BLE001 -- teardown of a broken ctx, best-effort
                pass
            await self._make_context(False)

    async def _make_context(self, use_state: bool) -> None:
        kw = {}
        if use_state and os.path.exists(STATE_FILE):
            kw["storage_state"] = STATE_FILE  # restore cookies + localStorage
        self._ctx = await self._browser.new_context(**kw)
        # Bound the daemon's OWN navigation/action timeouts under the client's
        # CMD_TIMEOUT (30s), mirroring SNAPSHOT_TIMEOUT_MS: a page that never fires
        # domcontentloaded (a stuck bot-wall) must let goto/click/etc. give up +
        # reply a clean `{"ok": false, "error": "TimeoutError"}` BEFORE the client's
        # deadline, else the client declares a hang and SIGKILLs the browser --
        # losing the session (and any Cloudflare clearance cookies). Stock Playwright
        # defaults are 30s, exactly the client's give-up; 20s keeps the margin.
        self._ctx.set_default_navigation_timeout(ACTION_TIMEOUT_MS)
        self._ctx.set_default_timeout(ACTION_TIMEOUT_MS)
        self._page = await self._ctx.new_page()

    async def _context_usable(self) -> bool:
        """Cheap probe that the context can actually navigate -- an about:blank goto
        exercises the same Page.navigate/browsingContext path that a toxic state
        breaks. True = usable; False (and logged) = quarantine + relaunch fresh."""
        try:
            await self._page.goto("about:blank", timeout=8000)
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"context self-test failed: {exc}", file=sys.stderr, flush=True)
            return False

    async def save_state(self) -> None:
        # Snapshot cookies + localStorage to disk so a restart (or a run that
        # forgets to `close`) keeps logins. Best-effort: a save failure must
        # not fail the command that triggered it.
        # DON'T save from a dead/disconnected browser: storage_state() on a crashing
        # browser can return garbage that, once written atomically over the good
        # file, breaks EVERY future launch (browsingContext undefined) -- the root
        # cause of the "won't recover after resets" incident. Keep the last good
        # state instead. (start_browser's self-heal is the backstop if one slips by.)
        if self._browser is not None and not self._browser.is_connected():
            print("save_state skipped: browser not connected", file=sys.stderr, flush=True)
            return
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
                # Cap the whole dispatch under the client's CMD_TIMEOUT: a mutating
                # command composes an action + auto-snapshot that can each run to
                # their own 20s bound (~40s together), past the client's 30s hang
                # kill. wait_for -> a clean TimeoutError reply (caught below), so the
                # session + cookies survive instead of the client SIGKILLing them.
                resp = await asyncio.wait_for(self.handle(cmd, args), timeout=DISPATCH_TIMEOUT)
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
    # Reap orphaned Xvfb/Firefox + stale locks from a PRIOR crashed daemon before we
    # launch our own -- stops the resource leak from accreting across crashes.
    _sweep_stale_browser_state()
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

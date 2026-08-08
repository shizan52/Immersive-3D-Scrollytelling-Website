#!/usr/bin/env python3
"""
run.py — see the whole site locally, at its real domain.

    python run.py             build if needed, serve, open the browser
    python run.py --rebuild   force a fresh build first
    python run.py --stop      remove the hosts entries and exit (cleanup only)
    python run.py --no-open   start the server but do not open a browser

What it does, and why each part is needed:

  1. Points bdeducationcenter.online and www.bdeducationcenter.online at 127.0.0.1 in the
     Windows hosts file. That is what lets you type the real domain into Chrome and land
     on this machine instead of the internet.
  2. Serves on port 80, so the URL needs no ":8080" and looks exactly like production.
  3. Runs the same `node build.mjs serve` the real server would: pre-compressed .br/.gz,
     correct MIME types, cache headers, the apex -> www redirect, and the /api/chat
     endpoint for the assistant (it reads the OpenRouter key from .env).
  4. Puts the hosts file back exactly as it was when you stop it (Ctrl+C).

Steps 1 and 2 both require Administrator on Windows, so the script relaunches itself
elevated if it is not already. Nothing is uploaded and nothing on your server is touched.
"""

from __future__ import annotations

import argparse
import atexit
import ctypes
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
HOSTS = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "drivers" / "etc" / "hosts"

APEX = "bdeducationcenter.online"
WWW = f"www.{APEX}"
PORT = 80
ADMIN_PORT = 5000
URL = f"http://{WWW}/"

BEGIN = "# >>> bdec local preview >>>"
END = "# <<< bdec local preview <<<"

# Files that, if newer than the build output, mean dist/ is stale.
SOURCES = ["index.html", "styles.css", "app.js", "hero.js", "scene.js", "chat.js", "build.mjs"]


# --------------------------------------------------------------------------- output
def say(msg: str) -> None:
    print(f"  {msg}", flush=True)


def step(msg: str) -> None:
    print(f"\n\033[36m▸ {msg}\033[0m", flush=True)


def warn(msg: str) -> None:
    print(f"\033[33m  ! {msg}\033[0m", flush=True)


def die(msg: str, code: int = 1) -> None:
    print(f"\033[31m\n  ✖ {msg}\033[0m", flush=True)
    # When UAC relaunched us we are in a brand-new console window; exiting would close it
    # instantly and the reason would never be read. Hold it open.
    if "--elevated" in sys.argv:
        try:
            input("\n  Press Enter to close…")
        except EOFError:
            pass
    sys.exit(code)


# ----------------------------------------------------------------------- elevation
def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def relaunch_elevated(argv: list[str]) -> None:
    """Re-run this script through the UAC prompt, then exit the unprivileged copy."""
    print("\n  Administrator rights are needed (hosts file + port 80).")
    print("  A UAC prompt will appear — accept it, and the site opens in a new window.\n")
    params = " ".join(f'"{a}"' for a in [str(Path(__file__).resolve()), *argv, "--elevated"])
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, params, str(ROOT), 1)
    if rc <= 32:  # ShellExecute returns <= 32 on failure, including "user said no"
        die(
            "Administrator rights are required to edit the hosts file and bind port 80.\n"
            "    Right-click PowerShell → Run as administrator, then run:  python run.py"
        )
    sys.exit(0)


# --------------------------------------------------------------------------- hosts
def read_hosts() -> str:
    try:
        return HOSTS.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return ""
    except PermissionError:
        die(f"cannot read {HOSTS} — run this as Administrator")
    return ""


def strip_block(text: str) -> str:
    """Remove our managed block, leaving everything else byte-for-byte alone."""
    return re.sub(
        rf"\n?{re.escape(BEGIN)}.*?{re.escape(END)}\n?",
        "\n",
        text,
        flags=re.S,
    )


def write_hosts(text: str) -> None:
    try:
        HOSTS.write_text(text, encoding="utf-8")
    except PermissionError:
        die(f"cannot write {HOSTS} — run this as Administrator")


def hosts_add() -> None:
    current = read_hosts()
    cleaned = strip_block(current).rstrip("\r\n")

    # If something else already maps these names, say so — a stale entry from another
    # tool would silently win and the preview would show the wrong thing.
    for line in cleaned.splitlines():
        bare = line.split("#", 1)[0].strip()
        if not bare:
            continue
        names = bare.split()[1:]
        if APEX in names or WWW in names:
            warn(f"an existing hosts entry already mentions the domain: {line.strip()}")

    block = f"{BEGIN}\n127.0.0.1 {APEX}\n127.0.0.1 {WWW}\n::1 {APEX}\n::1 {WWW}\n{END}"
    write_hosts(cleaned + "\n\n" + block + "\n")
    say(f"hosts: {APEX} and {WWW} → 127.0.0.1")
    flush_dns()


def hosts_remove(quiet: bool = False) -> None:
    current = read_hosts()
    if BEGIN not in current:
        if not quiet:
            say("hosts: nothing of ours to remove")
        return
    write_hosts(strip_block(current).rstrip("\r\n") + "\n")
    if not quiet:
        say("hosts: entries removed, file restored")
    flush_dns()


def flush_dns() -> None:
    subprocess.run(["ipconfig", "/flushdns"], capture_output=True, check=False)


# --------------------------------------------------------------------------- build
def node_exe() -> str:
    exe = shutil.which("node")
    if not exe:
        die("node was not found on PATH. Install Node.js 18+ and try again.")
    return exe


def dist_is_stale() -> bool:
    index = ROOT / "dist" / "index.html"
    if not index.exists():
        return True
    built = index.stat().st_mtime
    for name in SOURCES:
        p = ROOT / name
        if p.exists() and p.stat().st_mtime > built:
            return True
    public = ROOT / "public"
    if public.exists():
        for p in public.rglob("*"):
            if p.is_file() and p.stat().st_mtime > built:
                return True
    return False


def build() -> None:
    step("Building the site")
    r = subprocess.run([node_exe(), "build.mjs"], cwd=ROOT, text=True,
                       capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print(r.stdout or "", flush=True)
        print(r.stderr or "", flush=True)
        die("build failed — fix the error above and re-run")
    # Echo just the summary lines the build prints at the end.
    for line in (r.stdout or "").splitlines():
        if line.strip().startswith(("initial", "hero chunk", "scene", "TOTAL", "built in")):
            say(line.strip())


# --------------------------------------------------------------------------- serve
def port_owner(port: int) -> str | None:
    """If the port is taken, name the process holding it so the message is useful."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return None
        except OSError:
            pass
    try:
        out = subprocess.run(["netstat", "-ano", "-p", "TCP"], capture_output=True,
                             text=True, check=False).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 5 and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
                pid = parts[4]
                name = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                                      capture_output=True, text=True, check=False).stdout
                proc = name.split(",")[0].strip('" \r\n') if "," in name else "unknown"
                return f"{proc} (pid {pid})"
    except Exception:
        pass
    return "another process"


def wait_ready(timeout: float = 25.0) -> dict | None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/health", timeout=2) as r:
                import json
                return json.loads(r.read().decode())
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.3)
    return None


def wait_url(url: str, timeout: float = 20.0) -> bool:
    """True once the URL answers with anything at all (even 401 means it is listening)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except urllib.error.HTTPError:
            return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.3)
    return False


# ---------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser(description="Run the BD Education Centre site locally at its real domain.")
    ap.add_argument("--rebuild", action="store_true", help="force a fresh build")
    ap.add_argument("--stop", action="store_true", help="remove hosts entries and exit")
    ap.add_argument("--no-open", action="store_true", help="do not open a browser")
    ap.add_argument("--elevated", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if os.name != "nt":
        die("run.py targets Windows (hosts file path and elevation are Windows-specific).")

    if not is_admin():
        relaunch_elevated(sys.argv[1:])

    if args.stop:
        step("Cleaning up")
        hosts_remove()
        return

    print("\n\033[1m  BD Education Centre — local preview\033[0m")

    # ---- build
    if args.rebuild or dist_is_stale():
        build()
    else:
        step("Build is current")
        say("dist/ is newer than every source file — skipping the build (use --rebuild to force)")

    # ---- port
    step(f"Checking port {PORT}")
    owner = port_owner(PORT)
    if owner:
        die(f"port {PORT} is already in use by {owner}.\n"
            f"    Stop it and re-run, or serve on another port with:  "
            f"$env:PORT=8080; node build.mjs serve")
    say(f"port {PORT} is free")

    # ---- hosts
    step("Pointing the domain at this machine")
    hosts_add()
    atexit.register(hosts_remove, True)

    # ---- admin / API
    # The registration form and the content panel live in admin.py. The site server
    # forwards /api/* to it, so both have to be up for the whole site to work.
    step("Starting the admin panel")
    admin = None
    if (ROOT / "admin.py").exists():
        admin = subprocess.Popen([sys.executable, "admin.py", "--port", str(ADMIN_PORT)],
                                 cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
        if wait_url(f"http://127.0.0.1:{ADMIN_PORT}/api/session"):
            say(f"admin + registration API on port {ADMIN_PORT}")
        else:
            warn("admin.py did not answer — the panel and the registration form will not work")
            warn(f"  run it yourself to see the error:  python admin.py --port {ADMIN_PORT}")
    else:
        warn("admin.py not found — registration and the content panel are unavailable")

    # ---- server
    step("Starting the server")
    env = {**os.environ, "PORT": str(PORT), "ADMIN_PORT": str(ADMIN_PORT)}
    proc = subprocess.Popen([node_exe(), "build.mjs", "serve"], cwd=ROOT, env=env)

    health = wait_ready()
    if health is None:
        proc.terminate()
        if admin:
            admin.terminate()
        die("the server did not come up in time — run `node build.mjs serve` directly to see why")

    say(f"serving dist/ on port {PORT}")
    if health.get("chat"):
        say(f"assistant is live ({health['models'][0]})")
    else:
        warn("assistant is OFF — no OPENROUTER_API_KEY in .env, the chat button will fall back to #contact")

    print(f"""
\033[1;32m  ✔ Ready\033[0m

    Site         \033[4m{URL}\033[0m
    Registration \033[4m{URL}register.html\033[0m
    Admin panel  \033[4mhttp://127.0.0.1:{ADMIN_PORT}/admin\033[0m
    Apex         http://{APEX}/          (301 → www, same as production)
    Perf HUD     {URL}#perf

  Press \033[1mCtrl+C\033[0m to stop — the hosts file is restored automatically.
""", flush=True)

    if not args.no_open:
        webbrowser.open(URL)

    # ---- run until interrupted
    try:
        proc.wait()
    except KeyboardInterrupt:
        pass
    finally:
        step("Stopping")
        for name, p in (("server", proc), ("admin", admin)):
            if p and p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill()
                say(f"{name} stopped")
        hosts_remove()
        print()


if __name__ == "__main__":
    main()

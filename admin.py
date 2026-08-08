#!/usr/bin/env python3
"""
admin.py — the content panel and the registration backend.

    python admin.py                 http://127.0.0.1:5000/admin
    python admin.py --port 5000
    python admin.py --set-password   change the admin password

What lives here:

  /admin              the panel (admin.html) — password protected
  /api/register       PUBLIC. The registration form posts here; rows go to data/bdec.db
  /api/content        GET/PUT the working draft (site.draft.json)
  /api/publish        draft -> site.json -> `node build.mjs` -> live in dist/
  /api/upload         image upload; resized and converted to WebP on the way in
  /api/registrations  list / search / export / delete
  /preview/           serves the *draft* rendered site, so you see edits before publishing

Two files hold the content:
  site.json        what is published — the build reads only this
  site.draft.json  what you are editing — created on first edit, deleted on publish

That split is the whole point of the Publish button: a half-finished sentence never
reaches a visitor, and Discard is always one click away.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from flask import (Flask, abort, jsonify, request, send_file,
                       send_from_directory, session)
except ImportError:
    sys.exit("Flask is missing.  pip install flask pillow")

try:
    from PIL import Image, ImageOps
except ImportError:
    sys.exit("Pillow is missing.  pip install pillow")

# iPhones save photos as HEIC by default, and Pillow cannot open one on its own — every
# picture straight off an iPhone was rejected as "not a readable image". This teaches
# Pillow the format; without the package everything else still works, JPEG and PNG included.
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIC_OK = True
except Exception:                                            # noqa: BLE001
    HEIC_OK = False

ROOT = Path(__file__).resolve().parent
SITE = ROOT / "site.json"
DRAFT = ROOT / "site.draft.json"
DATA = ROOT / "data"
DB = DATA / "bdec.db"
UPLOADS = ROOT / "public" / "uploads"
DIST = ROOT / "dist"
SECRET_FILE = DATA / "admin.secret"

# No password ever lives in this file. On first run a random one is generated, printed to
# the console once, and immediately hashed with PBKDF2 into data/admin.secret — only the
# hash is ever stored or compared against.

# Phone-sized, deliberately. A photo off a modern phone is 3-12 MB and a short clip is
# routinely 20-40 MB; the old 8 MB video ceiling rejected almost everything anyone would
# actually film, and the failure looked like "upload does not work" rather than "too big".
MAX_UPLOAD_MB = 64              # request ceiling — must exceed the video cap below
MAX_VIDEO_MB = 40               # a clip still has to cross a home upstream link
VIDEO_WARN_MB = 8               # above this the panel warns, but still accepts
IMAGE_MAX_WIDTH = 1800          # nothing on this site is displayed wider
WEBP_QUALITY = 82

# Storage ceilings. The site runs on one laptop shared with other projects, so nothing is
# allowed to grow without bound: superseded uploads are collected on every publish, only
# the last couple of content versions are kept, and the registration table is a rolling
# window rather than an archive.
KEEP_BACKUPS = 2
KEEP_REGISTRATIONS = 20

SETTINGS_FILE = DATA / "settings.json"

app = Flask(__name__, static_folder=None)
app.config.update(
    MAX_CONTENT_LENGTH=MAX_UPLOAD_MB * 1024 * 1024,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=60 * 60 * 12,
)


@app.errorhandler(413)
def too_large(_e):
    """
    A file past MAX_CONTENT_LENGTH is refused by Flask before any handler runs, and the
    default reply is an HTML page. The panel expects JSON, so it could not read the reason
    and showed nothing at all — which is what "the upload just does nothing" looked like.
    """
    return jsonify(error=f"File is too large — maximum {MAX_UPLOAD_MB} MB allowed."), 413


# ═════════════════════════════════════════════════════════════════ password

def _hash(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)


def save_password(password: str, *, is_default: bool = False) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    salt = secrets.token_bytes(16)
    SECRET_FILE.write_text(json.dumps({
        "salt": salt.hex(),
        "hash": _hash(password, salt).hex(),
        "session_key": secrets.token_hex(32),
        "is_default": is_default,
    }), encoding="utf-8")
    try:
        os.chmod(SECRET_FILE, 0o600)
    except OSError:
        pass


def load_secret() -> dict:
    if not SECRET_FILE.exists():
        pw = secrets.token_urlsafe(9)
        save_password(pw, is_default=True)
        print(f"\n  \033[33mfirst run — admin password generated: {pw}\033[0m")
        print("  write it down now; change it from the panel's Settings tab afterwards.\n")
    return json.loads(SECRET_FILE.read_text(encoding="utf-8"))


def check_password(password: str) -> bool:
    s = load_secret()
    expect = bytes.fromhex(s["hash"])
    got = _hash(password, bytes.fromhex(s["salt"]))
    return hmac.compare_digest(expect, got)   # constant time — no timing oracle


# ═══════════════════════════════════════════════════════════════════ store

def db() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS registrations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            first_name TEXT    NOT NULL,
            last_name  TEXT    NOT NULL,
            phone      TEXT    NOT NULL,
            gender     TEXT    NOT NULL,
            created_at TEXT    NOT NULL,
            ip         TEXT
        )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reg_created ON registrations(created_at DESC)")

    # Added after the first rows were already being taken, so it has to be a migration
    # rather than part of CREATE TABLE — the live database is not rebuilt on deploy.
    have = {r["name"] for r in conn.execute("PRAGMA table_info(registrations)")}
    if "course" not in have:
        conn.execute("ALTER TABLE registrations ADD COLUMN course TEXT")

    conn.commit()
    return conn


def course_options() -> list[str]:
    """
    The courses someone can pick, taken from the fee cards.

    One source of truth: the owner edits the fees in the panel and the registration form
    follows. A separate list would drift the first time a price changed.
    """
    names = []
    try:
        content = read_site(draft=DRAFT.exists())
        for sec in content.get("sections", []):
            for blk in sec.get("blocks", []):
                if blk.get("type") == "fees":
                    for item in blk.get("items", []):
                        name = re.sub(r"<[^>]+>", "", str(item.get("name", ""))).strip()
                        if name and name not in names:
                            names.append(name)
    except Exception:                                        # noqa: BLE001
        pass
    return names


def settings() -> dict:
    """Operational settings that are not website content — Telegram links live here."""
    if SETTINGS_FILE.exists():
        try:
            return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"telegram": {"chats": []}}


def save_settings(data: dict) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_site(draft: bool = False) -> dict:
    """The draft if one exists (and was asked for), else the published content."""
    path = DRAFT if (draft and DRAFT.exists()) else SITE
    return json.loads(path.read_text(encoding="utf-8"))


def write_draft(data: dict) -> None:
    DRAFT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ══════════════════════════════════════════════════════════════════ guards

def logged_in() -> bool:
    return bool(session.get("ok"))


def require_login():
    if not logged_in():
        abort(401)


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["X-Frame-Options"] = "SAMEORIGIN"   # the preview iframe is same-origin
    return resp


# ════════════════════════════════════════════════════════════════════ auth

_login_attempts: dict[str, list[float]] = {}


@app.post("/api/login")
def api_login():
    ip = request.remote_addr or "?"
    now = time.time()
    tries = [t for t in _login_attempts.get(ip, []) if now - t < 300]
    if len(tries) >= 8:
        return jsonify(error="Too many attempts — try again in 5 minutes"), 429

    password = (request.json or {}).get("password", "")
    if not check_password(password):
        tries.append(now)
        _login_attempts[ip] = tries
        return jsonify(error="Wrong password"), 401

    _login_attempts.pop(ip, None)
    session.clear()
    session["ok"] = True
    session.permanent = True
    return jsonify(ok=True)


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/session")
def api_session():
    return jsonify(ok=logged_in(), draft=DRAFT.exists())


@app.post("/api/password")
def api_password():
    require_login()
    body = request.json or {}
    if not check_password(body.get("current", "")):
        return jsonify(error="Current password did not match"), 400
    new = body.get("new", "")
    if len(new) < 6:
        return jsonify(error="New password must be at least 6 characters"), 400
    save_password(new)
    return jsonify(ok=True)


# ═════════════════════════════════════════════════════════════════ content

@app.get("/api/content")
def api_content_get():
    require_login()
    return jsonify(content=read_site(draft=True), draft=DRAFT.exists())


@app.put("/api/content")
def api_content_put():
    require_login()
    body = request.json or {}
    content = body.get("content")
    if not isinstance(content, dict) or "sections" not in content:
        return jsonify(error="content structure is invalid"), 400
    write_draft(content)
    return jsonify(ok=True, draft=True)


@app.post("/api/discard")
def api_discard():
    require_login()
    DRAFT.unlink(missing_ok=True)
    return jsonify(ok=True, content=read_site())


@app.post("/api/publish")
def api_publish():
    """Draft -> site.json -> rebuild. The site is only ever swapped by a real build."""
    require_login()
    if not DRAFT.exists():
        return jsonify(error="No changes to publish"), 400

    content = read_site(draft=True)
    backup = DATA / "backups"
    backup.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    # Keep the outgoing version so a bad publish can be undone.
    if SITE.exists():
        (backup / f"site-{stamp}.json").write_text(SITE.read_text(encoding="utf-8"), encoding="utf-8")
        old = sorted(backup.glob("site-*.json"))
        for stale in old[:-KEEP_BACKUPS]:
            stale.unlink(missing_ok=True)

    SITE.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")

    # Collect uploads nothing points at any more. Replacing an image, deleting a block or
    # swapping a hero video all leave an orphan behind; this is the one place that has to
    # know about it, and it runs on every publish.
    removed = sweep_uploads(content)

    started = time.time()
    proc = subprocess.run(["node", "build.mjs"], cwd=ROOT, capture_output=True,
                          text=True, encoding="utf-8", errors="replace", shell=(os.name == "nt"))
    if proc.returncode != 0:
        return jsonify(error="build failed",
                       detail=(proc.stderr or proc.stdout or "")[-1500:]), 500

    DRAFT.unlink(missing_ok=True)
    summary = [l.strip() for l in (proc.stdout or "").splitlines()
               if l.strip().startswith(("initial", "TOTAL", "built in"))]

    # Say so if the page now points at a picture that is not there. Reporting "published"
    # over a broken image is how the owner ends up staring at a live site wondering why
    # what they just saved is not showing.
    broken = missing_media(content)

    return jsonify(ok=True, seconds=round(time.time() - started, 1),
                   summary=summary, cleaned=removed, missing=broken)


# An upload is not referenced by anything for the few seconds between the file landing
# and the editor saving the block that points at it. Publishing inside that window used
# to delete the picture the owner had just chosen — it happened, twice, and the content
# was left pointing at files that no longer existed. Nothing this young is ever swept.
SWEEP_GRACE_SECONDS = 6 * 60 * 60


def sweep_uploads(content: dict) -> list[str]:
    """
    Delete uploads nothing refers to any more.

    Both the published content AND any pending draft count as "referred to". Looking only
    at what was just published would delete a photo added to an unpublished draft — the
    editor would still show it, the file would be gone, and the loss would only surface
    at the next publish.

    Recent files are never touched, whatever the content says. Deleting a picture the
    owner cannot get back is far worse than leaving a few stale kilobytes on the disk
    until the next publish, and this runs on every publish anyway.
    """
    if not UPLOADS.exists():
        return []

    text = json.dumps(content)
    if DRAFT.exists():
        text += DRAFT.read_text(encoding="utf-8")

    used = set(re.findall(r"/uploads/([A-Za-z0-9._-]+)", text))
    now = time.time()
    removed: list[str] = []
    for f in UPLOADS.iterdir():
        if not f.is_file() or f.name in used:
            continue
        if now - f.stat().st_mtime < SWEEP_GRACE_SECONDS:
            continue
        f.unlink(missing_ok=True)
        (DIST / "uploads" / f.name).unlink(missing_ok=True)
        removed.append(f.name)
    return removed


def publish_media(*relative: str) -> None:
    """
    Copy a file from public/ into the built dist/ straight away.

    The web server serves dist/, but uploads land in public/ — so until this existed, a
    new picture was invisible on the live site until the next full rebuild, and the owner
    saw "uploaded" followed by a broken image. The build copies public/ into dist/ too,
    so the two stay in step; this just closes the gap in between.
    """
    for rel in relative:
        src = ROOT / "public" / rel.lstrip("/")
        if not src.exists():
            continue
        dest = DIST / rel.lstrip("/")
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(src.read_bytes())
        except OSError:
            # dist/ may be mid-rebuild. The build will copy it across anyway.
            pass


@app.post("/api/media/forget")
def api_media_forget():
    """
    Delete specific uploads now, because the owner removed what pointed at them.

    The orphan sweep deliberately spares anything recent — that is what stops a publish
    deleting a picture chosen seconds earlier. But removing a post is an explicit
    instruction, not a guess, so its file goes immediately. The one thing this must never
    do is delete a file something else still uses, so the current draft and the published
    content are both checked first.
    """
    require_login()
    body = request.json or {}
    wanted = body.get("srcs") or ([body["src"]] if body.get("src") else [])

    referenced = json.dumps(read_site())
    if DRAFT.exists():
        referenced += DRAFT.read_text(encoding="utf-8")

    removed, kept = [], []
    for src in wanted:
        if not isinstance(src, str) or not src.startswith("/uploads/"):
            continue
        name = src[len("/uploads/"):]
        # Reject anything that is not a plain filename — no traversal out of uploads/.
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name):
            continue
        if f"/uploads/{name}" in referenced:
            kept.append(src)
            continue
        (UPLOADS / name).unlink(missing_ok=True)
        (DIST / "uploads" / name).unlink(missing_ok=True)
        removed.append(src)

    return jsonify(ok=True, removed=removed, kept=kept)


def missing_media(content: dict) -> list[str]:
    """Media the content points at that is not actually on disk."""
    text = json.dumps(content)
    gone = []
    for ref in sorted(set(re.findall(r"/uploads/[A-Za-z0-9._-]+", text))):
        if not (ROOT / "public" / ref.lstrip("/")).exists():
            gone.append(ref)
    logo = (content.get("brand") or {}).get("logo")
    if logo and not (ROOT / "public" / logo.lstrip("/")).exists():
        gone.append(logo)
    return gone


@app.get("/api/backups")
def api_backups():
    require_login()
    backup = DATA / "backups"
    items = []
    for p in sorted(backup.glob("site-*.json"), reverse=True):
        items.append({"name": p.name,
                      "when": p.stem.replace("site-", ""),
                      "size": p.stat().st_size})
    return jsonify(items=items)


@app.post("/api/restore")
def api_restore():
    require_login()
    name = (request.json or {}).get("name", "")
    if not re.fullmatch(r"site-\d{8}-\d{6}\.json", name):
        return jsonify(error="Invalid file name"), 400
    src = DATA / "backups" / name
    if not src.exists():
        return jsonify(error="Backup not found"), 404
    write_draft(json.loads(src.read_text(encoding="utf-8")))
    return jsonify(ok=True, content=read_site(draft=True))


# ═══════════════════════════════════════════════════════════ ai knowledge
#
# content.md is the assistant's entire world: it answers only from this text and says "I
# do not know" for anything else. Editing it here means the bot and the website can never
# drift apart, and it takes effect on the next question — the chat server re-reads the
# file whenever its timestamp changes, so nothing needs restarting.

KNOWLEDGE = ROOT / "content.md"


def refresh_machine_files() -> None:
    """Rewrite llms.txt / llms-full.txt / robots.txt / sitemap.xml in dist/.

    Failure is not fatal: the knowledge itself is already saved and the chatbot uses it
    immediately. Only the crawler-facing copy would be a build behind.
    """
    try:
        subprocess.run(["node", "build.mjs", "machine-files"], cwd=ROOT, capture_output=True,
                       text=True, timeout=30, shell=(os.name == "nt"))
    except Exception:
        pass


@app.get("/api/knowledge")
def api_knowledge_get():
    require_login()
    text = KNOWLEDGE.read_text(encoding="utf-8") if KNOWLEDGE.exists() else ""
    return jsonify(text=text, chars=len(text), tokens=round(len(text) / 3.2))


@app.put("/api/knowledge")
def api_knowledge_put():
    require_login()
    text = (request.json or {}).get("text")
    if not isinstance(text, str):
        return jsonify(error="No text provided"), 400
    if not text.strip():
        return jsonify(error="Cannot be empty — the bot would have nothing to know"), 400
    if len(text) > 60_000:
        return jsonify(error="Too large — keep it under 60,000 characters"), 400

    # Keep one step back. The knowledge is small and hand-written; an accidental
    # select-all-delete should not be unrecoverable.
    if KNOWLEDGE.exists():
        (DATA / "content.prev.md").write_text(KNOWLEDGE.read_text(encoding="utf-8"), encoding="utf-8")

    KNOWLEDGE.write_text(text, encoding="utf-8")

    # /llms-full.txt is this file, served to AI crawlers. Refresh it now rather than
    # waiting for the next Publish, so what a crawler reads is never behind what the
    # chatbot answers. Cheap (text only) and never touches the built pages.
    refresh_machine_files()

    return jsonify(ok=True, chars=len(text), tokens=round(len(text) / 3.2))


@app.post("/api/knowledge/revert")
def api_knowledge_revert():
    require_login()
    prev = DATA / "content.prev.md"
    if not prev.exists():
        return jsonify(error="No previous version to restore"), 404
    text = prev.read_text(encoding="utf-8")
    KNOWLEDGE.write_text(text, encoding="utf-8")
    prev.unlink(missing_ok=True)
    refresh_machine_files()
    return jsonify(ok=True, text=text)


@app.post("/api/knowledge/ask")
def api_knowledge_ask():
    """Ask the live assistant a question straight from the panel, to check an edit."""
    require_login()
    q = str((request.json or {}).get("q", "")).strip()[:500]
    if not q:
        return jsonify(error="Enter a question"), 400
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:8080/api/chat",
            data=json.dumps({"messages": [{"role": "user", "content": q}]}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            answer = ""
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                try:
                    msg = json.loads(line[5:])
                except json.JSONDecodeError:
                    continue
                if msg.get("t"):
                    answer += msg["t"]
                elif msg.get("error"):
                    answer = msg["error"]
        return jsonify(ok=True, answer=answer.strip() or "(empty answer)")
    except Exception as e:  # noqa: BLE001
        return jsonify(error=f"Is the site server running? ({e})"), 502


# ═════════════════════════════════════════════════════════════════ uploads

SAFE_NAME = re.compile(r"[^a-zA-Z0-9._-]+")


@app.post("/api/upload")
def api_upload():
    """
    Take whatever the owner drags in and make it web-safe.

    Photos off a phone are routinely 4-8 MB and 4000 px wide. Shipping one unchanged
    would cost more than the entire rest of the site put together, so everything is
    re-encoded to WebP, capped at 1800 px, and stripped of EXIF (which also removes the
    GPS coordinates phones quietly attach).
    """
    require_login()
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received"), 400

    raw = f.read()
    if not raw:
        return jsonify(error="File is empty"), 400

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        ext = Path(f.filename).suffix.lower()
        if ext in (".heic", ".heif") and not HEIC_OK:
            return jsonify(error="This server cannot open iPhone HEIC photos. "
                                 "Set your phone's Settings → Camera → Formats → 'Most Compatible' "
                                 "so photos save as JPEG — then it will work."), 400
        return jsonify(error=f"This is not a readable image ({ext or 'unknown type'})"), 400

    # Honour the phone's rotation flag, then drop all metadata.
    img = ImageOps.exif_transpose(img)
    if img.mode in ("P", "LA", "RGBA"):
        img = img.convert("RGBA")
    else:
        img = img.convert("RGB")

    if img.width > IMAGE_MAX_WIDTH:
        h = round(img.height * IMAGE_MAX_WIDTH / img.width)
        img = img.resize((IMAGE_MAX_WIDTH, h), Image.LANCZOS)

    UPLOADS.mkdir(parents=True, exist_ok=True)
    stem = SAFE_NAME.sub("-", Path(f.filename).stem)[:40].strip("-") or "image"
    name = f"{stem}-{secrets.token_hex(4)}.webp"
    out = UPLOADS / name

    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    out.write_bytes(buf.getvalue())

    # Live immediately, without waiting for a publish. Otherwise the panel shows the
    # picture (it reads from public/) while the real site returns 404 (it reads dist/).
    publish_media(f"uploads/{name}")

    return jsonify(ok=True, src=f"/uploads/{name}", width=img.width, height=img.height,
                   bytes=out.stat().st_size, original=len(raw))


@app.post("/api/upload-video")
def api_upload_video():
    """
    A short hero clip.

    Unlike images there is nothing useful we can do to shrink it server-side without
    bundling ffmpeg, so the defence is a hard size cap plus a loud warning in the panel.
    The site is served from a home connection; a 20 MB hero video would cost more than
    everything else on the site combined, several times over.
    """
    require_login()
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received"), 400

    ext = Path(f.filename).suffix.lower()
    # .mov is what an iPhone records; the container is MP4-compatible and every browser
    # plays it, so refusing it only meant iPhone video could never be posted at all.
    if ext not in (".mp4", ".webm", ".mov", ".m4v"):
        return jsonify(error=f"This video type ({ext or 'unknown'}) is not supported — use .mp4, .mov, or .webm"), 400

    raw = f.read()
    if len(raw) > MAX_VIDEO_MB * 1024 * 1024:
        return jsonify(error=f"Video is {len(raw)/1048576:.1f} MB — maximum {MAX_VIDEO_MB} MB. "
                             f"Trim it shorter on your phone and try again."), 400

    # Reject anything whose header does not look like the container it claims to be.
    head = raw[:16]
    looks_mp4 = b"ftyp" in head
    looks_webm = head.startswith(b"\x1a\x45\xdf\xa3")
    if not (looks_mp4 or looks_webm):
        return jsonify(error="This file does not look like a real video"), 400

    UPLOADS.mkdir(parents=True, exist_ok=True)
    stem = SAFE_NAME.sub("-", Path(f.filename).stem)[:40].strip("-") or "video"
    # .mov and .m4v from a phone are the same MP4 container under a different name. Saving
    # them as .mp4 means the web server sends video/mp4 and the browser plays it, instead
    # of offering it as a download because it did not recognise the extension.
    out_ext = ".webm" if ext == ".webm" else ".mp4"
    name = f"{stem}-{secrets.token_hex(4)}{out_ext}"
    (UPLOADS / name).write_bytes(raw)
    publish_media(f"uploads/{name}")
    return jsonify(ok=True, src=f"/uploads/{name}", bytes=len(raw),
                   heavy=len(raw) > VIDEO_WARN_MB * 1024 * 1024)


@app.post("/api/logo")
def api_logo():
    """
    The brand logo.

    One upload produces everything the site needs: the mark in the header, the browser
    tab icon and the phone home-screen icon. They are written to fixed filenames rather
    than hashed ones because the HTML references them by name and there is only ever one
    logo — no orphans to collect.
    """
    require_login()
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify(error="No file received"), 400

    try:
        img = Image.open(io.BytesIO(f.read()))
        img.load()
    except Exception:
        return jsonify(error="This is not a readable image"), 400

    img = ImageOps.exif_transpose(img).convert("RGBA")

    logos = ROOT / "public"
    logos.mkdir(parents=True, exist_ok=True)

    # Header mark — keep the aspect ratio, cap the height.
    mark = img.copy()
    if mark.height > 160:
        mark = mark.resize((round(mark.width * 160 / mark.height), 160), Image.LANCZOS)
    buf = io.BytesIO()
    mark.save(buf, "WEBP", quality=90, method=6)
    (logos / "logo.webp").write_bytes(buf.getvalue())

    # Icons are square; pad rather than crop so nothing of the logo is lost.
    def square(size: int, path: Path):
        side = max(img.width, img.height)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        canvas.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)

    square(32, logos / "favicon-32.png")
    square(180, logos / "apple-touch-icon.png")

    # Straight into the served directory, so the new logo is live at once instead of
    # after the next publish.
    publish_media("logo.webp", "favicon-32.png", "apple-touch-icon.png")

    return jsonify(ok=True,
                   src="/logo.webp",
                   width=mark.width, height=mark.height,
                   bytes=(logos / "logo.webp").stat().st_size)


@app.delete("/api/logo")
def api_logo_delete():
    require_login()
    pub = ROOT / "public"
    (pub / "logo.webp").unlink(missing_ok=True)

    # The favicon and the iOS home-screen icon are generated from the logo, but the page
    # links to them whether or not a logo exists. Deleting them outright would leave two
    # 404s in every visitor's <head>, so put the shipped defaults back instead.
    for name in ("favicon-32.png", "apple-touch-icon.png"):
        fallback = pub / f"default-{name}"
        if fallback.exists():
            (pub / name).write_bytes(fallback.read_bytes())
        else:
            (pub / name).unlink(missing_ok=True)
    (DIST / "logo.webp").unlink(missing_ok=True)
    publish_media("favicon-32.png", "apple-touch-icon.png")
    return jsonify(ok=True)


# ══════════════════════════════════════════════════════════════════ telegram
#
# A Telegram bot cannot message a phone number. The API's destination is a chat_id, and a
# chat only exists once that person has opened the bot and pressed Start — Telegram's
# anti-spam rule, with no way around it. So the panel walks the owner through linking a
# phone once, stores the chat_id, and sends there afterwards.


def tg_token() -> str | None:
    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        return os.environ["TELEGRAM_BOT_TOKEN"].strip()
    envf = ROOT / ".env"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8").split("\n"):
            m = re.match(r"^\s*TELEGRAM_BOT_TOKEN\s*=\s*(.+)$", line)
            if m:
                return m.group(1).strip().strip("\"'")
    return None


def _tls_context() -> ssl.SSLContext:
    """
    A trust store Python can actually use.

    On this Windows box `ssl.get_default_verify_paths().cafile` is None, so verification
    falls back to the Windows store — which carries an antivirus/proxy root and makes
    every request to api.telegram.org fail with "self signed certificate in certificate
    chain". certifi's bundle is the portable fix and is already present.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


def tg_call(method: str, payload: dict | None = None, timeout: float = 10.0):
    token = tg_token()
    if not token:
        return None
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_tls_context()) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001 — network problems must never surface to a visitor
        return {"ok": False, "description": str(e)}


def tg_notify(row: dict) -> None:
    """
    Announce one registration.

    Runs on a daemon thread: a visitor pressing Submit must never wait on — or fail
    because of — Telegram being slow or unreachable. Their row is already committed by
    the time this starts.
    """
    chats = settings().get("telegram", {}).get("chats", [])
    if not chats or not tg_token():
        return

    gender = "Male" if row["gender"] == "male" else "Female"
    when = datetime.now(timezone.utc).astimezone().strftime("%d/%m/%Y %I:%M %p")
    # The course is the single most useful thing in this message — it says which class to
    # ring them about — so it sits right under the name, not buried at the bottom.
    course = str(row.get("course") or "").strip()
    text = (
        "🎓 <b>New registration</b>\n\n"
        f"<b>Name:</b> {html_escape(row['first_name'])} {html_escape(row['last_name'])}\n"
        + (f"<b>Course:</b> {html_escape(course)}\n" if course else "")
        + f"<b>Phone:</b> <code>{html_escape(row['phone'])}</code>\n"
        f"<b>Gender:</b> {gender}\n"
        f"<b>Time:</b> {when}\n\n"
        f"Total registrations: {row.get('total', '?')}"
    )

    def run():
        for c in chats:
            tg_call("sendMessage", {
                "chat_id": c["id"],
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            })

    threading.Thread(target=run, daemon=True).start()


def html_escape(s: str) -> str:
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


@app.get("/api/telegram")
def api_telegram_get():
    require_login()
    token = tg_token()
    info = tg_call("getMe") if token else None
    return jsonify(
        configured=bool(token),
        bot=(info or {}).get("result"),
        chats=settings().get("telegram", {}).get("chats", []),
    )


@app.post("/api/telegram/scan")
def api_telegram_scan():
    """Look for people who have pressed Start but are not linked yet."""
    require_login()
    if not tg_token():
        return jsonify(error="TELEGRAM_BOT_TOKEN missing (check .env)"), 400

    res = tg_call("getUpdates", {"timeout": 0, "allowed_updates": ["message", "my_chat_member"]})
    if not res or not res.get("ok"):
        return jsonify(error=f"Telegram: {(res or {}).get('description', 'no response')}"), 502

    known = {c["id"] for c in settings().get("telegram", {}).get("chats", [])}
    found = {}
    for u in res.get("result", []):
        chat = (u.get("message") or u.get("my_chat_member") or {}).get("chat")
        if chat and chat["id"] not in known:
            name = " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) \
                or chat.get("title") or str(chat["id"])
            found[chat["id"]] = {"id": chat["id"], "name": name,
                                 "username": chat.get("username"), "type": chat.get("type")}
    return jsonify(found=list(found.values()))


@app.post("/api/telegram/chats")
def api_telegram_add():
    require_login()
    b = request.json or {}
    try:
        cid = int(b.get("id"))
    except (TypeError, ValueError):
        return jsonify(error="Invalid chat id"), 400

    s = settings()
    chats = s.setdefault("telegram", {}).setdefault("chats", [])
    if any(c["id"] == cid for c in chats):
        return jsonify(error="This chat is already linked"), 400

    entry = {"id": cid, "name": str(b.get("name") or cid)[:60],
             "label": str(b.get("label") or "")[:60]}
    chats.append(entry)
    save_settings(s)

    r = tg_call("sendMessage", {
        "chat_id": cid,
        "text": "✅ Linked. Every new registration will be sent here from now on.",
    })
    if not r or not r.get("ok"):
        chats.pop()
        save_settings(s)
        return jsonify(error=f"Could not send: {(r or {}).get('description', '?')}"), 502
    return jsonify(ok=True, chat=entry)


@app.delete("/api/telegram/chats/<int:cid>")
def api_telegram_remove(cid: int):
    require_login()
    s = settings()
    chats = s.setdefault("telegram", {}).setdefault("chats", [])
    s["telegram"]["chats"] = [c for c in chats if c["id"] != cid]
    save_settings(s)
    return jsonify(ok=True)


@app.post("/api/telegram/test")
def api_telegram_test():
    require_login()
    chats = settings().get("telegram", {}).get("chats", [])
    if not chats:
        return jsonify(error="No chats linked"), 400
    sent, failed = 0, []
    for c in chats:
        r = tg_call("sendMessage", {
            "chat_id": c["id"],
            "text": "🔔 Test message — BD Education Centre registration notifications are working.",
        })
        if r and r.get("ok"):
            sent += 1
        else:
            failed.append(c.get("label") or c.get("name"))
    return jsonify(ok=True, sent=sent, failed=failed)


# ═══════════════════════════════════════════════════════════ registrations

PHONE_RE = re.compile(r"[^\d+]")
_reg_hits: dict[str, list[float]] = {}


@app.post("/api/register")
def api_register():
    """PUBLIC — no login. This is what the registration form on the site posts to."""
    ip = (request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
          or request.remote_addr or "?")
    now = time.time()
    hits = [t for t in _reg_hits.get(ip, []) if now - t < 3600]
    if len(hits) >= 12:
        return jsonify(error="Too many submissions — try again shortly"), 429

    b = request.json or {}
    first = str(b.get("firstName", "")).strip()[:60]
    last = str(b.get("lastName", "")).strip()[:60]
    phone = str(b.get("phone", "")).strip()[:24]
    gender = str(b.get("gender", "")).strip().lower()
    course = str(b.get("course", "")).strip()[:80]

    digits = PHONE_RE.sub("", phone)
    if not first:
        return jsonify(error="Enter your first name"), 400
    if not last:
        return jsonify(error="Enter your last name"), 400
    if not (10 <= len(digits.lstrip("+")) <= 15):
        return jsonify(error="Check that the mobile number is correct"), 400
    if gender not in ("male", "female"):
        return jsonify(error="Select a gender"), 400

    # Only a course that is actually offered. Anything else is either a stale page or
    # someone posting by hand, and neither should end up in the owner's list.
    allowed = course_options()
    if allowed:
        if not course:
            return jsonify(error="Select the course you are interested in"), 400
        if course not in allowed:
            return jsonify(error="Select a valid course"), 400

    hits.append(now)
    _reg_hits[ip] = hits

    conn = db()
    conn.execute(
        "INSERT INTO registrations (first_name,last_name,phone,gender,course,created_at,ip)"
        " VALUES (?,?,?,?,?,?,?)",
        (first, last, digits, gender, course,
         datetime.now(timezone.utc).isoformat(timespec="seconds"), ip))

    # Rolling window: the table is a recent-contacts list, not an archive. Anything past
    # the newest KEEP_REGISTRATIONS rows drops off, so the file never grows.
    conn.execute(
        "DELETE FROM registrations WHERE id NOT IN"
        " (SELECT id FROM registrations ORDER BY id DESC LIMIT ?)", (KEEP_REGISTRATIONS,))
    conn.commit()
    total = conn.execute("SELECT COUNT(*) c FROM registrations").fetchone()["c"]
    conn.close()

    tg_notify({"first_name": first, "last_name": last, "phone": digits,
               "gender": gender, "course": course, "total": total})
    return jsonify(ok=True)


@app.get("/api/registrations")
def api_registrations():
    require_login()
    q = (request.args.get("q") or "").strip()
    conn = db()
    if q:
        like = f"%{q}%"
        rows = conn.execute(
            "SELECT * FROM registrations WHERE first_name LIKE ? OR last_name LIKE ?"
            " OR phone LIKE ? OR course LIKE ? ORDER BY id DESC LIMIT 500",
            (like, like, like, like)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM registrations ORDER BY id DESC LIMIT 500").fetchall()
    total = conn.execute("SELECT COUNT(*) c FROM registrations").fetchone()["c"]
    today = conn.execute(
        "SELECT COUNT(*) c FROM registrations WHERE substr(created_at,1,10)=?",
        (datetime.now(timezone.utc).strftime("%Y-%m-%d"),)).fetchone()["c"]
    conn.close()
    return jsonify(items=[dict(r) for r in rows], total=total, today=today)


@app.delete("/api/registrations/<int:rid>")
def api_registration_delete(rid: int):
    require_login()
    conn = db()
    conn.execute("DELETE FROM registrations WHERE id=?", (rid,))
    conn.commit()
    conn.close()
    return jsonify(ok=True)


@app.get("/api/registrations.csv")
def api_registrations_csv():
    require_login()
    conn = db()
    rows = conn.execute("SELECT * FROM registrations ORDER BY id DESC").fetchall()
    conn.close()

    def cell(v):
        s = str(v if v is not None else "")
        # A leading =, +, - or @ makes Excel treat the cell as a formula. Phone numbers
        # start with +, so this matters here.
        if s[:1] in ("=", "+", "-", "@"):
            s = "'" + s
        return '"' + s.replace('"', '""') + '"'

    cols = ("id", "first_name", "last_name", "phone", "gender", "course", "created_at")
    lines = ["﻿" + ",".join(cols)]
    for r in rows:
        lines.append(",".join(cell(r[k]) for k in cols))
    body = "\r\n".join(lines).encode("utf-8")
    return send_file(io.BytesIO(body), mimetype="text/csv; charset=utf-8",
                     as_attachment=True,
                     download_name=f"registrations-{datetime.now().strftime('%Y%m%d')}.csv")


# ═══════════════════════════════════════════════════════════ panel + preview

# The panel is two files that change together. Serving either from cache while the other
# is fresh produces a panel that is half old and half new — buttons that silently do
# nothing, because a handler calls a function the cached script has never heard of. That
# cost an afternoon once already, so the script carries the file's own mtime as its URL
# and neither file is ever cached.

def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


@app.get("/")
@app.get("/admin")
def admin_page():
    html = (ROOT / "admin.html").read_text(encoding="utf-8")
    stamp = int((ROOT / "admin-blocks.js").stat().st_mtime)
    html = html.replace('src="/admin-blocks.js"', f'src="/admin-blocks.js?v={stamp}"')
    return _no_store(app.response_class(html, mimetype="text/html"))


@app.get("/admin-blocks.js")
def admin_blocks():
    return _no_store(send_file(ROOT / "admin-blocks.js", mimetype="text/javascript"))


@app.get("/uploads/<path:name>")
def serve_upload(name):
    return send_from_directory(UPLOADS, name, max_age=3600)


@app.get("/preview/")
@app.get("/preview/<path:sub>")
def preview(sub: str = ""):
    """
    The draft, rendered.

    Everything except the document itself is served straight out of dist/ — the built
    CSS, the JS bundles, the fonts, the 3D scene. Only index.html is re-rendered on the
    fly from the draft, so what you see is exactly what Publish would produce.
    """
    require_login()
    if sub in ("", "index.html"):
        proc = subprocess.run(["node", "build.mjs", "render-draft"], cwd=ROOT,
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", shell=(os.name == "nt"))
        if proc.returncode != 0:
            return ("<pre style='padding:2rem;font:14px monospace;color:#c00'>preview render failed\n\n"
                    + (proc.stderr or proc.stdout or "")[-2000:] + "</pre>"), 500
        return proc.stdout, 200, {"Content-Type": "text/html; charset=utf-8",
                                  "Cache-Control": "no-store"}
    target = (DIST / sub).resolve()
    if not str(target).startswith(str(DIST.resolve())) or not target.exists():
        abort(404)
    return send_from_directory(DIST, sub)


# ═════════════════════════════════════════════════════════════════════ main

def main() -> None:
    ap = argparse.ArgumentParser(description="BD Education Centre — admin panel")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--set-password", action="store_true", help="change the admin password")
    args = ap.parse_args()

    DATA.mkdir(parents=True, exist_ok=True)

    if args.set_password:
        pw = getpass.getpass("New admin password: ")
        if len(pw) < 6:
            sys.exit("too short — at least 6 characters")
        if pw != getpass.getpass("Repeat: "):
            sys.exit("they did not match")
        save_password(pw)
        print("password updated")
        return

    secret = load_secret()
    app.secret_key = secret["session_key"]
    db().close()

    if not SITE.exists():
        sys.exit(f"missing {SITE} — the panel edits that file")

    print(f"\n  admin   http://{args.host}:{args.port}/admin")
    print(f"  preview http://{args.host}:{args.port}/preview/")
    print(f"  data    {DB}")
    if secret.get("is_default"):
        print("\n  \033[33m! still on the generated first-run password — change it in the panel\033[0m")
    print()
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()

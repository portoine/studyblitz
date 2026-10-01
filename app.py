"""
StudyBlitz — a modern flashcard & study platform.
Flask backend with SQLite persistence.
"""

import os
import json
import uuid
import sqlite3
import random
from datetime import datetime, timedelta
from pathlib import Path
from functools import wraps
from flask import (
    Flask, request, jsonify, render_template,
    session, redirect, url_for, g, abort
)
from werkzeug.security import generate_password_hash, check_password_hash
import anthropic

# Load .env file if present
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().strip().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(32).hex())

# Claude AI client
ai_client = None
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if ANTHROPIC_API_KEY:
    ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

DB_PATH = Path(__file__).parent / "studyblitz.db"


# ── Database helpers ──────────────────────────────────────────────────────────

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(str(DB_PATH))
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db:
        db.close()


def init_db():
    db = sqlite3.connect(str(DB_PATH))
    db.executescript("""
    CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        username    TEXT UNIQUE NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        pw_hash     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        streak_days INTEGER NOT NULL DEFAULT 0,
        last_study  TEXT
    );
    CREATE TABLE IF NOT EXISTS sets (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_public   INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS cards (
        id          TEXT PRIMARY KEY,
        set_id      TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
        term        TEXT NOT NULL,
        definition  TEXT NOT NULL,
        position    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS progress (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
        box         INTEGER NOT NULL DEFAULT 0,
        next_review TEXT NOT NULL DEFAULT (datetime('now')),
        correct     INTEGER NOT NULL DEFAULT 0,
        incorrect   INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, card_id)
    );
    CREATE TABLE IF NOT EXISTS scores (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id),
        set_id      TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
        mode        TEXT NOT NULL,
        score       REAL NOT NULL,
        total       INTEGER NOT NULL,
        time_secs   REAL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cards_set ON cards(set_id);
    CREATE INDEX IF NOT EXISTS idx_progress_user ON progress(user_id);
    CREATE INDEX IF NOT EXISTS idx_scores_user_set ON scores(user_id, set_id);
    """)
    db.close()


init_db()


# ── Auth helpers ──────────────────────────────────────────────────────────────

def current_user():
    uid = session.get("user_id")
    if not uid:
        return None
    return get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


def login_required(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.is_json or request.path.startswith("/api/"):
                return jsonify(error="Not authenticated"), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return wrapped


# ── Page routes ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    return redirect(url_for("login_page"))


@app.route("/login")
def login_page():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    return render_template("login.html")


@app.route("/signup")
def signup_page():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    return render_template("signup.html")


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("app.html")


@app.route("/study/<set_id>/<mode>")
@login_required
def study_page(set_id, mode):
    return render_template("app.html")


# ── Auth API ──────────────────────────────────────────────────────────────────

@app.route("/api/signup", methods=["POST"])
def api_signup():
    d = request.get_json(force=True)
    username = (d.get("username") or "").strip()
    email = (d.get("email") or "").strip().lower()
    password = d.get("password") or ""
    if len(username) < 2:
        return jsonify(error="Username must be at least 2 characters"), 400
    if "@" not in email:
        return jsonify(error="Invalid email"), 400
    if len(password) < 6:
        return jsonify(error="Password must be at least 6 characters"), 400
    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return jsonify(error="Username taken"), 409
    if db.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
        return jsonify(error="Email already registered"), 409
    uid = uuid.uuid4().hex[:16]
    db.execute(
        "INSERT INTO users(id,username,email,pw_hash) VALUES(?,?,?,?)",
        (uid, username, email, generate_password_hash(password)),
    )
    db.commit()
    session["user_id"] = uid
    return jsonify(ok=True, user={"id": uid, "username": username})


@app.route("/api/login", methods=["POST"])
def api_login():
    d = request.get_json(force=True)
    ident = (d.get("username") or "").strip()
    password = d.get("password") or ""
    db = get_db()
    user = db.execute(
        "SELECT * FROM users WHERE username=? OR email=?", (ident, ident.lower())
    ).fetchone()
    if not user or not check_password_hash(user["pw_hash"], password):
        return jsonify(error="Invalid credentials"), 401
    session["user_id"] = user["id"]
    return jsonify(ok=True, user={"id": user["id"], "username": user["username"]})


@app.route("/api/logout", methods=["POST"])
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.route("/api/me")
@login_required
def api_me():
    u = current_user()
    return jsonify(id=u["id"], username=u["username"], streak_days=u["streak_days"])


# ── Sets API ──────────────────────────────────────────────────────────────────

@app.route("/api/sets", methods=["GET"])
@login_required
def api_list_sets():
    uid = session["user_id"]
    rows = get_db().execute(
        """SELECT s.*, COUNT(c.id) as card_count,
           (SELECT MAX(sc.created_at) FROM scores sc WHERE sc.set_id=s.id AND sc.user_id=?) as last_studied
           FROM sets s LEFT JOIN cards c ON c.set_id=s.id
           WHERE s.user_id=?
           GROUP BY s.id ORDER BY s.updated_at DESC""",
        (uid, uid),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/sets", methods=["POST"])
@login_required
def api_create_set():
    d = request.get_json(force=True)
    title = (d.get("title") or "").strip()
    if not title:
        return jsonify(error="Title required"), 400
    cards = d.get("cards", [])
    if len(cards) < 1:
        return jsonify(error="Add at least one card"), 400
    db = get_db()
    sid = uuid.uuid4().hex[:12]
    db.execute(
        "INSERT INTO sets(id,user_id,title,description) VALUES(?,?,?,?)",
        (sid, session["user_id"], title, d.get("description", "")),
    )
    for i, c in enumerate(cards):
        term = (c.get("term") or "").strip()
        defn = (c.get("definition") or "").strip()
        if term and defn:
            db.execute(
                "INSERT INTO cards(id,set_id,term,definition,position) VALUES(?,?,?,?,?)",
                (uuid.uuid4().hex[:12], sid, term, defn, i),
            )
    db.commit()
    return jsonify(ok=True, id=sid)


@app.route("/api/sets/<sid>", methods=["GET"])
@login_required
def api_get_set(sid):
    db = get_db()
    s = db.execute("SELECT * FROM sets WHERE id=?", (sid,)).fetchone()
    if not s:
        return jsonify(error="Not found"), 404
    cards = db.execute(
        "SELECT * FROM cards WHERE set_id=? ORDER BY position", (sid,)
    ).fetchall()
    # get progress for current user
    uid = session["user_id"]
    prog = {}
    for row in db.execute(
        "SELECT card_id, box, correct, incorrect FROM progress WHERE user_id=? AND card_id IN (SELECT id FROM cards WHERE set_id=?)",
        (uid, sid),
    ).fetchall():
        prog[row["card_id"]] = dict(row)
    result = dict(s)
    result["cards"] = []
    for c in cards:
        cd = dict(c)
        cd["progress"] = prog.get(c["id"], {"box": 0, "correct": 0, "incorrect": 0})
        result["cards"].append(cd)
    # recent scores
    scores = db.execute(
        "SELECT mode, score, total, time_secs, created_at FROM scores WHERE user_id=? AND set_id=? ORDER BY created_at DESC LIMIT 20",
        (uid, sid),
    ).fetchall()
    result["scores"] = [dict(r) for r in scores]
    return jsonify(result)


@app.route("/api/sets/<sid>", methods=["PUT"])
@login_required
def api_update_set(sid):
    db = get_db()
    s = db.execute("SELECT * FROM sets WHERE id=? AND user_id=?", (sid, session["user_id"])).fetchone()
    if not s:
        return jsonify(error="Not found"), 404
    d = request.get_json(force=True)
    title = (d.get("title") or "").strip() or s["title"]
    desc = d.get("description", s["description"])
    cards = d.get("cards", [])
    db.execute("UPDATE sets SET title=?, description=?, updated_at=datetime('now') WHERE id=?", (title, desc, sid))
    # replace cards
    if cards:
        db.execute("DELETE FROM cards WHERE set_id=?", (sid,))
        for i, c in enumerate(cards):
            term = (c.get("term") or "").strip()
            defn = (c.get("definition") or "").strip()
            if term and defn:
                db.execute(
                    "INSERT INTO cards(id,set_id,term,definition,position) VALUES(?,?,?,?,?)",
                    (c.get("id", uuid.uuid4().hex[:12]), sid, term, defn, i),
                )
    db.commit()
    return jsonify(ok=True)


@app.route("/api/sets/<sid>", methods=["DELETE"])
@login_required
def api_delete_set(sid):
    db = get_db()
    db.execute("DELETE FROM sets WHERE id=? AND user_id=?", (sid, session["user_id"]))
    db.commit()
    return jsonify(ok=True)


# ── Study / Progress API ─────────────────────────────────────────────────────

@app.route("/api/progress", methods=["POST"])
@login_required
def api_update_progress():
    """Record a study attempt for a card. Implements spaced repetition (Leitner boxes)."""
    d = request.get_json(force=True)
    card_id = d.get("card_id")
    correct = d.get("correct", False)
    uid = session["user_id"]
    db = get_db()
    row = db.execute("SELECT * FROM progress WHERE user_id=? AND card_id=?", (uid, card_id)).fetchone()
    if row:
        box = row["box"]
        if correct:
            box = min(box + 1, 5)
        else:
            box = max(box - 1, 0)
        intervals = [0, 1, 3, 7, 14, 30]  # days per box
        next_rev = (datetime.utcnow() + timedelta(days=intervals[box])).isoformat()
        col = "correct" if correct else "incorrect"
        db.execute(
            f"UPDATE progress SET box=?, next_review=?, {col}={col}+1 WHERE id=?",
            (box, next_rev, row["id"]),
        )
    else:
        box = 1 if correct else 0
        intervals = [0, 1, 3, 7, 14, 30]
        next_rev = (datetime.utcnow() + timedelta(days=intervals[box])).isoformat()
        pid = uuid.uuid4().hex[:12]
        db.execute(
            "INSERT INTO progress(id,user_id,card_id,box,next_review,correct,incorrect) VALUES(?,?,?,?,?,?,?)",
            (pid, uid, card_id, box, next_rev, 1 if correct else 0, 0 if correct else 1),
        )
    # update streak
    today = datetime.utcnow().strftime("%Y-%m-%d")
    user = db.execute("SELECT last_study, streak_days FROM users WHERE id=?", (uid,)).fetchone()
    if user["last_study"] != today:
        yesterday = (datetime.utcnow() - timedelta(days=1)).strftime("%Y-%m-%d")
        streak = (user["streak_days"] + 1) if user["last_study"] == yesterday else 1
        db.execute("UPDATE users SET last_study=?, streak_days=? WHERE id=?", (today, streak, uid))
    db.commit()
    return jsonify(ok=True, box=box)


@app.route("/api/scores", methods=["POST"])
@login_required
def api_save_score():
    d = request.get_json(force=True)
    db = get_db()
    db.execute(
        "INSERT INTO scores(id,user_id,set_id,mode,score,total,time_secs) VALUES(?,?,?,?,?,?,?)",
        (uuid.uuid4().hex[:12], session["user_id"], d["set_id"], d["mode"],
         d["score"], d["total"], d.get("time_secs")),
    )
    db.commit()
    return jsonify(ok=True)


@app.route("/api/sets/<sid>/learn")
@login_required
def api_learn_cards(sid):
    """Return cards prioritized by spaced repetition — due cards first, then unseen."""
    uid = session["user_id"]
    db = get_db()
    cards = db.execute("SELECT * FROM cards WHERE set_id=? ORDER BY position", (sid,)).fetchall()
    prog = {}
    for row in db.execute(
        "SELECT * FROM progress WHERE user_id=? AND card_id IN (SELECT id FROM cards WHERE set_id=?)",
        (uid, sid),
    ).fetchall():
        prog[row["card_id"]] = dict(row)
    now = datetime.utcnow().isoformat()
    due, unseen, mastered = [], [], []
    for c in cards:
        cd = dict(c)
        p = prog.get(c["id"])
        if not p:
            cd["status"] = "new"
            unseen.append(cd)
        elif p["next_review"] <= now:
            cd["status"] = "due"
            cd["box"] = p["box"]
            due.append(cd)
        else:
            cd["status"] = "mastered" if p["box"] >= 4 else "learning"
            cd["box"] = p["box"]
            mastered.append(cd)
    return jsonify(due=due, unseen=unseen, mastered=mastered)


# ── Explore / public sets ─────────────────────────────────────────────────────

@app.route("/api/explore")
@login_required
def api_explore():
    q = request.args.get("q", "").strip()
    db = get_db()
    if q:
        rows = db.execute(
            """SELECT s.*, u.username, COUNT(c.id) as card_count
               FROM sets s JOIN users u ON u.id=s.user_id LEFT JOIN cards c ON c.set_id=s.id
               WHERE s.is_public=1 AND (s.title LIKE ? OR s.description LIKE ?)
               GROUP BY s.id ORDER BY s.created_at DESC LIMIT 50""",
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT s.*, u.username, COUNT(c.id) as card_count
               FROM sets s JOIN users u ON u.id=s.user_id LEFT JOIN cards c ON c.set_id=s.id
               WHERE s.is_public=1
               GROUP BY s.id ORDER BY s.created_at DESC LIMIT 50""",
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/sets/<sid>/copy", methods=["POST"])
@login_required
def api_copy_set(sid):
    db = get_db()
    s = db.execute("SELECT * FROM sets WHERE id=? AND is_public=1", (sid,)).fetchone()
    if not s:
        return jsonify(error="Not found"), 404
    new_id = uuid.uuid4().hex[:12]
    db.execute(
        "INSERT INTO sets(id,user_id,title,description) VALUES(?,?,?,?)",
        (new_id, session["user_id"], s["title"], s["description"]),
    )
    cards = db.execute("SELECT * FROM cards WHERE set_id=? ORDER BY position", (sid,)).fetchall()
    for i, c in enumerate(cards):
        db.execute(
            "INSERT INTO cards(id,set_id,term,definition,position) VALUES(?,?,?,?,?)",
            (uuid.uuid4().hex[:12], new_id, c["term"], c["definition"], i),
        )
    db.commit()
    return jsonify(ok=True, id=new_id)


# ── AI Features ───────────────────────────────────────────────────────────────

def require_ai(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not ai_client:
            return jsonify(error="AI features not configured. Set ANTHROPIC_API_KEY."), 503
        return f(*args, **kwargs)
    return wrapped


@app.route("/api/generate-cards", methods=["POST"])
@login_required
@require_ai
def api_generate_cards():
    """Magic Notes: paste notes/text and AI generates flashcards."""
    d = request.get_json(force=True)
    notes = (d.get("notes") or "").strip()
    title = (d.get("title") or "").strip()
    num_cards = min(int(d.get("num_cards", 20)), 50)
    if not notes or len(notes) < 20:
        return jsonify(error="Paste at least a few sentences of notes."), 400

    msg = ai_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=4000,
        messages=[{"role": "user", "content": f"""You are a study assistant. Create exactly {num_cards} flashcards from these notes.
Each flashcard should test one key concept, term, or fact.

Return ONLY a JSON array of objects with "term" and "definition" keys. No other text.
Keep terms concise (1-8 words). Keep definitions clear and complete but brief (1-2 sentences).

Notes:
{notes}"""}],
    )
    try:
        text = msg.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        cards = json.loads(text)
        if not isinstance(cards, list):
            raise ValueError("Not a list")
    except Exception:
        return jsonify(error="AI returned invalid format. Try again."), 500

    # auto-create the set if title provided
    if title:
        db = get_db()
        sid = uuid.uuid4().hex[:12]
        db.execute(
            "INSERT INTO sets(id,user_id,title,description) VALUES(?,?,?,?)",
            (sid, session["user_id"], title, "Generated from notes with AI"),
        )
        for i, c in enumerate(cards):
            db.execute(
                "INSERT INTO cards(id,set_id,term,definition,position) VALUES(?,?,?,?,?)",
                (uuid.uuid4().hex[:12], sid, c["term"], c["definition"], i),
            )
        db.commit()
        return jsonify(ok=True, id=sid, cards=cards)

    return jsonify(ok=True, cards=cards)


@app.route("/api/generate-summary", methods=["POST"])
@login_required
@require_ai
def api_generate_summary():
    """Generate a study guide summary from notes."""
    d = request.get_json(force=True)
    notes = (d.get("notes") or "").strip()
    if not notes or len(notes) < 20:
        return jsonify(error="Paste at least a few sentences of notes."), 400

    msg = ai_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=3000,
        messages=[{"role": "user", "content": f"""Create a concise study guide from these notes. Format it with:
- A brief overview (2-3 sentences)
- Key concepts as bullet points with bold terms
- Important relationships or connections between concepts
- Quick-review questions at the end (3-5 questions)

Use markdown formatting. Be thorough but concise.

Notes:
{notes}"""}],
    )
    return jsonify(ok=True, summary=msg.content[0].text)


@app.route("/api/chat", methods=["POST"])
@login_required
@require_ai
def api_chat():
    """AI homework help / Q-Chat: ask questions, get explanations."""
    d = request.get_json(force=True)
    messages = d.get("messages", [])
    context = d.get("context", "")

    system_prompt = "You are StudyBlitz AI, a friendly and knowledgeable study tutor. Help students understand concepts, solve problems, and learn effectively. Give clear, step-by-step explanations. Use examples when helpful. If a student is wrong, gently guide them to the right answer rather than just giving it away."
    if context:
        system_prompt += f"\n\nThe student is currently studying this set:\n{context}"

    api_messages = []
    for m in messages[-20:]:  # keep last 20 messages
        api_messages.append({"role": m["role"], "content": m["content"]})

    msg = ai_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=2000,
        system=system_prompt,
        messages=api_messages,
    )
    return jsonify(ok=True, reply=msg.content[0].text)


@app.route("/api/explain-card", methods=["POST"])
@login_required
@require_ai
def api_explain_card():
    """Get a detailed explanation of a flashcard term."""
    d = request.get_json(force=True)
    term = d.get("term", "")
    definition = d.get("definition", "")

    msg = ai_client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1500,
        messages=[{"role": "user", "content": f"""Explain this concept in a way that helps a student deeply understand it:

Term: {term}
Definition: {definition}

Provide:
1. A simple explanation in everyday language
2. An example or analogy
3. Why it matters / how it connects to related concepts
4. A memory trick or mnemonic if applicable

Keep it concise but thorough."""}],
    )
    return jsonify(ok=True, explanation=msg.content[0].text)


if __name__ == "__main__":
    debug = os.environ.get("FLASK_ENV") != "production"
    port = int(os.environ.get("PORT", 5055))
    app.run(debug=debug, host="0.0.0.0", port=port)

/* ── StudyBlitz — Frontend ─────────────────────────────────────────────────── */

let currentSetId = null;
let currentSetData = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function api(url, opts = {}) {
  if (opts.body && typeof opts.body === "object") {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok && data.error) throw new Error(data.error);
  return data;
}

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.style.display = "none");
  const el = document.getElementById(`view-${name}`);
  if (el) el.style.display = "block";
  if (name === "dashboard") loadSets();
  if (name === "explore") loadExplore();
  if (name === "create") resetCreateForm();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  try {
    const me = await api("/api/me");
    document.getElementById("nav-username").textContent = me.username;
    document.getElementById("streak-badge").textContent = me.streak_days > 0 ? `${me.streak_days} day streak` : "";

    // route based on path
    const path = location.pathname;
    const studyMatch = path.match(/^\/study\/([^/]+)\/(\w+)$/);
    if (studyMatch) {
      currentSetId = studyMatch[1];
      currentSetData = await api(`/api/sets/${currentSetId}`);
      const mode = studyMatch[2];
      if (mode === "flashcards") startFlashcards();
      else if (mode === "learn") startLearn();
      else if (mode === "test") startTest();
      else if (mode === "match") startMatch();
      else showSetDetail(currentSetId);
    } else {
      showView("dashboard");
    }
  } catch {
    location.href = "/login";
  }
})();

// ── Dashboard ────────────────────────────────────────────────────────────────

async function loadSets() {
  const sets = await api("/api/sets");
  const grid = document.getElementById("sets-list");
  const empty = document.getElementById("no-sets");
  if (sets.length === 0) {
    grid.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  grid.innerHTML = sets.map(s => {
    const pct = s.card_count > 0 ? Math.round((s.card_count > 0 ? 50 : 0)) : 0; // placeholder
    return `
    <div class="set-card" onclick="showSetDetail('${s.id}')">
      <div class="set-card-title">${esc(s.title)}</div>
      <div class="set-card-meta">${s.card_count} card${s.card_count !== 1 ? "s" : ""}${s.last_studied ? " · studied " + timeAgo(s.last_studied) : ""}</div>
      <div class="set-card-bar"><div class="set-card-bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join("");
}

// ── Explore ──────────────────────────────────────────────────────────────────

let exploreTimer;
function debounceExplore() {
  clearTimeout(exploreTimer);
  exploreTimer = setTimeout(loadExplore, 300);
}

async function loadExplore() {
  const q = document.getElementById("explore-search")?.value || "";
  const sets = await api(`/api/explore?q=${encodeURIComponent(q)}`);
  document.getElementById("explore-list").innerHTML = sets.length === 0
    ? '<p class="text-muted">No sets found.</p>'
    : sets.map(s => `
    <div class="set-card" onclick="copySet('${s.id}')">
      <div class="set-card-title">${esc(s.title)}</div>
      <div class="set-card-meta">${s.card_count} cards · by ${esc(s.username)}</div>
    </div>`).join("");
}

async function copySet(id) {
  if (!confirm("Copy this set to your library?")) return;
  await api(`/api/sets/${id}/copy`, { method: "POST" });
  showView("dashboard");
}

// ── Create / Edit ────────────────────────────────────────────────────────────

function resetCreateForm() {
  document.getElementById("create-heading").textContent = "Create a New Set";
  document.getElementById("edit-set-id").value = "";
  document.getElementById("set-title").value = "";
  document.getElementById("set-desc").value = "";
  document.getElementById("card-editor").innerHTML = "";
  for (let i = 0; i < 4; i++) addCardRow();
}

function addCardRow() {
  const editor = document.getElementById("card-editor");
  const idx = editor.children.length;
  const row = document.createElement("div");
  row.className = "card-row";
  row.innerHTML = `
    <span class="card-num">${idx + 1}</span>
    <input type="text" class="card-term" placeholder="Term" required>
    <input type="text" class="card-def" placeholder="Definition" required>
    <button type="button" class="btn-icon btn-remove-card" onclick="removeCardRow(this)" title="Remove">&times;</button>`;
  editor.appendChild(row);
  if (idx === 0) row.querySelector(".card-term").focus();
  // tab from definition to next term
  row.querySelector(".card-def").addEventListener("keydown", e => {
    if (e.key === "Tab" && !e.shiftKey) {
      const rows = editor.querySelectorAll(".card-row");
      const myIdx = [...rows].indexOf(row);
      if (myIdx === rows.length - 1) {
        e.preventDefault();
        addCardRow();
        editor.lastElementChild.querySelector(".card-term").focus();
      }
    }
  });
}

function removeCardRow(btn) {
  const editor = document.getElementById("card-editor");
  if (editor.children.length <= 1) return;
  btn.closest(".card-row").remove();
  renumberCards();
}

function renumberCards() {
  document.querySelectorAll("#card-editor .card-row").forEach((row, i) => {
    row.querySelector(".card-num").textContent = i + 1;
  });
}

async function saveSet(e) {
  e.preventDefault();
  const id = document.getElementById("edit-set-id").value;
  const title = document.getElementById("set-title").value.trim();
  const desc = document.getElementById("set-desc").value.trim();
  const rows = document.querySelectorAll("#card-editor .card-row");
  const cards = [];
  rows.forEach(r => {
    const term = r.querySelector(".card-term").value.trim();
    const def = r.querySelector(".card-def").value.trim();
    if (term && def) cards.push({ term, definition: def });
  });
  if (cards.length < 1) return alert("Add at least one card with a term and definition.");

  if (id) {
    await api(`/api/sets/${id}`, { method: "PUT", body: { title, description: desc, cards } });
    showSetDetail(id);
  } else {
    const res = await api("/api/sets", { method: "POST", body: { title, description: desc, cards } });
    showSetDetail(res.id);
  }
}

function editSet() {
  if (!currentSetData) return;
  showView("create");
  document.getElementById("create-heading").textContent = "Edit Set";
  document.getElementById("edit-set-id").value = currentSetId;
  document.getElementById("set-title").value = currentSetData.title;
  document.getElementById("set-desc").value = currentSetData.description || "";
  const editor = document.getElementById("card-editor");
  editor.innerHTML = "";
  currentSetData.cards.forEach(c => {
    addCardRow();
    const row = editor.lastElementChild;
    row.querySelector(".card-term").value = c.term;
    row.querySelector(".card-def").value = c.definition;
  });
}

async function deleteSet() {
  if (!confirm("Delete this set and all its cards? This can't be undone.")) return;
  await api(`/api/sets/${currentSetId}`, { method: "DELETE" });
  showView("dashboard");
}

function bulkImport() {
  document.getElementById("import-modal").style.display = "flex";
  document.getElementById("import-text").value = "";
  document.getElementById("import-text").focus();
}

function doBulkImport() {
  const text = document.getElementById("import-text").value;
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const editor = document.getElementById("card-editor");
  lines.forEach(line => {
    const sep = line.includes("\t") ? "\t" : ";";
    const parts = line.split(sep).map(s => s.trim());
    if (parts.length >= 2) {
      addCardRow();
      const row = editor.lastElementChild;
      row.querySelector(".card-term").value = parts[0];
      row.querySelector(".card-def").value = parts.slice(1).join("; ");
    }
  });
  renumberCards();
  document.getElementById("import-modal").style.display = "none";
}

// ── Set detail ───────────────────────────────────────────────────────────────

async function showSetDetail(id) {
  currentSetId = id;
  currentSetData = await api(`/api/sets/${id}`);
  const s = currentSetData;
  document.getElementById("set-detail-title").textContent = s.title;
  document.getElementById("set-detail-desc").textContent = s.description || "";
  document.getElementById("set-detail-count").textContent = `${s.cards.length} card${s.cards.length !== 1 ? "s" : ""}`;

  // mastery bar
  let mastered = 0, learning = 0, newC = 0;
  s.cards.forEach(c => {
    const b = c.progress?.box || 0;
    if (b >= 4) mastered++;
    else if (b > 0) learning++;
    else newC++;
  });
  const total = s.cards.length || 1;
  document.getElementById("set-progress-bar").innerHTML = `
    <div class="seg-mastered" style="width:${mastered/total*100}%" title="Mastered: ${mastered}"></div>
    <div class="seg-learning" style="width:${learning/total*100}%" title="Learning: ${learning}"></div>`;

  // card preview
  document.getElementById("set-cards-preview").innerHTML = s.cards.slice(0, 20).map(c => `
    <div class="card-preview-row">
      <div class="card-preview-term">${esc(c.term)}</div>
      <div class="card-preview-def">${esc(c.definition)}</div>
    </div>`).join("") + (s.cards.length > 20 ? `<p class="text-muted">...and ${s.cards.length - 20} more</p>` : "");

  // scores
  const scoresEl = document.getElementById("set-scores");
  if (s.scores && s.scores.length > 0) {
    scoresEl.innerHTML = `<h3>Recent Activity</h3>` + s.scores.map(sc =>
      `<div class="score-row">${capitalize(sc.mode)} — ${Math.round(sc.score)}/${sc.total}${sc.time_secs ? ` in ${sc.time_secs.toFixed(1)}s` : ""} · ${timeAgo(sc.created_at)}</div>`
    ).join("");
  } else {
    scoresEl.innerHTML = "";
  }
  showView("set");
}

function backToSet() {
  if (currentSetId) showSetDetail(currentSetId);
  else showView("dashboard");
}

// ── Flashcards ───────────────────────────────────────────────────────────────

let fcCards = [], fcIdx = 0, fcStarred = new Set();

function startFlashcards() {
  if (!currentSetData || currentSetData.cards.length === 0) return;
  fcCards = [...currentSetData.cards];
  fcIdx = 0;
  fcStarred = new Set();
  showView("flashcards");
  renderFlashcard();
}

function renderFlashcard() {
  const card = fcCards[fcIdx];
  const el = document.getElementById("flashcard");
  el.classList.remove("flipped");
  document.getElementById("fc-front").textContent = card.term;
  document.getElementById("fc-back").textContent = card.definition;
  document.getElementById("fc-progress").textContent = `${fcIdx + 1} / ${fcCards.length}`;
  const starBtn = document.getElementById("fc-star-btn");
  starBtn.classList.toggle("starred", fcStarred.has(card.id));
  starBtn.innerHTML = fcStarred.has(card.id) ? "&#9733;" : "&#9734;";
}

function flipCard() {
  document.getElementById("flashcard").classList.toggle("flipped");
}

function fcPrev() {
  if (fcIdx > 0) { fcIdx--; renderFlashcard(); }
}

function fcNext() {
  if (fcIdx < fcCards.length - 1) { fcIdx++; renderFlashcard(); }
}

function fcShuffle() {
  fcCards = shuffle(fcCards);
  fcIdx = 0;
  renderFlashcard();
}

function fcToggleStar() {
  const id = fcCards[fcIdx].id;
  fcStarred.has(id) ? fcStarred.delete(id) : fcStarred.add(id);
  renderFlashcard();
}

function fcFilterStarred() {
  if (document.getElementById("fc-star-only").checked) {
    if (fcStarred.size === 0) {
      alert("Star some cards first!");
      document.getElementById("fc-star-only").checked = false;
      return;
    }
    fcCards = currentSetData.cards.filter(c => fcStarred.has(c.id));
  } else {
    fcCards = [...currentSetData.cards];
  }
  fcIdx = 0;
  renderFlashcard();
}

// keyboard nav
document.addEventListener("keydown", e => {
  if (document.getElementById("view-flashcards")?.style.display === "none") return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "ArrowLeft") fcPrev();
  else if (e.key === "ArrowRight") fcNext();
  else if (e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); flipCard(); }
});

// ── Learn mode ───────────────────────────────────────────────────────────────

let learnQueue = [], learnIdx = 0, learnCorrect = 0, learnTotal = 0;

async function startLearn() {
  if (!currentSetData || currentSetData.cards.length === 0) return;
  showView("learn");
  document.getElementById("learn-summary").style.display = "none";
  document.querySelector(".learn-stage").style.display = "block";

  // mix multiple-choice and written
  learnQueue = shuffle([...currentSetData.cards]);
  learnIdx = 0;
  learnCorrect = 0;
  learnTotal = learnQueue.length;
  renderLearnCard();
}

function renderLearnCard() {
  if (learnIdx >= learnQueue.length) {
    finishLearn();
    return;
  }
  const card = learnQueue[learnIdx];
  document.getElementById("learn-progress").textContent = `${learnIdx + 1} / ${learnTotal}`;
  document.getElementById("learn-prompt").textContent = card.term;
  const fb = document.getElementById("learn-feedback");
  fb.className = "learn-feedback";
  fb.style.display = "none";
  document.getElementById("learn-next-btn").style.display = "none";

  // alternate between MC and written
  if (learnIdx % 3 === 2 && learnQueue.length >= 2) {
    // written
    document.getElementById("learn-choices").style.display = "none";
    document.getElementById("learn-write").style.display = "flex";
    document.getElementById("learn-input").value = "";
    document.getElementById("learn-input").focus();
  } else {
    // multiple choice
    document.getElementById("learn-write").style.display = "none";
    document.getElementById("learn-choices").style.display = "grid";
    const wrong = shuffle(currentSetData.cards.filter(c => c.id !== card.id)).slice(0, 3);
    const options = shuffle([card, ...wrong]);
    document.getElementById("learn-choices").innerHTML = options.map(o =>
      `<button class="learn-choice" data-correct="${o.id === card.id}" onclick="learnPickChoice(this, ${o.id === card.id})">${esc(o.definition)}</button>`
    ).join("");
  }
}

function learnPickChoice(btn, correct) {
  const choices = document.querySelectorAll(".learn-choice");
  choices.forEach(c => {
    c.style.pointerEvents = "none";
    if (c.dataset.correct === "true") c.classList.add("correct");
  });
  if (!correct) btn.classList.add("wrong");
  showLearnFeedback(correct, learnQueue[learnIdx]);
}

function learnSubmitWritten() {
  const input = document.getElementById("learn-input").value.trim().toLowerCase();
  const card = learnQueue[learnIdx];
  const answer = card.definition.trim().toLowerCase();
  const correct = input === answer || levenshtein(input, answer) <= Math.max(1, Math.floor(answer.length * 0.15));
  showLearnFeedback(correct, card);
}

function showLearnFeedback(correct, card) {
  if (correct) learnCorrect++;
  const fb = document.getElementById("learn-feedback");
  fb.className = `learn-feedback show ${correct ? "correct" : "wrong"}`;
  fb.textContent = correct ? "Correct!" : `Incorrect — the answer is: ${card.definition}`;
  document.getElementById("learn-next-btn").style.display = "block";
  // update spaced rep
  api("/api/progress", { method: "POST", body: { card_id: card.id, correct } }).catch(() => {});
}

function learnNext() {
  learnIdx++;
  renderLearnCard();
}

function finishLearn() {
  document.querySelector(".learn-stage").style.display = "none";
  const summary = document.getElementById("learn-summary");
  summary.style.display = "block";
  const pct = Math.round((learnCorrect / learnTotal) * 100);
  document.getElementById("learn-summary-stats").innerHTML = `
    <span style="color:${pct >= 80 ? "var(--success)" : pct >= 50 ? "var(--warning)" : "var(--danger)"}">${pct}%</span>
    <p class="text-muted" style="font-size:16px;margin-top:8px">${learnCorrect} of ${learnTotal} correct</p>`;
  api("/api/scores", { method: "POST", body: { set_id: currentSetId, mode: "learn", score: learnCorrect, total: learnTotal } }).catch(() => {});
}

// handle enter in learn input
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && document.getElementById("learn-input") === document.activeElement) {
    e.preventDefault();
    learnSubmitWritten();
  }
});

// ── Test mode ────────────────────────────────────────────────────────────────

let testCards = [], testStartTime;

function startTest() {
  if (!currentSetData || currentSetData.cards.length === 0) return;
  testCards = shuffle([...currentSetData.cards]);
  showView("test");
  document.getElementById("test-form").style.display = "block";
  document.getElementById("test-results").style.display = "none";
  testStartTime = Date.now();

  // timer
  const timerEl = document.getElementById("test-timer");
  clearInterval(window._testInterval);
  window._testInterval = setInterval(() => {
    const s = ((Date.now() - testStartTime) / 1000).toFixed(0);
    const m = Math.floor(s / 60);
    timerEl.textContent = m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
  }, 1000);

  const qEl = document.getElementById("test-questions");
  qEl.innerHTML = testCards.map((card, i) => {
    // mix MC and written
    if (i % 3 === 2) {
      return `
      <div class="test-q" data-card-id="${card.id}" data-answer="${esc(card.definition)}" data-type="written">
        <div class="test-q-num">Question ${i + 1}</div>
        <div class="test-q-prompt">${esc(card.term)}</div>
        <input type="text" class="test-q-write" placeholder="Type your answer..." autocomplete="off">
      </div>`;
    }
    const wrong = shuffle(currentSetData.cards.filter(c => c.id !== card.id)).slice(0, 3);
    const opts = shuffle([card, ...wrong]);
    return `
    <div class="test-q" data-card-id="${card.id}" data-answer="${card.id}" data-type="mc">
      <div class="test-q-num">Question ${i + 1}</div>
      <div class="test-q-prompt">${esc(card.term)}</div>
      <div class="test-q-choices">
        ${opts.map(o => `
          <label class="test-q-choice">
            <input type="radio" name="q${i}" value="${o.id}">
            ${esc(o.definition)}
          </label>`).join("")}
      </div>
    </div>`;
  }).join("");
}

function submitTest(e) {
  e.preventDefault();
  clearInterval(window._testInterval);
  const elapsed = (Date.now() - testStartTime) / 1000;
  let correct = 0;
  document.querySelectorAll(".test-q").forEach(q => {
    const type = q.dataset.type;
    let isCorrect = false;
    if (type === "mc") {
      const sel = q.querySelector("input[type=radio]:checked");
      isCorrect = sel && sel.value === q.dataset.answer;
    } else {
      const input = q.querySelector(".test-q-write").value.trim().toLowerCase();
      const ans = q.dataset.answer.toLowerCase();
      isCorrect = input === ans || levenshtein(input, ans) <= Math.max(1, Math.floor(ans.length * 0.15));
    }
    q.classList.add(isCorrect ? "correct-q" : "wrong-q");
    if (!isCorrect) {
      const card = testCards.find(c => c.id === q.dataset.cardId);
      if (card) {
        const div = document.createElement("div");
        div.className = "correct-answer";
        div.textContent = `Correct answer: ${card.definition}`;
        q.appendChild(div);
      }
    }
    if (isCorrect) correct++;
    api("/api/progress", { method: "POST", body: { card_id: q.dataset.cardId, correct: isCorrect } }).catch(() => {});
  });
  document.getElementById("test-form").querySelector("button[type=submit]").style.display = "none";
  document.getElementById("test-results").style.display = "block";
  const pct = Math.round((correct / testCards.length) * 100);
  document.getElementById("test-score-heading").innerHTML = `
    <span style="color:${pct >= 80 ? "var(--success)" : pct >= 50 ? "var(--warning)" : "var(--danger)"}">${pct}%</span>
    — ${correct} of ${testCards.length} correct (${elapsed.toFixed(1)}s)`;
  api("/api/scores", { method: "POST", body: { set_id: currentSetId, mode: "test", score: correct, total: testCards.length, time_secs: elapsed } }).catch(() => {});
}

// ── Match mode ───────────────────────────────────────────────────────────────

let matchPairs = [], matchSelected = null, matchMatched = 0, matchTotal = 0, matchStart;

function startMatch() {
  if (!currentSetData || currentSetData.cards.length === 0) return;
  showView("match");
  document.getElementById("match-complete").style.display = "none";
  const cards = shuffle([...currentSetData.cards]).slice(0, 8); // max 8 pairs
  matchTotal = cards.length;
  matchMatched = 0;
  matchSelected = null;
  matchStart = Date.now();

  // timer
  const timerEl = document.getElementById("match-timer");
  clearInterval(window._matchInterval);
  window._matchInterval = setInterval(() => {
    timerEl.textContent = ((Date.now() - matchStart) / 1000).toFixed(1) + "s";
  }, 100);

  // build tiles: one for term, one for definition per card
  const tiles = [];
  cards.forEach(c => {
    tiles.push({ id: c.id, text: c.term, side: "term" });
    tiles.push({ id: c.id, text: c.definition, side: "def" });
  });
  const shuffled = shuffle(tiles);
  document.getElementById("match-grid").innerHTML = shuffled.map((t, i) =>
    `<div class="match-tile" data-id="${t.id}" data-side="${t.side}" data-idx="${i}" onclick="matchTap(this)">${esc(t.text)}</div>`
  ).join("");
  document.getElementById("match-progress").textContent = `0 / ${matchTotal}`;
}

function matchTap(el) {
  if (el.classList.contains("matched")) return;
  if (matchSelected && matchSelected === el) {
    el.classList.remove("selected");
    matchSelected = null;
    return;
  }
  if (!matchSelected) {
    el.classList.add("selected");
    matchSelected = el;
    return;
  }
  // check match: same card id, different side
  const prev = matchSelected;
  if (prev.dataset.id === el.dataset.id && prev.dataset.side !== el.dataset.side) {
    prev.classList.remove("selected");
    prev.classList.add("matched");
    el.classList.add("matched");
    matchMatched++;
    document.getElementById("match-progress").textContent = `${matchMatched} / ${matchTotal}`;
    if (matchMatched === matchTotal) {
      clearInterval(window._matchInterval);
      const elapsed = (Date.now() - matchStart) / 1000;
      document.getElementById("match-final-time").textContent = `Completed in ${elapsed.toFixed(1)} seconds`;
      document.getElementById("match-complete").style.display = "block";
      api("/api/scores", { method: "POST", body: { set_id: currentSetId, mode: "match", score: matchTotal, total: matchTotal, time_secs: elapsed } }).catch(() => {});
    }
  } else {
    el.classList.add("wrong");
    prev.classList.add("wrong");
    setTimeout(() => {
      el.classList.remove("wrong", "selected");
      prev.classList.remove("wrong", "selected");
    }, 500);
  }
  matchSelected = null;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function timeAgo(dateStr) {
  const d = new Date(dateStr + (dateStr.includes("Z") ? "" : "Z"));
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

async function logout() {
  await api("/api/logout", { method: "POST" });
  location.href = "/login";
}

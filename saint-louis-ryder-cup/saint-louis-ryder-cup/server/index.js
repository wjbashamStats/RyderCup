/**
 * Saint Louis Ryder Cup — Backend Server
 * Node.js + Express + SQLite (better-sqlite3)
 *
 * Endpoints:
 *   GET  /api/state          → returns current scoreboard state JSON
 *   POST /api/state          → host saves full state JSON  (requires PIN header)
 *   POST /api/hole           → pairing submits a single hole result
 *   GET  /api/matches        → list of matches with player names (for pairing UI)
 *
 * Auth:
 *   Host PIN:    X-Host-Pin header (or body.pin)
 *   Pairing PIN: X-Match-Pin header / body.matchPin  (match id embedded in URL)
 */

const express    = require("express");
const Database   = require("better-sqlite3");
const path       = require("path");
const crypto     = require("crypto");

/* ── config ─────────────────────────────────────────── */
const PORT     = process.env.PORT || 3000;
const HOST_PIN = process.env.HOST_PIN || "0626";      // change this!
// Per-pairing PIN used by players to submit their own scores.
// Each match gets PIN = last 4 of its id by default (or set a shared one here).
const PAIRING_PIN = process.env.PAIRING_PIN || null;  // null = per-match pin

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ── database ────────────────────────────────────────── */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "slrc.db");
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS hole_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id   TEXT NOT NULL,
    hole_index INTEGER NOT NULL,
    result     TEXT,          -- 'j' | 'e' | 'h' | null (clear)
    submitted_by TEXT,        -- player name or 'host'
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

/* helpers */
function getState() {
  const row = db.prepare("SELECT value FROM kv WHERE key='state'").get();
  return row ? JSON.parse(row.value) : null;
}
function saveState(state) {
  db.prepare(`
    INSERT INTO kv(key,value,updated_at) VALUES('state',?,strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(JSON.stringify(state));
}

function pinOk(req) {
  const h = req.headers["x-host-pin"] || (req.body && req.body.pin);
  return h === HOST_PIN;
}
function matchPinOk(req, matchId) {
  if (PAIRING_PIN) {
    // single shared pairing PIN
    const p = req.headers["x-match-pin"] || (req.body && req.body.matchPin);
    return p === PAIRING_PIN;
  }
  // per-match PIN = last 4 chars of the match id (auto-derived, no config needed)
  const pin = matchId.slice(-4);
  const p = req.headers["x-match-pin"] || (req.body && req.body.matchPin);
  return p === pin;
}

/* ── recompute helpers (mirrors frontend logic) ──────── */
function recomputeFromHoles(mt) {
  if (!mt.holes || !mt.holes.some(h => h)) return;
  let jh=0, eh=0, ha=0, jf=0, ef=0, hf=0, jb=0, eb=0, hb=0;
  mt.holes.forEach((h, i) => {
    if (h==="j")  { jh++; i<9?jf++:jb++; }
    else if (h==="e") { eh++; i<9?ef++:eb++; }
    else if (h==="h") { ha++; i<9?hf++:hb++; }
  });
  const jHole = jh + 0.5*ha, eHole = eh + 0.5*ha;
  const frontDone = mt.holes.slice(0,9).every(h => h);
  const backDone  = mt.holes.slice(9,18).every(h => h);
  const bonus = (a,b) => a>b ? [1,0] : a<b ? [0,1] : [0.5,0.5];
  let pa=jHole, pb=eHole;
  if (frontDone) { const[a,b]=bonus(jf+0.5*hf, ef+0.5*hf); pa+=a; pb+=b; }
  if (backDone)  { const[a,b]=bonus(jb+0.5*hb, eb+0.5*hb); pa+=a; pb+=b; }
  if (frontDone && backDone) { const[a,b]=bonus(jHole,eHole); pa+=a; pb+=b; }
  mt.pa = pa; mt.pb = pb;
}

/* ── routes ──────────────────────────────────────────── */

/** GET /api/state — public, polled by all viewers */
app.get("/api/state", (req, res) => {
  const state = getState();
  if (!state) return res.status(404).json({ error: "No state yet" });
  res.json(state);
});

/** GET /api/updated — lightweight poll: just the updated_at timestamp */
app.get("/api/updated", (req, res) => {
  const row = db.prepare("SELECT updated_at FROM kv WHERE key='state'").get();
  res.json({ updated_at: row ? row.updated_at : 0 });
});

/** POST /api/state — host saves full state */
app.post("/api/state", (req, res) => {
  if (!pinOk(req)) return res.status(401).json({ error: "Wrong host PIN" });
  const body = req.body;
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Bad body" });
  saveState(body);
  res.json({ ok: true });
});

/**
 * GET /api/matches — returns minimal match list for the pairing score-entry UI.
 * Includes each match's per-match PIN so the app can tell the player what to enter.
 */
app.get("/api/matches", (req, res) => {
  const state = getState();
  if (!state) return res.status(404).json({ error: "No state" });
  const matches = state.matches.map(mt => ({
    id:     mt.id,
    day:    mt.day,
    a:      mt.a,
    b:      mt.b,
    holes:  mt.holes,
    pa:     mt.pa,
    pb:     mt.pb,
    // expose the per-match PIN so host can share it
    matchPin: PAIRING_PIN || mt.id.slice(-4),
  }));
  const teams = state.teams;
  const days  = state.days.map(d => ({ id:d.id, name:d.name, format:d.format, course:d.course }));
  res.json({ matches, teams, days });
});

/**
 * POST /api/hole — a pairing submits a single hole result
 * Body: { matchId, holeIndex, result, matchPin, submittedBy? }
 * result: "j" | "e" | "h" | null  (null clears the hole)
 */
app.post("/api/hole", (req, res) => {
  const { matchId, holeIndex, result, matchPin, submittedBy } = req.body || {};
  if (!matchId) return res.status(400).json({ error: "matchId required" });
  if (holeIndex == null || holeIndex < 0 || holeIndex > 17)
    return res.status(400).json({ error: "holeIndex must be 0–17" });
  if (!["j","e","h",null].includes(result))
    return res.status(400).json({ error: "result must be j | e | h | null" });

  // auth: host PIN OR matching pairing PIN
  const isHostReq = req.headers["x-host-pin"] === HOST_PIN || (req.body && req.body.pin === HOST_PIN);
  if (!isHostReq && !matchPinOk(req, matchId))
    return res.status(401).json({ error: "Wrong match PIN" });

  const state = getState();
  if (!state) return res.status(404).json({ error: "No state" });

  const mt = state.matches.find(x => x.id === matchId);
  if (!mt) return res.status(404).json({ error: "Match not found" });

  if (!Array.isArray(mt.holes) || mt.holes.length !== 18)
    mt.holes = Array(18).fill(null);

  mt.holes[holeIndex] = result;
  recomputeFromHoles(mt);

  // log it
  db.prepare(`
    INSERT INTO hole_log(match_id,hole_index,result,submitted_by)
    VALUES(?,?,?,?)
  `).run(matchId, holeIndex, result, submittedBy || "player");

  saveState(state);
  res.json({ ok: true, pa: mt.pa, pb: mt.pb, holes: mt.holes });
});

/**
 * GET /api/match/:id  — get a single match's current holes (for the pairing entry page)
 */
app.get("/api/match/:id", (req, res) => {
  const state = getState();
  if (!state) return res.status(404).json({ error: "No state" });
  const mt = state.matches.find(x => x.id === req.params.id);
  if (!mt) return res.status(404).json({ error: "Not found" });
  res.json({
    id: mt.id, day: mt.day, a: mt.a, b: mt.b,
    holes: mt.holes, pa: mt.pa, pb: mt.pb,
    matchPin: PAIRING_PIN || mt.id.slice(-4),
  });
});

/* ── serve score-entry page ──────────────────────────── */
// The main index.html is served from /public by the static middleware above.
// score.html (pairing entry page) is also in /public.
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n🏌️  Saint Louis Ryder Cup server running`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Host PIN: ${HOST_PIN}  (set HOST_PIN env var to change)`);
  if (PAIRING_PIN) console.log(`   Pairing PIN: ${PAIRING_PIN} (shared)`);
  else console.log(`   Pairing PINs: last 4 chars of each match ID (shown in host view)`);
  console.log();
});

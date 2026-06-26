# Saint Louis Ryder Cup — Backend & Hosting Guide

This turns your single HTML file into a **live, multi-device scoreboard** with a
real backend. The host runs the show from their phone; each pairing gets a link
and a 4-digit PIN to punch in their own win / loss / halve for every hole; and
everyone watching sees the board update within a few seconds.

---

## What's in this folder

```
slrc/
├── server/
│   └── index.js          ← the backend (Node + Express + SQLite)
├── public/
│   ├── index.html        ← the scoreboard (your original, now talks to the server)
│   └── score.html        ← NEW: the pairing score-entry page players use
├── package.json
├── .env.example
└── DEPLOY.md             ← this file
```

---

## How it works (the 60-second version)

- **One source of truth.** The server keeps the whole tournament in a tiny SQLite
  database file (`slrc.db`). No more "saved on this device only."
- **The host** opens the scoreboard, taps **Host**, enters the host PIN. Only
  someone with that PIN can change names, pairings, race-to total, etc.
- **Each pairing** opens `/score`, picks their match, enters their **4-digit match
  PIN**, and taps J / ½ / E for each hole. The server recalculates the 21-point
  total (with the front/back/match bonuses) automatically — identical math to the
  scoreboard.
- **Everyone else** just opens the main page. It polls the server every 8 seconds
  and refreshes when anything changes.

Win / loss / all-square **by hole** is exactly what the entry page captures:
**J** = the gold team won the hole, **½** = halved (all square), **E** = the blue
team won the hole.

---

## The PINs

There are two kinds:

| PIN | Who uses it | Where it's set |
|-----|-------------|----------------|
| **Host PIN** | You, to edit the board | `HOST_PIN` env var (default `0626`) |
| **Match PIN** | Each pairing, to enter their scores | Auto-generated: the **last 4 characters of the match's ID**. The host can see each one — open the host view and the match list shows it. Or set one shared `PAIRING_PIN` for everybody. |

**Recommendation for a weekend with friends:** set a single `PAIRING_PIN` (e.g.
`1234`) so you can tell everyone the same number. Per-match PINs are more secure
but more to hand out.

---

## Run it locally first (5 minutes)

You need **Node.js 18 or newer**. Check with `node -v`. If you don't have it,
download it from <https://nodejs.org> (the "LTS" version).

```bash
cd slrc
npm install          # installs express + better-sqlite3
npm start            # starts the server
```

You'll see:

```
🏌️  Saint Louis Ryder Cup server running
   http://localhost:3000
   Host PIN: 0626
```

Open <http://localhost:3000> — that's the scoreboard.
Open <http://localhost:3000/score> — that's the pairing entry page.

To change the host PIN locally:

```bash
HOST_PIN=4242 PAIRING_PIN=1234 npm start
```

> **Test on your phone, same Wi-Fi:** find your computer's local IP
> (`ipconfig` on Windows / `ifconfig | grep inet` on Mac), then visit
> `http://THAT-IP:3000` from your phone. Good enough for a backyard test, but for
> the actual event you want real hosting so it works on cell data — see below.

---

## Hosting it for real

You want a host that:
1. Runs a Node server (not just static files), and
2. Gives you a **persistent disk** so the SQLite database survives restarts.

Here are three good options, easiest first.

### Option A — Render.com (recommended, has a free tier)

1. Put this folder in a **GitHub repo** (see "Pushing to GitHub" below).
2. Go to <https://render.com> → sign up → **New → Web Service**.
3. Connect your repo.
4. Fill in:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance type:** Free is fine for a friend group.
5. Under **Environment**, add variables:
   - `HOST_PIN` = your host PIN
   - `PAIRING_PIN` = your shared pairing PIN (optional)
   - `DB_PATH` = `/data/slrc.db`
6. Add a **Disk** (Render → your service → Disks → Add Disk):
   - **Mount path:** `/data`
   - **Size:** 1 GB is plenty.
   - This is what keeps scores from disappearing on restart.
7. Click **Create Web Service**. In ~2 minutes you'll get a URL like
   `https://saint-louis-ryder-cup.onrender.com`.

> **Free-tier note:** Render's free services "sleep" after 15 minutes idle and take
> ~30 seconds to wake on the next visit. For tournament day, either upgrade to the
> cheapest paid instance (~$7/mo, no sleeping) for that month, or just have someone
> load the page a minute before the first tee.

### Option B — Railway.app

Very similar flow. New Project → Deploy from GitHub repo. Add the same environment
variables. Railway gives you a volume for persistent storage — mount it and point
`DB_PATH` at it (e.g. `/data/slrc.db`). Railway has a small monthly usage credit.

### Option C — Fly.io

More control, still simple. Install the `fly` CLI, run `fly launch` in this folder
(it detects Node), say yes to creating a volume, then set `DB_PATH` to the volume
mount path. Set secrets with `fly secrets set HOST_PIN=... PAIRING_PIN=...`.

---

## Pushing to GitHub (needed for Options A & B)

```bash
cd slrc
git init
git add .
git commit -m "Saint Louis Ryder Cup scoreboard + backend"
```

Then create an empty repo on github.com and follow its "push an existing
repository" instructions (two commands it gives you). The `.gitignore` already
keeps `node_modules` and your local database out of the repo.

---

## Day-of checklist

1. **Open the scoreboard** at your hosting URL. Tap **Host**, enter your host PIN.
2. **Set the pairings** for the round (the +Add / player dropdowns). This creates
   the matches the players will see on the entry page.
3. **Hand out the entry link + PIN.** The link is `your-url/score`. A QR code on a
   printed sheet at the first tee works great — generate one free at any
   QR site by pasting that URL.
   - With a shared `PAIRING_PIN`: tell everyone the one number.
   - With per-match PINs: read each pair their 4-digit code from the host view.
4. **Players enter scores** hole by hole as they play. Each tap saves on its own,
   and **Submit** at the end pushes the final card.
5. **Watch it roll in.** The main board, news feed, leaderboard, and specialists
   all update automatically.

If a pairing makes a mistake, they can tap a hole button again to clear it, or you
as host can fix any score directly from the scoreboard's hole-by-hole editor.

---

## Common questions

**Do I lose my old in-browser scores?**
The app no longer uses browser storage — the server is the source of truth. The
first time the server starts with an empty database, it seeds the default
tournament (your teams, courses, and empty matches), and you take it from there.

**Can two pairings enter at the same time?**
Yes. Each writes only its own match's holes, and the server recalculates after
every hole, so there's no fighting over the data.

**Is the host PIN safe?**
Yes — it's checked **on the server**, never embedded in the page. A wrong PIN just
gets the save rejected. (Still, pick a PIN you don't mind sharing with co-captains
and keep it off the printed player sheet.)

**Can I run it without internet at the course?**
Cell coverage permitting, real hosting (Options A–C) is the move since it works on
any network. A purely on-site setup (everyone on one hotspot hitting your laptop)
is possible but fiddly — not recommended unless coverage is genuinely zero.

**Where's the data stored?**
In `slrc.db` (SQLite) at whatever `DB_PATH` points to. Back it up by downloading
that file from your host's dashboard if you want a souvenir of the carnage.

---

## API reference (if you want to tinker)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/api/state` | none | Full tournament state (the board polls this) |
| `GET`  | `/api/updated` | none | Just a timestamp, for cheap change-polling |
| `POST` | `/api/state` | host PIN | Host saves the full state |
| `GET`  | `/api/matches` | none | Match list for the entry page |
| `GET`  | `/api/match/:id` | none | One match's current holes |
| `POST` | `/api/hole` | match or host PIN | Submit one hole result (`j`/`e`/`h`/`null`) |

Host PIN goes in the `X-Host-Pin` header; match PIN in `X-Match-Pin` (or in the
JSON body as `pin` / `matchPin`).

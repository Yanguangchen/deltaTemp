# GPR Annotator

Upload a ground penetrating radar image, Gemini interprets it, and the features come
back as traced hyperbolas, apex markers and estimated positions/depths. Drag,
resize, rename or add your own arrows, then export.

Plain HTML/CSS/JS on the front end. The only backend is a zero-dependency Node script
whose job is to hold the API key and forward requests.

## Part of the DeltaTemp workspace

This tool is a sibling of Data Helper, not a standalone project. `server.js` serves
the whole DeltaTemp folder, so one process runs both:

| URL | App |
| --- | --- |
| `http://localhost:8787/` | Data Helper (temperature differences) |
| `http://localhost:8787/gpr-annotator/` | GPR Annotator |

Data Helper's top bar carries a **GPR Annotator** nav link, and this app's top bar has
a **← Data Helper** link back, so you move between them without touching the URL.
Data Helper itself stays a static, no-server app — opening its `index.html` directly
still works exactly as before.

## Setup

The env template lives at the **DeltaTemp root**, one level up, so it sits next to
the other projects instead of being buried in this folder:

```
DeltaTemp\
├─ .env.example      ← copy this to .env
└─ gpr-annotator\
   └─ .env.example   ← optional per-app override
```

```bash
cd ..
copy .env.example .env     # then paste your key into .env
cd gpr-annotator
npm start                  # → http://localhost:8787
```

Get a key at https://aistudio.google.com/apikey. No `npm install` — there are no
dependencies. Needs Node 18+ for global `fetch`.

### Where the server looks

At boot, nearest-first:

1. `gpr-annotator\.env` — per-app override, optional
2. `DeltaTemp\.env` — the shared one you normally use

First file to define a key wins, and a real shell environment variable beats both.
So one root `.env` covers every app under DeltaTemp, and you only drop a `.env` in
this folder if you want different values here. The startup banner prints which files
it actually loaded.

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | Required for the server path |
| `GEMINI_MODEL` | `gemini-3.7-flash` | Any model id your key can reach |
| `GEMINI_MODEL_FALLBACK` | `gemini-3.5-flash` | Used on 429/503; empty disables |
| `GEMINI_MAX_RETRIES` | `3` | Attempts per model before moving on |
| `PORT` | `8787` | Local server port |

Read nearest-first: `gpr-annotator\.env.local` → `gpr-annotator\.env` →
`DeltaTemp\.env.local` → `DeltaTemp\.env`. First file to define a key wins.

### Choosing a model

Defaults to `gemini-3.7-flash`. Verified against a live key, the useful ids are
`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash` and
`gemini-3.1-pro-preview`. Model ids differ per account — **Settings → List models
my key can call** queries Google and fills the dropdown with ids that really work.

`gemini-3.7-flash` is popular enough to return 503 "high demand" in bursts. The
server retries it 3 times (1s then 2s backoff) and then falls back to
`GEMINI_MODEL_FALLBACK`, so a busy model degrades instead of failing. When the
fallback answers, the toast says which model produced the annotations.

## Two ways to run it

**Served (recommended).** `npm start`. The key lives in `.env` on the server, the
browser posts the image to `/api/annotate`, and the key never reaches the page. The
Settings dialog shows a green "server key active" banner and ignores its own key field.

**Static.** Open `index.html` directly — no server, no `.env`. You then have to paste
a key into Settings, where it's kept in `localStorage` and sent from the browser
straight to Google. Fine for a quick local look; don't host the page this way.

The app decides between the two by probing `GET /api/config` at load.

## Using it

- **Upload** — drop a radargram on the page or click to browse.
- **Interpretation focus** — optional free text in the side panel (survey length,
  depth range, "focus on utilities") appended to the prompt.
- **Scan icon** — returns up to 10 target annotations, each with a caption,
  rationale and confidence estimate. A scan with no clear targets can return none.
- **Arrow icon** above the image — drag from the arrow's start to its tip. Escape
  cancels drawing. Drag either endpoint or the shaft to adjust a completed arrow.
- **Wave velocity** — optional survey-calibrated m/ns, used when converting a time
  axis to depth. A known time zero is also required.
- Icon actions have hover titles and accessible names. The light card layout
  respects reduced-motion preferences.

### Editing annotations

| Action | How |
| --- | --- |
| Move a label | Drag the label box |
| Resize a label | Drag its top-right handle; focus the handle and use arrow keys for keyboard adjustment |
| Draw an arrow | Select the arrow icon above the scan, then drag on the image |
| Move an arrow | Drag its shaft, or either endpoint |
| Re-target an arrow | Drag the ringed dot at the arrow tip |
| Edit the caption | Double-click the label; Enter commits, Esc cancels |
| Select | Click a label, arrow, or side-panel card |
| Nudge label | Arrow keys (Shift = bigger step) |
| Nudge label + target together | Alt + arrow keys |
| Delete | Delete/Backspace, or the × on the card |
| Add manually | **+** icon in the panel |

**Export PNG** renders the image at its original resolution with arrows and labels
burned in, including resized labels and manually drawn arrows. Reanalysis preserves
manual arrows; clearing annotations removes everything.

## Measurements and interpretation

The prompt asks for coherent hyperbolas, apexes and visible limb points. Repeated
phase bands are not separate targets. Labels describe possible targets, not
confirmed materials; confidence is a model estimate.

The app interpolates the apex against two readable axis ticks. Horizontal positions
are along the scan line, not a sideways offset from the survey path. Metres, feet
and inches convert to metres. A readable depth axis is used directly. With two-way
time, depth is `velocity × (time − timeZero) / 2`; a known time zero and a printed
or operator-supplied calibrated velocity are required. Missing calibration shows
**Unknown**. Measurements are not extrapolated beyond the chosen ticks. Dragging
an apex updates its measurements and removes the old curve trace.

Curve width alone does not establish metallic material, diameter or depth. The
guidance follows the [GSSI Utility Locating Handbook](https://www.geophysical.com/wp-content/uploads/2021/07/MN72615B-Utility-Locating-Handbook.pdf)
and [Sensors & Software pipe-diameter guidance](https://www.sensoft.ca/blog/tips-determining-pipe-diameter-from-gpr-data/).
Image estimates depend on the original survey calibration and readable ticks.

## How coordinates work

Gemini returns points on its normalized 0–1000 grid (`{y, x}`, origin top-left). The
app converts those to 0–1 fractions of the image and keeps them that way, so
annotations stay locked to the right pixels across window resizes and when the export
scales back up to full resolution.

## Files

| File | Role |
| --- | --- |
| `index.html` | Markup, settings dialog |
| `style.css` | Light card UI, motion preferences, label/arrow styling |
| `app.js` | State, rendering, drag handling, PNG export, both request paths |
| `prompt.js` | System prompt, response schema, request builder/parser — shared by browser and server |
| `server.js` | Static file server + `/api/annotate` proxy + `.env` loader |
| `.env.example` | Optional per-app override template — the main one is at the DeltaTemp root |

`prompt.js` is a UMD-ish module loaded by both sides, so the served and static paths
send Gemini an identical request.

## Verified

`server.js` was exercised locally: `/api/config` reports key state, static files serve
with correct MIME types, and `/api/annotate` returns a clear error with no key set.
Both apps resolve from one process — `/` returns the Data Helper title,
`/gpr-annotator/` returns this app's — and the nav links are present in both pages.

Because the static root is now the workspace folder, the path guards were re-tested:
`/.env`, `/.env.example`, `/gpr-annotator/.env`, `/.git/config` and encoded traversal
(`%2e%2e%2f%2e%2e%2fWindows%2fwin.ini`) all return 403. Any path segment beginning
with a dot is refused, so no `.env` is ever reachable over HTTP.

The env cascade was tested with throwaway files: a root `DeltaTemp\.env` alone was
picked up (`PORT` and `GEMINI_MODEL` both applied, `hasServerKey: true`), and adding
`gpr-annotator\.env` overrode the model while still inheriting the key from the root.
Both test files were deleted afterwards.

Browser checks cover desktop/mobile layouts, the loading overlay on success/error/
cancel, fixture-based measurements, label resizing, arrow drawing/retargeting and
source-resolution PNG export. `node tests/gpr-measurements.cjs` checks interpolation,
unit conversion, time/depth conversion and missing calibration.
`tests/gpr-editing.browser.js` uses a controlled response fixture; it does not
validate AI interpretation accuracy.

A live Gemini request on 2026-09-18 timed out at the server's 110-second limit.
The revised prompt has not yet been validated against a completed live response.

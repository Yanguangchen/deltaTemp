# GPR Annotator

Upload a ground penetrating radar image, Gemini interprets it, and the features come
back as traced hyperbolas, apex markers and estimated positions/depths. Then mark it
up yourself: arrows, region boxes, measurements, freehand reflector traces and notes,
on a canvas deliberately larger than the scan so annotations can live in the margin.
Edit any annotation's text, confidence, colour and line weight, undo freely, and
export at source resolution.

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

### Deployed on Vercel

Vercel never runs `server.js` — it publishes the workspace as static files, so the
`/api` routes it serves locally simply don't exist there. `../api/*.js` re-creates
them as serverless functions: `config`, `health`, `models`, `annotate`, `client-log`.
Same env vars (`GEMINI_API_KEY` and friends, set in Project → Settings → Environment
Variables, then redeploy), same `prompt.js`, so a deployed analysis asks Gemini for
exactly what a local one does.

#### The access token

A deployed `/api/annotate` is a Gemini proxy on a public URL. Set `GPR_ACCESS_TOKEN`
in the Vercel environment and the routes that spend the key — `annotate`, `models`,
`client-log` — require an `x-gpr-token` header matching it; without it they answer
401. Paste the same value into Settings → "Access token", which appears only when
the server says it needs one. `config` and `health` stay open so the client can
discover that a token is required instead of assuming there's no server at all.

Generate one with:

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Leave it unset locally — `server.js` ignores the variable, and a local server is
already reachable only from your own machine. Unset *in production* logs an
`auth.open` warning to the Vercel runtime logs, because that combination means the
URL alone is enough to spend your key.

This is a shared secret, not authentication: it stops drive-by use, not someone the
token was given to. Pair it with a budget cap on the Google project.

Three further things are the platform's and differ from `npm start`:

- Request bodies are capped at 4.5 MB. The client already downscales to a 1600 px
  long edge before upload, so real radargrams land far under that.
- Each invocation is its own process, so there are no uptime, in-flight or metric
  counters and no log file. `/api/metrics` and `/api/logs` exist locally only, which
  means `observability.html` is a local-server page. Function output goes to the
  Vercel runtime logs instead, and `/api/health` reports `runtime: "vercel-function"`
  so you can tell which server answered.
- `vercel.json` gives `api/annotate.js` a 300 s limit, enough for the retry and
  fallback chain. That ceiling needs Fluid compute; without it, lower it to 60.

## Using it

- **Upload** - drop a radargram on the page or click to browse.
- **Interpretation focus** - optional free text in the side panel (survey length,
  depth range, "focus on utilities") appended to the prompt.
- **Scan icon** - returns up to 10 target annotations, each with a caption,
  rationale and confidence estimate. A scan with no clear targets can return none.
- **Wave velocity** - optional survey-calibrated m/ns, used when converting a time
  axis to depth. A known time zero is also required.
- Icon actions have hover titles and accessible names. The light card layout
  respects reduced-motion preferences.

### The canvas is bigger than the scan

GPR exports are often only a few hundred pixels wide, so the drawing surface is
sized to the panel, **not** to the image. The scan is centred at about 70% of the
canvas and scaled up to fill it; the band left over on all four sides is ordinary
annotation space. Notes, labels and arrow tails may sit entirely off the image,
which is what a report figure usually wants - callouts in the margin with leaders
pointing back into the data.

Coordinates are still a fraction of the image, so `x = -0.3` simply means "30% of
the image width into the left margin". Everything survives window resizes and still
exports at source resolution.

- **Zoom** - the `-` / `+` buttons either side of the percentage, or `-`, `+` and
  `0` on the keyboard. The percentage button refits the image. Zooming in shrinks
  the margin; zoom out when you want more room for labels.
- **Margin icon** (side panel) - stacks every leader-line label into the left and
  right margins, ordered by depth. One click turns scattered markup into a figure
  layout. It says so if there is not enough margin to do it.

### Tools

Pick a tool in the canvas toolbar, or press its key. A tool reverts to Select after
one shape, and Esc cancels mid-draw.

| Tool | Key | Draw | Produces |
| --- | --- | --- | --- |
| Select | `V` | - | Move, resize and re-target existing annotations |
| Arrow | `A` | Drag tail to tip | A bare arrow; the tail may start in the margin |
| Region | `B` | Drag a rectangle | A dashed box with its own draggable label |
| Measurement | `R` | Drag between two points | A ruler reading along/depth separation from the axis calibration, or image percentages when no calibration is known |
| Trace | `P` | Drag along the reflector | A freehand polyline with a label and leader |
| Note | `N` | Click | A standalone text card with no leader - designed for the margin |

Manual targets still come from the **+** icon in the panel. Everything drawn by hand
survives reanalysis; only the model's own targets are replaced.

### Editing annotations

Selecting anything - on the canvas or in the side panel - opens an editor under the
list with that annotation's label, note, confidence, line weight and colour.

| Action | How |
| --- | --- |
| Edit label / note | Editor fields, or double-click the label on the canvas |
| Confidence | Editor slider; **Clear** removes the estimate entirely |
| **Line weight** | Editor slider, 0.4x-4x. Scales arrows, boxes, rulers, traces, leaders and target rings together, on screen and in the export. New annotations inherit the last weight you set; **Reset** returns to 1x |
| Colour | Editor swatches (8-colour palette) |
| Move a label | Drag the label box anywhere in the canvas, margin included |
| Resize a label | Drag its top-right handle; focus the handle and use arrow keys |
| Move a target | Drag the ringed dot |
| Move a whole shape | Drag its line, box edge or trace |
| Reshape | Drag either endpoint handle of an arrow, ruler or box |
| Nudge | Arrow keys (Shift = bigger step); Alt moves the whole annotation |
| Duplicate | `Ctrl+D`, or the copy icon in the editor |
| Delete | `Delete`/`Backspace`, the x on the card, or the editor's bin icon |
| **Undo / redo** | `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`), or the toolbar arrows - 80 steps |

**Export PNG** renders at source resolution and **expands the frame to cover anything
in the margin**, so off-image notes and labels are never cropped. The image itself
stays 1:1 with the original pixels; the surrounding area is filled and the image edge
outlined. Oversized results are capped at 9000px on the long edge.

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
| `app.js` | State, canvas layout, rendering, drag/draw handling, undo stack, PNG export, both request paths |
| `tests/workspace.browser.js` | Drives every tool, the editor, undo/redo and export against a synthetic 420x260 scan |
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

`tests/workspace.html` runs `tests/workspace.browser.js`. Open it in a browser, or
headlessly with `--headless=new --window-size=1500,950 --virtual-time-budget=25000
--allow-file-access-from-files --dump-dom`. The page title becomes
`ALL n CHECKS PASSED` or `FAILED n/m`, and the full list lands in `#test-report`.
It loads a synthetic 420x260 radargram and asserts that the canvas is larger than
the image, that a small scan is scaled up, that all six tools produce annotations,
that a note and an arrow tail land outside the image, that label / note /
confidence / colour / line-weight edits apply, that undo, redo and duplicate
behave, that margin arrangement moves every label off the image, that zoom and fit
work, and that the exported PNG is wider than the source. All 22 checks passed on
2026-09-24: canvas 985x463 around a 524x324 displayed image, export 743x321 from a
420x260 source.

`tests/workspace.html` is a copy of `index.html` with the test script appended and
asset paths rewritten one level up, so regenerate it whenever `index.html` changes
(a `sed` one-liner doing the six substitutions is in the git history of this file;
the page fails loudly with a `CRASH` title if it has drifted).

A live Gemini request on 2026-09-18 timed out at the server's 110-second limit.
The revised prompt has not yet been validated against a completed live response.

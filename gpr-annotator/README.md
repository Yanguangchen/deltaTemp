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
| `FIREBASE_PROJECT_ID` | `gprportal-49b88` | Project whose ID tokens are accepted |
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

When every model in the chain fails, the error names the status each one returned.
A **503** is real contention — retry, drop to a smaller image, or pick a model from
another family. A **429** is this key's quota and waiting does not clear it, so the
message points at the Google project's quota and billing instead. A "busy" error
that survives more than an hour is almost always a 429 or a key problem, not a
traffic spike. Pick a fallback from a *different* family than `GEMINI_MODEL`;
two flash models share the same project quota, so the fallback does not help
when the cause is project-level.

## Two ways to run it

**Served (recommended).** `npm start`. The key lives in `.env` on the server, the
browser posts the image to `/api/annotate`, and the key never reaches the page. The
Settings dialog shows a green "server key active" banner and ignores its own key field.

**Static.** Open `index.html` directly — no server, no `.env`. You then have to paste
a key into Settings, where it's kept in `localStorage` and sent from the browser
straight to Google. Fine for a quick local look; don't host the page this way.

The app decides between the two by probing `GET /api/config` at load. If that
probe fails, the page shows "No API server reachable from …" and falls back to the
Static path.

## Google sign-in

The page and the API both require a Google account, through Firebase Auth on the
`gprportal-49b88` project. That project is shared with other RAK apps.

**In the browser** (`auth.js`, loaded by `index.html` and `observability.html`), a
sign-in screen covers the page until the user signs in with Google and the server
confirms they are approved (`GET /api/me`). The round initial in the top bar shows
who is signed in; click it to sign out. A signed-in user who isn't approved sees
their UID so an admin can add it. Pages opened from `file://` skip the screen,
because Firebase can't sign in there and there's no server to protect.

**On the server** (`server-auth.js`), this is the part that actually protects the
Gemini key. The sign-in screen only hides the UI. Every `/api/*` route except
`/api/config` needs `Authorization: Bearer <Firebase ID token>`:

| Route | No or bad token | Signed in, rules refuse | Signed in, rules approve |
| --- | --- | --- | --- |
| `/api/config` | 200 | 200 | 200 |
| `/api/me` | 401 | 200, `allowed: false` | 200, `allowed: true` |
| Everything else (`annotate`, `models`, `health`, `metrics`, `logs`, `client-log`) | 401 | 403 | Served |

The token check has no dependencies. It verifies the RS256 signature against
Google's published keys (cached for as long as Google's `Cache-Control` allows,
and refetched at most once a minute when a new key appears), and checks `aud`
and `iss` against the project and `exp`, `iat` and `auth_time` with 60s of clock
skew. `node tests/gpr-auth.cjs` covers the accept and reject cases.

### Who is approved: the Firestore rules

Every RAK app on the project can sign people in, so a valid token only proves
someone has an account there. Approval comes from the Firestore rules, and this
app keeps no list of its own. After checking the token, the server reads
`appAccess/gpr-annotator` from Firestore **using the user's own token**, so the
rules judge that user:

| Firestore answers | Meaning |
| --- | --- |
| 200 or 404 | The rules allowed the read (the document doesn't need to exist), so the user is approved |
| 403 `PERMISSION_DENIED` | Not approved |
| Anything else | Firestore outage. The API returns 503 rather than wrongly saying "not approved" |

So everyone already approved by `isAllowedUser()` in `DeltaTemp/firestore.rules`
can use GPR Annotator, and nobody else can. To approve someone for every RAK app
at once, add their UID there and deploy the rules. Their UID is in Firebase
console → Authentication → Users, or on the "not approved" screen they see after
signing in.

The server remembers each answer per UID: 5 minutes for "yes" and 30 seconds for
"no". A newly approved user gets in within 30 seconds; a removed user can keep
access for up to 5 minutes on a warm server instance.

### Firestore rules

`firestore.rules`, `firebase.json` and `.firebaserc` at the DeltaTemp root hold
the rules for `gprportal-49b88`. Apart from comments, the only change from the
rules this project had on 2026-09-24 is an explicit read rule for
`appAccess/{appId}`, granted to the same `isAllowedUser()`. The catch-all rule
already allows that read. The explicit rule keeps the check working if the
catch-all is ever narrowed. No one gains or loses access.

```bash
firebase deploy --only firestore:rules --dry-run   # compile check, publishes nothing
firebase deploy --only firestore:rules             # publish
```

These rules cover the **whole project**, including the other RAK apps. Deploying
this file replaces whatever is live, so if another repo also deploys rules to
`gprportal-49b88`, keep one copy as the source of truth.

### One-time Firebase setup

- **Authorized domains.** Firebase console → Authentication → Settings →
  Authorized domains must include every host that serves the page:
  `delta-temp.vercel.app`, plus any custom domain. `localhost` is there by default.
  Otherwise sign-in fails with `auth/unauthorized-domain`, and the sign-in screen
  says so.
- **Google provider** must be enabled under Authentication → Sign-in method. It
  probably already is, since the other RAK apps use it.
- **API key restrictions (recommended).** The `apiKey` in `auth.js` is a public
  identifier, not a secret. Restricting it by HTTP referrer in Google Cloud console
  → Credentials still stops other sites from reusing it.

The Firebase web config lives in `auth.js`. Analytics from the console snippet is
not loaded, so the app still makes no tracking requests.

## Deploying to Vercel

Vercel serves the DeltaTemp folder as static files and never runs `server.js`. The
API runs as a Vercel Function instead:

- `api/index.js` (at the DeltaTemp root) exports the same `handler(req, res)` that
  `server.js` uses locally, so both environments share one router.
- `vercel.json` rewrites `/api/*` to that function, allows it 120s (the upstream
  timeout is 110s) and bundles `prompt.js`, `logger.js` and `metrics.js` with it.
- `server.js` only calls `listen()` when you run it directly (`npm start`).
  Importing it does not start a server.

Without this setup every `/api/*` request returns 404 in production, and the page
shows the "No API server reachable" warning even on the deployed URL.

### Setting the key

`.env` / `.env.local` files are gitignored, so they never reach Vercel. Set the
variables on the project instead:

```bash
vercel env add GEMINI_API_KEY production   # paste the key when prompted
vercel env add GEMINI_API_KEY preview      # optional, for preview deployments
```

Approval needs no variable. It comes from the Firestore rules (see above).

`GEMINI_MODEL`, `GEMINI_MODEL_FALLBACK` and `GEMINI_MAX_RETRIES` are optional and
use the defaults above. Env changes only take effect after the next deployment.
Check them with `curl https://<your-domain>/api/config`: `hasServerKey` should be
`true`.

### Differences from the local server

| | Local (`npm start`) | Vercel |
| --- | --- | --- |
| Request body limit | 25 MB | **4.5 MB** (platform limit). Base64 makes the payload about a third larger than the file, so images over ~3.3 MB fail |
| Log files | `logs/app-YYYY-MM-DD.jsonl` | None (read-only filesystem). Logs go to stdout and appear in the Vercel dashboard's logs view |
| `/api/metrics`, `/api/logs`, `/api/health` | One process, full history | Per function instance and reset on cold start, so the observability dashboard shows only part of the traffic |
| `.env` cascade | Loaded from disk | Not used. Set variables with `vercel env` |
| Allowed origins | Same origin plus local dev servers (`localhost`, `127.0.0.1`) | Same. Other sites get 403, because these endpoints spend the server's key |

`/api/logs`, `/api/metrics` and `/api/health` need an approved user, like every
other route except `/api/config`.

### Testing the Vercel path locally

```bash
vercel dev --listen 3311      # from the DeltaTemp root
curl localhost:3311/api/config
```

`vercel dev` runs `api/index.js` the way production does, and it also reads
`.env.local`.

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
| `auth.js` | Google sign-in screen, account button, and `GprAuth.fetch` (adds the ID token to API calls) |
| `server-auth.js` | Firebase ID token verification, and the Firestore-rules access check; no dependencies |
| `../firestore.rules` | Firestore rules for the shared `gprportal-49b88` project; they decide who is approved |
| `server.js` | Static file server + `/api/annotate` proxy + `.env` loader; exports `handler` for Vercel |
| `../api/index.js` | Vercel Function entry: re-exports `server.js`'s `handler` |
| `../vercel.json` | Rewrites `/api/*` to the function, sets its duration and bundled files |
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

On 2026-09-24 the Vercel path was checked with `vercel dev`: `/api/config` and
`/api/health` answered from `api/index.js`, `/gpr-annotator/` served with a 200, and
`npm start` still behaved as before. A POST carrying `Origin: https://delta-temp.vercel.app`
with a matching `Host` was accepted, and one from a foreign origin got 403. This has not yet been checked on a real
production deployment with `GEMINI_API_KEY` set.

Google sign-in was checked on 2026-09-24. `node tests/gpr-auth.cjs` passes: it
accepts a valid token and rejects malformed, wrong-key, unknown-kid, non-RS256,
wrong-project, wrong-issuer, expired, future-dated, subject-less and edited
tokens. It also checks the Firestore access mapping: 200 and 404 approve, 403
refuses, 500 is reported as an error, the user's own token is sent, and the answer
is cached. `firebase deploy --only firestore:rules --dry-run` compiled the rules
against the live project, and an unauthenticated Firestore read returned 403 as
expected. Against the running server, `/api/config`
answered without a token and every other route returned 401. A token carrying a
real Google key id with a forged signature was rejected. In Chrome the sign-in
screen loaded the Firebase SDK and showed the Google button. At 390px wide the
card sat 16px from each edge with no sideways scroll. `tests/workspace.html`
(`file://`, sign-in skipped) still passed all 22 checks. A real Google sign-in
through the popup, and the approved and not-approved screens after it, have not
been tested yet.

A live Gemini request on 2026-09-18 timed out at the server's 110-second limit.
The revised prompt has not yet been validated against a completed live response.

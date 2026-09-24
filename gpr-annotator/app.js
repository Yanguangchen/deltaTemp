/* GPR Annotator — AI-assisted radargram markup.

   Coordinates are normalized against the IMAGE (0..1 spans the radargram), but
   they are deliberately NOT clamped to that range: the drawing canvas is a
   separate, larger surface and the image is centred inside it. A label at
   x = -0.2 sits in the left margin, outside the scan. Because the unit is still
   "fraction of the image", every annotation stays locked to the same pixels
   through window resizes, zooming, and export at source resolution. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    dropzone:   $('dropzone'),
    fileInput:  $('file-input'),
    stage:      $('stage'),
    canvasWrap: $('canvas-wrap'),
    canvas:     $('canvas'),
    frame:      $('frame'),
    image:      $('gpr-image'),
    shapes:     $('arrow-layer'),
    labels:     $('label-layer'),
    status:     $('stage-status'),
    statusText: $('stage-status-text'),
    list:       $('ann-list'),
    hint:       $('prompt-hint'),
    toast:      $('toast'),
    settings:   $('settings'),
    apiKey:     $('api-key'),
    modelName:  $('model-name'),
    btnSettings: $('btn-settings'),
    btnAnalyze:  $('btn-analyze'),
    btnExport:   $('btn-export'),
    btnAdd:      $('btn-add'),
    btnClear:    $('btn-clear'),
    btnArrange:  $('btn-arrange'),
    serverStatus: $('server-status'),
    modelList:    $('model-list'),
    modelNote:    $('model-note'),
    btnListModels: $('btn-list-models'),
    btnCancel:    $('btn-cancel'),
    originWarning: $('origin-warning'),
    velocity: $('wave-velocity'),
    imageName: $('image-name'),
    annCount: $('ann-count'),
    canvasHint: $('canvas-hint'),
    tools: [...document.querySelectorAll('.tool')],
    zoomIn: $('zoom-in'),
    zoomOut: $('zoom-out'),
    zoomFit: $('zoom-fit'),
    zoomLevel: $('zoom-level'),
    btnUndo: $('btn-undo'),
    btnRedo: $('btn-redo'),
    editor: $('ann-editor'),
    editKind: $('edit-kind'),
    editLabel: $('edit-label'),
    editNote: $('edit-note'),
    editConf: $('edit-conf'),
    editConfOut: $('edit-conf-out'),
    confField: $('conf-field'),
    btnConfClear: $('btn-conf-clear'),
    editColors: $('edit-colors'),
    editWeight: $('edit-weight'),
    editWeightOut: $('edit-weight-out'),
    btnWeightReset: $('btn-weight-reset'),
    btnDuplicate: $('btn-duplicate'),
    btnDeleteSel: $('btn-delete-sel'),
  };

  /* Gemini is sent a downscaled copy — a phone photo is tens of megabytes as
     base64, which is what makes a request appear to hang. Annotation coordinates
     are normalized, so shrinking the upload does not move any marker. */
  const API_MAX_EDGE = 1600;
  const REQUEST_TIMEOUT_MS = 120000;

  const PROMPT = window.GPR_PROMPT;
  const T = window.Telemetry;

  const PALETTE = ['#4da3ff', '#ffd166', '#06d6a0', '#ff6b6b', '#c792ea',
                   '#ff9f43', '#4ecdc4', '#f78fb3'];

  const DEFAULT_MODEL = PROMPT.DEFAULT_MODEL;
  const STORE_KEY = 'gpr-annotator/settings';

  /* What each annotation kind owns geometrically.
       point : a single target point (tx,ty) with a ringed handle
       two   : two draggable endpoints, a and b
       path  : a freehand polyline
       label : shows a text card;  leader: joins that card to the target */
  const KIND = {
    target: { name: 'Target',      point: true, label: true, leader: true },
    arrow:  { name: 'Arrow',       two: true },
    box:    { name: 'Region',      two: true,   label: true },
    ruler:  { name: 'Measurement', two: true,   readout: true },
    free:   { name: 'Trace',       path: true,  label: true, leader: true },
    note:   { name: 'Note',        label: true },
  };

  const TOOL_HINT = {
    '':      'Drag to move · Labels can sit in the margin around the scan',
    arrow:   'Drag from the arrow tail to its tip · Esc to cancel',
    box:     'Drag a rectangle around the region · Esc to cancel',
    ruler:   'Drag between the two points you want measured · Esc to cancel',
    free:    'Drag to trace the reflector · Esc to cancel',
    note:    'Click anywhere — including the margin — to drop a note',
  };

  const state = {
    image: null,        // { dataUrl, mimeType, base64, naturalW, naturalH }
    annotations: [],
    selectedId: null,
    busy: false,
    seq: 0,
    tool: '',
    zoom: 1,
    calibration: null,  // axis calibration from the last analysis, reused by manual shapes
    server: { hasServerKey: false, model: null },
    apiBase: '',
  };

  /* Canvas geometry, recomputed on every layout pass.
     x,y,w,h = where the image sits inside the canvas, in canvas pixels. */
  let view = { x: 0, y: 0, w: 1, h: 1, cw: 1, ch: 1, scale: 1, fit: 1 };

  const VIEW_FIT = 0.70;   // fitted image fills this share of the canvas, leaving margin
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 8;

  /* ── Server probe ───────────────────────────────────── */

  const API_FALLBACK_ORIGIN = `${location.protocol === 'https:' ? 'https' : 'http'}://localhost:8787`;

  async function resolveApiBase() {
    const candidates = ['', API_FALLBACK_ORIGIN];

    for (const base of candidates) {
      if (base && base === location.origin) continue;
      try {
        const res = await fetch(`${base}/api/config`, { cache: 'no-store' });
        if (!res.ok) continue;
        const cfg = await res.json();
        if (typeof cfg?.hasServerKey !== 'boolean') continue;
        return { base, cfg };
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  async function probeServer() {
    if (location.protocol === 'file:') {
      T.warn('server.unreachable', { reason: 'file-protocol', href: location.href });
      showOriginWarning(
        'This page was opened directly from disk (<code>file://</code>), so it cannot use the server or the key in <code>.env.local</code>. ' +
        'Open <a href="http://localhost:8787/gpr-annotator/">http://localhost:8787/gpr-annotator/</a> instead.',
      );
      reflectServerStatus();
      return;
    }

    const found = await resolveApiBase();

    if (!found) {
      T.warn('server.probe_failed', { origin: location.origin, tried: ['same-origin', API_FALLBACK_ORIGIN] });
      showOriginWarning(
        `No API server reachable from <code>${location.origin}</code>. Analysis would call Google directly with the key in Settings. ` +
        `Start it with <code>npm start</code> in the gpr-annotator folder, then open ` +
        `<a href="${API_FALLBACK_ORIGIN}/gpr-annotator/">${API_FALLBACK_ORIGIN}/gpr-annotator/</a>.`,
      );
      reflectServerStatus();
      return;
    }

    state.apiBase = found.base;
    state.server = found.cfg;
    T.setEndpoint(`${found.base}/api/client-log`);
    T.info('server.config', { ...found.cfg, apiBase: found.base || '(same origin)', clientVersion: T.version });

    if (found.base) {
      showOriginWarning(
        `This page is served from <code>${location.origin}</code>, so API calls are going cross-origin to ` +
        `<code>${found.base}</code>. That works, but <a href="${found.base}/gpr-annotator/">${found.base}/gpr-annotator/</a> ` +
        'is the supported way to run it.',
      );
    } else if (!found.cfg.hasServerKey) {
      showOriginWarning(
        'The server is running but has no API key, so requests go from this browser straight to Google. ' +
        'Put <code>GEMINI_API_KEY</code> in <code>.env.local</code> and restart the server to use the proxy.',
      );
    }

    reflectServerStatus();
  }

  function showOriginWarning(html) {
    el.originWarning.innerHTML = html;
    el.originWarning.hidden = false;
  }

  function reflectServerStatus() {
    const { hasServerKey, model } = state.server;
    el.serverStatus.hidden = !hasServerKey;
    if (hasServerKey) {
      el.serverStatus.textContent =
        `Server key active (${model}). Requests are proxied through server.js — the field below is ignored.`;
    }
  }

  /* ── Settings ───────────────────────────────────────── */

  function loadSettings() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { /* ignore */ }
    el.apiKey.value = saved.apiKey || '';
    el.modelName.value = saved.model || DEFAULT_MODEL;
  }

  function saveSettings() {
    const data = {
      apiKey: el.apiKey.value.trim(),
      model: el.modelName.value.trim() || DEFAULT_MODEL,
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* ignore */ }
    return data;
  }

  function settings() {
    return {
      apiKey: el.apiKey.value.trim(),
      model: el.modelName.value.trim() || DEFAULT_MODEL,
    };
  }

  /* ── Toast ──────────────────────────────────────────── */

  let toastTimer = null;
  function toast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', isError);
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, isError ? 8000 : 3500);
  }

  /* ── Image loading ──────────────────────────────────── */

  function readFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('That file is not an image.', true);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.', true);
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(',');
      const probe = new Image();
      probe.onload = () => {
        const prepSpan = T.span('image.prepare', {
          name: file.name, type: file.type,
          sourceMb: +(file.size / 1048576).toFixed(2),
          px: `${probe.naturalWidth}×${probe.naturalHeight}`,
        });
        const upload = makeUploadCopy(probe, file.type, dataUrl.slice(comma + 1));
        prepSpan.end({
          downscaled: Boolean(upload.note),
          uploadMb: +((upload.base64.length * 0.75) / 1048576).toFixed(2),
        });

        state.image = {
          dataUrl,
          mimeType: file.type,
          base64: dataUrl.slice(comma + 1),
          naturalW: probe.naturalWidth,
          naturalH: probe.naturalHeight,
          uploadMime: upload.mimeType,
          uploadBase64: upload.base64,
          uploadNote: upload.note,
        };
        state.annotations = [];
        state.selectedId = null;
        state.seq = 0;
        state.calibration = null;
        state.zoom = 1;
        history.past.length = 0;
        history.future.length = 0;
        setTool('');

        el.image.src = dataUrl;
        el.imageName.textContent = file.name;
        el.dropzone.hidden = true;
        el.stage.hidden = false;
        setEnabled(true);
        render();

        const size = `${probe.naturalWidth}×${probe.naturalHeight}px`;
        toast(`Loaded ${file.name} — ${size}${upload.note ? ` · ${upload.note}` : ''}`);
      };
      probe.onerror = () => toast('That image could not be decoded.', true);
      probe.src = dataUrl;
    };
    reader.readAsDataURL(file);
  }

  /* Shrink oversized images for the API call only. The on-screen image and the
     PNG export keep the original pixels. */
  function makeUploadCopy(probe, mimeType, originalBase64) {
    const longEdge = Math.max(probe.naturalWidth, probe.naturalHeight);
    const originalMb = (originalBase64.length * 0.75) / (1024 * 1024);

    if (longEdge <= API_MAX_EDGE && originalMb <= 4) {
      return { mimeType, base64: originalBase64, note: '' };
    }

    const scale = Math.min(1, API_MAX_EDGE / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(probe.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(probe.naturalHeight * scale));

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(probe, 0, 0, canvas.width, canvas.height);

    try {
      const url = canvas.toDataURL('image/jpeg', 0.9);
      const base64 = url.slice(url.indexOf(',') + 1);
      const mb = (base64.length * 0.75) / (1024 * 1024);
      return {
        mimeType: 'image/jpeg',
        base64,
        note: `sending ${canvas.width}×${canvas.height} (${mb.toFixed(1)} MB) to Gemini`,
      };
    } catch {
      return { mimeType, base64: originalBase64, note: '' };
    }
  }

  function setEnabled(on) {
    const off = !on;
    el.btnAnalyze.disabled = off || state.busy;
    for (const b of [el.btnExport, el.btnAdd, el.btnClear, el.btnArrange,
                     el.zoomIn, el.zoomOut, el.zoomFit, ...el.tools]) b.disabled = off;
    updateHistoryButtons();
  }

  /* ── Annotation model ───────────────────────────────── */

  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));
  const byId = (id) => state.annotations.find((a) => a.id === id);

  /* Line weight is a multiplier on each shape's natural stroke width, so one
     control thickens arrows, boxes, rulers and traces consistently. New
     annotations inherit the last weight the operator chose. */
  const WEIGHT_MIN = 0.4;
  const WEIGHT_MAX = 4;
  const clampWeight = (v) => Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, num(v, 1)));
  const weightOf = (ann) => clampWeight(ann.weight);
  const strokeStyle = (base, ann) => `stroke-width:${(base * weightOf(ann)).toFixed(2)}px`;
  let lastWeight = 1;

  function addAnnotation(opts) {
    const {
      label, note = '', confidence = null, tx = 0.5, ty = 0.5, lx = 0.5, ly = 0.4,
      calibration = null, velocityMPerNs = null, curve = [], kind = 'target',
      a = null, b = null, path = null, color = null, weight = lastWeight,
    } = opts;

    const ann = {
      id: `a${++state.seq}`,
      kind,
      label: label || defaultLabel(kind),
      note,
      confidence,
      calibration: calibration || state.calibration,
      velocityMPerNs,
      curve,
      path: path ? path.map((p) => ({ x: num(p.x), y: num(p.y) })) : null,
      a: a ? { x: num(a.x), y: num(a.y) } : null,
      b: b ? { x: num(b.x), y: num(b.y) } : null,
      labelScale: 1,
      weight: clampWeight(weight),
      color: color || PALETTE[(state.seq - 1) % PALETTE.length],
      tx: num(tx), ty: num(ty),
      lx: num(lx), ly: num(ly),
    };
    state.annotations.push(ann);
    return ann;
  }

  const defaultLabel = (kind) => ({
    target: 'Untitled feature', arrow: 'Arrow', box: 'Region of interest',
    ruler: 'Measurement', free: 'Traced reflector', note: 'Note',
  }[kind] || 'Untitled feature');

  /* Every draggable point an annotation owns, as live references. */
  function points(ann) {
    const out = [];
    const k = KIND[ann.kind];
    if (k.two) { out.push(ann.a, ann.b); }
    if (k.point) out.push({ get x() { return ann.tx; }, set x(v) { ann.tx = v; }, get y() { return ann.ty; }, set y(v) { ann.ty = v; } });
    if (k.path && ann.path) out.push(...ann.path);
    if (k.label) out.push({ get x() { return ann.lx; }, set x(v) { ann.lx = v; }, get y() { return ann.ly; }, set y(v) { ann.ly = v; } });
    return out.filter(Boolean);
  }

  function translate(ann, dx, dy) {
    for (const p of points(ann)) { p.x += dx; p.y += dy; }
  }

  /* Bounding box of an annotation's geometry, ignoring its label card. */
  function shapeBox(ann) {
    const xs = [];
    const ys = [];
    const k = KIND[ann.kind];
    if (k.two && ann.a && ann.b) { xs.push(ann.a.x, ann.b.x); ys.push(ann.a.y, ann.b.y); }
    if (k.point) { xs.push(ann.tx); ys.push(ann.ty); }
    if (k.path && ann.path) for (const p of ann.path) { xs.push(p.x); ys.push(p.y); }
    if (!xs.length) { xs.push(ann.lx); ys.push(ann.ly); }
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  const pathMid = (path) => path[Math.floor(path.length / 2)] || { x: 0.5, y: 0.5 };

  /* ── Measurements ───────────────────────────────────── */

  const calOf = (ann) => ann.calibration || state.calibration;
  const measureAt = (ann, x, y) =>
    PROMPT.measurePoint(calOf(ann), { x: x * 1000, y: y * 1000 }, el.velocity.value || ann.velocityMPerNs);
  const metricsFor = (ann) => measureAt(ann, ann.tx, ann.ty);
  const metres = (value) => (value === null ? 'Unknown' : `≈ ${Number(value.toPrecision(3))} m`);

  function measurementSummary(ann) {
    if (!calOf(ann)) return '';
    const m = metricsFor(ann);
    return `${metres(m.alongM)} along · ${metres(m.depthM)} deep`;
  }

  /* Ruler readout: axis-calibrated where possible, image fractions otherwise. */
  function rulerSummary(ann) {
    if (!ann.a || !ann.b) return '';
    if (calOf(ann)) {
      const m1 = measureAt(ann, ann.a.x, ann.a.y);
      const m2 = measureAt(ann, ann.b.x, ann.b.y);
      const dAlong = m1.alongM !== null && m2.alongM !== null ? Math.abs(m1.alongM - m2.alongM) : null;
      const dDepth = m1.depthM !== null && m2.depthM !== null ? Math.abs(m1.depthM - m2.depthM) : null;
      if (dAlong !== null || dDepth !== null) {
        const parts = [];
        if (dAlong !== null) parts.push(`${metres(dAlong).replace('≈ ', '')} along`);
        if (dDepth !== null) parts.push(`${metres(dDepth).replace('≈ ', '')} deep`);
        if (dAlong !== null && dDepth !== null) parts.push(`${Number(Math.hypot(dAlong, dDepth).toPrecision(3))} m apart`);
        return parts.join(' · ');
      }
    }
    const dx = Math.abs(ann.b.x - ann.a.x) * 100;
    const dy = Math.abs(ann.b.y - ann.a.y) * 100;
    return `${dx.toFixed(1)}% × ${dy.toFixed(1)}% of image`;
  }

  /* ── Canvas layout ──────────────────────────────────── */

  function layout() {
    if (!state.image) return;
    const cw = Math.max(240, Math.round(el.canvasWrap.clientWidth));
    const ch = Math.max(220, Math.round(el.canvasWrap.clientHeight));
    el.canvas.style.width = `${cw}px`;
    el.canvas.style.height = `${ch}px`;

    const iw = state.image.naturalW;
    const ih = state.image.naturalH;
    const fit = Math.min((cw * VIEW_FIT) / iw, (ch * VIEW_FIT) / ih);
    const scale = fit * state.zoom;
    const w = Math.max(12, iw * scale);
    const h = Math.max(12, ih * scale);

    view = { x: (cw - w) / 2, y: (ch - h) / 2, w, h, cw, ch, scale, fit };

    el.frame.style.left = `${view.x}px`;
    el.frame.style.top = `${view.y}px`;
    el.frame.style.width = `${w}px`;
    el.frame.style.height = `${h}px`;
    el.zoomLevel.textContent = `${Math.round(scale * 100)}%`;
    el.zoomOut.disabled = !state.image || state.zoom <= ZOOM_MIN;
    el.zoomIn.disabled = !state.image || state.zoom >= ZOOM_MAX;
  }

  const cxOf = (nx) => view.x + nx * view.w;
  const cyOf = (ny) => view.y + ny * view.h;
  const nxOf = (px) => (px - view.x) / view.w;
  const nyOf = (py) => (py - view.y) / view.h;

  /* The canvas expressed in image-normalized units — the legal area for any
     annotation. Negative x is the left margin, x > 1 the right margin. */
  function canvasBounds() {
    return { x0: nxOf(0), x1: nxOf(view.cw), y0: nyOf(0), y1: nyOf(view.ch) };
  }

  function clampToCanvas(p) {
    const b = canvasBounds();
    return { x: Math.min(b.x1, Math.max(b.x0, p.x)), y: Math.min(b.y1, Math.max(b.y0, p.y)) };
  }

  function setZoom(next, silent) {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (z === state.zoom) return;
    state.zoom = z;
    render();
    if (!silent) T.debug('view.zoom', { zoom: +z.toFixed(2), scale: +view.scale.toFixed(3) });
  }

  /* ── Rendering ──────────────────────────────────────── */

  function render() {
    layout();
    renderLabels();
    renderShapes();   // needs label boxes measured, so it runs second
    renderList();
    renderEditor();
  }

  function labelNodeOf(id) {
    return el.labels.querySelector(`[data-id="${CSS.escape(id)}"]`);
  }

  function renderLabels() {
    el.labels.innerHTML = '';

    for (const ann of state.annotations) {
      const kind = KIND[ann.kind];
      if (!kind.label && !kind.readout) continue;

      const node = document.createElement('div');
      node.className = `ann-label kind-${ann.kind}${ann.id === state.selectedId ? ' selected' : ''}`;
      node.dataset.id = ann.id;
      node.style.borderColor = ann.color;
      node.style.setProperty('--label-scale', ann.labelScale);

      if (kind.readout) {
        // A measurement readout tracks the midpoint of its own line.
        node.classList.add('readout');
        const mid = ann.a && ann.b ? { x: (ann.a.x + ann.b.x) / 2, y: (ann.a.y + ann.b.y) / 2 } : { x: ann.lx, y: ann.ly };
        node.style.left = `${cxOf(mid.x)}px`;
        node.style.top = `${cyOf(mid.y)}px`;
        if (ann.label && ann.label !== defaultLabel('ruler')) {
          const title = document.createElement('span');
          title.className = 'text';
          title.textContent = ann.label;
          node.appendChild(title);
        }
        const value = document.createElement('span');
        value.className = 'label-measure';
        value.textContent = rulerSummary(ann);
        node.appendChild(value);
        el.labels.appendChild(node);
        continue;
      }

      node.style.left = `${cxOf(ann.lx)}px`;
      node.style.top = `${cyOf(ann.ly)}px`;

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = ann.label;
      node.appendChild(text);

      if (calOf(ann) && (ann.kind === 'target' || ann.kind === 'free')) {
        const measure = document.createElement('span');
        measure.className = 'label-measure';
        measure.textContent = measurementSummary(ann);
        node.appendChild(measure);
      }

      if (ann.confidence != null) {
        const conf = document.createElement('span');
        conf.className = 'conf';
        conf.textContent = `confidence ${Math.round(ann.confidence * 100)}%`;
        node.appendChild(conf);
      }

      const resize = document.createElement('button');
      resize.type = 'button';
      resize.className = 'label-resize';
      resize.title = 'Drag to resize · Arrow keys to adjust';
      resize.setAttribute('aria-label', `Resize ${ann.label}`);
      resize.innerHTML = '<svg aria-hidden="true"><use href="#i-resize"/></svg>';
      node.appendChild(resize);

      el.labels.appendChild(node);
      if (view.w && view.h) {
        resizeLabel(ann, ann.labelScale);
        node.style.setProperty('--label-scale', ann.labelScale);
        node.style.left = `${cxOf(ann.lx)}px`;
        node.style.top = `${cyOf(ann.ly)}px`;
      }
    }
  }

  const SVG = 'http://www.w3.org/2000/svg';
  const mk = (name, attrs) => {
    const node = document.createElementNS(SVG, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  };

  function renderShapes() {
    el.shapes.setAttribute('viewBox', `0 0 ${view.cw} ${view.ch}`);
    el.shapes.setAttribute('width', view.cw);
    el.shapes.setAttribute('height', view.ch);
    el.shapes.innerHTML = '';

    for (const ann of state.annotations) {
      const kind = KIND[ann.kind];
      const g = mk('g', { class: `ann ${ann.kind}${ann.id === state.selectedId ? ' selected' : ''}` });
      g.dataset.id = ann.id;

      // AI hyperbola trace (0..1000 grid in image space)
      if (ann.curve && ann.curve.length > 1) {
        g.appendChild(mk('polyline', {
          points: ann.curve.map((p) => `${cxOf(p.x / 1000)},${cyOf(p.y / 1000)}`).join(' '),
          class: 'hyperbola-trace', stroke: ann.color, style: strokeStyle(2.5, ann),
        }));
      }

      if (ann.kind === 'free' && ann.path?.length > 1) {
        const pts = ann.path.map((p) => `${cxOf(p.x)},${cyOf(p.y)}`).join(' ');
        g.appendChild(mk('polyline', { points: pts, class: 'trace-line', stroke: ann.color, style: strokeStyle(2.6, ann) }));
        g.appendChild(withRole(mk('polyline', { points: pts, class: 'shape-hit' }), ann, 'shape'));
        const mid = pathMid(ann.path);
        ann.tx = mid.x; ann.ty = mid.y;
      }

      if (ann.kind === 'box' && ann.a && ann.b) {
        const x = Math.min(cxOf(ann.a.x), cxOf(ann.b.x));
        const y = Math.min(cyOf(ann.a.y), cyOf(ann.b.y));
        const w = Math.abs(cxOf(ann.b.x) - cxOf(ann.a.x));
        const h = Math.abs(cyOf(ann.b.y) - cyOf(ann.a.y));
        g.appendChild(mk('rect', { x, y, width: w, height: h, class: 'region-box', stroke: ann.color, style: strokeStyle(2, ann) }));
        g.appendChild(withRole(mk('rect', { x, y, width: w, height: h, class: 'shape-hit' }), ann, 'shape'));
        g.appendChild(cornerHandle(ann, ann.a, 'pa'));
        g.appendChild(cornerHandle(ann, ann.b, 'pb'));
      }

      if (ann.kind === 'ruler' && ann.a && ann.b) {
        const p1 = { x: cxOf(ann.a.x), y: cyOf(ann.a.y) };
        const p2 = { x: cxOf(ann.b.x), y: cyOf(ann.b.y) };
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const nx = -(p2.y - p1.y) / len;
        const ny = (p2.x - p1.x) / len;
        g.appendChild(mk('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'ruler-line', stroke: ann.color, style: strokeStyle(2, ann) }));
        for (const p of [p1, p2]) {
          g.appendChild(mk('line', {
            x1: p.x - nx * 7, y1: p.y - ny * 7, x2: p.x + nx * 7, y2: p.y + ny * 7,
            class: 'ruler-tick', stroke: ann.color, style: strokeStyle(2.4, ann),
          }));
        }
        g.appendChild(withRole(mk('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'shape-hit' }), ann, 'shape'));
        g.appendChild(cornerHandle(ann, ann.a, 'pa'));
        g.appendChild(cornerHandle(ann, ann.b, 'pb'));
      }

      if (ann.kind === 'arrow' && ann.a && ann.b) {
        drawArrow(g, ann, { x: cxOf(ann.a.x), y: cyOf(ann.a.y) }, { x: cxOf(ann.b.x), y: cyOf(ann.b.y) }, 0);
        g.appendChild(withRole(mk('line', {
          x1: cxOf(ann.a.x), y1: cyOf(ann.a.y), x2: cxOf(ann.b.x), y2: cyOf(ann.b.y), class: 'shape-hit',
        }), ann, 'shape'));
        g.appendChild(cornerHandle(ann, ann.a, 'pa'));
        g.appendChild(cornerHandle(ann, ann.b, 'pb'));
      }

      // Leader line from the label card to the target point
      if (kind.leader) {
        const node = labelNodeOf(ann.id);
        const box = {
          cx: cxOf(ann.lx),
          cy: cyOf(ann.ly),
          hw: (node ? node.offsetWidth * ann.labelScale : 60) / 2 + 3,
          hh: (node ? node.offsetHeight * ann.labelScale : 22) / 2 + 3,
        };
        const target = { x: cxOf(ann.tx), y: cyOf(ann.ty) };
        drawArrow(g, ann, edgeOfBox(box, target), target, 5);
      }

      if (kind.point) {
        g.appendChild(cornerHandle(ann, { x: ann.tx, y: ann.ty }, ann.kind === 'free' ? 'shape' : 'target', true));
      }

      el.shapes.appendChild(g);
    }
  }

  function withRole(node, ann, role) {
    node.dataset.id = ann.id;
    node.dataset.role = role;
    return node;
  }

  function cornerHandle(ann, point, role, ringed) {
    const g = mk('g', { class: `target-handle${ringed ? ' ringed' : ''}` });
    g.dataset.id = ann.id;
    g.dataset.role = role;
    const x = cxOf(point.x);
    const y = cyOf(point.y);
    g.appendChild(mk('circle', {
      class: 'target-ring', cx: x, cy: y, r: ringed ? 9 : 7, stroke: ann.color, style: strokeStyle(1.5, ann),
    }));
    g.appendChild(mk('circle', { class: 'target-dot', cx: x, cy: y, r: 3.5, fill: ann.color }));
    return g;
  }

  function drawArrow(g, ann, start, tip, inset) {
    const dx = tip.x - start.x;
    const dy = tip.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len <= 12) return;

    const ux = dx / len;
    const uy = dy / len;
    const head = 9 * (0.7 + 0.3 * weightOf(ann));
    const end = { x: tip.x - ux * inset, y: tip.y - uy * inset };
    const base = { x: end.x - ux * head, y: end.y - uy * head };

    g.appendChild(mk('line', {
      x1: start.x, y1: start.y, x2: base.x, y2: base.y, class: 'arrow-line', stroke: ann.color,
      style: strokeStyle(2, ann),
    }));
    const wing = head * 0.52;
    g.appendChild(mk('polygon', {
      points: [`${end.x},${end.y}`,
               `${base.x - uy * wing},${base.y + ux * wing}`,
               `${base.x + uy * wing},${base.y - ux * wing}`].join(' '),
      fill: ann.color,
    }));
  }

  /* Where the line from the box centre toward `to` crosses the box edge. */
  function edgeOfBox(box, to) {
    const dx = to.x - box.cx;
    const dy = to.y - box.cy;
    if (dx === 0 && dy === 0) return { x: box.cx, y: box.cy };

    const sx = dx === 0 ? Infinity : box.hw / Math.abs(dx);
    const sy = dy === 0 ? Infinity : box.hh / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: box.cx + dx * s, y: box.cy + dy * s };
  }

  function renderList() {
    el.annCount.textContent = state.annotations.length;
    el.list.innerHTML = '';

    if (!state.annotations.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = state.image
        ? 'Scan ready. Select the scan icon above to find targets, or draw your own with the canvas tools.'
        : 'Your targets will appear here. Upload a scan to get started.';
      el.list.appendChild(p);
      return;
    }

    for (const ann of state.annotations) {
      const card = document.createElement('div');
      card.className = `ann-card${ann.id === state.selectedId ? ' selected' : ''}`;
      card.dataset.id = ann.id;

      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      swatch.style.background = ann.color;

      const body = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = ann.label;
      body.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'meta';
      const anchor = KIND[ann.kind].two && ann.a ? ann.a : { x: ann.tx, y: ann.ty };
      const outside = anchor.x < 0 || anchor.x > 1 || anchor.y < 0 || anchor.y > 1;
      const pos = `x ${(anchor.x * 100).toFixed(0)}%  y ${(anchor.y * 100).toFixed(0)}%`;
      meta.textContent = [KIND[ann.kind].name, pos,
        ann.confidence != null ? `${Math.round(ann.confidence * 100)}%` : null,
        outside ? 'off-image' : null].filter(Boolean).join('  ·  ');
      body.appendChild(meta);

      if (ann.kind === 'ruler') {
        const value = document.createElement('div');
        value.className = 'measurement-basis';
        value.textContent = rulerSummary(ann);
        body.appendChild(value);
      } else if (calOf(ann) && KIND[ann.kind].point) {
        const m = metricsFor(ann);
        const grid = document.createElement('div');
        grid.className = 'measurement-grid';
        [['Along scan', metres(m.alongM)], ['Depth', metres(m.depthM)]].forEach(([name, value]) => {
          const cell = document.createElement('div');
          const key = document.createElement('span');
          const val = document.createElement('strong');
          key.textContent = name;
          val.textContent = value;
          cell.append(key, val);
          grid.append(cell);
        });
        body.append(grid);
        const basis = document.createElement('div');
        basis.className = 'measurement-basis';
        basis.textContent = `${m.basis}${m.timeNs !== null ? ` · ${Number(m.timeNs.toPrecision(3))} ns` : ''}`;
        body.append(basis);
      }

      if (ann.note) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = ann.note;
        body.appendChild(note);
      }

      const del = document.createElement('button');
      del.className = 'card-del';
      del.type = 'button';
      del.title = 'Delete annotation';
      del.setAttribute('aria-label', `Delete ${ann.label}`);
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        record();
        removeAnnotation(ann.id);
      });

      card.append(swatch, body, del);
      card.addEventListener('click', () => select(ann.id));
      el.list.appendChild(card);
    }
  }

  /* ── Editor panel ───────────────────────────────────── */

  function buildSwatches() {
    el.editColors.innerHTML = '';
    for (const color of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch-btn';
      b.dataset.color = color;
      b.style.background = color;
      b.title = color;
      b.setAttribute('aria-label', `Use colour ${color}`);
      b.addEventListener('click', () => {
        const ann = byId(state.selectedId);
        if (!ann || ann.color === color) return;
        record();
        ann.color = color;
        render();
      });
      el.editColors.appendChild(b);
    }
  }

  function renderEditor() {
    const ann = byId(state.selectedId);
    el.editor.hidden = !ann;
    if (!ann) return;

    el.editKind.textContent = KIND[ann.kind].name;
    if (document.activeElement !== el.editLabel) el.editLabel.value = ann.label;
    if (document.activeElement !== el.editNote) el.editNote.value = ann.note || '';

    const hasConf = ann.confidence != null;
    if (document.activeElement !== el.editConf) el.editConf.value = hasConf ? Math.round(ann.confidence * 100) : 0;
    el.editConfOut.textContent = hasConf ? `${Math.round(ann.confidence * 100)}%` : 'not set';
    el.confField.classList.toggle('unset', !hasConf);

    if (document.activeElement !== el.editWeight) el.editWeight.value = weightOf(ann);
    el.editWeightOut.textContent = `${weightOf(ann).toFixed(1)}×`;

    for (const b of el.editColors.children) {
      b.classList.toggle('on', b.dataset.color === ann.color);
      b.setAttribute('aria-pressed', String(b.dataset.color === ann.color));
    }
  }

  function select(id) {
    state.selectedId = id;
    render();
  }

  function removeAnnotation(id) {
    state.annotations = state.annotations.filter((a) => a.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    render();
  }

  /* ── Undo / redo ────────────────────────────────────── */

  const history = { past: [], future: [] };
  const HISTORY_MAX = 80;

  const serialize = () => JSON.stringify({ a: state.annotations, seq: state.seq });

  function restore(snapshot) {
    const parsed = JSON.parse(snapshot);
    state.annotations = parsed.a;
    state.seq = parsed.seq;
    if (!state.annotations.some((a) => a.id === state.selectedId)) state.selectedId = null;
  }

  /* Call immediately BEFORE mutating, so undo returns to the prior state. */
  function record() {
    history.past.push(serialize());
    if (history.past.length > HISTORY_MAX) history.past.shift();
    history.future.length = 0;
    updateHistoryButtons();
  }

  let lastNudge = 0;
  function recordNudge() {
    const now = performance.now();
    if (now - lastNudge > 700) record();
    lastNudge = now;
  }

  function undo() {
    if (!history.past.length) return;
    history.future.push(serialize());
    restore(history.past.pop());
    render();
    updateHistoryButtons();
  }

  function redo() {
    if (!history.future.length) return;
    history.past.push(serialize());
    restore(history.future.pop());
    render();
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    el.btnUndo.disabled = !history.past.length;
    el.btnRedo.disabled = !history.future.length;
  }

  /* ── Label placement ────────────────────────────────── */

  /* Pick a label spot near the target that avoids other labels. The search now
     reaches into the canvas margin, so labels can live off the image. */
  function placeLabel(tx, ty, taken) {
    const b = canvasBounds();
    const pad = 0.03;
    const radii = [0.16, 0.26, 0.38, 0.52];
    const angles = [-90, -45, -135, 0, 180, 45, 135, 90];
    let best = null;
    let bestScore = -Infinity;

    for (const r of radii) {
      for (const deg of angles) {
        const rad = (deg * Math.PI) / 180;
        const x = tx + Math.cos(rad) * r * 0.75;
        const y = ty + Math.sin(rad) * r;
        if (x < b.x0 + pad || x > b.x1 - pad || y < b.y0 + pad || y > b.y1 - pad) continue;

        let nearest = Infinity;
        for (const p of taken) nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y));
        const score = Math.min(nearest, 0.35) - r * 0.25;
        if (score > bestScore) { bestScore = score; best = { x, y }; }
      }
    }
    return best || clampToCanvas({ x: tx, y: ty - 0.12 });
  }

  /* Stack every label into the margins beside the scan, leaders fanning back in.
     This is the layout a report figure usually wants. */
  function arrangeLabels() {
    const items = state.annotations.filter((a) => KIND[a.kind].leader);
    if (!items.length) { toast('No labels with leader lines to arrange.'); return; }

    const b = canvasBounds();
    const leftRoom = -b.x0;
    const rightRoom = b.x1 - 1;
    if (Math.max(leftRoom, rightRoom) < 0.12) {
      toast('Not enough margin — zoom out first so the labels have room beside the scan.', true);
      return;
    }

    record();
    const left = [];
    const right = [];
    for (const ann of items) {
      const preferLeft = ann.tx < 0.5 ? leftRoom >= 0.12 : rightRoom < 0.12;
      (preferLeft ? left : right).push(ann);
    }

    const place = (list, x) => {
      list.sort((p, q) => p.ty - q.ty);
      const top = b.y0 + 0.06;
      const bottom = b.y1 - 0.06;
      const step = list.length > 1 ? (bottom - top) / (list.length - 1) : 0;
      list.forEach((ann, i) => {
        ann.lx = x;
        ann.ly = list.length > 1 ? top + step * i : (top + bottom) / 2;
      });
    };

    place(left, b.x0 + leftRoom / 2);
    place(right, 1 + rightRoom / 2);
    render();
    T.info('labels.arranged', { left: left.length, right: right.length });
    toast(`Arranged ${items.length} label${items.length === 1 ? '' : 's'} into the margin.`);
  }

  /* ── Tools ──────────────────────────────────────────── */

  function setTool(tool) {
    state.tool = tool || '';
    for (const b of el.tools) {
      const on = (b.dataset.tool || '') === state.tool;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
    }
    el.canvas.classList.toggle('drawing', Boolean(state.tool));
    el.canvasHint.textContent = TOOL_HINT[state.tool] || TOOL_HINT[''];
  }

  function resizeLabel(ann, scale, anchor) {
    const node = labelNodeOf(ann.id);
    if (!node) return;
    const b = canvasBounds();
    const maxScale = Math.min(3, (view.cw - 4) / Math.max(1, node.offsetWidth), (view.ch - 4) / Math.max(1, node.offsetHeight));
    ann.labelScale = Math.max(Math.min(0.65, maxScale), Math.min(maxScale, scale));
    const hw = (node.offsetWidth * ann.labelScale) / (2 * view.w);
    const hh = (node.offsetHeight * ann.labelScale) / (2 * view.h);
    ann.lx = Math.max(b.x0 + hw, Math.min(b.x1 - hw, anchor ? anchor.x + hw : ann.lx));
    ann.ly = Math.max(b.y0 + hh, Math.min(b.y1 - hh, anchor ? anchor.y - hh : ann.ly));
  }

  function pointInCanvas(event) {
    const rect = el.canvas.getBoundingClientRect();
    return { x: nxOf(event.clientX - rect.left), y: nyOf(event.clientY - rect.top) };
  }

  /* ── Dragging & drawing ─────────────────────────────── */

  let drag = null;

  el.canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.busy || drag) return;
    const p = clampToCanvas(pointInCanvas(event));

    if (state.tool) {
      event.preventDefault();
      record();
      const tool = state.tool;

      if (tool === 'note') {
        const ann = addAnnotation({ kind: 'note', lx: p.x, ly: p.y });
        state.selectedId = ann.id;
        setTool('');
        render();
        el.editLabel.focus();
        el.editLabel.select();
        return;
      }

      const ann = tool === 'free'
        ? addAnnotation({ kind: 'free', path: [p], tx: p.x, ty: p.y, lx: p.x, ly: p.y - 0.1 })
        : addAnnotation({ kind: tool, a: { x: p.x, y: p.y }, b: { x: p.x, y: p.y }, tx: p.x, ty: p.y, lx: p.x, ly: p.y - 0.12 });

      state.selectedId = ann.id;
      drag = { id: ann.id, mode: tool === 'free' ? 'draw-free' : 'draw', moved: false, created: true };
      render();
      capture(event);
      return;
    }

    const roleNode = event.target.closest('[data-role]');
    const label = event.target.closest('.ann-label');
    const group = event.target.closest('g.ann');
    const resize = event.target.closest('.label-resize');
    const node = roleNode || label || group;
    if (!node) {
      if (state.selectedId) select(null);
      return;
    }
    if (label && label.classList.contains('editing')) return;

    const ann = byId(node.dataset.id);
    if (!ann) return;

    event.preventDefault();
    select(ann.id);

    let mode;
    if (resize) mode = 'resize';
    else if (roleNode) mode = roleNode.dataset.role;
    else if (label) mode = KIND[ann.kind].readout ? 'shape' : 'label';
    else mode = KIND[ann.kind].point ? 'target' : 'shape';

    const rect = label && !KIND[ann.kind].readout ? labelNodeOf(ann.id).getBoundingClientRect() : null;
    const anchorSource = mode === 'target' ? { x: ann.tx, y: ann.ty }
      : mode === 'pa' ? ann.a
        : mode === 'pb' ? ann.b
          : { x: ann.lx, y: ann.ly };

    record();
    drag = {
      id: ann.id,
      mode,
      grabDx: anchorSource.x - p.x,
      grabDy: anchorSource.y - p.y,
      origin: { x: p.x, y: p.y },
      startScale: ann.labelScale,
      startWidth: rect?.width,
      startHeight: rect?.height,
      anchor: rect ? { x: ann.lx - rect.width / (2 * view.w), y: ann.ly + rect.height / (2 * view.h) } : null,
      moved: false,
    };
    capture(event);
  });

  /* Pointer capture keeps a drag alive outside the canvas, but it throws if the
     pointer is already gone. A failed capture must not abort the drag. */
  function capture(event) {
    try { el.canvas.setPointerCapture(event.pointerId); } catch { /* drag still works */ }
  }
  function releaseCapture(event) {
    try {
      if (el.canvas.hasPointerCapture?.(event.pointerId)) el.canvas.releasePointerCapture(event.pointerId);
    } catch { /* already released */ }
  }

  el.canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const ann = byId(drag.id);
    if (!ann) return;

    const raw = pointInCanvas(event);
    const p = clampToCanvas(raw);
    const moved = clampToCanvas({ x: raw.x + drag.grabDx, y: raw.y + drag.grabDy });

    switch (drag.mode) {
      case 'draw':
        ann.b = { x: p.x, y: p.y };
        ann.tx = p.x; ann.ty = p.y;
        break;
      case 'draw-free': {
        const last = ann.path[ann.path.length - 1];
        if (Math.hypot((p.x - last.x) * view.w, (p.y - last.y) * view.h) > 3) ann.path.push({ x: p.x, y: p.y });
        break;
      }
      case 'resize': {
        const dx = (raw.x - drag.origin.x) * view.w;
        const dy = (raw.y - drag.origin.y) * view.h;
        const projection = (dx * drag.startWidth - dy * drag.startHeight) /
          (drag.startWidth ** 2 + drag.startHeight ** 2);
        resizeLabel(ann, drag.startScale * (1 + projection), drag.anchor);
        break;
      }
      case 'shape': {
        // Move every point together, stopping when the shape reaches the canvas edge.
        const b = canvasBounds();
        const box = shapeBox(ann);
        let dx = raw.x - drag.origin.x;
        let dy = raw.y - drag.origin.y;
        dx = Math.max(b.x0 - box.x0, Math.min(b.x1 - box.x1, dx));
        dy = Math.max(b.y0 - box.y0, Math.min(b.y1 - box.y1, dy));
        translate(ann, dx, dy);
        drag.origin = { x: drag.origin.x + dx, y: drag.origin.y + dy };
        break;
      }
      case 'pa': ann.a = { x: moved.x, y: moved.y }; break;
      case 'pb': ann.b = { x: moved.x, y: moved.y }; break;
      case 'target': ann.tx = moved.x; ann.ty = moved.y; ann.curve = []; break;
      default: ann.lx = moved.x; ann.ly = moved.y;
    }

    drag.moved = true;
    layout();
    renderLabels();
    renderShapes();
  });

  function endDrag(event) {
    if (!drag) return;
    const { moved, created, mode, id } = drag;
    const ann = byId(id);
    drag = null;

    if (created) {
      const tooSmall = mode === 'draw-free'
        ? !ann || ann.path.length < 3
        : !ann || Math.hypot((ann.b.x - ann.a.x) * view.w, (ann.b.y - ann.a.y) * view.h) < 12;

      if (event.type === 'pointercancel' || tooSmall) {
        if (ann) removeAnnotation(ann.id);
        history.past.pop();          // the creation never happened
        updateHistoryButtons();
        setTool('');
        releaseCapture(event);
        render();
        return;
      }
      if (ann.kind === 'free') { const m = pathMid(ann.path); ann.tx = m.x; ann.ty = m.y; }
      setTool('');
      T.debug('annotation.created', { kind: ann.kind, id: ann.id });
    } else if (!moved) {
      history.past.pop();            // a click that changed nothing
      updateHistoryButtons();
    }

    releaseCapture(event);
    render();
  }

  el.canvas.addEventListener('pointerup', endDrag);
  el.canvas.addEventListener('pointercancel', endDrag);

  /* ── Inline label editing ───────────────────────────── */

  el.labels.addEventListener('dblclick', (event) => {
    if (event.target.closest('.label-resize')) return;
    const node = event.target.closest('.ann-label');
    if (!node || node.classList.contains('readout')) return;
    const ann = byId(node.dataset.id);
    if (!ann) return;

    const text = node.querySelector('.text');
    const before = serialize();
    node.classList.add('editing');
    text.contentEditable = 'true';
    text.focus();

    const range = document.createRange();
    range.selectNodeContents(text);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = () => {
      text.contentEditable = 'false';
      node.classList.remove('editing');
      const next = text.textContent.trim() || defaultLabel(ann.kind);
      if (next !== ann.label) {
        history.past.push(before);
        history.future.length = 0;
        updateHistoryButtons();
        ann.label = next;
      }
      render();
    };

    text.addEventListener('blur', commit, { once: true });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); text.textContent = ann.label; text.blur(); }
    });
  });

  /* ── Editor field wiring ────────────────────────────── */

  /* One editing session (a burst of typing, a slider drag) becomes one undo
     step. The snapshot is taken on the first input rather than on focus, so it
     is captured even when the field never received a focus event. */
  function bindField(input, apply, live) {
    let pending = null;
    const begin = () => { if (pending === null) pending = serialize(); };

    const flush = () => {
      if (pending === null) return;
      if (pending !== serialize()) {
        history.past.push(pending);
        if (history.past.length > HISTORY_MAX) history.past.shift();
        history.future.length = 0;
        updateHistoryButtons();
      }
      pending = null;
    };

    input.addEventListener('input', () => {
      const ann = byId(state.selectedId);
      if (!ann) return;
      begin();
      apply(ann, input.value);
      live();
    });
    input.addEventListener('change', flush);
    input.addEventListener('blur', flush);
  }

  bindField(el.editLabel, (ann, v) => { ann.label = v || defaultLabel(ann.kind); }, () => { renderLabels(); renderShapes(); renderList(); });
  bindField(el.editNote, (ann, v) => { ann.note = v; }, () => renderList());
  bindField(el.editConf, (ann, v) => { ann.confidence = Number(v) / 100; }, () => { renderLabels(); renderShapes(); renderList(); renderEditor(); });
  bindField(el.editWeight, (ann, v) => { ann.weight = clampWeight(v); lastWeight = ann.weight; }, () => { renderShapes(); renderEditor(); });

  el.btnWeightReset.addEventListener('click', () => {
    const ann = byId(state.selectedId);
    if (!ann || weightOf(ann) === 1) return;
    record();
    ann.weight = 1;
    lastWeight = 1;
    render();
  });

  el.btnConfClear.addEventListener('click', () => {
    const ann = byId(state.selectedId);
    if (!ann || ann.confidence == null) return;
    record();
    ann.confidence = null;
    render();
  });

  el.btnDuplicate.addEventListener('click', duplicateSelected);
  el.btnDeleteSel.addEventListener('click', () => {
    if (!state.selectedId) return;
    record();
    removeAnnotation(state.selectedId);
  });

  function duplicateSelected() {
    const ann = byId(state.selectedId);
    if (!ann) return;
    record();
    const copy = JSON.parse(JSON.stringify(ann));
    copy.id = `a${++state.seq}`;
    state.annotations.push(copy);
    translate(copy, 0.04, 0.04);
    state.selectedId = copy.id;
    render();
    toast('Duplicated annotation.');
  }

  /* ── Keyboard ───────────────────────────────────────── */

  const TOOL_KEYS = { v: '', a: 'arrow', b: 'box', r: 'ruler', p: 'free', n: 'note' };

  document.addEventListener('keydown', (event) => {
    const typing = document.activeElement &&
      (document.activeElement.isContentEditable ||
       /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));

    if (event.key === 'Escape' && (state.tool || drag)) {
      if (drag?.created) { removeAnnotation(drag.id); history.past.pop(); updateHistoryButtons(); }
      drag = null;
      setTool('');
      render();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !typing) {
      const k = event.key.toLowerCase();
      if (k === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (k === 'y') { event.preventDefault(); redo(); return; }
      if (k === 'd') { event.preventDefault(); duplicateSelected(); return; }
    }

    const resizeControl = event.target.closest?.('.label-resize');
    if (resizeControl && /^Arrow/.test(event.key)) {
      const ann = byId(resizeControl.closest('.ann-label').dataset.id);
      if (!ann) return;
      event.preventDefault();
      recordNudge();
      state.selectedId = ann.id;
      resizeLabel(ann, ann.labelScale + (['ArrowUp', 'ArrowRight'].includes(event.key) ? 0.1 : -0.1));
      render();
      labelNodeOf(ann.id)?.querySelector('.label-resize')?.focus();
      return;
    }

    if (typing) return;

    if (state.image && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const tool = TOOL_KEYS[event.key.toLowerCase()];
      if (tool !== undefined) { event.preventDefault(); setTool(state.tool === tool ? '' : tool); return; }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); setZoom(state.zoom * 1.25); return; }
      if (event.key === '-' || event.key === '_') { event.preventDefault(); setZoom(state.zoom / 1.25); return; }
      if (event.key === '0') { event.preventDefault(); setZoom(1); return; }
    }

    if (!state.selectedId) return;
    const ann = byId(state.selectedId);
    if (!ann) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      record();
      removeAnnotation(ann.id);
      return;
    }

    const step = event.shiftKey ? 0.02 : 0.004;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!nudge) return;

    event.preventDefault();
    recordNudge();
    const b = canvasBounds();

    // Alt (or a shape with no separate label) moves the whole annotation.
    if (event.altKey || !KIND[ann.kind].label) {
      const box = shapeBox(ann);
      const dx = Math.max(b.x0 - box.x0, Math.min(b.x1 - box.x1, nudge[0]));
      const dy = Math.max(b.y0 - box.y0, Math.min(b.y1 - box.y1, nudge[1]));
      translate(ann, dx, dy);
      if (KIND[ann.kind].point) ann.curve = [];
    } else {
      ann.lx = Math.min(b.x1, Math.max(b.x0, ann.lx + nudge[0]));
      ann.ly = Math.min(b.y1, Math.max(b.y0, ann.ly + nudge[1]));
    }
    render();
  });

  /* ── Gemini call ────────────────────────────────────── */

  /* Two paths: proxy through server.js when it holds the key, otherwise call
     Google directly with the key from Settings. Both go through prompt.js so
     the request is identical either way. */
  async function analyze() {
    T.info('analyze.click', {
      hasImage: Boolean(state.image),
      busy: state.busy,
      hasServerKey: state.server.hasServerKey,
      apiBase: state.apiBase || '(same origin)',
      model: el.modelName.value.trim() || DEFAULT_MODEL,
    });

    if (!state.image || state.busy) {
      T.warn('analyze.skipped', {
        reason: !state.image ? 'no image loaded' : 'a previous analysis is still marked busy',
        busy: state.busy,
      });
      if (state.busy) toast('An analysis is already running. Press Cancel first.', true);
      else toast('Upload a GPR image first.', true);
      return;
    }

    const { apiKey, model } = settings();
    if (el.velocity.value && !PROMPT.validVelocity(el.velocity.value)) {
      toast('Enter a wave velocity above 0 and at most 0.3 m/ns.', true);
      el.velocity.focus();
      return;
    }
    const useServer = state.server.hasServerKey;

    if (!useServer && !apiKey) {
      toast('No server key found. Add a Gemini API key in Settings, or run `npm start`.', true);
      el.settings.showModal();
      return;
    }

    setBusy(true, 'Analyzing radargram…');
    const focus = el.hint.value.trim();
    const span = T.span('analyze', {
      model, path: useServer ? 'proxy' : 'direct',
      uploadMb: +((state.image.uploadBase64.length * 0.75) / 1048576).toFixed(2),
      sourcePx: `${state.image.naturalW}×${state.image.naturalH}`,
    });
    const stopHeartbeat = T.heartbeat('analyze', { model, path: useServer ? 'proxy' : 'direct' });

    const controller = new AbortController();
    state.abort = controller;
    const timer = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
      const items = useServer
        ? await callProxy(focus, controller.signal)
        : await callGeminiDirect(focus, apiKey, model, controller.signal);

      applyResults(items.list);
      const n = items.list.length;
      span.end({ annotations: n, modelUsed: items.modelUsed, serverMs: items.ms, reqId: items.reqId });

      toast(n === 0 ? 'No clear target reflections found. Add a marker manually or try a clearer scan.' : `Added ${n} annotation${n === 1 ? '' : 's'}${
        items.modelUsed && items.modelUsed !== model
          ? ` · ${model} was busy, answered by ${items.modelUsed}`
          : ''}.`);
    } catch (err) {
      span.fail(err, { aborted: err.name === 'AbortError', reason: controller.signal.reason });
      if (err.name === 'AbortError') {
        toast(controller.signal.reason === 'cancelled'
          ? 'Analysis cancelled.'
          : `Analysis timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try a smaller image or a flash model.`,
        controller.signal.reason !== 'cancelled');
      } else {
        toast(`Analysis failed: ${err.message}`, true);
      }
    } finally {
      stopHeartbeat();
      clearTimeout(timer);
      state.abort = null;
      setBusy(false);
    }
  }

  async function callProxy(focus, signal) {
    const res = await fetch(`${state.apiBase}/api/annotate`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mimeType: state.image.uploadMime,
        base64: state.image.uploadBase64,
        focus,
        velocityMPerNs: el.velocity.value ? Number(el.velocity.value) : null,
      }),
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

    const items = payload?.annotations;
    if (!Array.isArray(items)) throw new Error('The server returned an invalid annotation list.');
    return { list: items, modelUsed: payload.modelUsed, ms: payload.ms, reqId: payload.reqId };
  }

  async function callGeminiDirect(focus, apiKey, model, signal) {
    const url = `${PROMPT.ENDPOINT}/${encodeURIComponent(model)}:generateContent`;

    T.warn('gemini.direct_call', {
      model, reason: state.server.hasServerKey ? 'settings-key-override' : 'no-server-key',
      note: 'bypasses server proxy — no server-side logs for this request',
    });

    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(PROMPT.buildRequest({
        mimeType: state.image.uploadMime,
        base64: state.image.uploadBase64,
        focus,
      })),
    });

    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Model "${model}" does not exist for this key. Settings → "List models my key can call".`);
      }
      throw new Error(payload?.error?.message || `HTTP ${res.status}`);
    }

    return { list: PROMPT.parseResponse(payload, { velocityMPerNs: el.velocity.value }), modelUsed: model };
  }

  /* Reanalysis keeps everything the operator drew by hand and replaces only the
     model's own targets. */
  function applyResults(items) {
    record();
    state.annotations = state.annotations.filter((ann) => ann.kind !== 'target' || ann.manual);
    state.selectedId = null;

    const taken = state.annotations.map((a) => ({ x: a.lx, y: a.ly }));
    for (const item of items) {
      const p = item.point || {};
      const tx = clamp01((Number(p.x) || 0) / 1000);
      const ty = clamp01((Number(p.y) || 0) / 1000);
      const spot = placeLabel(tx, ty, taken);
      taken.push(spot);

      if (item.calibration) state.calibration = item.calibration;

      const conf = Number(item.confidence);
      addAnnotation({
        label: String(item.label || 'Feature').trim(),
        note: String(item.note || '').trim(),
        confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
        calibration: item.calibration || null,
        velocityMPerNs: item.velocityMPerNs,
        curve: item.curve || [],
        tx, ty,
        lx: spot.x, ly: spot.y,
      });
    }
    render();
  }

  let busyTimer = null;

  function setBusy(on, message = '') {
    state.busy = on;
    for (const b of [el.btnAdd, el.btnClear, el.btnArrange, ...el.tools]) b.disabled = on || !state.image;
    if (on) setTool('');
    el.status.hidden = !on;
    el.btnAnalyze.disabled = on || !state.image;
    el.btnAnalyze.querySelector('span').textContent = on ? 'Analyzing…' : 'Analyze scan';
    el.btnAnalyze.setAttribute('aria-label', on ? 'Analyzing…' : 'Analyze scan');
    el.btnAnalyze.title = on ? 'Analyzing…' : 'Analyze scan';
    el.btnAnalyze.classList.toggle('working', on);
    el.stage.setAttribute('aria-busy', String(on));

    clearTimeout(busyTimer);
    if (!on) return;

    const started = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - started) / 1000);
      let note = message || 'Analyzing radargram…';
      if (s >= 60) note = 'Still waiting for Gemini — you can cancel';
      else if (s >= 25) note = 'Waiting for Gemini to finish';
      else if (s >= 8) note = 'Waiting for Gemini';
      el.statusText.textContent = `${note} · ${s}s`;
      busyTimer = setTimeout(tick, 1000);
    };
    tick();
  }

  /* ── Export ─────────────────────────────────────────── */

  /* The exported PNG covers the image plus whatever spills into the margin, so
     off-image labels are never cropped. Image pixels stay 1:1 with the source. */
  function contentBounds() {
    const b = { x0: 0, y0: 0, x1: 1, y1: 1 };
    const grow = (x, y) => {
      b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y);
    };

    for (const ann of state.annotations) {
      const box = shapeBox(ann);
      grow(box.x0, box.y0);
      grow(box.x1, box.y1);
      if (KIND[ann.kind].label || KIND[ann.kind].readout) {
        const node = labelNodeOf(ann.id);
        const hw = ((node?.offsetWidth || 160) * ann.labelScale) / (2 * view.w);
        const hh = ((node?.offsetHeight || 40) * ann.labelScale) / (2 * view.h);
        const cx = KIND[ann.kind].readout && ann.a && ann.b ? (ann.a.x + ann.b.x) / 2 : ann.lx;
        const cy = KIND[ann.kind].readout && ann.a && ann.b ? (ann.a.y + ann.b.y) / 2 : ann.ly;
        grow(cx - hw, cy - hh);
        grow(cx + hw, cy + hh);
      }
      for (const p of ann.curve || []) grow(p.x / 1000, p.y / 1000);
    }

    const padX = 0.02 + (b.x1 - b.x0) * 0.01;
    const padY = 0.02 + (b.y1 - b.y0) * 0.01;
    return { x0: b.x0 - padX, x1: b.x1 + padX, y0: b.y0 - padY, y1: b.y1 + padY };
  }

  function exportPng() {
    if (!state.image) return;

    const sw = state.image.naturalW;
    const sh = state.image.naturalH;
    const k = sw / Math.max(1, view.w);          // on-screen px → source px
    const bounds = contentBounds();

    const fullW = (bounds.x1 - bounds.x0) * sw;
    const fullH = (bounds.y1 - bounds.y0) * sh;
    const cap = Math.min(1, 9000 / fullW, 9000 / fullH);   // keep the PNG sane

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(fullW * cap));
    canvas.height = Math.max(1, Math.round(fullH * cap));

    const ctx = canvas.getContext('2d');
    ctx.scale(cap, cap);

    const X = (nx) => (nx - bounds.x0) * sw;
    const Y = (ny) => (ny - bounds.y0) * sh;

    ctx.fillStyle = '#eef1ea';
    ctx.fillRect(0, 0, fullW, fullH);
    ctx.drawImage(el.image, X(0), Y(0), sw, sh);
    ctx.strokeStyle = 'rgba(30,50,35,.25)';
    ctx.lineWidth = Math.max(1, k);
    ctx.strokeRect(X(0), Y(0), sw, sh);

    for (const ann of state.annotations) {
      const kind = KIND[ann.kind];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (ann.curve?.length > 1) {
        ctx.save();
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = Math.max(2, 2 * k) * weightOf(ann);
        ctx.setLineDash([5 * k, 4 * k]);
        ctx.beginPath();
        ann.curve.forEach((p, i) => (i ? ctx.lineTo(X(p.x / 1000), Y(p.y / 1000)) : ctx.moveTo(X(p.x / 1000), Y(p.y / 1000))));
        ctx.stroke();
        ctx.restore();
      }

      if (ann.kind === 'free' && ann.path?.length > 1) {
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = Math.max(2, 2.4 * k) * weightOf(ann);
        ctx.beginPath();
        ann.path.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
        ctx.stroke();
      }

      if (ann.kind === 'box' && ann.a && ann.b) {
        const x = Math.min(X(ann.a.x), X(ann.b.x));
        const y = Math.min(Y(ann.a.y), Y(ann.b.y));
        const w = Math.abs(X(ann.b.x) - X(ann.a.x));
        const h = Math.abs(Y(ann.b.y) - Y(ann.a.y));
        ctx.save();
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = Math.max(2, 2 * k) * weightOf(ann);
        ctx.setLineDash([9 * k, 5 * k]);
        ctx.strokeRect(x, y, w, h);
        ctx.restore();
      }

      if (ann.kind === 'ruler' && ann.a && ann.b) {
        const p1 = { x: X(ann.a.x), y: Y(ann.a.y) };
        const p2 = { x: X(ann.b.x), y: Y(ann.b.y) };
        const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
        const nx = -(p2.y - p1.y) / len;
        const ny = (p2.x - p1.x) / len;
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = Math.max(2, 2 * k) * weightOf(ann);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
        for (const p of [p1, p2]) {
          ctx.moveTo(p.x - nx * 7 * k, p.y - ny * 7 * k);
          ctx.lineTo(p.x + nx * 7 * k, p.y + ny * 7 * k);
        }
        ctx.stroke();
      }

      if (ann.kind === 'arrow' && ann.a && ann.b) {
        drawArrowOnCanvas(ctx, ann, { x: X(ann.a.x), y: Y(ann.a.y) }, { x: X(ann.b.x), y: Y(ann.b.y) }, 0, k);
      }

      if (!kind.label && !kind.readout) continue;

      // ── label card ──
      const fontPx = 11 * k * ann.labelScale;
      const pad = fontPx * 0.55;
      const lineH = fontPx * 1.3;
      const node = labelNodeOf(ann.id);
      const maxW = Math.max(20, (node?.offsetWidth || 215) * k * ann.labelScale - pad * 2);

      ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const lines = [];
      if (kind.readout) {
        if (ann.label && ann.label !== defaultLabel('ruler')) lines.push(...wrapText(ctx, ann.label, maxW));
        lines.push(...wrapText(ctx, rulerSummary(ann), maxW));
      } else {
        lines.push(...wrapText(ctx, ann.label, maxW));
        if (calOf(ann) && kind.point) lines.push(...wrapText(ctx, measurementSummary(ann), maxW));
      }
      const confText = ann.confidence != null ? `confidence ${Math.round(ann.confidence * 100)}%` : null;

      let boxW = 0;
      for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
      if (confText) {
        ctx.font = `${Math.round(fontPx * 0.78)}px ui-monospace, Menlo, Consolas, monospace`;
        boxW = Math.max(boxW, ctx.measureText(confText).width);
      }
      boxW += pad * 2;
      const boxH = lines.length * lineH + (confText ? Math.round(lineH * 0.85) : 0) + pad * 2 - (lineH - fontPx);

      const centre = kind.readout && ann.a && ann.b
        ? { x: X((ann.a.x + ann.b.x) / 2), y: Y((ann.a.y + ann.b.y) / 2) }
        : { x: X(ann.lx), y: Y(ann.ly) };
      const box = { cx: centre.x, cy: centre.y, hw: boxW / 2 + 3, hh: boxH / 2 + 3 };

      if (kind.leader) {
        const target = { x: X(ann.tx), y: Y(ann.ty) };
        drawArrowOnCanvas(ctx, ann, edgeOfBox(box, target), target, 5 * k, k);

        ctx.strokeStyle = ann.color;
        ctx.lineWidth = Math.max(1.5, 1.5 * k) * weightOf(ann);
        ctx.beginPath();
        ctx.arc(target.x, target.y, 9 * k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = ann.color;
        ctx.beginPath();
        ctx.arc(target.x, target.y, 3.5 * k, 0, Math.PI * 2);
        ctx.fill();
      }

      const bx = centre.x - boxW / 2;
      const by = centre.y - boxH / 2;
      roundRect(ctx, bx, by, boxW, boxH, Math.round(6 * k));
      ctx.fillStyle = '#f2f6fb';
      ctx.fill();
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1.5, 1.5 * k);
      ctx.stroke();

      ctx.fillStyle = '#0b0f15';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      let ty = by + pad;
      for (const line of lines) {
        ctx.fillText(line, bx + pad, ty);
        ty += lineH;
      }
      if (confText) {
        ctx.font = `${Math.round(fontPx * 0.78)}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillStyle = 'rgba(11,15,21,.62)';
        ctx.fillText(confText, bx + pad, ty);
      }
    }

    canvas.toBlob((blob) => {
      if (!blob) { toast('Export failed.', true); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gpr-annotated-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Exported ${canvas.width}×${canvas.height} PNG.`);
    }, 'image/png');
  }

  function drawArrowOnCanvas(ctx, ann, start, tip, inset, k) {
    const dx = tip.x - start.x;
    const dy = tip.y - start.y;
    const len = Math.hypot(dx, dy);
    if (len <= 12 * k) return;

    const ux = dx / len;
    const uy = dy / len;
    const head = 9 * k * (0.7 + 0.3 * weightOf(ann));
    const end = { x: tip.x - ux * inset, y: tip.y - uy * inset };
    const base = { x: end.x - ux * head, y: end.y - uy * head };
    const wing = head * 0.52;

    ctx.strokeStyle = ann.color;
    ctx.lineWidth = Math.max(2, 2 * k) * weightOf(ann);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(base.x, base.y);
    ctx.stroke();

    ctx.fillStyle = ann.color;
    ctx.beginPath();
    ctx.moveTo(end.x, end.y);
    ctx.lineTo(base.x - uy * wing, base.y + ux * wing);
    ctx.lineTo(base.x + uy * wing, base.y - ux * wing);
    ctx.closePath();
    ctx.fill();
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [''];
    const lines = [];
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = `${line} ${words[i]}`;
      if (ctx.measureText(test).width > maxWidth) { lines.push(line); line = words[i]; }
      else line = test;
    }
    lines.push(line);
    return lines;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /* ── Wiring ─────────────────────────────────────────── */

  el.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) readFile(file);
    e.target.value = '';
  });

  el.dropzone.addEventListener('click', (e) => {
    if (e.target.tagName !== 'LABEL') el.fileInput.click();
  });

  for (const type of ['dragenter', 'dragover']) {
    document.addEventListener(type, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    document.addEventListener(type, (e) => {
      e.preventDefault();
      if (type === 'dragleave' && e.relatedTarget) return;
      el.dropzone.classList.remove('over');
    });
  }
  document.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) readFile(file);
  });

  /* Populate the model datalist from the live ListModels call. */
  async function listModels() {
    el.modelNote.hidden = false;
    el.modelNote.classList.remove('bad');
    el.modelNote.textContent = 'Asking Google…';

    try {
      if (!state.server.hasServerKey) throw new Error('no server key');
      const res = await fetch(`${state.apiBase}/api/models`);
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

      const models = payload.models || [];
      if (!models.length) throw new Error('No models returned for this key.');

      el.modelList.innerHTML = '';
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        if (m.label) opt.label = m.label;
        el.modelList.appendChild(opt);
      }

      const current = el.modelName.value.trim();
      const known = models.some((m) => m.id === current);
      el.modelNote.classList.toggle('bad', Boolean(current) && !known);
      el.modelNote.textContent = current && !known
        ? `${models.length} models available — but "${current}" is not one of them. Click the field to pick a real one.`
        : `${models.length} models available. Click the field to see the list.`;
    } catch (err) {
      el.modelNote.classList.add('bad');
      el.modelNote.textContent = state.server.hasServerKey
        ? `Could not list models: ${err.message}`
        : 'Needs a server key. Put GEMINI_API_KEY in DeltaTemp\\.env and restart the server.';
    }
  }

  el.btnListModels.addEventListener('click', listModels);

  el.btnCancel.addEventListener('click', () => {
    if (state.abort) state.abort.abort('cancelled');
  });

  el.btnSettings.addEventListener('click', () => {
    el.modelNote.hidden = true;
    el.settings.showModal();
  });
  el.settings.addEventListener('close', () => {
    if (el.settings.returnValue === 'save') {
      saveSettings();
      toast('Settings saved.');
    } else {
      loadSettings();
    }
  });

  el.btnAnalyze.addEventListener('click', () => {
    analyze().catch((err) => {
      T.error('analyze.unhandled', { error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
      toast(`Analysis crashed: ${err?.message || err}`, true);
      setBusy(false);
    });
  });
  el.btnExport.addEventListener('click', exportPng);

  for (const b of el.tools) {
    b.addEventListener('click', () => {
      if (!state.image || state.busy) return;
      const tool = b.dataset.tool || '';
      setTool(state.tool === tool ? '' : tool);
    });
  }

  el.zoomIn.addEventListener('click', () => setZoom(state.zoom * 1.25));
  el.zoomOut.addEventListener('click', () => setZoom(state.zoom / 1.25));
  el.zoomFit.addEventListener('click', () => setZoom(1));
  el.btnUndo.addEventListener('click', undo);
  el.btnRedo.addEventListener('click', redo);
  el.btnArrange.addEventListener('click', arrangeLabels);

  el.btnAdd.addEventListener('click', () => {
    if (!state.image) return;
    record();
    const taken = state.annotations.map((a) => ({ x: a.lx, y: a.ly }));
    const tx = 0.5;
    const ty = 0.45 + (state.annotations.length % 4) * 0.08;
    const spot = placeLabel(tx, ty, taken);
    const ann = addAnnotation({ label: 'New annotation', tx, ty, lx: spot.x, ly: spot.y });
    ann.manual = true;               // survives reanalysis
    state.selectedId = ann.id;
    render();
    el.editLabel.focus();
    el.editLabel.select();
  });

  el.btnClear.addEventListener('click', () => {
    setTool('');
    if (!state.annotations.length) return;
    record();
    state.annotations = [];
    state.selectedId = null;
    state.seq = 0;
    render();
  });

  el.image.addEventListener('load', render);
  document.querySelector('.canvas-toolbar label').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.fileInput.click(); }
  });
  el.velocity.addEventListener('input', () => { if (state.image) render(); });
  window.addEventListener('resize', () => { if (state.image) render(); });

  /* Read hook for tests/workspace.browser.js and for poking at a live session
     from the console. Nothing in the app reads it back. */
  window.__gprState = state;

  buildSwatches();
  loadSettings();
  renderList();
  probeServer();
})();

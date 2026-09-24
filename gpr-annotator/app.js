/* GPR Annotator — AI-assisted radargram markup.
   Annotations are stored in normalized image space (0..1) so they survive
   window resizing and export at full source resolution. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    dropzone:   $('dropzone'),
    fileInput:  $('file-input'),
    stage:      $('stage'),
    frame:      $('frame'),
    image:      $('gpr-image'),
    arrows:     $('arrow-layer'),
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
    serverStatus: $('server-status'),
    modelList:    $('model-list'),
    modelNote:    $('model-note'),
    btnListModels: $('btn-list-models'),
    btnCancel:    $('btn-cancel'),
    originWarning: $('origin-warning'),
    velocity: $('wave-velocity'),
    imageName: $('image-name'),
    annCount: $('ann-count'),
    btnArrow: $('btn-arrow'),
    canvasHint: $('canvas-hint'),
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

  const state = {
    image: null,        // { dataUrl, mimeType, base64, naturalW, naturalH }
    annotations: [],
    selectedId: null,
    busy: false,
    seq: 0,
    tool: null,
    server: { hasServerKey: false, model: null }, // filled by probeServer()
    apiBase: '',                                  // '' = same origin
  };

  /* Is server.js running with a key in .env? If so we proxy through it and the
     browser never handles the key at all. */
  /* The page may be served by something other than server.js — VS Code Live
     Server on :5500 is the common case. Try same-origin first, then the known
     API port, so the app works from either. */
  const API_FALLBACK_ORIGIN = `${location.protocol === 'https:' ? 'https' : 'http'}://localhost:8787`;

  async function resolveApiBase() {
    const candidates = ['', API_FALLBACK_ORIGIN];

    for (const base of candidates) {
      if (base && base === location.origin) continue; // already tried as same-origin
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
      // No /api/* can ever work from a file:// page. Say so loudly instead of
      // silently falling back to a direct call with no timeout.
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
      // Served by another dev server; the API is being reached cross-origin.
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
          // what actually gets sent to Gemini
          uploadMime: upload.mimeType,
          uploadBase64: upload.base64,
          uploadNote: upload.note,
        };
        state.annotations = [];
        state.selectedId = null;
        state.seq = 0;
        setTool(null);

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
    el.btnAnalyze.disabled = !on || state.busy;
    el.btnExport.disabled = !on;
    el.btnAdd.disabled = !on;
    el.btnClear.disabled = !on;
    el.btnArrow.disabled = !on;
  }

  /* ── Annotation model ───────────────────────────────── */

  function addAnnotation({ label, note = '', confidence = null, tx, ty, lx, ly, calibration = null, velocityMPerNs = null, curve = [], kind = 'target' }) {
    const ann = {
      id: `a${++state.seq}`,
      label: label || 'Untitled feature',
      note,
      confidence,
      calibration, velocityMPerNs, curve,
      kind, labelScale: 1,
      color: PALETTE[(state.seq - 1) % PALETTE.length],
      tx: clamp01(tx),
      ty: clamp01(ty),
      lx: clamp01(lx),
      ly: clamp01(ly),
    };
    state.annotations.push(ann);
    return ann;
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const byId = (id) => state.annotations.find((a) => a.id === id);
  const metricsFor = ann => PROMPT.measurePoint(ann.calibration, {x:ann.tx*1000,y:ann.ty*1000}, el.velocity.value || ann.velocityMPerNs);
  const metres = value => value===null ? 'Unknown' : `≈ ${Number(value.toPrecision(3))} m`;
  function measurementSummary(ann) {
    if(!ann.calibration)return '';
    const m=metricsFor(ann);
    return `${metres(m.alongM)} along · ${metres(m.depthM)} deep`;
  }

  /* Pick a label spot near the target that avoids the other labels. */
  function placeLabel(tx, ty, taken) {
    const radii = [0.16, 0.24, 0.32];
    const angles = [-90, -45, -135, 0, 180, 45, 135, 90];
    let best = null;
    let bestScore = -Infinity;

    for (const r of radii) {
      for (const deg of angles) {
        const rad = (deg * Math.PI) / 180;
        const x = tx + Math.cos(rad) * r * 0.75;
        const y = ty + Math.sin(rad) * r;
        if (x < 0.1 || x > 0.9 || y < 0.06 || y > 0.94) continue;

        let nearest = Infinity;
        for (const p of taken) {
          nearest = Math.min(nearest, Math.hypot(p.x - x, p.y - y));
        }
        const score = Math.min(nearest, 0.35) - r * 0.25;
        if (score > bestScore) { bestScore = score; best = { x, y }; }
      }
    }
    return best || { x: clamp01(tx), y: clamp01(ty - 0.12) };
  }

  /* ── Rendering ──────────────────────────────────────── */

  function frameSize() {
    return { w: el.image.clientWidth, h: el.image.clientHeight };
  }

  function render() {
    renderLabels();
    renderArrows();   // needs label boxes measured, so it runs second
    renderList();
  }

  function renderLabels() {
    const { w, h } = frameSize();
    el.labels.innerHTML = '';

    for (const ann of state.annotations) {
      if (ann.kind === 'arrow') continue;
      const node = document.createElement('div');
      node.className = 'ann-label';
      node.dataset.id = ann.id;
      node.style.left = `${ann.lx * w}px`;
      node.style.top = `${ann.ly * h}px`;
      node.style.borderColor = ann.color;
      node.style.setProperty('--label-scale', ann.labelScale);
      if (ann.id === state.selectedId) node.classList.add('selected');

      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = ann.label;
      node.appendChild(text);

      if(ann.calibration){const measure=document.createElement('span');measure.className='label-measure';measure.textContent=measurementSummary(ann);node.appendChild(measure);}

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
      if(w && h) {
        resizeLabel(ann,ann.labelScale);
        node.style.setProperty('--label-scale',ann.labelScale);
        node.style.left=`${ann.lx*w}px`;
        node.style.top=`${ann.ly*h}px`;
      }
    }
  }

  function renderArrows() {
    const { w, h } = frameSize();
    el.arrows.setAttribute('viewBox', `0 0 ${w} ${h}`);
    el.arrows.setAttribute('width', w);
    el.arrows.setAttribute('height', h);

    const svgNS = 'http://www.w3.org/2000/svg';
    el.arrows.innerHTML = '';

    for (const ann of state.annotations) {
      if(ann.curve.length>1){
        const trace=document.createElementNS(svgNS,'polyline');
        trace.setAttribute('points',ann.curve.map(p=>`${p.x*w/1000},${p.y*h/1000}`).join(' '));
        trace.setAttribute('class','hyperbola-trace');trace.setAttribute('stroke',ann.color);el.arrows.appendChild(trace);
      }
      const labelNode = el.labels.querySelector(`[data-id="${ann.id}"]`);
      const box = {
        cx: ann.lx * w,
        cy: ann.ly * h,
        hw: (labelNode ? labelNode.offsetWidth * ann.labelScale : 60) / 2 + 3,
        hh: (labelNode ? labelNode.offsetHeight * ann.labelScale : 22) / 2 + 3,
      };
      const target = { x: ann.tx * w, y: ann.ty * h };

      const start = ann.kind === 'arrow' ? {x: ann.lx*w, y: ann.ly*h} : edgeOfBox(box, target);
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const len = Math.hypot(dx, dy);

      const g = document.createElementNS(svgNS, 'g');
      g.setAttribute('class', `ann ${ann.kind}${ann.id === state.selectedId ? ' selected' : ''}`);
      g.dataset.id = ann.id;

      if (len > 12) {
        const ux = dx / len;
        const uy = dy / len;
        const head = 9;
        const inset = ann.kind === 'arrow' ? 0 : 5;
        const tip = { x: target.x - ux * inset, y: target.y - uy * inset };
        const base = { x: tip.x - ux * head, y: tip.y - uy * head };

        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('class', 'arrow-line');
        line.setAttribute('x1', start.x); line.setAttribute('y1', start.y);
        line.setAttribute('x2', base.x);  line.setAttribute('y2', base.y);
        line.setAttribute('stroke', ann.color);
        g.appendChild(line);

        const hit = document.createElementNS(svgNS, 'line');
        hit.setAttribute('class', 'arrow-hit');
        hit.setAttribute('x1', start.x); hit.setAttribute('y1', start.y);
        hit.setAttribute('x2', tip.x);   hit.setAttribute('y2', tip.y);
        g.appendChild(hit);

        const wing = head * 0.52;
        const poly = document.createElementNS(svgNS, 'polygon');
        poly.setAttribute('points', [
          `${tip.x},${tip.y}`,
          `${base.x - uy * wing},${base.y + ux * wing}`,
          `${base.x + uy * wing},${base.y - ux * wing}`,
        ].join(' '));
        poly.setAttribute('fill', ann.color);
        g.appendChild(poly);
      }

      const handle = document.createElementNS(svgNS, 'g');
      handle.setAttribute('class', 'target-handle');
      handle.dataset.id = ann.id;
      handle.dataset.role = 'target';

      const ring = document.createElementNS(svgNS, 'circle');
      ring.setAttribute('class', 'target-ring');
      ring.setAttribute('cx', target.x); ring.setAttribute('cy', target.y);
      ring.setAttribute('r', 9);
      ring.setAttribute('stroke', ann.color);
      handle.appendChild(ring);

      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('class', 'target-dot');
      dot.setAttribute('cx', target.x); dot.setAttribute('cy', target.y);
      dot.setAttribute('r', 3.5);
      dot.setAttribute('fill', ann.color);
      handle.appendChild(dot);

      g.appendChild(handle);
      if (ann.kind === 'arrow') {
        const tail = handle.cloneNode(true);
        tail.dataset.role = 'tail';
        tail.querySelectorAll('circle').forEach(circle => {
          circle.setAttribute('cx', start.x); circle.setAttribute('cy', start.y);
        });
        g.appendChild(tail);
      }
      el.arrows.appendChild(g);
    }
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
    el.annCount.textContent=state.annotations.length;
    el.list.innerHTML = '';

    if (!state.annotations.length) {
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = state.image
        ? 'Scan ready. Select the scan icon above to find targets, or the + icon to add your own.'
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
      const pos = `x ${(ann.tx * 100).toFixed(0)}%  y ${(ann.ty * 100).toFixed(0)}%`;
      meta.textContent = ann.confidence != null
        ? `${pos}  ·  ${Math.round(ann.confidence * 100)}%`
        : pos;
      body.appendChild(meta);

      if(ann.calibration){
        const m=metricsFor(ann),grid=document.createElement('div');grid.className='measurement-grid';
        [['Along scan',metres(m.alongM)],['Depth',metres(m.depthM)]].forEach(([name,value])=>{const cell=document.createElement('div'),key=document.createElement('span'),val=document.createElement('strong');key.textContent=name;val.textContent=value;cell.append(key,val);grid.append(cell);});
        body.append(grid);
        const basis=document.createElement('div');basis.className='measurement-basis';basis.textContent=`${m.basis}${m.timeNs!==null?' · '+Number(m.timeNs.toPrecision(3))+' ns':''}`;body.append(basis);
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
      del.setAttribute('aria-label','Delete '+ann.label);
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeAnnotation(ann.id);
      });

      card.append(swatch, body, del);
      card.addEventListener('click', () => select(ann.id));
      el.list.appendChild(card);
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

  /* ── Dragging ───────────────────────────────────────── */

  let drag = null;

  function setTool(tool) {
    state.tool = tool;
    el.btnArrow.setAttribute('aria-pressed', String(tool === 'arrow'));
    el.frame.classList.toggle('drawing-arrow', tool === 'arrow');
    el.canvasHint.textContent = tool === 'arrow'
      ? 'Drag from arrow start to tip · Esc to cancel'
      : 'Drag to move · Top-right handle to resize';
  }

  function resizeLabel(ann, scale, anchor) {
    const node = el.labels.querySelector(`[data-id="${ann.id}"]`);
    if (!node) return;
    const {w, h} = frameSize();
    const maxScale = Math.min(2.5, (w-4)/node.offsetWidth, (h-4)/node.offsetHeight);
    ann.labelScale = Math.max(Math.min(.65, maxScale), Math.min(maxScale, scale));
    const hw = node.offsetWidth * ann.labelScale / (2*w);
    const hh = node.offsetHeight * ann.labelScale / (2*h);
    ann.lx = Math.max(hw, Math.min(1-hw, anchor ? anchor.x+hw : ann.lx));
    ann.ly = Math.max(hh, Math.min(1-hh, anchor ? anchor.y-hh : ann.ly));
  }

  function pointInFrame(event) {
    const rect = el.image.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  el.frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state.busy || drag) return;
    const p = pointInFrame(event);
    if (state.tool === 'arrow') {
      event.preventDefault();
      const ann = addAnnotation({kind:'arrow', label:'Arrow', tx:p.x, ty:p.y, lx:p.x, ly:p.y});
      state.selectedId = ann.id;
      drag = {id:ann.id, mode:'draw', moved:false};
      render();
      el.frame.setPointerCapture(event.pointerId);
      return;
    }
    const handle = event.target.closest('.target-handle');
    const label = event.target.closest('.ann-label');
    const arrow = event.target.closest('g.ann');
    const resize = event.target.closest('.label-resize');
    const node = handle || label || arrow;
    if (!node) return;
    if (label && label.classList.contains('editing')) return;

    const ann = byId(node.dataset.id);
    if (!ann) return;

    event.preventDefault();
    select(ann.id);

    const mode = resize ? 'resize' : handle ? handle.dataset.role : label ? 'label' : ann.kind === 'arrow' ? 'move-arrow' : 'target';
    const rect = label ? el.labels.querySelector(`[data-id="${ann.id}"]`).getBoundingClientRect() : null;
    const {w,h} = frameSize();
    drag = {
      id: ann.id,
      mode,
      grabDx: (mode === 'target' ? ann.tx : ann.lx) - p.x,
      grabDy: (mode === 'target' ? ann.ty : ann.ly) - p.y,
      origin: {x:p.x, y:p.y, lx:ann.lx, ly:ann.ly, tx:ann.tx, ty:ann.ty},
      startScale: ann.labelScale,
      startWidth: rect?.width, startHeight: rect?.height,
      anchor: rect ? {x:ann.lx-rect.width/(2*w), y:ann.ly+rect.height/(2*h)} : null,
      moved: false,
    };
    el.frame.setPointerCapture(event.pointerId);
  });

  el.frame.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const ann = byId(drag.id);
    if (!ann) return;

    const p = pointInFrame(event);
    const nx = clamp01(p.x + drag.grabDx);
    const ny = clamp01(p.y + drag.grabDy);

    if (drag.mode === 'draw') { ann.tx=clamp01(p.x); ann.ty=clamp01(p.y); }
    else if (drag.mode === 'resize') {
      const {w,h}=frameSize();
      const dx=(p.x-drag.origin.x)*w, dy=(p.y-drag.origin.y)*h;
      const projection=(dx*drag.startWidth-dy*drag.startHeight)/(drag.startWidth**2+drag.startHeight**2);
      resizeLabel(ann, drag.startScale*(1+projection), drag.anchor);
    } else if (drag.mode === 'move-arrow') {
      const o=drag.origin;
      const dx=Math.max(-Math.min(o.lx,o.tx),Math.min(1-Math.max(o.lx,o.tx),p.x-o.x));
      const dy=Math.max(-Math.min(o.ly,o.ty),Math.min(1-Math.max(o.ly,o.ty),p.y-o.y));
      ann.lx=o.lx+dx; ann.ly=o.ly+dy; ann.tx=o.tx+dx; ann.ty=o.ty+dy;
    } else if (drag.mode === 'target') { ann.tx = nx; ann.ty = ny; ann.curve = []; }
    else { ann.lx = nx; ann.ly = ny; }

    drag.moved = true;
    renderLabels();
    renderArrows();
  });

  function endDrag(event) {
    if (!drag) return;
    const moved = drag.moved;
    if (drag.mode === 'draw') {
      const ann=byId(drag.id), {w,h}=frameSize();
      if(event.type === 'pointercancel' || !ann || Math.hypot((ann.tx-ann.lx)*w,(ann.ty-ann.ly)*h)<12) {
        removeAnnotation(drag.id);
      } else {
        setTool(null);
      }
    }
    drag = null;
    if (el.frame.hasPointerCapture?.(event.pointerId)) {
      el.frame.releasePointerCapture(event.pointerId);
    }
    if (moved) render();
  }

  el.frame.addEventListener('pointerup', endDrag);
  el.frame.addEventListener('pointercancel', endDrag);

  /* ── Inline label editing ───────────────────────────── */

  el.labels.addEventListener('dblclick', (event) => {
    if(event.target.closest('.label-resize'))return;
    const node = event.target.closest('.ann-label');
    if (!node) return;
    const ann = byId(node.dataset.id);
    if (!ann) return;

    const text = node.querySelector('.text');
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
      const next = text.textContent.trim();
      ann.label = next || 'Untitled feature';
      render();
    };

    text.addEventListener('blur', commit, { once: true });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); text.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); text.textContent = ann.label; text.blur(); }
    });
  });

  /* ── Keyboard ───────────────────────────────────────── */

  document.addEventListener('keydown', (event) => {
    if(event.key==='Escape' && (state.tool || drag)) {
      if(drag?.mode==='draw')removeAnnotation(drag.id);
      drag=null;
      setTool(null);
      return;
    }
    const resizeControl=event.target.closest('.label-resize');
    if(resizeControl && /^Arrow/.test(event.key)) {
      const ann=byId(resizeControl.closest('.ann-label').dataset.id);
      if(!ann)return;
      event.preventDefault();
      state.selectedId=ann.id;
      resizeLabel(ann,ann.labelScale+(['ArrowUp','ArrowRight'].includes(event.key) ? .1 : -.1));
      render();
      el.labels.querySelector(`[data-id="${ann.id}"] .label-resize`)?.focus();
      return;
    }
    if (!state.selectedId) return;
    const editing = document.activeElement &&
      (document.activeElement.isContentEditable ||
       /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName));
    if (editing) return;

    const ann = byId(state.selectedId);
    if (!ann) return;


    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeAnnotation(ann.id);
      return;
    }

    const step = event.shiftKey ? 0.02 : 0.004;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!nudge) return;

    event.preventDefault();
    ann.lx = clamp01(ann.lx + nudge[0]);
    ann.ly = clamp01(ann.ly + nudge[1]);
    if (event.altKey || ann.kind === 'arrow') { ann.tx = clamp01(ann.tx + nudge[0]); ann.ty = clamp01(ann.ty + nudge[1]); ann.curve = []; }
    render();
  });

  /* ── Gemini call ────────────────────────────────────── */

  /* Two paths: proxy through server.js when it holds the key, otherwise call
     Google directly with the key from Settings. Both go through prompt.js so
     the request is identical either way. */
  async function analyze() {
    /* Logged before any guard: if a click produces no network request, this
       record says which precondition stopped it. */
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
    if(el.velocity.value&&!PROMPT.validVelocity(el.velocity.value)){toast('Enter a wave velocity above 0 and at most 0.3 m/ns.',true);el.velocity.focus();return;}
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
    // Emits a warning every 3s while the spinner is up, so "stuck analyzing"
    // shows exactly how long it has been stuck and on which path.
    const stopHeartbeat = T.heartbeat('analyze', { model, path: useServer ? 'proxy' : 'direct' });

    /* Never let a stalled request spin forever: abort on timeout or on Cancel. */
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

      toast(n===0?'No clear target reflections found. Add a marker manually or try a clearer scan.':`Added ${n} annotation${n === 1 ? '' : 's'}${
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

    // This path bypasses the server entirely, so it leaves no server-side trace.
    // Log it prominently or a stall here looks like the app doing nothing.
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

    return { list: PROMPT.parseResponse(payload, {velocityMPerNs:el.velocity.value}), modelUsed: model };
  }

  function applyResults(items) {
    state.annotations = state.annotations.filter(ann => ann.kind === 'arrow');
    state.selectedId = null;

    const taken = [];
    for (const item of items) {
      const p = item.point || {};
      const tx = clamp01((Number(p.x) || 0) / 1000);
      const ty = clamp01((Number(p.y) || 0) / 1000);
      const spot = placeLabel(tx, ty, taken);
      taken.push(spot);

      const conf = Number(item.confidence);
      addAnnotation({
        label: String(item.label || 'Feature').trim(),
        note: String(item.note || '').trim(),
        confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
        calibration:item.calibration||null,velocityMPerNs:item.velocityMPerNs,curve:item.curve||[],
        tx, ty,
        lx: spot.x, ly: spot.y,
      });
    }
    render();
  }

  let busyTimer = null;

  function setBusy(on, message = '') {
    state.busy = on;
    el.btnArrow.disabled=on || !state.image;
    el.btnAdd.disabled=on || !state.image;
    el.btnClear.disabled=on || !state.image;
    if(on)setTool(null);
    el.status.hidden = !on;
    el.btnAnalyze.disabled = on || !state.image;
    el.btnAnalyze.querySelector('span').textContent = on ? 'Analyzing…' : 'Analyze scan';
    el.btnAnalyze.setAttribute('aria-label',on?'Analyzing…':'Analyze scan');
    el.btnAnalyze.title=on?'Analyzing…':'Analyze scan';
    el.btnAnalyze.classList.toggle('working',on);
    el.stage.setAttribute('aria-busy',String(on));

    clearTimeout(busyTimer);
    if (!on) return;

    /* A silent spinner is indistinguishable from a hang. Congested models can
       take 25s+ per attempt, so show elapsed time and say what is happening. */
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

  function exportPng() {
    if (!state.image) return;

    const W = state.image.naturalW;
    const H = state.image.naturalH;
    const scale = W / Math.max(1, el.image.clientWidth);

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(el.image, 0, 0, W, H);

    for (const ann of state.annotations) {
      const fontPx = 11 * scale * ann.labelScale;
      const pad = fontPx * .55;
      const lineH = fontPx * 1.3;
      const labelNode=el.labels.querySelector(`[data-id="${ann.id}"]`);
      const maxW = Math.max(20, (labelNode?.offsetWidth || 215)*scale*ann.labelScale-pad*2);
      ctx.font = `600 ${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const lines = wrapText(ctx, ann.label, maxW);
      if(ann.calibration)lines.push(...wrapText(ctx,measurementSummary(ann),maxW));
      const confText = ann.confidence != null ? `confidence ${Math.round(ann.confidence * 100)}%` : null;

      let boxW = 0;
      for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
      if (confText) {
        ctx.font = `${Math.round(fontPx * 0.78)}px ui-monospace, Menlo, Consolas, monospace`;
        boxW = Math.max(boxW, ctx.measureText(confText).width);
      }
      boxW += pad * 2;
      const boxH = lines.length * lineH + (confText ? Math.round(lineH * 0.85) : 0) + pad * 2 - (lineH - fontPx);

      const cx = ann.lx * W;
      const cy = ann.ly * H;
      const box = { cx, cy, hw: boxW / 2 + 3, hh: boxH / 2 + 3 };
      const target = { x: ann.tx * W, y: ann.ty * H };

      if(ann.curve.length>1){ctx.save();ctx.strokeStyle=ann.color;ctx.lineWidth=Math.max(2,2*scale);ctx.setLineDash([5*scale,4*scale]);ctx.beginPath();ann.curve.forEach((p,i)=>i?ctx.lineTo(p.x*W/1000,p.y*H/1000):ctx.moveTo(p.x*W/1000,p.y*H/1000));ctx.stroke();ctx.restore();}
      // arrow
      const start = ann.kind === 'arrow' ? {x:ann.lx*W,y:ann.ly*H} : edgeOfBox(box, target);
      const dx = target.x - start.x;
      const dy = target.y - start.y;
      const len = Math.hypot(dx, dy);
      const lw = Math.max(2, 2 * scale);

      if (len > 12 * scale) {
        const ux = dx / len;
        const uy = dy / len;
        const head = 9 * scale;
        const inset=ann.kind==='arrow'?0:5*scale;
        const tip = { x: target.x - ux * inset, y: target.y - uy * inset };
        const base = { x: tip.x - ux * head, y: tip.y - uy * head };
        const wing = head * 0.52;

        ctx.strokeStyle = ann.color;
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(base.x, base.y);
        ctx.stroke();

        ctx.fillStyle = ann.color;
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(base.x - uy * wing, base.y + ux * wing);
        ctx.lineTo(base.x + uy * wing, base.y - ux * wing);
        ctx.closePath();
        ctx.fill();
      }

      if(ann.kind==='arrow')continue;

      // target marker
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1.5, 1.5 * scale);
      ctx.beginPath();
      ctx.arc(target.x, target.y, 9 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = ann.color;
      ctx.beginPath();
      ctx.arc(target.x, target.y, 3.5 * scale, 0, Math.PI * 2);
      ctx.fill();

      // label box
      const bx = cx - boxW / 2;
      const by = cy - boxH / 2;
      roundRect(ctx, bx, by, boxW, boxH, Math.round(6 * scale));
      ctx.fillStyle = '#f2f6fb';
      ctx.fill();
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = Math.max(1.5, 1.5 * scale);
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
      toast('Exported annotated PNG.');
    }, 'image/png');
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

  /* Populate the model datalist from the live ListModels call, so the names on
     offer are the ones this key can really use. */
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

  /* analyze() is async, so a synchronous throw inside it becomes a rejected
     promise that would otherwise vanish silently and leave the spinner up. */
  el.btnAnalyze.addEventListener('click', () => {
    analyze().catch((err) => {
      T.error('analyze.unhandled', { error: err?.message, stack: err?.stack?.split('\n').slice(0, 4).join(' | ') });
      toast(`Analysis crashed: ${err?.message || err}`, true);
      setBusy(false);
    });
  });
  el.btnExport.addEventListener('click', exportPng);
  el.btnArrow.addEventListener('click',()=>{if(state.image&&!state.busy)setTool(state.tool==='arrow'?null:'arrow');});

  el.btnAdd.addEventListener('click', () => {
    if (!state.image) return;
    const taken = state.annotations.map((a) => ({ x: a.lx, y: a.ly }));
    const tx = 0.5;
    const ty = 0.45 + (state.annotations.length % 4) * 0.08;
    const spot = placeLabel(tx, ty, taken);
    const ann = addAnnotation({ label: 'New annotation', tx, ty, lx: spot.x, ly: spot.y });
    state.selectedId = ann.id;
    render();
  });

  el.btnClear.addEventListener('click', () => {
    setTool(null);
    if (!state.annotations.length) return;
    state.annotations = [];
    state.selectedId = null;
    state.seq = 0;
    render();
  });

  el.image.addEventListener('load', render);
  document.querySelector('.canvas-toolbar label').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.fileInput.click();}});
  el.velocity.addEventListener('input',()=>{if(state.image)render();});
  window.addEventListener('resize', () => { if (state.image) render(); });

  loadSettings();
  renderList();
  probeServer();
})();

/* Drives the annotator with a deliberately small synthetic radargram (420×260)
   to prove the canvas is independent of image size: every tool is exercised and
   two annotations are parked in the margin, outside the image.

   Loaded by tests/workspace.html, which is a copy of index.html with this file
   appended. Results land in #test-report and in document.title. */

(() => {
  const log = [];
  const fail = [];
  const check = (name, cond, detail = '') => {
    (cond ? log : fail).push(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* A small radargram: banded background with three hyperbolas. */
  function makeScan() {
    const c = document.createElement('canvas');
    c.width = 420; c.height = 260;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 260);
    g.addColorStop(0, '#1b2430'); g.addColorStop(1, '#0a0f16');
    x.fillStyle = g; x.fillRect(0, 0, 420, 260);
    for (let i = 0; i < 260; i += 4) {
      x.fillStyle = `rgba(150,180,210,${0.03 + Math.random() * 0.05})`;
      x.fillRect(0, i, 420, 2);
    }
    for (const [ax, ay] of [[95, 92], [215, 132], [325, 76]]) {
      for (let k = 0; k < 3; k++) {
        x.strokeStyle = `rgba(215,235,255,${0.55 - k * 0.15})`;
        x.lineWidth = 2;
        x.beginPath();
        for (let dx = -70; dx <= 70; dx++) {
          const y = ay + k * 9 + Math.sqrt(dx * dx + 900) - 30;
          dx === -70 ? x.moveTo(ax + dx, y) : x.lineTo(ax + dx, y);
        }
        x.stroke();
      }
    }
    return c;
  }

  const pt = (target, type, clientX, clientY) => target.dispatchEvent(
    new PointerEvent(type, { pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX, clientY, bubbles: true, cancelable: true }),
  );

  /* A tool drag in canvas client coordinates. */
  async function dragOn(canvas, from, to, steps = 6) {
    const r = canvas.getBoundingClientRect();
    const X = (v) => r.left + v;
    const Y = (v) => r.top + v;
    pt(canvas, 'pointerdown', X(from.x), Y(from.y));
    for (let i = 1; i <= steps; i++) {
      pt(canvas, 'pointermove', X(from.x + ((to.x - from.x) * i) / steps), Y(from.y + ((to.y - from.y) * i) / steps));
    }
    pt(canvas, 'pointerup', X(to.x), Y(to.y));
    await wait(30);
  }

  async function run() {
    const canvas = makeScan();
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], 'synthetic-scan.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    $('file-input').files = dt.files;
    $('file-input').dispatchEvent(new Event('change', { bubbles: true }));

    for (let i = 0; i < 60 && $('stage').hidden; i++) await wait(50);
    await wait(120);

    const cv = $('canvas');
    const frame = $('frame');
    const cvRect = cv.getBoundingClientRect();
    const frRect = frame.getBoundingClientRect();

    check('canvas is larger than the image', cvRect.width > frRect.width + 60 && cvRect.height > frRect.height + 40,
      `canvas ${Math.round(cvRect.width)}×${Math.round(cvRect.height)} vs image ${Math.round(frRect.width)}×${Math.round(frRect.height)}`);
    check('small image is scaled up, not shown at 420px', frRect.width > 420,
      `displayed ${Math.round(frRect.width)}px from a 420px source`);

    const imgX = frRect.left - cvRect.left;
    const imgY = frRect.top - cvRect.top;
    const inside = (fx, fy) => ({ x: imgX + frRect.width * fx, y: imgY + frRect.height * fy });

    // ── every drawing tool ──
    $('tool-box').click();
    await dragOn(cv, inside(0.1, 0.18), inside(0.42, 0.55));

    $('tool-ruler').click();
    await dragOn(cv, inside(0.2, 0.75), inside(0.72, 0.75));

    $('tool-free').click();
    await dragOn(cv, inside(0.55, 0.25), inside(0.9, 0.45), 14);

    $('tool-arrow').click();
    await dragOn(cv, { x: 14, y: cvRect.height - 40 }, inside(0.35, 0.85));   // starts in the margin

    $('tool-note').click();
    const r0 = cv.getBoundingClientRect();
    pt(cv, 'pointerdown', r0.left + 60, r0.top + 26);
    pt(cv, 'pointerup', r0.left + 60, r0.top + 26);
    await wait(60);

    $('btn-add').click();
    await wait(60);

    const kinds = window.__gprState.annotations.map((a) => a.kind);
    check('all five tools produced an annotation',
      ['box', 'ruler', 'free', 'arrow', 'note', 'target'].every((k) => kinds.includes(k)), kinds.join(', '));

    // ── annotations outside the image ──
    const anns = window.__gprState.annotations;
    const note = anns.find((a) => a.kind === 'note');
    const arrow = anns.find((a) => a.kind === 'arrow');
    check('a note sits outside the image', note && (note.lx < 0 || note.ly < 0 || note.lx > 1 || note.ly > 1),
      note ? `note at x=${note.lx.toFixed(2)} y=${note.ly.toFixed(2)}` : 'no note');
    check('an arrow tail sits outside the image', arrow && (arrow.a.x < 0 || arrow.a.y > 1 || arrow.a.x > 1 || arrow.a.y < 0),
      arrow ? `tail at x=${arrow.a.x.toFixed(2)} y=${arrow.a.y.toFixed(2)}` : 'no arrow');

    // ── editing ──
    const target = anns.find((a) => a.kind === 'target');
    document.querySelector(`.ann-card[data-id="${target.id}"]`).click();
    await wait(30);
    check('editor opens for the selection', !$('ann-editor').hidden);

    $('edit-label').value = 'Suspected 110 mm duct';
    $('edit-label').dispatchEvent(new Event('input', { bubbles: true }));
    $('edit-label').dispatchEvent(new Event('change', { bubbles: true }));
    $('edit-note').value = 'Checked against the as-built drawing.';
    $('edit-note').dispatchEvent(new Event('input', { bubbles: true }));
    $('edit-note').dispatchEvent(new Event('change', { bubbles: true }));
    $('edit-conf').value = '72';
    $('edit-conf').dispatchEvent(new Event('input', { bubbles: true }));
    $('edit-conf').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.swatch-btn[data-color="#ff6b6b"]').click();
    await wait(40);

    const edited = window.__gprState.annotations.find((a) => a.id === target.id);
    check('label edit applied', edited.label === 'Suspected 110 mm duct', edited.label);
    check('note edit applied', /as-built/.test(edited.note || ''));
    check('confidence edit applied', Math.round(edited.confidence * 100) === 72, String(edited.confidence));
    check('colour edit applied', edited.color === '#ff6b6b', edited.color);

    // ── line weight ──
    $('edit-weight').value = '2.8';
    $('edit-weight').dispatchEvent(new Event('input', { bubbles: true }));
    $('edit-weight').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(40);
    const weighted = window.__gprState.annotations.find((a) => a.id === target.id);
    check('line weight stored', Math.abs(weighted.weight - 2.8) < 0.01, String(weighted.weight));
    const leaderLine = document.querySelector(`g.ann[data-id="${target.id}"] .arrow-line`);
    check('line weight reaches the SVG stroke',
      leaderLine && Math.abs(parseFloat(leaderLine.style.strokeWidth) - 5.6) < 0.1,
      leaderLine ? leaderLine.style.strokeWidth : 'no leader line');

    const boxAnn = window.__gprState.annotations.find((a) => a.kind === 'box');
    document.querySelector(`.ann-card[data-id="${boxAnn.id}"]`).click();
    await wait(30);
    $('edit-weight').value = '3.6';
    $('edit-weight').dispatchEvent(new Event('input', { bubbles: true }));
    $('edit-weight').dispatchEvent(new Event('change', { bubbles: true }));
    await wait(40);
    const rect = document.querySelector(`g.ann[data-id="${boxAnn.id}"] .region-box`);
    check('box thickness follows the weight',
      rect && Math.abs(parseFloat(rect.style.strokeWidth) - 7.2) < 0.1, rect ? rect.style.strokeWidth : 'no box');
    document.querySelector(`.ann-card[data-id="${target.id}"]`).click();
    await wait(30);

    // ── undo / redo ──
    const beforeUndo = window.__gprState.annotations.length;
    $('btn-undo').click(); await wait(20);     // undo the box weight
    $('btn-undo').click(); await wait(20);     // undo the target weight
    $('btn-undo').click(); await wait(20);     // undo the colour change
    const afterColourUndo = window.__gprState.annotations.find((a) => a.id === target.id);
    check('undo reverts the colour', afterColourUndo && afterColourUndo.color !== '#ff6b6b', afterColourUndo?.color);
    $('btn-redo').click(); await wait(20);
    check('redo restores the colour',
      window.__gprState.annotations.find((a) => a.id === target.id)?.color === '#ff6b6b');
    check('undo/redo did not change the count', window.__gprState.annotations.length === beforeUndo);

    // ── duplicate ──
    $('btn-duplicate').click(); await wait(40);
    check('duplicate adds a copy', window.__gprState.annotations.length === beforeUndo + 1);
    $('btn-undo').click(); await wait(30);
    check('undo removes the duplicate', window.__gprState.annotations.length === beforeUndo);

    // ── margin arrangement ──
    $('btn-arrange').click(); await wait(60);
    const leaders = window.__gprState.annotations.filter((a) => a.kind === 'target' || a.kind === 'free');
    check('arrange moves every label off the image',
      leaders.length > 0 && leaders.every((a) => a.lx < 0 || a.lx > 1),
      leaders.map((a) => a.lx.toFixed(2)).join(', '));

    // ── zoom ──
    const w0 = frame.getBoundingClientRect().width;
    $('zoom-in').click(); await wait(40);
    const w1 = frame.getBoundingClientRect().width;
    check('zoom in enlarges the image', w1 > w0 + 2, `${Math.round(w0)} → ${Math.round(w1)}`);
    $('zoom-fit').click(); await wait(40);
    check('fit restores the fitted size', Math.abs(frame.getBoundingClientRect().width - w0) < 1.5);

    // ── export covers the margin ──
    const exported = await new Promise((resolve) => {
      const realCreate = URL.createObjectURL;
      URL.createObjectURL = (blobOut) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = realCreate(blobOut);
        URL.createObjectURL = realCreate;
        return img.src;
      };
      $('btn-export').click();
      setTimeout(() => resolve(null), 4000);
    });
    check('export is wider than the source image (margin included)',
      exported && exported.w > 420, exported ? `${exported.w}×${exported.h} from a 420×260 source` : 'no export');

    const report = document.createElement('pre');
    report.id = 'test-report';
    report.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;max-height:38vh;overflow:auto;z-index:99;background:#0d1410;color:#cfe6c8;padding:12px;border-radius:10px;font:11px/1.6 Consolas,monospace;white-space:pre-wrap';
    report.textContent = [...fail, ...log].join('\n');
    document.body.appendChild(report);
    document.title = fail.length ? `FAILED ${fail.length}/${fail.length + log.length}` : `ALL ${log.length} CHECKS PASSED`;
  }

  window.addEventListener('load', () => { run().catch((e) => { document.title = `CRASH ${e.message}`; const p = document.createElement('pre'); p.id = 'test-report'; p.textContent = `CRASH ${e.message}\n${e.stack}`; document.body.appendChild(p); }); });
})();

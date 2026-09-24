/* Browser regression check. Open http://localhost:8787/gpr-annotator/ first,
   then run this with agent-browser eval --stdin. All analysis responses are
   stubbed locally, so this does not send the fixture to Gemini. */
(async () => {
  const $ = id => document.getElementById(id);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const overlayVisible = () => getComputedStyle($('stage-status')).display !== 'none';
  const originalFetch = window.fetch;
  let reply, rejectRequest, signal, requestCount = 0;
  window.fetch = (url, options) => {
    if (!String(url).endsWith('/api/annotate')) return originalFetch(url, options);
    requestCount++;
    signal = options.signal;
    return new Promise((resolve, reject) => {
      reply = resolve;
      rejectRequest = reject;
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  try {
    assert(!overlayVisible(), 'Analyzing overlay is visible before a request');
    const canvas = document.createElement('canvas');
    canvas.width = 200; canvas.height = 120;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 200, 120);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const files = new DataTransfer();
    files.items.add(new File([blob], 'ui-test-fixture.png', { type: 'image/png' }));
    const imageLoaded = new Promise(resolve => $('gpr-image').addEventListener('load', resolve, { once: true }));
    $('file-input').files = files.files;
    $('file-input').dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.race([imageLoaded, new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture image did not load')),3000))]);
    await waitFor(() => !$('stage').hidden && !$('btn-analyze').disabled, 'Image did not load');
    assert(!overlayVisible(), 'Image loading incorrectly shows Analyzing');
    assert(requestCount === 0, 'Loading the image unexpectedly started analysis');

    $('btn-analyze').click();
    await waitFor(() => requestCount === 1, 'Analysis did not reach the proxy');
    assert(overlayVisible(), 'Pending request has no loading overlay');
    reply(new Response(JSON.stringify({ annotations: [{ label: 'Test feature', point: { x: 500, y: 400 }, confidence: .9, note: 'UI test' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => !$('btn-analyze').disabled, 'Success did not reset busy state');
    assert(!overlayVisible(), 'Overlay remains after success');
    assert(document.querySelectorAll('.ann-card').length === 1, 'Result annotation was not rendered');

    $('btn-analyze').click();
    await waitFor(() => requestCount === 2, 'Second request did not start');
    reply(new Response(JSON.stringify({ error: 'Simulated provider failure' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    await waitFor(() => !$('btn-analyze').disabled, 'Failure did not reset busy state');
    assert(!overlayVisible(), 'Overlay remains after failure');
    assert($('toast').textContent.includes('Simulated provider failure'), 'Failure feedback missing');

    $('btn-analyze').click();
    await waitFor(() => requestCount === 3, 'Cancellation request did not start');
    $('btn-cancel').click();
    await waitFor(() => !$('btn-analyze').disabled, 'Cancel did not reset busy state');
    assert(signal.aborted && !overlayVisible(), 'Cancel did not dismiss the overlay');
    assert($('toast').textContent.includes('cancelled'), 'Cancellation feedback missing');
    return 'Passed: image load stays idle; pending analysis shows the overlay; success, error and cancel hide it; annotations remain usable.';
  } finally {
    if (rejectRequest) rejectRequest(new DOMException('Test cleanup', 'AbortError'));
    window.fetch = originalFetch;
  }
})()

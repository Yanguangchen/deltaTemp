/* Shared between the browser (window.GPR_PROMPT) and the Node proxy (require).
   Keeping the prompt + schema in one place means direct-from-browser calls and
   server-proxied calls ask Gemini for exactly the same thing. */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GPR_PROMPT = api;
}(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SYSTEM_PROMPT = `You interpret ground penetrating radar B-scans for a survey operator. Locate coherent target reflections and explain their morphology. Prioritize identifiable hyperbolas, not generic patches of distortion.

INTERPRETATION
- Trace each continuous inverted-U reflection through its shallowest apex and both descending limbs. Pick the apex on the first coherent target reflection, not a bright patch on its flank, the center of a noisy zone, a caption, or an axis.
- One annotation per distinct target. Adjacent alternating dark/light bands and repeated deeper ringing can belong to one response; do not label each band as another pipe. Separate crossing hyperbolas only when distinct apexes/limbs can be followed.
- Label a coherent isolated hyperbola as "Hyperbola — possible utility" or "Hyperbola — discrete target". Regularly spaced shallow hyperbolas in concrete may be "Hyperbola — probable rebar". Use probable pipe/conduit only when context and geometry support it. A single crossing cannot establish a pipe's route, diameter, material, or lateral offset outside the scan line.
- Strong relative amplitude, coherent phase bands, ringing or a shadow may support "possible metallic target" in the note; amplitude alone does not establish metal. Hyperbola width/curvature depends on propagation velocity, depth, antenna footprint, crossing angle and display scaling. Wider/taller does NOT automatically mean more metallic or larger. The hyperbola is a travel-time response, not the physical pipe outline. Consider rocks, roots and overlapping targets as alternatives when appropriate.
- Compare amplitudes within similar depths; account for gain, attenuation and saturation. Do not claim polarity-based material identification when palette/phase information is unknown.
- Only label a layer boundary or attenuation zone if it is a distinct useful feature or specifically requested. Omit routine surface coupling and background clutter when they would distract from targets.

AXIS CALIBRATION
- Read the visible axes before locating targets. All point and tick positions use a 0–1000 grid over the ENTIRE supplied image, including margins. x increases rightward; y downward.
- calibration.horizontal describes two widely separated, clearly readable horizontal distance ticks. firstPosition/secondPosition are their x coordinates; firstValue/secondValue are their printed values. Recognize metres, feet and inches; do not mistake trace counts for distance.
- calibration.vertical similarly uses two readable y-axis ticks. Prefer a readable depth axis (m, ft or in) over a time axis, even if it is on the right. If only time is readable, use ns and the two-way travel-time values.
- Use unit "unknown" and zero tick values/positions when an axis scale is missing, nonlinear, ambiguous or unreadable. Never assume plot edges equal zero/full range or infer real units from pixel width.
- velocityMPerNs: use ONLY a velocity explicitly printed in the image, e.g. v=0.1 m/ns; otherwise 0. Never guess a typical soil velocity or fit a velocity from the visual curve. The app applies a separate operator-supplied velocity when available. For a time axis set timeZeroKnown=true only if a corrected surface/time-zero reference is explicitly shown; otherwise false. timeZeroNs is that reference.
- The application calculates along-scan position by tick interpolation and depth from a depth axis or z=v*(two-way-time minus time-zero)/2. Do not put invented distances or depths into prose. These are image-based estimates, not survey-grade picks.

OUTPUT
- Return up to 10 supported targets, most useful first; there is NO minimum. Return an empty annotations array if no interpretable targets exist.
- point: the apex coordinates, integers 0–1000.
- curve: 5–9 visible points following the same hyperbolic reflection from left limb through the apex to right limb, ordered by x. Do not invent hidden limbs; use an empty array for non-hyperbolic or untraceable features.
- label: at most 7 words; name the reflection and tentative interpretation.
- note: 1–2 concise sentences describing observed curvature, continuity, amplitude relative to background, and the main alternative or uncertainty in target/material interpretation.
- confidence: 0–1 confidence in the stated interpretation, not a measurement accuracy or calibrated probability. Lower it for merged/cropped/ambiguous responses. Return JSON matching the schema.`;

  const axisSchema = units => ({
    type: 'OBJECT',
    properties: {
      unit: { type: 'STRING', enum: units },
      firstPosition: { type: 'NUMBER' }, secondPosition: { type: 'NUMBER' },
      firstValue: { type: 'NUMBER' }, secondValue: { type: 'NUMBER' },
    }, required: ['unit', 'firstPosition', 'secondPosition', 'firstValue', 'secondValue'],
  });
  const pointSchema = { type: 'OBJECT', properties: { x: { type: 'INTEGER' }, y: { type: 'INTEGER' } }, required: ['x', 'y'] };

  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      calibration: {
        type: 'OBJECT', properties: {
          horizontal: axisSchema(['m', 'ft', 'in', 'unknown']),
          vertical: axisSchema(['m', 'ft', 'in', 'ns', 'unknown']),
          velocityMPerNs: { type: 'NUMBER' },
          timeZeroKnown: { type: 'BOOLEAN' }, timeZeroNs: { type: 'NUMBER' },
        }, required: ['horizontal', 'vertical', 'velocityMPerNs', 'timeZeroKnown', 'timeZeroNs'],
      },
      annotations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            label: { type: 'STRING' },
            note: { type: 'STRING' },
            confidence: { type: 'NUMBER' },
            curve: { type: 'ARRAY', items: pointSchema },
            point: {
              type: 'OBJECT',
              properties: { y: { type: 'INTEGER' }, x: { type: 'INTEGER' } },
              required: ['y', 'x'],
            },
          },
          required: ['label', 'note', 'confidence', 'point', 'curve'],
        },
      },
    },
    required: ['calibration', 'annotations'],
  };

  /* Build the generateContent request body. */
  function buildRequest({ mimeType, base64, focus }) {
    const userText = focus && focus.trim()
      ? `Locate and trace the target hyperbolas, mark their apexes, and read axis calibration for position/depth estimates. Operator context: ${focus.trim()}`
      : 'Locate and trace the target hyperbolas, mark their apexes, and read axis calibration for position/depth estimates.';

    return {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType || 'image/png', data: base64 } },
          { text: userText },
        ],
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    };
  }

  /* Pull the annotation array out of a generateContent response, or throw. */
  function parseResponse(payload, options = {}) {
    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('')
      .trim();

    if (!text) {
      const reason = payload?.candidates?.[0]?.finishReason || payload?.promptFeedback?.blockReason;
      throw new Error(reason ? `Model returned no content (${reason}).` : 'Model returned no content.');
    }

    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const parsed = JSON.parse(fence ? fence[1].trim() : text);
    const items = Array.isArray(parsed) ? parsed : parsed.annotations;
    if (!Array.isArray(items)) throw new Error('The model returned an invalid annotation list.');
    return items.slice(0, 10).map(item => ({
      ...item,
      calibration: parsed.calibration || null,
      velocityMPerNs: validVelocity(options.velocityMPerNs) ? Number(options.velocityMPerNs) : null,
      curve: Array.isArray(item.curve) ? item.curve.filter(p=>validPosition(p.x)&&validPosition(p.y)).slice(0, 12) : [],
    }));
  }

  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const validPosition = n => finite(n) && n >= 0 && n <= 1000;
  const validVelocity = n => n !== null && n !== '' && Number.isFinite(Number(n)) && Number(n) > 0 && Number(n) <= 0.3;
  function axisValue(axis, position) {
    if (!axis || !validPosition(position) || !validPosition(axis.firstPosition) || !validPosition(axis.secondPosition) || !finite(axis.firstValue) || !finite(axis.secondValue)) return null;
    const span = axis.secondPosition-axis.firstPosition;
    if (Math.abs(span)<20 || axis.firstValue===axis.secondValue) return null;
    const fraction=(position-axis.firstPosition)/span;
    // Only interpolate between readable ticks; no off-chart extrapolation.
    if(fraction<0 || fraction>1)return null;
    return axis.firstValue+fraction*(axis.secondValue-axis.firstValue);
  }
  function measurePoint(calibration, point, operatorVelocity) {
    const factors={m:1,ft:0.3048,in:0.0254};
    const c=calibration||{}, horizontal=axisValue(c.horizontal,point.x), vertical=axisValue(c.vertical,point.y);
    const alongM=horizontal!==null&&factors[c.horizontal?.unit]?horizontal*factors[c.horizontal.unit]:null;
    let depthM=null, basis='Depth scale unavailable', timeNs=null;
    if(vertical!==null&&factors[c.vertical?.unit]&&vertical>=0){depthM=vertical*factors[c.vertical.unit];basis=`Read from ${c.vertical.unit} depth axis`;}
    else if(vertical!==null&&c.vertical?.unit==='ns'){
      timeNs=vertical;
      const velocity=validVelocity(operatorVelocity)?Number(operatorVelocity):validVelocity(c.velocityMPerNs)?Number(c.velocityMPerNs):null;
      if(velocity&&c.timeZeroKnown===true&&finite(c.timeZeroNs)&&vertical>=c.timeZeroNs){depthM=velocity*(vertical-c.timeZeroNs)/2;basis=`Time × ${velocity} m/ns ÷ 2; time zero ${c.timeZeroNs} ns`;}
      else basis=velocity?'Time-zero reference unavailable':'Velocity needed for depth';
    }
    return {alongM,depthM,timeNs,basis};
  }

  const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
  /* Last-resort default when nothing is set in .env or the Settings dialog.
     Override with GEMINI_MODEL; use Settings → "List models my key can call"
     if this id is rejected for your account. */
  const DEFAULT_MODEL = 'gemini-3.7-flash';

  return { SYSTEM_PROMPT, RESPONSE_SCHEMA, buildRequest, parseResponse, measurePoint, validVelocity, ENDPOINT, DEFAULT_MODEL };
}));

/* Open /gpr-annotator/ and upload a local image before running with
   agent-browser eval --stdin. Responses below are fixtures, not AI findings. */
(async () => {
  const $=id=>document.getElementById(id);
  const assert=(ok,message)=>{if(!ok)throw new Error(message);};
  const waitFor=async predicate=>{const until=Date.now()+3000;while(!predicate()){if(Date.now()>until)throw new Error('UI did not settle');await new Promise(r=>setTimeout(r,20));}};
  assert(!$('stage').hidden,'Upload an image first');
  assert(!document.querySelector('.workspace-intro'),'Verbose intro still present');
  const calibration={horizontal:{unit:'m',firstPosition:100,secondPosition:900,firstValue:0,secondValue:100},vertical:{unit:'m',firstPosition:100,secondPosition:900,firstValue:0,secondValue:30},velocityMPerNs:0,timeZeroKnown:false,timeZeroNs:0};
  const annotations=[{label:'Hyperbola · test fixture',note:'Controlled UI fixture, not an interpretation of this image.',confidence:.8,point:{x:440,y:500},curve:[{x:340,y:680},{x:390,y:545},{x:440,y:500},{x:490,y:545},{x:540,y:680}],calibration}];
  const original=window.fetch;
  try {
    window.fetch=(url,options)=>String(url).endsWith('/api/annotate')?Promise.resolve(new Response(JSON.stringify({annotations}),{status:200,headers:{'Content-Type':'application/json'}})):original(url,options);
    $('btn-analyze').click();
    await waitFor(()=>!$('btn-analyze').disabled);
    assert(document.querySelectorAll('.hyperbola-trace').length===1,'Missing hyperbola trace');
    assert(document.querySelector('.measurement-grid').textContent.includes('42.5 m'),'Wrong along-scan estimate');
    assert(document.querySelector('.measurement-grid').textContent.includes('15 m'),'Wrong depth estimate');
    const label=document.querySelector('.ann-label');
    const before=label.getBoundingClientRect().width;
    label.querySelector('.label-resize').focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    assert(document.querySelector('.ann-label').getBoundingClientRect().width>before,'Keyboard resizing did not enlarge label');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    assert(Math.abs(document.querySelector('.ann-label').getBoundingClientRect().width-before)<1,'Keyboard shrinking failed');
    $('btn-arrow').click();
    assert($('btn-arrow').getAttribute('aria-pressed')==='true','Arrow tool did not activate');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    assert($('btn-arrow').getAttribute('aria-pressed')==='false','Escape did not leave arrow tool');
    assert(!$('stage-status').hidden===false,'Busy overlay did not clear');
    return {passed:'Axis estimates, traced curve, keyboard resize, arrow tool cancellation, intro removal.',frame:$('gpr-image').getBoundingClientRect().toJSON(),handle:document.querySelector('.label-resize').getBoundingClientRect().toJSON(),label:document.querySelector('.ann-label').getBoundingClientRect().toJSON()};
  } finally {window.fetch=original;}
})()

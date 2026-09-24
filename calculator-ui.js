'use strict';
const C=window.TemperatureCalculator;
let temperatureSource=null,temperaturePairs=[],temperatureResult=null,resultPage=1,pasteTimer,importedTemperatures=false;
let pasteOptions={layout:'auto'};
function calcStatus(message,error=false){$('calc-status').textContent=message;$('calc-status').classList.toggle('error',error);$('results-empty').hidden=!$('calculation').hidden;}
function loadTemperatures(matrix,label){
  try{
    temperatureSource=C.parseMatrix(matrix,importedTemperatures?{}:pasteOptions);
    const inferred=temperatureSource.inferred;
    $('inferred-layout').hidden=!inferred;
    if(inferred){
      $('paste-ambient').checked=inferred.ambient;
      const names={temperatures:'Temperatures only',date:'Date & Time + temperatures',hours:'Hours + temperatures','date-hours':'Date & Time + Hours + temperatures'};
      $('inferred-summary').textContent=`Detected: ${inferred.count} sensors${inferred.layout==='temperatures'?'':' · '+names[inferred.layout].replace(' + temperatures','')}${inferred.ambient?' · Last sensor is ambient':''}`;
      $('inferred-note').textContent=`No headers found. ${names[inferred.layout]}; temperatures are assigned Temp-1 to Temp-${inferred.count} from left to right.${inferred.ambient?' The last column is treated as ambient.':''} Adjust below if needed.`;
    }
    const preset=$('pair-preset').value;
    if(preset!=='custom')temperaturePairs=C.makePairs(temperatureSource.sensors,preset);
    else temperaturePairs=temperaturePairs.filter(p=>temperatureSource.sensors.some(s=>s.id===p.a)&&temperatureSource.sensors.some(s=>s.id===p.b));
    $('calculation').hidden=false;resultPage=1;renderPairs();recalculate();calcStatus(`${temperatureSource.rows.length.toLocaleString()} readings · ${temperatureSource.sensors.length} sensors${/sample/i.test(label)?' · Example data':''}${temperatureSource.summaryCount?' · '+temperatureSource.summaryCount+' summary row(s) skipped':''}`);
  }catch(error){temperatureSource=null;temperatureResult=null;$('calculation').hidden=true;calcStatus(error.message,true);}
}
function renderPairs(){
  $('pairs').replaceChildren();
  temperaturePairs.forEach((pair,i)=>{
    const wrap=document.createElement('div');wrap.className='pair';
    const label=document.createElement('span');label.className='pair-number';label.textContent=String(i+1).padStart(2,'0');wrap.append(label);
    ['a','b'].forEach((side,si)=>{if(si){const minus=document.createElement('span');minus.textContent='−';wrap.append(minus);}const select=document.createElement('select');select.setAttribute('aria-label',`Pair ${i+1} ${side==='a'?'first':'second'} temperature`);temperatureSource.sensors.forEach(s=>select.append(option(s.id,s.label)));select.value=pair[side];select.addEventListener('change',()=>{pair[side]=+select.value;$('pair-preset').value='custom';resultPage=1;recalculate();});wrap.append(select);});
    const remove=document.createElement('button');remove.textContent='×';remove.className='remove-pair';remove.setAttribute('aria-label',`Remove pair ${i+1}`);remove.addEventListener('click',()=>{temperaturePairs.splice(i,1);$('pair-preset').value='custom';renderPairs();recalculate();});wrap.append(remove);$('pairs').append(wrap);
  });
}
function recalculate(){
  if(!temperatureSource)return;
  const missingDate=temperatureSource.dateIndex<0,missingHours=temperatureSource.hoursIndex<0;
  $('reading-timing').hidden=!missingDate&&!missingHours;
  $('start-time-field').hidden=!missingDate;
  $('interval-field').hidden=!missingDate&&!missingHours;
  $('first-hour-field').hidden=!missingHours;
  $('timing-note').textContent=[missingDate?'Enter a starting time to fill the date column, or leave it blank.':'Dates are taken from your readings.',missingHours?'Hours counts half-hour intervals: 1, 2, 3… with the default 30-minute interval.':'Hours is taken from your readings.'].join(' ');
  try{
    temperatureResult=C.calculate(temperatureSource,temperaturePairs,$('difference-mode').value,{start:$('reading-start').value,interval:$('reading-interval').value,firstHour:$('reading-first-hour').value===''?NaN:$('reading-first-hour').value});
    $('timing-error').textContent='';
  }catch(error){
    temperatureResult=null;$('timing-error').textContent=error.message;$('copy-results').disabled=$('download-results').disabled=true;$('result-table').tHead.replaceChildren();$('result-table').tBodies[0].replaceChildren();$('result-info').textContent='Correct the reading time settings to show results.';$('copy-fallback').hidden=true;return;
  }
  $('copy-fallback').hidden=true;$('result-status').textContent='';
  $('calc-count').textContent=`${temperatureResult.rows.length.toLocaleString()} readings`;
  $('pair-summary').textContent=temperaturePairs.length?temperaturePairs.map(p=>$('difference-mode').value==='absolute'?`|T${p.a}−T${p.b}|`:`T${p.a}−T${p.b}`).join(' · '):'Choose at least one pair';
  if(!temperaturePairs.length)$('pair-options').open=true;
  $('copy-results').disabled=$('download-results').disabled=!temperaturePairs.length;
  $('result-note').textContent=!temperaturePairs.length?'Choose sensor pairs above to calculate differences.':temperatureResult.missing?`${temperatureResult.missing} blank results: missing or invalid temperatures in rows ${temperatureResult.invalidRows.slice(0,10).join(', ')}${temperatureResult.invalidRows.length>10?', …':''}.`:'All rows included in copy & download · 2 decimal places';
  renderResults();
}
function renderResults(){
  const result=temperatureResult;if(!result)return;
  const pages=Math.max(1,Math.ceil(result.rows.length/50));resultPage=Math.min(resultPage,pages);
  const tr=document.createElement('tr');result.headers.forEach(h=>{const th=document.createElement('th');th.scope='col';th.textContent=h;tr.append(th);});$('result-table').tHead.replaceChildren(tr);
  const frag=document.createDocumentFragment();result.rows.slice((resultPage-1)*50,resultPage*50).forEach(row=>{const tr=document.createElement('tr');row.forEach((v,i)=>{const td=document.createElement('td');td.textContent=v===null?'—':i>=result.metadataCount&&typeof v==='number'?v.toFixed(2):String(v);if(i>=result.metadataCount)td.className='numeric';if(v===null){td.classList.add('missing');td.title='Missing or nonnumeric input';}tr.append(td);});frag.append(tr);});$('result-table').tBodies[0].replaceChildren(frag);
  $('result-info').textContent=`${(resultPage-1)*50+1}–${Math.min(resultPage*50,result.rows.length)} of ${result.rows.length.toLocaleString()} readings`;
  $('result-page').textContent=`${resultPage} / ${pages}`;$('result-prev').disabled=resultPage===1;$('result-next').disabled=resultPage===pages;
}
$('paste-input').addEventListener('input',()=>{importedTemperatures=false;pasteOptions={layout:'auto'};$('paste-layout').value='auto';$('inferred-layout').hidden=true;clearTimeout(pasteTimer);$('calculation').hidden=true;pasteTimer=setTimeout(()=>{if(!$('paste-input').value.trim()){temperatureSource=null;temperatureResult=null;calcStatus('');return;}try{loadTemperatures(C.readTSV($('paste-input').value),'Pasted from clipboard');}catch(error){calcStatus(error.message,true);}},180);});
$('paste-clear').addEventListener('click',()=>{clearTimeout(pasteTimer);$('paste-input').value='';temperatureSource=null;temperatureResult=null;$('calculation').hidden=true;$('result-table').tHead.replaceChildren();$('result-table').tBodies[0].replaceChildren();$('copy-text').value='';$('copy-fallback').hidden=true;calcStatus('');$('paste-input').focus();});
$('sample').addEventListener('click',()=>{$('paste-input').value='Date & Time\tHours(1/2 Hrs)\tTemp-1\tTemp-2\tTemp-3\tTemp-4\tTemp-5\tTemp-6\tTemp-7\tTemp-8\tTemp-9\tTemp-10 (Ambient)\n01/09/2026 10:00\t1\t35.26\t36.01\t35.91\t34.79\t35.72\t36.10\t36.48\t37.33\t38.28\t35.35\n01/09/2026 10:30\t2\t36.40\t38.10\t36.80\t36.20\t38.50\t37.10\t38.20\t40.10\t38.90\t34.80\n01/09/2026 11:00\t3\t38.60\t41.20\t39.10\t38.40\t41.70\t39.80\t40.20\t43.10\t41.40\t34.20';loadTemperatures(C.readTSV($('paste-input').value),'Illustrative sample data');});
$('pair-preset').addEventListener('change',()=>{if(!temperatureSource)return;if($('pair-preset').value!=='custom')temperaturePairs=C.makePairs(temperatureSource.sensors,$('pair-preset').value);resultPage=1;renderPairs();recalculate();});
$('difference-mode').addEventListener('change',recalculate);
$('add-pair').addEventListener('click',()=>{temperaturePairs.push({a:temperatureSource.sensors[1].id,b:temperatureSource.sensors[0].id});$('pair-preset').value='custom';renderPairs();recalculate();});
$('result-prev').addEventListener('click',()=>{resultPage--;renderResults();});$('result-next').addEventListener('click',()=>{resultPage++;renderResults();});
$('copy-results').addEventListener('click',async()=>{
  const copiedResult=temperatureResult;
  const text=C.toTSV(copiedResult);
  $('copy-fallback').hidden=false;$('copy-text').value=text;$('copy-text').focus({preventScroll:true});$('copy-text').select();$('result-status').textContent='The full table is selected below. Press Ctrl+C if your browser asks for clipboard permission.';
  try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(text);if(temperatureResult!==copiedResult)return;$('copy-fallback').hidden=true;$('result-status').textContent=`Copied ${copiedResult.rows.length} rows. Paste into Excel with Ctrl+V.`;}
  catch{if(temperatureResult!==copiedResult)return;$('copy-fallback').hidden=false;$('copy-text').value=text;$('copy-text').focus();$('copy-text').select();$('result-status').textContent='Press Ctrl+C to copy the selected table below.';}
});
$('download-results').addEventListener('click',()=>{
  try{const r=temperatureResult,sheet=XLSX.utils.aoa_to_sheet([r.headers,...r.rows]);r.rows.forEach((row,ri)=>row.forEach((v,ci)=>{const cell=sheet[XLSX.utils.encode_cell({r:ri+1,c:ci})];if(cell&&ci>=r.metadataCount)cell.z='0.00';}));sheet['!cols']=r.headers.map((_,i)=>({wch:i===0&&r.metadataCount?24:17}));const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,sheet,'Differential temperature');XLSX.writeFile(book,'Differential temperature.xlsx');$('result-status').textContent=`Downloaded ${r.rows.length} calculated rows.`;}catch(error){$('result-status').textContent=`Download failed: ${error.message}`;}
});
window.addEventListener('temperature-import',event=>{clearTimeout(pasteTimer);importedTemperatures=true;const matrix=event.detail.matrix;$('paste-input').value=C.toTSV({headers:matrix[0],rows:matrix.slice(1),metadataCount:21});loadTemperatures(matrix,event.detail.label);});
$('clear').addEventListener('click',()=>{if(importedTemperatures){$('paste-clear').click();importedTemperatures=false;}});
$('sample').addEventListener('click',()=>{importedTemperatures=false;});
$('paste-clear').addEventListener('click',()=>{$('inferred-layout').hidden=true;$('inferred-layout').open=false;$('pair-options').open=false;pasteOptions={layout:'auto'};$('paste-layout').value='auto';});
function updatePasteLayout(){
  clearTimeout(pasteTimer);pasteOptions={layout:$('paste-layout').value,ambient:$('paste-ambient').checked};
  try{loadTemperatures(C.readTSV($('paste-input').value),'Pasted from clipboard');}catch(error){calcStatus(error.message,true);}
}
$('paste-layout').addEventListener('change',updatePasteLayout);
$('paste-ambient').addEventListener('change',updatePasteLayout);
function resetReadingTiming(){$('reading-start').value='';$('reading-interval').value='30';$('reading-first-hour').value='1';$('timing-error').textContent='';}
['reading-start','reading-interval','reading-first-hour'].forEach(id=>$(id).addEventListener('input',recalculate));
$('paste-input').addEventListener('input',resetReadingTiming);
$('paste-clear').addEventListener('click',resetReadingTiming);

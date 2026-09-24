(function(root){
  'use strict';
  // Excel's plain-text clipboard format is tab-separated, with quoted multiline cells.
  function readTSV(text){
    const rows=[];let row=[],cell='',quoted=false;
    text=String(text).replace(/^\uFEFF/,'').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
    for(let i=0;i<text.length;i++){
      const ch=text[i];
      if(ch==='"'&&(quoted||cell==='')){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(!quoted&&(ch==='\t'||ch==='\n')){row.push(cell);cell='';if(ch==='\n'){rows.push(row);row=[];}}
      else cell+=ch;
    }
    if(quoted)throw new Error('A quoted cell is incomplete. Copy the full table from Excel again.');
    row.push(cell);rows.push(row);
    return rows.map(r=>r.slice(0,21)).filter(r=>r.some(c=>String(c).trim()!==''));
  }
  const sensorId=value=>{const m=String(value).trim().match(/^temp(?:erature)?\s*[-_ ]?\s*(\d+)\b/i);return m?Number(m[1]):null;};
  const summaryLabel=value=>/^(?:max(?:imum)?|min(?:imum)?|average|mean|total)\b/i.test(String(value??'').trim());
  function inferHeaders(matrix,options){
    const data=matrix.filter(row=>!row.some(summaryLabel)&&row.some(v=>String(v??'').trim()!==''));
    const width=data.reduce((max,row)=>Math.max(max,row.reduce((last,v,i)=>String(v??'').trim()!==''?i+1:last,0)),0);
    const sample=data.slice(0,30);
    const values=col=>sample.map(r=>r[col]).filter(v=>String(v??'').trim()!=='');
    const dateLike=value=>{
      if(value instanceof Date)return Number.isFinite(value.getTime());
      const text=String(value).trim(),n=numeric(value);
      return (n!==null&&n>=20000&&n<=80000)||/^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[ T].*)?$/.test(text)||/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i.test(text)||/^\d{1,2}[- ](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[- ]\d{2,4}(?:\s.*)?$/i.test(text);
    };
    const first=values(0),hasDate=first.length>0&&first.every(dateLike);
    const hoursLike=(col)=>{
      const ns=values(col).map(numeric);
      if(!ns.length||ns.some(n=>n===null||n<0||!Number.isInteger(n*2)))return false;
      const followsSequence=ns.length>=2&&ns.slice(1).every((n,i)=>Math.abs(n-ns[i]-0.5)<1e-8||Math.abs(n-ns[i]-1)<1e-8);
      // Without labels, temperature values can also rise regularly. Use the
      // example's column count or a counter starting at 0/0.5/1 as evidence.
      const expectedWidth=width-col===11;
      return (followsSequence&&(expectedWidth||ns[0]<=1||(hasDate&&col===1)))||(ns.length===1&&(expectedWidth||(hasDate&&col===1&&ns[0]<=1)));
    };
    let layout=options.layout||'auto';
    if(layout==='auto')layout=hasDate?(hoursLike(1)?'date-hours':'date'):(hoursLike(0)?'hours':'temperatures');
    const metadata={temperatures:[],date:['Date & Time'],hours:['Hours'],'date-hours':['Date & Time','Hours']}[layout];
    if(!metadata)throw new Error('Choose a valid pasted column layout.');
    const count=width-metadata.length;
    if(count<2||!sample.some(row=>row.slice(metadata.length,width).filter(v=>numeric(v)!==null).length>=2))throw new Error('Paste at least two temperature columns. Headers are optional; keep each reading on its own row.');
    // Reject arbitrary text tables while still allowing blank/error readings.
    if(sample.some(row=>row.slice(metadata.length,width).some(v=>numeric(v)===null&&String(v??'').trim()!==''&&!/^(?:#.*|n\/?a|null|nan|-|—)$/i.test(String(v).trim()))))throw new Error('Could not recognize the readings. Paste numeric temperature columns, with or without headers.');
    const ambient=options.ambient===undefined?count===10:options.ambient;
    const headers=[...metadata,...Array.from({length:count},(_,i)=>`Temp-${i+1}${ambient&&i===count-1?' (Ambient)':''}`)];
    return {headers,layout,ambient,count};
  }
  function parseMatrix(matrix,options={}){
    matrix=matrix.map(row=>row.slice(0,21));
    let header=-1, count=0;
    for(let r=0;r<Math.min(40,matrix.length);r++){
      const n=matrix[r].filter(v=>sensorId(v)!==null).length;
      if(n>count){header=r;count=n;}
    }
    if(count<2){
      if(count===1)throw new Error('Paste at least two temperature columns.');
      const inferred=inferHeaders(matrix,options);
      const source=parseMatrix([inferred.headers,...matrix]);
      source.inferred=inferred;
      return source;
    }
    const sensors=[];const seen=new Set();
    matrix[header].forEach((value,index)=>{const id=sensorId(value);if(id!==null){if(seen.has(id))throw new Error(`Temp-${id} appears twice. Paste only one temperature table.`);seen.add(id);sensors.push({id,index,label:String(value).trim(),ambient:/ambient/i.test(value)});}});
    const labels=matrix[header].map((v,i)=>String(v||matrix[header-1]?.[i]||'').trim());
    const dateIndex=labels.findIndex(v=>/date|time/i.test(v)&&!/hours?/i.test(v));
    const hoursIndex=labels.findIndex(v=>/hours?|elapsed/i.test(v));
    const isSummary=r=>r.some((v,i)=>!sensors.some(s=>s.index===i)&&summaryLabel(v));
    const summaryCount=matrix.slice(header+1).filter(isSummary).length;
    const rows=matrix.slice(header+1).filter(r=>!isSummary(r)&&(sensors.some(s=>String(r[s.index]??'').trim()!=='')||[dateIndex,hoursIndex].some(i=>i>=0&&String(r[i]??'').trim()!=='')));
    if(!rows.length)throw new Error('The headers are recognized. Paste the reading rows beneath them as well.');
    return {sensors,rows,dateIndex,hoursIndex,summaryCount,dateLabel:labels[dateIndex]||'Date & Time',hoursLabel:labels[hoursIndex]||'Hours'};
  }
  function makePairs(sensors,preset){
    const available=new Set(sensors.filter(s=>!s.ambient).map(s=>s.id));
    const out=[];
    if(preset==='example'){
      [[2,1],[2,3],[5,4],[5,6],[8,7],[8,9]].forEach(([a,b])=>{if(available.has(a)&&available.has(b))out.push({a,b});});
    }else{
      [...available].sort((a,b)=>a-b).forEach(a=>{if(a%2===1&&available.has(a+1))out.push({a:a+1,b:a});});
    }
    return out;
  }
  function numeric(value){
    if(typeof value==='number')return Number.isFinite(value)?value:null;
    const text=String(value??'').trim();
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text))return null;
    const n=Number(text);return Number.isFinite(n)?n:null;
  }
  function readingDate(start,offsetMinutes){
    if(!start)return '';
    const match=String(start).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if(!match)throw new Error('Enter a valid first reading date and time.');
    const [,year,month,day,hour,minute]=match.map(Number);
    const base=new Date(Date.UTC(year,month-1,day,hour,minute));
    if(base.getUTCFullYear()!==year||base.getUTCMonth()!==month-1||base.getUTCDate()!==day||base.getUTCHours()!==hour||base.getUTCMinutes()!==minute)throw new Error('Enter a valid first reading date and time.');
    const d=new Date(base.getTime()+offsetMinutes*60000),pad=n=>String(n).padStart(2,'0');
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth()+1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function calculate(source,pairs,mode='signed',timing={}){
    const sensorMap=new Map(source.sensors.map(s=>[s.id,s.index]));
    const interval=timing.interval===undefined?30:Number(timing.interval);
    const firstHour=timing.firstHour===undefined?1:Number(timing.firstHour);
    if((source.hoursIndex<0||(source.dateIndex<0&&timing.start))&&(!Number.isInteger(interval)||interval<=0))throw new Error('Enter a reading interval of at least 1 whole minute.');
    if(source.hoursIndex<0&&(!Number.isInteger(firstHour)||firstHour<0))throw new Error('Enter a whole starting Hours value of 0 or more.');
    const headers=['Date & Time',source.hoursIndex>=0&&!/^hours$/i.test(source.hoursLabel)?source.hoursLabel:'Hours(1/2 Hrs)'];
    headers.push(...pairs.map(p=>mode==='absolute'?`|T${p.a}-T${p.b}|`:`T${p.a}-T${p.b}`));
    let missing=0;const invalidRows=new Set();
    const rows=source.rows.map((row,ri)=>{
      const out=[source.dateIndex>=0?(row[source.dateIndex]??''):readingDate(timing.start,ri*interval),source.hoursIndex>=0?(row[source.hoursIndex]??''):Math.round((firstHour+ri*interval/30)*1e8)/1e8];
      pairs.forEach(p=>{const a=numeric(row[sensorMap.get(p.a)]),b=numeric(row[sensorMap.get(p.b)]);if(a===null||b===null){out.push(null);missing++;invalidRows.add(ri+1);}else {let diff=a-b;if(mode==='absolute')diff=Math.abs(diff);out.push(Math.round((diff+Math.sign(diff)*Number.EPSILON)*100)/100);}});
      return out;
    });
    return {headers,rows,missing,invalidRows:[...invalidRows],metadataCount:2};
  }
  function toTSV(result){const quote=v=>{const s=String(v??'');return /[\t\n\r"]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};return [result.headers,...result.rows.map(r=>r.map((v,i)=>i>=result.metadataCount&&typeof v==='number'?v.toFixed(2):v))].map(r=>r.map(quote).join('\t')).join('\r\n');}
  root.TemperatureCalculator={readTSV,sensorId,parseMatrix,makePairs,numeric,calculate,toTSV};
  if(typeof module!=='undefined')module.exports=root.TemperatureCalculator;
})(typeof window!=='undefined'?window:globalThis);

/* Shared parsing logic, also exercised by the Node verification script. */
(function (root) {
  'use strict';
  const LIMIT = 21;
  const letter = i => String.fromCharCode(65 + i);
  const present = cell => cell && cell.v !== undefined && cell.v !== null && String(cell.v).trim() !== '';
  function cropSheet(sheet) {
    const copy = {};
    let maxRow = 0;
    for (const key of Object.keys(sheet)) {
      const match = /^([A-U])([1-9]\d*)$/.exec(key);
      if (match) { copy[key] = sheet[key]; if (present(sheet[key])) maxRow = Math.max(maxRow, +match[2]); }
    }
    copy['!ref'] = `A1:U${Math.max(1, maxRow)}`;
    copy['!merges'] = (sheet['!merges'] || []).filter(m => m.s.c < LIMIT).map(m => ({s:{...m.s},e:{r:m.e.r,c:Math.min(20,m.e.c)}}));
    return copy;
  }
  function detectLayout(sheet) {
    for (let row = 1; row <= 40; row++) {
      const a = String(sheet[`A${row}`]?.v || '').toLowerCase();
      const c = String(sheet[`C${row + 1}`]?.v || '').toLowerCase();
      if (/date.*time/.test(a) && /temp/.test(c)) return { start:row, depth:2 };
    }
    let best = { start:1, depth:1 }, score = -1;
    for (let row = 1; row <= 40; row++) {
      const cells = Array.from({length:LIMIT}, (_, i) => sheet[`${letter(i)}${row}`]).filter(present);
      const textCount = cells.filter(c => c.t === 's' || typeof c.v === 'string').length;
      const candidate = textCount * 2 + cells.length;
      if (textCount && candidate > score) { best.start = row; score = candidate; }
    }
    return best;
  }
  function parseSheet(sheet, start, depth, XLSX) {
    if (!Number.isInteger(start) || start < 1 || ![1,2,3].includes(depth)) throw new Error('Enter a valid first header row and select 1–3 header rows.');
    const end = XLSX.utils.decode_range(sheet['!ref'] || 'A1:U1').e.r + 1;
    if (start > end) throw new Error(`The header row must be between 1 and ${end}.`);
    function headerCell(row, col) {
      const direct = sheet[`${letter(col)}${row}`];
      if (present(direct)) return direct;
      const merge = (sheet['!merges'] || []).find(m => row-1 >= m.s.r && row-1 <= m.e.r && col >= m.s.c && col <= m.e.c);
      return merge ? sheet[`${letter(merge.s.c)}${merge.s.r+1}`] : null;
    }
    const headers = Array.from({length:LIMIT}, (_, col) => {
      for (let row = start + depth - 1; row >= start; row--) {
        const cell = headerCell(row, col);
        if (present(cell)) return String(cell.v).trim();
      }
      return `Column ${letter(col)}`;
    });
    const rows = [];
    for (let row = start + depth; row <= end; row++) {
      const cells = Array.from({length:LIMIT}, (_, col) => {
        const c = sheet[`${letter(col)}${row}`];
        if (!present(c)) return {value:null,text:'',type:'',format:''};
        return {value:c.v,text:c.w ?? XLSX.utils.format_cell(c),type:c.t,format:c.z || ''};
      });
      if (cells.some(c => c.value !== null)) rows.push({sourceRow:row,cells});
    }
    return {headers,rows};
  }
  function selectRows(rows, {query='',column='',contains='',sort=-1,direction=1}={}) {
    const q=query.trim().toLocaleLowerCase(), term=contains.trim().toLocaleLowerCase();
    const result=rows.filter(row => (!q || row.cells.some(c => c.text.toLocaleLowerCase().includes(q))) && (column==='' || !term || row.cells[+column].text.toLocaleLowerCase().includes(term)));
    if (sort >= 0) result.sort((a,b) => {
      const x=a.cells[sort], y=b.cells[sort];
      if (x.value===null || y.value===null) return x.value===y.value ? 0 : x.value===null ? 1 : -1;
      return direction * (typeof x.value==='number' && typeof y.value==='number' ? x.value-y.value : x.text.localeCompare(y.text,undefined,{numeric:true}));
    });
    return result;
  }
  function exportSheet(headers, rows, XLSX) {
    const out=XLSX.utils.aoa_to_sheet([headers,...rows.map(r=>r.cells.map(c=>c.value))]);
    rows.forEach((r,ri)=>r.cells.forEach((c,ci)=>{ const dest=out[XLSX.utils.encode_cell({r:ri+1,c:ci})]; if(dest){if(c.format)dest.z=c.format;if(c.type==='e')dest.t='e';} }));
    out['!cols']=headers.map((h,i)=>({wch:i===0||i===12?22:Math.min(30,Math.max(14,h.length+2))}));
    out['!autofilter']={ref:out['!ref']};
    return out;
  }
  root.DataHelper={LIMIT,letter,cropSheet,detectLayout,parseSheet,selectRows,exportSheet};
  if (typeof module!=='undefined') module.exports=root.DataHelper;
})(typeof window!=='undefined'?window:globalThis);

'use strict';
const $=id=>document.getElementById(id);
const D=window.DataHelper;
let workbook=null, fileName='', parsed=null, selected=[], page=1, sort=-1, direction=1, loadId=0;
const status=(message,error=false)=>{ $('status').textContent=message; $('status').classList.toggle('error',error); };
function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
function clearFilters(){ $('search').value='';$('filter-column').value='';$('filter-value').value='';$('filter-value').disabled=true;sort=-1;direction=1;page=1; }
function applyLayout(){
  try{
    const next=D.parseSheet(workbook.Sheets[$('sheet').value],Number($('header-row').value),Number($('header-depth').value),XLSX);
    parsed=next;clearFilters();
    $('filter-column').replaceChildren(option('','Filter a column'),...parsed.headers.map((h,i)=>option(i,`${D.letter(i)} · ${h}`)));
    $('layout-note').textContent=`Data starts at row ${Number($('header-row').value)+Number($('header-depth').value)} · 21 columns · Blank rows skipped`;
    status(parsed.rows.length ? '' : 'No data rows found. Choose another worksheet or adjust the header rows.');update();
    window.dispatchEvent(new CustomEvent('temperature-import',{detail:{matrix:[parsed.headers,...parsed.rows.map(r=>r.cells.map(c=>typeof c.value==='number'&&!XLSX.SSF.is_date(c.format)?c.value:c.text))],label:'Imported from '+$('sheet').value+' · Full stored precision'}}));
  }catch(error){status(error.message,true);}
}
function chooseSheet(){const layout=D.detectLayout(workbook.Sheets[$('sheet').value]);$('header-row').value=layout.start;$('header-depth').value=layout.depth;applyLayout();}
async function importFile(file){
  if(!file)return;
  if(!/\.(xlsx|xls)$/i.test(file.name)){status('Please choose an Excel workbook (.xlsx or .xls).',true);return;}
  if(file.size>30*1024*1024){status('This workbook is larger than 30 MB. Please save a smaller copy and try again.',true);return;}
  const token=++loadId;status('Reading workbook…');$('browse').disabled=true;
  try{
    if(!window.XLSX)throw new Error('The Excel reader could not load. Keep the vendor folder beside index.html, then reopen the page.');
    const bytes=await file.arrayBuffer();if(token!==loadId)return;
    const original=XLSX.read(bytes,{type:'array',cellNF:true,cellText:true,cellHTML:false,cellFormula:false});
    if(!original.SheetNames.length)throw new Error('This workbook does not contain any worksheets.');
    const sheets={};original.SheetNames.forEach(name=>{sheets[name]=D.cropSheet(original.Sheets[name]);});
    workbook={SheetNames:original.SheetNames,Sheets:sheets,Workbook:original.Workbook};fileName=file.name;
    $('sheet').replaceChildren(...workbook.SheetNames.map(name=>option(name,name)));
    $('sheet').value=workbook.SheetNames.find(name=>/new data/i.test(name)) || workbook.SheetNames[0];
    $('filename').textContent=fileName;$('workspace').hidden=false;$('empty').hidden=true;
    $('drop-title').textContent='Drop a file to replace this workbook';$('drop-detail').textContent='.xlsx / .xls · Columns A–U';chooseSheet();
  }catch(error){status(`Unable to read this file. ${error.message || 'Try saving it again as an .xlsx workbook.'}`,true);}
  finally{if(token===loadId){$('browse').disabled=false;$('file').value='';}}
}
function update(){
  if(!parsed)return;
  selected=D.selectRows(parsed.rows,{query:$('search').value,column:$('filter-column').value,contains:$('filter-value').value,sort,direction});
  const size=Number($('page-size').value),totalPages=Math.max(1,Math.ceil(selected.length/size));page=Math.min(page,totalPages);
  $('row-count').textContent=`${selected.length.toLocaleString()} / ${parsed.rows.length.toLocaleString()} rows`;
  const head=document.createElement('tr'),corner=document.createElement('th');corner.textContent='#';corner.title='Original Excel row';corner.scope='col';head.append(corner);
  parsed.headers.forEach((header,i)=>{
    const th=document.createElement('th');th.scope='col';th.setAttribute('aria-sort',sort===i?(direction===1?'ascending':'descending'):'none');
    const button=document.createElement('button'),label=document.createElement('span'),letter=document.createElement('small'),arrow=document.createElement('span');
    letter.textContent=D.letter(i);label.append(letter,document.createTextNode(header));arrow.textContent=sort===i?(direction===1?'↑':'↓'):'↕';arrow.className='sort-icon';arrow.setAttribute('aria-hidden','true');button.append(label,arrow);
    button.setAttribute('aria-label',`Sort column ${D.letter(i)}: ${header}`);button.addEventListener('click',()=>{direction=sort===i?-direction:1;sort=i;page=1;update();$('table').querySelectorAll('th button')[i].focus({preventScroll:true});});th.append(button);head.append(th);
  });
  $('table').tHead.replaceChildren(head);
  const frag=document.createDocumentFragment();
  selected.slice((page-1)*size,page*size).forEach(row=>{const tr=document.createElement('tr'),num=document.createElement('td');num.textContent=row.sourceRow;tr.append(num);row.cells.forEach(cell=>{const td=document.createElement('td');td.textContent=cell.text;td.title=cell.text;if(typeof cell.value==='number'&&!XLSX.SSF.is_date(cell.format))td.className='numeric';tr.append(td);});frag.append(tr);});
  $('table').tBodies[0].replaceChildren(frag);$('no-rows').hidden=selected.length>0;
  $('page-info').textContent=selected.length?`Showing ${((page-1)*size+1).toLocaleString()}–${Math.min(page*size,selected.length).toLocaleString()} of ${selected.length.toLocaleString()} rows`:'0 rows';
  $('page-number').textContent=`${page} / ${totalPages}`;$('prev').disabled=page===1;$('next').disabled=page===totalPages;$('export').disabled=selected.length===0;
}
$('browse').addEventListener('click',()=>$('file').click());
$('file').addEventListener('change',e=>importFile(e.target.files[0]));
let dragDepth=0;
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('dropzone').addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;$('dropzone').classList.add('dragging');});
$('dropzone').addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropzone').classList.remove('dragging');}});
$('dropzone').addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropzone').classList.remove('dragging');if(e.dataTransfer.files.length!==1){status('Drop one workbook at a time.',true);return;}importFile(e.dataTransfer.files[0]);});
$('sheet').addEventListener('change',chooseSheet);$('apply').addEventListener('click',applyLayout);
['search','filter-value'].forEach(id=>$(id).addEventListener('input',()=>{page=1;update();}));
$('filter-column').addEventListener('change',()=>{$('filter-value').disabled=$('filter-column').value==='';$('filter-value').value='';page=1;update();});
$('reset').addEventListener('click',()=>{clearFilters();update();});
$('page-size').addEventListener('change',()=>{page=1;update();});
$('prev').addEventListener('click',()=>{page--;update();});$('next').addEventListener('click',()=>{page++;update();});
$('clear').addEventListener('click',()=>{loadId++;workbook=null;parsed=null;selected=[];fileName='';$('file').value='';$('browse').disabled=false;$('workspace').hidden=true;$('empty').hidden=false;$('filename').textContent='';$('sheet').replaceChildren();$('table').tHead.replaceChildren();$('table').tBodies[0].replaceChildren();$('drop-title').textContent='Or drop an Excel file here';$('drop-detail').textContent='.xlsx / .xls · Columns A–U';status('');});
$('export').addEventListener('click',()=>{
  try{const out=XLSX.utils.book_new();out.Workbook={WBProps:{date1904:!!workbook.Workbook?.WBProps?.date1904}};XLSX.utils.book_append_sheet(out,D.exportSheet(parsed.headers,selected,XLSX),'Filtered data');XLSX.writeFile(out,fileName.replace(/\.[^.]+$/,'')+' - filtered.xlsx');status(`Exported ${selected.length.toLocaleString()} rows, with columns A–U only.`);}catch(error){status(`Export failed: ${error.message}`,true);}
});


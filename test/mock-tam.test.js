// Nachbau der TAM-Oberfläche (jsdom) – prüft Tabellen-Lesen, Refresh, Auftragskarte, 0-km, alle auswählen, Bestätigen.
// Aufruf: npm i jsdom@24 && node test/mock-tam.test.js
const {JSDOM}=require('jsdom');const fs=require('fs');
const body=`<div id="mainview" class="x-viewport">
<ul><li id="x-auto-35__AgentVeroeffentlichteAuftraege" class="x-tab-strip-active"><span class="x-tab-strip-text">[Meine Aufträge] Veröffentlichte Aufträge</span></li></ul>
<div id="AgentVeroeffentlichteAuftraege" class=" x-component "><div class="x-grid3"><table><tr class="x-grid3-hd-row">
<td class="x-grid3-hd x-grid3-td-teilAuftragNr">AuftragsNr</td><td class="x-grid3-hd x-grid3-td-besichtigungsPlz">PLZ</td><td class="x-grid3-hd x-grid3-td-besichtigungsOrt">Ort</td></tr></table>
<div class="x-grid3-body"><div class="x-grid3-row" id="r1"><table><tr><td class="x-grid3-cell x-grid3-td-hid">1</td><td class="x-grid3-cell x-grid3-td-teilAuftragNr">MW3191767</td><td class="x-grid3-cell x-grid3-td-besichtigungsPlz">56218</td><td class="x-grid3-cell x-grid3-td-besichtigungsOrt">Mülheim-Kärlich</td></tr></table></div></div></div>
<div class="x-toolbar">Seite <table class="x-btn"><tr><td><button></button></td></tr></table><table class="x-btn"><tr><td><button></button></td></tr></table><table class="x-btn"><tr><td><button></button></td></tr></table><table class="x-btn"><tr><td><button></button></td></tr></table><table class="x-btn" id="refresh"><tr><td><button></button></td></tr></table> Einträge pro Seite</div></div></div>`;
const dom=new JSDOM('<html><head><script src="de.tomcom.tam.TAM.nocache.js"></script></head><body>'+body+'</body></html>',{runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window, d=w.document;
Object.defineProperty(w.HTMLElement.prototype,'offsetParent',{get(){return this.style.display==='none'?null:this.parentNode}});
w.CSS={escape:s=>s};
let refreshed=0; d.getElementById('refresh').addEventListener('click',()=>{refreshed++; const r=d.getElementById('r1'); const c=r.cloneNode(true); r.replaceWith(c); bindDbl(c);});
const btn=(t,cls='')=>`<table class="x-btn ${cls}"><tr><td><button>${t}</button></td></tr></table>`;
let accepted=null;
function bindDbl(el){el.addEventListener('dblclick',()=>{
  const c=d.createElement('div');c.className='x-window';c.id='card';
  c.innerHTML=`<div class="x-window-header"><span class="x-window-header-text">Auftragskarte zu MW3191767</span></div>
  <div class="x-panel-header">Warenkorb <input type="checkbox" class="x-view-item-checkbox" id="all"></div>
  <div class="x-view" id="wk"><div class="x-view-item x-view-item-check"><input type="checkbox" class="x-view-item-checkbox">MW3191767</div></div>
  <div class="x-view"><div class="zusatzteilauftrag" id="z0"><div class="entfernung">0 km</div>MW3000001 Dienst A</div><div class="zusatzteilauftrag"><div class="entfernung">5 km</div>MW3054003 Daimler</div></div>
  ${btn('Weitere Aufträge finden')}${btn('Annehmen')}${btn('Ablehnen')}${btn('Schließen')}`;
  d.body.appendChild(c);
  c.querySelector('#z0').addEventListener('click',()=>{const it=d.createElement('div');it.className='x-view-item x-view-item-check';it.innerHTML='<input type="checkbox" class="x-view-item-checkbox">MW3000001';c.querySelector('#wk').appendChild(it);});
  [...c.querySelectorAll('button')].forEach(b=>b.addEventListener('click',()=>{
    if(b.textContent==='Schließen') c.remove();
    if(b.textContent==='Annehmen'){
      const checked=[...c.querySelectorAll('#wk input')].filter(i=>i.checked).map(i=>i.parentNode.textContent);
      if(!checked.length){return;}
      const dl=d.createElement('div');dl.className='x-window';
      dl.innerHTML=`<div class="x-window-header"><span class="x-window-header-text">Auftragsannahme bestätigen</span></div><div class="x-form-check-wrap"><input type="checkbox" class="x-form-checkbox"> Ja, hiermit bestätige ich die Bedingungen</div>${btn('Bestätigen','x-item-disabled')}${btn('Abbrechen')}`;
      d.body.appendChild(dl);
      const cb=dl.querySelector('input'); const bb=dl.querySelectorAll('.x-btn')[0];
      cb.addEventListener('click',()=>bb.classList.toggle('x-item-disabled',!cb.checked));
      bb.querySelector('button').addEventListener('click',()=>{if(!bb.classList.contains('x-item-disabled')){accepted=checked;dl.remove();}});
    }
  }));
  c.querySelector('#all').addEventListener('click',()=>{ if(c.querySelector('#all').checked) c.querySelectorAll('#wk input').forEach(i=>i.checked=true); });
});}
bindDbl(d.getElementById('r1'));
w.GM_getValue=(k,d)=>({places:{plz:[],orte:['muelheim-kaerlich'],loadedAt:new Date().toISOString(),source:'t'},running:true,intervalSec:15}[k]??d);
w.GM_setValue=()=>{};w.GM_xmlhttpRequest=()=>{};w.GM_notification=()=>{};
w.eval(fs.readFileSync(require('path').join(__dirname,'..','tam-auto-annahme.user.js'),'utf8'));
setTimeout(()=>{
  console.log('refresh geklickt:',refreshed,'| angenommen:',accepted,'| Karte offen:',!!d.getElementById('card'));
  console.log([...d.querySelectorAll('#tamauto-log div')].map(x=>x.textContent).reverse().join('\n'));
  process.exit(0)},20000);

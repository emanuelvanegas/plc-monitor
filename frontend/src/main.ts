import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import './style.css';
import type { Config, Health, Plc, PlcEvent, Summary, Variable } from './types';
import { HistoryChart } from './chart';
import { browserDemo, request, exportCsv, resetBrowserDemo } from './data-source';

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => el<HTMLInputElement>(id);
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const number = (value: number) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(value);
const time = (value: string) => new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(new Date(value));
const date = (value: string) => new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).format(new Date(value));
const url = (id: string) => '/api/plcs/' + encodeURIComponent(id);
let devices: Plc[] = [], selectedId: string | null = null, health: Health | null = null;
let summary: Summary = { total:0,connected:0,offline:0,warnings:0 };
let busy = false, refreshing = false, selectionSequence = 0;
let selectionRequest: AbortController | null = null;
let editing: { id:string; revision:number } | null = null;
let formVariables: Variable[] = [];
const selected = () => devices.find(d => d.id === selectedId);
const chart = new HistoryChart();
const warning = (d: Plc) => Object.values(d.state.variables).some(v => v.alarm_active === true);

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await request(path, { ...options, headers: { 'content-type':'application/json', ...options.headers } });
  const text = await response.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { message:text || 'Respuesta no disponible' }; }
  if (!response.ok) throw new Error(body.message ?? body.storage_error ?? `Error HTTP ${response.status}`);
  return body as T;
}
function message(text: string | null, error = false) {
  const node = el('app-message'); node.hidden = !text; node.textContent = text;
  node.dataset.error=String(error);
  node.style.background = error ? '#FCEDEA' : '#E8F3E8'; node.style.color = error ? '#A3302A' : '#1A3C2B';
}

function renderSummary() {
  el('fleet-summary').innerHTML = [['Registrados',summary.total,'text-forest'],['Conectados',summary.connected,'text-forest'],['Sin conexión',summary.offline,'text-red-dark'],['Con aviso',summary.warnings,'text-amber-dark']]
    .map(([label,count,color]) => `<div class="flex justify-between items-center"><span class="text-secondary">${label}</span><span class="font-mono font-medium ${color}">${count}</span></div>`).join('');
}
function renderList() {
  const list = el('device-list');
  const query = input('search-input').value.toLocaleLowerCase('es');
  const matching = devices.filter(d => `${d.name} ${d.location} ${d.host} ${d.port}`.toLocaleLowerCase('es').includes(query));
  const focusedId = (document.activeElement as HTMLElement | null)?.dataset.deviceId;
  list.replaceChildren();
  if (!matching.length) {
    list.innerHTML = `<div class="p-16 text-sm text-secondary text-center">${devices.length ? 'No hay resultados.' : 'Agrega tu primer PLC para comenzar.'}${devices.length ? '<button id="clear-search" type="button" class="text-forest underline block mx-auto mt-8">Limpiar búsqueda</button>' : ''}</div>`;
    if (devices.length) el('clear-search').onclick = () => { input('search-input').value=''; renderList(); };
    return;
  }
  matching.forEach(d => {
    const button = document.createElement('button'); button.type='button'; button.dataset.deviceId=d.id;
    button.className=`device-item w-full text-left p-12 border-b border-fill hover:bg-fill flex flex-col gap-6 ${d.id===selectedId?'active':''}`;
    button.setAttribute('aria-pressed',String(d.id===selectedId));
    const connection = d.state.connection==='connected'?'Conectado':d.state.connection==='offline'?'Sin conexión':'Sin verificar';
    button.innerHTML=`<span class="font-medium text-sm">${esc(d.name)}</span><span class="text-xs text-secondary">${esc(d.location)}</span><span class="text-xs font-mono text-secondary">${esc(d.host)}:${d.port} · ID ${d.unit_id}</span><span class="text-xs ${d.state.connection==='offline'?'text-red-dark':warning(d)?'text-amber-dark':'text-forest'}">${connection} · ${d.paused?'Adquisición pausada':d.state.connection==='connected'?'En ejecución':'Esperando comunicación'}${warning(d)?' · Aviso de umbral':''}</span>`;
    button.onclick=()=>{selectedId=d.id;renderBasic();void loadSelected();if(innerWidth<1025)el('device-detail').scrollIntoView({block:'start'});};
    list.appendChild(button);
  });
  if (focusedId) list.querySelector<HTMLElement>(`[data-device-id="${CSS.escape(focusedId)}"]`)?.focus({preventScroll:true});
}
function renderBasic() {
  renderSummary();renderList();
  const d=selected();el('device-detail').hidden=!d;
  el('mode-label').textContent=browserDemo?'Demo en navegador':health?.demo?'Demo Modbus TCP':'Modbus TCP';
  if(!d)return;
  el('det-name').textContent=d.name;el('det-loc').textContent=`${d.location} · Modbus TCP`;
  el('det-last').textContent=d.state.last_success?`Última lectura correcta: ${time(d.state.last_success)}`:'Esperando la primera lectura';
  const offline=d.state.connection==='offline';
  el('det-badge').textContent=offline?'Sin conexión':d.state.connection==='connected'?'Conectado':'Sin verificar';
  el('det-badge').className=`font-mono text-xs px-8 py-4 rounded ${offline?'bg-coral-pale text-red-dark':'bg-mint-pale text-forest'}`;
  const pause=el<HTMLButtonElement>('btn-pause');pause.textContent=d.paused?'Reanudar':'Pausar';pause.setAttribute('aria-pressed',String(d.paused));
  pause.setAttribute('aria-label',`${d.paused?'Reanudar':'Pausar'} adquisición de ${d.name}`);
  el('metrics-container').innerHTML=d.variables.map(v=>{
    const state=d.state.variables[v.id], last=state?.last_good;
    const stale=!!last && (d.paused || d.state.connection!=='connected' || state.quality!=='good' || Date.now()-Date.parse(last.observed_at)>d.timeout_ms+2*d.interval_ms);
    const label=d.paused?'Adquisición pausada':!last?'Esperando lectura':stale?'Datos desactualizados':state.alarm_active?'Umbral superado':'Rango normal';
    return `<section class="bg-panels border border-borders rounded p-16 flex flex-col gap-12 min-w-0"><div class="flex flex-wrap justify-between gap-8"><span class="text-sm font-medium">${esc(v.name)}</span><span class="font-mono text-xs text-secondary bg-fill px-4 py-2 rounded">${v.register_type==='holding'?'HR':'IR'} · ${v.address}</span></div><div class="font-heading font-semibold metric-value leading-none font-tabular my-4 ${stale?'stale-reading':''}">${last?.value!==null && last?.value!==undefined?number(last.value):'—'} <span class="text-[18px] text-secondary">${esc(last?.unit??v.unit)}</span></div><div class="flex flex-wrap justify-between gap-8 items-center text-xs mt-auto"><span class="${stale?'bg-coral-pale text-red-dark':state?.alarm_active?'bg-gold-pale text-amber-dark':'bg-mint-pale text-forest'} px-6 py-4 rounded">${label}</span>${v.high_limit!==null?`<span class="font-mono text-secondary">Límite: ${number(v.high_limit)} ${esc(v.unit)}</span>`:''}</div>${state?.error?`<p class="text-xs text-red-dark">${esc(state.error)}</p>`:''}</section>`;
  }).join('');
  el('info-ip').textContent=d.host;el('info-port').textContent=String(d.port);el('info-uid').textContent=String(d.unit_id);el('info-int').textContent=number(d.interval_ms/1000)+' s';
  el('info-state').textContent=d.paused?'Adquisición pausada':offline?'Sin conexión':d.state.connection==='connected'?'En ejecución':'Esperando comunicación';
  el('events-title').textContent=`Eventos · ${d.name}`;
  el('simulation-scope').textContent=browserDemo?`PLC virtual · ${d.name}`:health?.demo_ids.includes(d.id)?`Simulación Modbus TCP · ${d.name}`:'Equipo configurado · lectura Modbus TCP';
  ['btn-sim-norm','btn-sim-high','btn-sim-off'].forEach(id=>{el<HTMLButtonElement>(id).disabled=busy||!health?.demo_ids.includes(d.id);});
  ['btn-config','btn-pause','btn-add'].forEach(id=>{el<HTMLButtonElement>(id).disabled=busy;});
}

async function loadSelected() {
  const d=selected();selectionRequest?.abort();const sequence=++selectionSequence;
  if(!d)return;
  const controller=new AbortController();selectionRequest=controller;
  try {
    chart.update(d);
    const events=await api<{events:PlcEvent[]}>(url(d.id)+'/events',{signal:controller.signal});
    if(sequence!==selectionSequence||selectedId!==d.id)return;
    const states:Record<string,string>={connection_restored:'Conectado',connection_lost:'Sin conexión',threshold_exceeded:'Aviso activo',threshold_recovered:'Rango recuperado',variable_error:'Revisar variable'};
    el('events-body').innerHTML=events.events.map(e=>`<tr class="border-b border-fill"><td class="py-8 px-8 text-secondary">${date(e.occurred_at)}</td><td class="py-8 px-8">${esc(d.name)}</td><td class="py-8 px-8"><span class="${e.severity==='error'?'bg-coral-pale text-red-dark':e.severity==='warning'?'bg-gold-pale text-amber-dark':'bg-mint-pale text-forest'} px-4 py-2 rounded">${e.severity==='error'?'ERROR':e.severity==='warning'?'AVISO':'INFO'}</span></td><td class="py-8 px-8">${esc(e.message)}</td><td class="py-8 px-8">${esc(states[e.kind]??'Registrado')}</td></tr>`).join('');
  } catch(error) {if(!controller.signal.aborted)message('No se pudo consultar el historial: '+String(error),true);}
}
async function refresh() {
  if(refreshing)return;refreshing=true;
  try {
    const response=await api<{summary:Summary;plcs:Plc[]}>('/api/plcs');
    devices=response.plcs;summary=response.summary;
    if(!selectedId||!devices.some(d=>d.id===selectedId))selectedId=devices[0]?.id??null;
    try {health=await api<Health>('/api/health');if(el('app-message').dataset.error==='true')message(null);}catch(error){message('El almacenamiento requiere atención: '+String(error),true);}
    renderBasic();await loadSelected();
  }catch(error){message('No se pudo actualizar el panel: '+String(error),true);renderBasic();}
  finally{refreshing=false;}
}
async function action(fn:()=>Promise<void>) {
  busy=true;renderBasic();
  try {await fn();await refresh();}catch(error){message(String(error),true);}
  finally{busy=false;renderBasic();}
}
input('search-input').oninput=renderList;
el('btn-pause').onclick=()=>void action(async()=>{const d=selected()!;await api(url(d.id)+'/acquisition',{method:'PUT',body:JSON.stringify({running:d.paused})});});
(['normal','high','offline'] as const).forEach((scenario,i)=>{
  el(['btn-sim-norm','btn-sim-high','btn-sim-off'][i]).onclick=()=>void action(async()=>{
    const d=selected()!;await api('/api/demo/plcs/'+encodeURIComponent(d.id)+'/scenario',{method:'PUT',body:JSON.stringify({scenario})});
    message(browserDemo?'Escenario aplicado al PLC virtual. Verás el cambio en la siguiente lectura simulada.':'Escenario aplicado al servidor Modbus. El recolector actualizará los datos al completar su siguiente lectura.');
  });
});
el('btn-export').onclick=()=>{const d=selected();if(!d)return;const range=chart.exportRange();void exportCsv(url(d.id)+'/export.csv?'+new URLSearchParams({from_ms:String(range.from),to_ms:String(range.to)}),`plc-${d.id}-historial.csv`).catch(error=>message(String(error),true));};

function defaultVariable(): Variable {return{id:crypto.randomUUID(),name:'Temperatura',register_type:'holding',address:0,data_type:'uint16',word_order:'ABCD',scale:.1,unit:'°C',high_limit:80,primary:true};}
function syncVariables() {
  el('cfg-variable-list').querySelectorAll<HTMLElement>('[data-variable-id]').forEach(row=>{
    const v=formVariables.find(v=>v.id===row.dataset.variableId)!;
    row.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-field]').forEach(field=>{
      const key=field.dataset.field!;
      (v as any)[key]=['address','scale'].includes(key)?Number(field.value):key==='high_limit'?(field.value===''?null:Number(field.value)):field.value;
    });
    v.primary=row.querySelector<HTMLInputElement>('[name="primary-variable"]')!.checked;
  });
}
function renderVariableForm() {
  el('cfg-variable-list').innerHTML=formVariables.map((v,i)=>`<fieldset class="border border-borders rounded p-12 flex flex-col gap-12" data-variable-id="${esc(v.id)}"><legend class="px-4 text-sm font-medium">Variable ${i+1}</legend><div class="variable-grid"><label>Nombre<input data-field="name" value="${esc(v.name)}" required maxlength="80"></label><label>Tipo de registro<select data-field="register_type"><option value="holding" ${v.register_type==='holding'?'selected':''}>Holding (FC03)</option><option value="input" ${v.register_type==='input'?'selected':''}>Entrada (FC04)</option></select></label><label>Dirección (desde 0)<input data-field="address" type="number" value="${v.address}" min="0" max="65535" required></label><label>Tipo de dato<select data-field="data_type">${['uint16','int16','float32'].map(type=>`<option ${v.data_type===type?'selected':''}>${type}</option>`).join('')}</select></label><label>Orden de palabras<select data-field="word_order"><option ${v.word_order==='ABCD'?'selected':''}>ABCD</option><option ${v.word_order==='CDAB'?'selected':''}>CDAB</option></select></label><label>Unidad<input data-field="unit" value="${esc(v.unit)}" maxlength="24"></label><label>Factor de escala<input data-field="scale" type="number" step="any" value="${v.scale}" required></label><label>Límite alto (opcional)<input data-field="high_limit" type="number" step="any" value="${v.high_limit??''}"></label></div><div class="flex flex-wrap justify-between items-center gap-12"><label class="flex items-center gap-8"><input type="radio" name="primary-variable" ${v.primary?'checked':''}> Tendencia inicial</label><button type="button" data-remove="${esc(v.id)}" class="text-sm underline text-secondary" ${formVariables.length===1?'disabled':''}>Quitar variable</button></div></fieldset>`).join('');
  el('cfg-variable-list').querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button=>button.onclick=()=>{syncVariables();formVariables=formVariables.filter(v=>v.id!==button.dataset.remove);if(!formVariables.some(v=>v.primary))formVariables[0].primary=true;renderVariableForm();});
}
function openConfig(d: Plc | undefined) {
  editing=d?{id:d.id,revision:d.revision}:null;
  const config: Config=d??{name:'',location:'',host:'127.0.0.1',port:5502,unit_id:1,interval_ms:1000,timeout_ms:2000,paused:false,variables:[defaultVariable()]};
  el<HTMLFormElement>('config-form').reset();el('dlg-title').textContent=d?'Configurar PLC':'Agregar PLC';
  const fields:Record<string,string|number>={name:config.name,location:config.location,ip:config.host,port:config.port,unitId:config.unit_id,interval:config.interval_ms/1000,timeout:config.timeout_ms/1000};
  Object.entries(fields).forEach(([field,value])=>{input('cfg-'+field).value=String(value);});
  formVariables=config.variables.map(v=>({...v}));renderVariableForm();el('form-error').hidden=true;el<HTMLDialogElement>('config-dialog').showModal();
}
el('btn-add').onclick=()=>openConfig(undefined);el('btn-config').onclick=()=>openConfig(selected());
el('btn-close-dlg').onclick=()=>el<HTMLDialogElement>('config-dialog').close();
el('btn-add-variable').onclick=()=>{syncVariables();const v=defaultVariable();v.name='Variable '+(formVariables.length+1);v.address=Math.max(...formVariables.map(v=>v.address+(v.data_type==='float32'?2:1)));v.primary=false;formVariables.push(v);renderVariableForm();};
el<HTMLFormElement>('config-form').onsubmit=async event=>{
  event.preventDefault();syncVariables();if(!el<HTMLFormElement>('config-form').reportValidity())return;
  const config:Config={name:input('cfg-name').value.trim(),location:input('cfg-location').value.trim(),host:input('cfg-ip').value.trim(),port:Number(input('cfg-port').value),unit_id:Number(input('cfg-unitId').value),interval_ms:Math.round(Number(input('cfg-interval').value)*1000),timeout_ms:Math.round(Number(input('cfg-timeout').value)*1000),paused:editing?(selected()?.paused??false):false,variables:formVariables};
  const submit=el<HTMLFormElement>('config-form').querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=true;
  try{
    const result=await api<Plc>(editing?url(editing.id):'/api/plcs',{method:editing?'PUT':'POST',body:JSON.stringify(editing?{...config,expected_revision:editing.revision}:config)});
    selectedId=result.id;input('search-input').value='';el<HTMLDialogElement>('config-dialog').close();await refresh();message(browserDemo?'PLC virtual guardado en este navegador.':'Configuración guardada. La adquisición pertenece al backend Rust.');
  }catch(error){el('form-error').textContent=String(error);el('form-error').hidden=false;}
  finally{submit.disabled=false;}
};

if(browserDemo){
  el('browser-demo').hidden=false;
  el('connection-description').textContent='Configura un PLC virtual y sus variables. Estos datos solo se usan en la simulación de tu navegador.';
  el('btn-reset-demo').onclick=()=>void action(async()=>{
    await resetBrowserDemo();selectedId=null;input('search-input').value='';
    await refresh();el<HTMLButtonElement>('chart-live').click();message('Demo reiniciada con los tres equipos de ejemplo.');
  });
}
void refresh();
setInterval(()=>{if(!document.hidden)void refresh();},1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});

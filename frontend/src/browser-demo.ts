import type { Config, HistoryResponse, Plc, PlcEvent, Sample, Variable } from './types';

type Scenario = 'normal' | 'high' | 'offline';
interface Snapshot { at: number; revision: number; config: Config; scenario: Scenario }
interface VirtualPlc { id: string; snapshots: Snapshot[]; state: Plc['state']; events: PlcEvent[]; lastTick: number }
interface Gap { from_ms: number; to_ms: number }
interface Bucket { samples: Sample[]; gap?: Gap }
const DAY = 86400000, STORAGE_KEY = 'plc-monitor-browser-demo-v1';
const clone = <T>(value: T): T => structuredClone(value);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json' } });
const stamp = (sample: Sample) => Date.parse(sample.observed_at);
const current = (plc: VirtualPlc) => plc.snapshots[plc.snapshots.length - 1];
class DemoError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

function variable(id: string, name: string, address: number, unit: string, scale = 1, high_limit: number | null = null, primary = false): Variable {
  return { id, name, address, unit, scale, high_limit, primary, register_type:'holding', data_type:'uint16', word_order:'ABCD' };
}
function fixtures(): { id:string; config:Config; scenario:Scenario }[] {
  const tank: Config = { name:'Tanque de mezcla', location:'Área de procesos', host:'tanque.virtual', port:502, unit_id:1, interval_ms:1000, timeout_ms:1000, paused:false, variables:[
    variable('tank-temperature','Temperatura',0,'°C',.1,80,true), variable('tank-level','Nivel',1,'%'), variable('tank-cycles','Ciclos',2,'ciclos'),
  ] };
  const oven = { ...clone(tank), name:'Horno de secado', location:'Producción', host:'horno.virtual', variables:[
    variable('oven-temperature','Temperatura',0,'°C',.1,80,true), variable('oven-humidity','Humedad',1,'%'), variable('oven-cycles','Ciclos',2,'ciclos'),
  ] };
  const belt = { ...clone(tank), name:'Banda de empaque', location:'Empaque', host:'banda.virtual', variables:[
    { ...variable('belt-speed','Velocidad',20,'m/s',1,2,true), data_type:'float32' as const }, variable('belt-pieces','Piezas',22,'pzs'), variable('belt-motor','Motor en marcha',23,'estado'),
  ] };
  return [{id:'demo-tank',config:tank,scenario:'normal'}, {id:'demo-oven',config:oven,scenario:'high'}, {id:'demo-belt',config:belt,scenario:'offline'}];
}

function validate(value: unknown): Config {
  if (!value || typeof value !== 'object') throw new DemoError('Configuración no válida');
  const c = clone(value) as Config;
  for (const [text, max] of [[c.name,80],[c.location,80],[c.host,253]] as const) {
    if (typeof text !== 'string' || !text.trim() || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new DemoError('Revisa nombre, ubicación y host');
  }
  if (/[\s/\\]/.test(c.host) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535 || !Number.isInteger(c.unit_id) || c.unit_id < 0 || c.unit_id > 255 || !Number.isInteger(c.interval_ms) || c.interval_ms < 100 || c.interval_ms > 60000 || !Number.isInteger(c.timeout_ms) || c.timeout_ms < 100 || c.timeout_ms > 30000 || typeof c.paused !== 'boolean') throw new DemoError('Revisa los parámetros del PLC virtual');
  if (!Array.isArray(c.variables) || c.variables.length < 1 || c.variables.length > 32 || c.variables.some(v => !v || typeof v !== 'object') || c.variables.filter(v => v.primary === true).length !== 1) throw new DemoError('Configura entre 1 y 32 variables y una tendencia inicial');
  const ids = new Set<string>(), occupied = new Set<string>();
  for (const v of c.variables) {
    if (typeof v.id !== 'string' || !v.id || v.id.length > 80 || ids.has(v.id) || typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80 || typeof v.unit !== 'string' || v.unit.length > 24 || /[\u0000-\u001f\u007f]/.test(v.name+v.unit) || !['holding','input'].includes(v.register_type) || !['uint16','int16','float32'].includes(v.data_type) || !['ABCD','CDAB'].includes(v.word_order) || !Number.isFinite(v.scale) || (v.high_limit !== null && !Number.isFinite(v.high_limit)) || typeof v.primary !== 'boolean') throw new DemoError('Revisa el mapa de variables');
    ids.add(v.id);
    const words = v.data_type === 'float32' ? 2 : 1;
    if (!Number.isInteger(v.address) || v.address < 0 || v.address + words > 65536) throw new DemoError('Dirección de registro no válida');
    for (let offset = 0; offset < words; offset++) {
      const key = v.register_type + ':' + (v.address + offset);
      if (occupied.has(key)) throw new DemoError('El mapa contiene registros superpuestos');
      occupied.add(key);
    }
  }
  return {name:c.name.trim(),location:c.location.trim(),host:c.host,port:c.port,unit_id:c.unit_id,interval_ms:c.interval_ms,timeout_ms:c.timeout_ms,paused:c.paused,variables:c.variables};
}

/** All values are deterministic functions of simulated time. History is generated
 * on demand rather than storing 24 hours of readings in localStorage or RAM. */
export class BrowserDemo {
  private devices = new Map<string, VirtualPlc>();
  private sequence = 0;
  private epoch: number;
  constructor(private readonly now: () => number = Date.now, private readonly storage?: Pick<Storage,'getItem'|'setItem'|'removeItem'>) {
    this.epoch = Math.floor(this.now() / 1000) * 1000 - DAY;
    this.load();
  }
  reset() {
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* in-memory mode still works */ }
    this.devices.clear(); this.sequence = 0;
    this.epoch = Math.floor(this.now() / 1000) * 1000 - DAY;
    this.seed(fixtures());
  }
  private load() {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved) || saved.length < 1 || saved.length > 10) throw new Error('Caché no válida');
        const ids = new Set<string>();
        const configs = saved.map((p: {id:unknown;config:unknown;scenario:unknown}) => {
          if (typeof p.id !== 'string' || !p.id || p.id.length > 80 || ids.has(p.id) || !['normal','high','offline'].includes(String(p.scenario))) throw new Error('Caché no válida');
          ids.add(p.id); return {id:p.id,config:validate(p.config),scenario:p.scenario as Scenario};
        });
        this.seed(configs); return;
      }
    } catch { /* Corrupt or unavailable storage must not prevent opening the demo. */ }
    this.seed(fixtures());
  }
  private save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify([...this.devices.values()].map(p => ({id:p.id,config:current(p).config,scenario:current(p).scenario})))); } catch { /* private browsing / quota: keep this session usable */ }
  }
  private seed(fixtures: {id:string;config:Config;scenario:Scenario}[]) {
    const now = this.now();
    for (const fixture of fixtures) {
      const config = clone(fixture.config), paused = config.paused;
      config.paused = false;
      const snapshots: Snapshot[] = [{at:this.epoch,revision:1,config,scenario:'normal'}];
      const checkpoint = (at: number, scenario: Scenario) => snapshots.push({at,revision:1,config:clone(config),scenario});
      if (fixture.id === 'demo-tank') {
        checkpoint(now - 210000,'high'); checkpoint(now - 185000,'normal');
        checkpoint(now - 85000,'offline'); checkpoint(now - 70000,'normal');
      }
      checkpoint(now - 60000,fixture.scenario);
      snapshots.sort((a,b) => a.at - b.at);
      if (paused) snapshots.push({at:now - 5000,revision:1,config:{...clone(config),paused:true},scenario:fixture.scenario});
      const plc: VirtualPlc = {id:fixture.id,snapshots,state:{connection:'unknown',last_success:null,variables:{}},events:[],lastTick:-Infinity};
      this.devices.set(plc.id,plc);
      // Seed the last valid reading even when the selected starting scenario is offline.
      for (let index = snapshots.length - 1; index >= 0; index--) {
        const s = snapshots[index];
        if (s.config.paused || s.scenario === 'offline') continue;
        const t = Math.floor((Math.min(now, snapshots[index + 1]?.at ?? now) - 1 - this.epoch) / s.config.interval_ms) * s.config.interval_ms + this.epoch;
        for (const v of s.config.variables) {
          if (!plc.state.variables[v.id]) {
            const sample = this.sample(plc.id,s,v,t);
            plc.state.variables[v.id] = {last_good:sample,quality:'good',error:null,alarm_active:v.high_limit === null ? null : sample.value! > v.high_limit};
            if (!plc.state.last_success || sample.observed_at > plc.state.last_success) plc.state.last_success = sample.observed_at;
          }
        }
      }
      this.advance(plc,now);
    }
  }
  private sample(id: string, snapshot: Snapshot, variable: Variable, time: number): Sample {
    let value: number | null = null;
    if (snapshot.scenario !== 'offline') {
      const t = (time - this.epoch) / 1000;
      const phase = [...variable.id].reduce((sum,c) => sum + c.charCodeAt(0),0) % 13;
      switch (variable.unit) {
        case '°C': value = 25.3 + Math.sin(t / 28 + phase) * 1.8 + Math.sin(t / 9) * .35; break;
        case '%': value = 60 + Math.sin(t / 35 + phase) * 5; break;
        case 'm/s': value = 1.5 + Math.sin(t / 19) * .12; break;
        case 'ciclos': value = 1250 + Math.floor(t / 12) % 5000; break;
        case 'pzs': value = 8400 + Math.floor(t / 3) % 20000; break;
        case 'estado': value = Math.floor(t / 25) % 2; break;
        default: value = 10 + phase + Math.sin(t / 20) * 2;
      }
      if (snapshot.scenario === 'high' && variable.high_limit !== null) value = variable.high_limit + Math.max(1, Math.abs(variable.high_limit) * .1);
      const raw = variable.scale === 0 ? 0 : value / variable.scale;
      value = (variable.data_type === 'float32' ? Math.fround(raw) : variable.data_type === 'int16' ? Math.max(-32768,Math.min(32767,Math.round(raw))) : Math.max(0,Math.min(65535,Math.round(raw)))) * variable.scale;
      value = Number(value.toPrecision(12));
    }
    return {plc_id:id,variable_id:variable.id,revision:snapshot.revision,observed_at:new Date(time).toISOString(),value,quality:value === null ? 'transport_error' : 'good',variable_name:variable.name,unit:variable.unit,plc_name:snapshot.config.name,error:value === null ? 'Interrupción simulada de lecturas' : null};
  }
  private event(plc: VirtualPlc, kind: string, severity: string, message: string, time: number) {
    plc.events.unshift({id:++this.sequence,plc_id:plc.id,kind,severity,message,occurred_at:new Date(time).toISOString()});
    plc.events.length = Math.min(plc.events.length,200);
  }
  private advance(plc: VirtualPlc, now: number) {
    const s = current(plc);
    if (s.config.paused) return;
    const tick = this.epoch + Math.floor((now - this.epoch) / s.config.interval_ms) * s.config.interval_ms;
    if (tick <= plc.lastTick) return;
    plc.lastTick = tick;
    const connection = s.scenario === 'offline' ? 'offline' : 'connected';
    if (connection !== plc.state.connection) this.event(plc,connection === 'connected' ? 'connection_restored' : 'connection_lost',connection === 'connected' ? 'info' : 'error',connection === 'connected' ? 'PLC virtual disponible' : 'Lecturas interrumpidas en la simulación',tick);
    plc.state.connection = connection;
    for (const v of s.config.variables) {
      const sample = this.sample(plc.id,s,v,tick);
      const state = plc.state.variables[v.id] ?? {last_good:null,quality:null,error:null,alarm_active:null};
      if (sample.value !== null) {
        const alarm = v.high_limit === null ? null : sample.value > v.high_limit;
        if (alarm === true && state.alarm_active !== true) this.event(plc,'threshold_exceeded','warning',`${v.name}: ${sample.value} ${v.unit} · umbral superado`,tick);
        if (alarm === false && state.alarm_active === true) this.event(plc,'threshold_recovered','info',`${v.name}: ${sample.value} ${v.unit} · rango recuperado`,tick);
        state.alarm_active = alarm; state.last_good = sample; plc.state.last_success = sample.observed_at;
      }
      state.quality = sample.quality; state.error = sample.error;
      plc.state.variables[v.id] = state;
    }
  }
  private view(plc: VirtualPlc): Plc {
    this.advance(plc,this.now()); const s = current(plc);
    return clone({...s.config,id:plc.id,revision:s.revision,state:plc.state});
  }
  private get(id: string) {
    const plc = this.devices.get(id);
    if (!plc) throw new DemoError('PLC virtual no encontrado',404);
    return plc;
  }
  private change(plc: VirtualPlc, config: Config, scenario = current(plc).scenario) {
    this.advance(plc,this.now());
    const previous = current(plc);
    if (plc.snapshots.length >= 250) throw new DemoError('Reinicia la demo para comenzar otra sesión de cambios');
    plc.snapshots.push({at:this.now(),revision:previous.revision + 1,config:clone(config),scenario});
    for (const id of Object.keys(plc.state.variables)) {
      const before = previous.config.variables.find(v => v.id === id), after = config.variables.find(v => v.id === id);
      if (JSON.stringify(before) !== JSON.stringify(after)) delete plc.state.variables[id];
    }
    this.save();
  }
  private bounds(query: URLSearchParams) {
    const to = query.has('to_ms') ? Number(query.get('to_ms')) : this.now();
    const from = query.has('from_ms') ? Number(query.get('from_ms')) : to - 300000;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from || to - from > DAY) throw new DemoError('El rango debe estar ordenado y abarcar como máximo 24 horas');
    return {from,to};
  }
  private async *readings(plc: VirtualPlc, from: number, to: number, variableId: string | null, signal?: AbortSignal | null): AsyncGenerator<Sample> {
    const snapshots = clone(plc.snapshots); let count = 0;
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      if (s.config.paused) continue;
      const begin = Math.max(from,s.at), end = Math.min(to,(snapshots[i + 1]?.at ?? Infinity) - 1,this.now());
      const interval = s.config.interval_ms;
      const variables = s.config.variables.filter(v => !variableId || v.id === variableId);
      for (let time = this.epoch + Math.ceil((begin - this.epoch) / interval) * interval; time <= end; time += interval) {
        for (const v of variables) {
          if (signal?.aborted) throw new DOMException('Solicitud cancelada','AbortError');
          yield this.sample(plc.id,s,v,time);
          if (++count % 2048 === 0) await new Promise(resolve => setTimeout(resolve,0));
        }
      }
    }
  }
  private async history(plc: VirtualPlc, variableId: string, query: URLSearchParams, signal?: AbortSignal | null): Promise<HistoryResponse> {
    const {from,to} = this.bounds(query);
    const limit = Math.max(6,Math.min(10000,Number(query.get('limit') ?? 2000) || 2000));
    const unit = current(plc).config.variables.find(v => v.id === variableId)?.unit;
    if (unit === undefined) throw new DemoError('Variable no encontrada',404);
    const count = Math.max(1,Math.floor(limit / 6)), width = Math.max(1,Math.ceil((to - from + 1) / count));
    const buckets: Bucket[] = Array.from({length:count},() => ({samples:[]}));
    let raw: Sample[] | undefined = [], sourceCount = 0, lastGood: number | undefined, gapStart: number | undefined;
    const gap = (a: number,b: number) => {
      if (b <= a) return;
      for (let i = Math.max(0,Math.floor((a-from)/width)); i <= Math.min(count-1,Math.floor((b-from)/width)); i++) {
        const start = Math.max(from,a,from+i*width), end = Math.min(to,b,from+(i+1)*width);
        if (end <= start) continue;
        const previous = buckets[i].gap;
        buckets[i].gap = {from_ms:Math.min(start,previous?.from_ms ?? start),to_ms:Math.max(end,previous?.to_ms ?? end)};
      }
    };
    const good = (s: Sample) => s.quality === 'good' && s.value !== null && s.unit === unit;
    const interval = current(plc).config.interval_ms, tolerance = Math.max(interval*2.5,interval+current(plc).config.timeout_ms);
    for await (const sample of this.readings(plc,from,to,variableId,signal)) {
      sourceCount++; const time = stamp(sample);
      if (raw) { raw.push(sample); if (raw.length > limit) raw = undefined; }
      if (!good(sample)) gapStart ??= lastGood === undefined ? time-interval/2 : lastGood+interval/2;
      else {
        if (gapStart !== undefined) { gap(gapStart,time-interval/2); gapStart = undefined; }
        else if (lastGood !== undefined && time-lastGood>tolerance) gap(lastGood+interval/2,time-interval/2);
        lastGood = time;
      }
      const bucket = buckets[Math.min(count-1,Math.max(0,Math.floor((time-from)/width)))];
      const points = [...bucket.samples,sample], valid = points.filter(good), invalid = points.filter(s => !good(s));
      const min = valid.reduce<Sample | undefined>((a,b) => !a || b.value! < a.value! ? b : a,undefined);
      const max = valid.reduce<Sample | undefined>((a,b) => !a || b.value! > a.value! ? b : a,undefined);
      const keep = new Set([points[0],sample,min,max,invalid[0],invalid.at(-1)]);
      bucket.samples = points.filter(s => keep.has(s));
    }
    if (gapStart !== undefined) gap(gapStart,to);
    else if (lastGood !== undefined && to-lastGood>tolerance) gap(lastGood+interval/2,to);
    if (raw) return {samples:raw,truncated:false,aggregated:false,source_count:sourceCount,from_ms:from,to_ms:to};
    const gaps: Gap[] = [];
    for (const bucket of buckets) if (bucket.gap) {
      const last = gaps.at(-1);
      if (last && last.to_ms >= bucket.gap.from_ms) last.to_ms = Math.max(last.to_ms,bucket.gap.to_ms);
      else gaps.push(bucket.gap);
    }
    return {samples:buckets.flatMap(b => b.samples),gaps,truncated:false,aggregated:true,bucket_ms:width,source_count:sourceCount,from_ms:from,to_ms:to};
  }
  private async csv(plc: VirtualPlc, query: URLSearchParams, signal?: AbortSignal | null) {
    const {from,to} = this.bounds(query);
    const quote = (value: unknown) => '"'+String(value ?? '').replaceAll('"','""')+'"';
    const chunks = ['id_equipo,nombre_equipo,id_variable,variable,fecha_hora_utc,valor,unidad,calidad,revision\r\n'];
    let rows = 0;
    for await (const sample of this.readings(plc,from,to,null,signal)) {
      if (++rows > 100000) throw new DemoError('Acerca el intervalo de la gráfica para exportar hasta 100.000 lecturas de esta demo');
      chunks.push([sample.plc_id,sample.plc_name,sample.variable_id,sample.variable_name,sample.observed_at,sample.value,sample.unit,sample.quality,sample.revision].map(quote).join(',')+'\r\n');
    }
    return new Response(new Blob(chunks,{type:'text/csv;charset=utf-8'}),{headers:{'content-type':'text/csv;charset=utf-8'}});
  }
  async handle(path: string, options: RequestInit = {}): Promise<Response> {
    if (options.signal?.aborted) throw new DOMException('Solicitud cancelada','AbortError');
    try {
      const url = new URL(path,'https://demo.invalid'), method = options.method ?? 'GET';
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (url.pathname === '/api/health' && method === 'GET') return json({status:'ok',demo:true,demo_ids:[...this.devices.keys()],storage_error:null});
      if (url.pathname === '/api/plcs' && method === 'GET') {
        const plcs = [...this.devices.values()].map(p => this.view(p));
        return json({plcs,summary:{total:plcs.length,connected:plcs.filter(p => p.state.connection === 'connected').length,offline:plcs.filter(p => p.state.connection === 'offline').length,warnings:plcs.filter(p => Object.values(p.state.variables).some(v => v.alarm_active === true)).length}});
      }
      const body = () => { try { return JSON.parse(String(options.body ?? '{}')); } catch { throw new DemoError('JSON no válido'); } };
      if (url.pathname === '/api/plcs' && method === 'POST') {
        if (this.devices.size >= 10) throw new DemoError('Esta demo admite hasta 10 PLC virtuales. Reinicia los ejemplos para comenzar de nuevo.');
        const config = validate(body()), id = crypto.randomUUID();
        const plc: VirtualPlc = {id,snapshots:[{at:this.now(),revision:1,config,scenario:'normal'}],state:{connection:'unknown',last_success:null,variables:{}},events:[],lastTick:-Infinity};
        this.devices.set(id,plc); this.save(); return json(this.view(plc),201);
      }
      if (parts[0] === 'api' && parts[1] === 'demo' && parts[2] === 'plcs' && parts[4] === 'scenario' && method === 'PUT') {
        const plc = this.get(parts[3]), scenario = body().scenario;
        if (!['normal','high','offline'].includes(scenario)) throw new DemoError('Escenario no válido');
        this.change(plc,current(plc).config,scenario); return json(this.view(plc));
      }
      if (parts[0] !== 'api' || parts[1] !== 'plcs') throw new DemoError('Ruta no disponible',404);
      const plc = this.get(parts[2]);
      if (parts.length === 3 && method === 'GET') return json(this.view(plc));
      if (parts.length === 3 && method === 'PUT') {
        const input = body();
        if (input.expected_revision !== current(plc).revision) throw new DemoError('La configuración cambió. Abre el formulario de nuevo.',409);
        this.change(plc,validate(input)); return json(this.view(plc));
      }
      if (parts[3] === 'acquisition' && method === 'PUT') {
        const running = body().running;
        if (typeof running !== 'boolean') throw new DemoError('Estado de adquisición no válido');
        if (current(plc).config.paused === running) this.change(plc,{...current(plc).config,paused:!running});
        return json(this.view(plc));
      }
      if (parts[3] === 'history' && method === 'GET') return json(await this.history(plc,url.searchParams.get('variable_id') ?? '',url.searchParams,options.signal));
      if (parts[3] === 'events' && method === 'GET') {
        this.advance(plc,this.now()); return json({events:clone(plc.events.slice(0,50)),next_before_id:null});
      }
      if (parts[3] === 'export.csv' && method === 'GET') return await this.csv(plc,url.searchParams,options.signal);
      throw new DemoError('Ruta no disponible',404);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return json({message:error instanceof Error ? error.message : 'No se pudo completar la operación'},error instanceof DemoError ? error.status : 500);
    }
  }
}
function storage() { try { return globalThis.localStorage; } catch { return undefined; } }
const demo = new BrowserDemo(Date.now,storage());
export const demoRequest = (path: string, options?: RequestInit) => demo.handle(path,options);
export const resetDemo = () => demo.reset();

import { expect, test } from '@playwright/test';
import { BrowserDemo } from '../src/browser-demo';
import type { Plc, HistoryResponse } from '../src/types';

function model() {
  let now = Date.parse('2026-11-13T12:00:00Z');
  const cache = new Map<string,string>();
  const storage = { getItem:(key:string) => cache.get(key) ?? null, setItem:(key:string,value:string) => { cache.set(key,value); }, removeItem:(key:string) => { cache.delete(key); } };
  const demo = new BrowserDemo(() => now,storage);
  return { demo, storage, clock:() => now, tick:(ms:number) => { now += ms; } };
}
const get = async (demo:BrowserDemo,id='demo-tank'):Promise<Plc> => (await demo.handle('/api/plcs/'+id)).json();
const put = (demo:BrowserDemo,path:string,body:unknown) => demo.handle(path,{method:'PUT',body:JSON.stringify(body)});

test('el historial conserva valores, interrupciones y picos también al resumir 24 horas',async()=>{
  const {demo,clock}=model();
  const query=`variable_id=tank-temperature&from_ms=${clock()-86400000}&to_ms=${clock()}`;
  const overview:HistoryResponse=await(await demo.handle('/api/plcs/demo-tank/history?'+query)).json();
  expect(overview.aggregated).toBe(true);
  expect(overview.source_count).toBe(86401);
  expect(overview.samples.length).toBeLessThanOrEqual(2000);
  expect(Math.max(...overview.samples.map(s=>s.value ?? -Infinity))).toBe(88);
  expect(overview.gaps?.some(g=>g.from_ms<=clock()-80000 && g.to_ms>=clock()-75000)).toBe(true);
  const raw:HistoryResponse=await(await demo.handle(`/api/plcs/demo-tank/history?variable_id=tank-temperature&from_ms=${clock()-90000}&to_ms=${clock()-60000}`)).json();
  expect(raw.aggregated).toBe(false);
  expect(raw.samples).toHaveLength(31);
  expect(raw.samples.filter(s=>s.quality!=='good')).toHaveLength(15);
  expect(raw.samples.filter(s=>s.quality!=='good').every(s=>s.value===null)).toBe(true);
});

test('la pausa aísla un PLC y los avisos se recuperan sin duplicar transiciones',async()=>{
  const {demo,tick}=model();
  const before=await get(demo);
  await put(demo,'/api/plcs/demo-tank/acquisition',{running:false});
  tick(5000);
  expect((await get(demo)).state.last_success).toBe(before.state.last_success);
  expect((await get(demo,'demo-oven')).state.last_success).not.toBe(before.state.last_success);
  await put(demo,'/api/plcs/demo-tank/acquisition',{running:true});
  await put(demo,'/api/demo/plcs/demo-tank/scenario',{scenario:'high'});
  tick(1000);
  expect((await get(demo)).state.variables['tank-temperature'].alarm_active).toBe(true);
  await get(demo); await get(demo);
  let events=await(await demo.handle('/api/plcs/demo-tank/events')).json();
  expect(events.events.filter((e:{kind:string})=>e.kind==='threshold_exceeded')).toHaveLength(1);
  await put(demo,'/api/demo/plcs/demo-tank/scenario',{scenario:'normal'});
  tick(1000);
  expect((await get(demo)).state.variables['tank-temperature'].alarm_active).toBe(false);
  events=await(await demo.handle('/api/plcs/demo-tank/events')).json();
  expect(events.events.filter((e:{kind:string})=>e.kind==='threshold_recovered')).toHaveLength(1);
});

test('valida configuración y revisiones y persiste solo los ajustes locales',async()=>{
  const {demo,storage,clock}=model();
  const plc=await get(demo);
  const collision=structuredClone(plc);
  collision.variables[1].address=0;
  expect((await put(demo,'/api/plcs/demo-tank',{...collision,expected_revision:plc.revision})).status).toBe(422);
  expect((await put(demo,'/api/plcs/demo-tank',{...plc,expected_revision:0})).status).toBe(409);
  expect((await put(demo,'/api/plcs/demo-tank',{...plc,name:'Tanque principal',expected_revision:plc.revision})).status).toBe(200);
  const reloaded=new BrowserDemo(clock,storage);
  expect((await get(reloaded)).name).toBe('Tanque principal');
  reloaded.reset();
  expect((await get(reloaded)).name).toBe('Tanque de mezcla');
  const blocked=new BrowserDemo(clock,{getItem:()=>{throw Error('Blocked');},setItem:()=>{throw Error('Quota');},removeItem:()=>{throw Error('Blocked');}});
  expect((await(await blocked.handle('/api/plcs')).json()).plcs).toHaveLength(3);
  blocked.reset();
  expect((await blocked.handle('/api/plcs')).status).toBe(200);
});

test('CSV mantiene ceros, fallos vacíos, nombres escapados e identidad del equipo',async()=>{
  const {demo,clock,tick}=model();
  const plc=await get(demo);
  plc.variables[0].scale=0;
  await put(demo,'/api/plcs/demo-tank',{...plc,name:'Tanque, "A"',expected_revision:plc.revision});
  tick(1000);
  await put(demo,'/api/demo/plcs/demo-tank/scenario',{scenario:'offline'});
  tick(1000);
  const response=await demo.handle(`/api/plcs/demo-tank/export.csv?from_ms=${clock()-2000}&to_ms=${clock()}`);
  expect(response.status).toBe(200);
  const csv=await response.text();
  expect(csv).toContain('"Tanque, ""A"""');
  expect(csv).toContain(',"0","°C","good",');
  expect(csv).toContain(',"","°C","transport_error",');
  expect(csv).not.toContain('demo-oven');
});

test('limita exportaciones y admite cancelar el cálculo de un historial largo',async()=>{
  const {demo,clock}=model();
  const response=await demo.handle(`/api/plcs/demo-tank/export.csv?from_ms=${clock()-86400000}&to_ms=${clock()}`);
  expect(response.status).toBe(422);
  expect((await response.json()).message).toContain('100.000');
  const controller=new AbortController();
  const pending=demo.handle(`/api/plcs/demo-tank/history?variable_id=tank-temperature&from_ms=${clock()-86400000}&to_ms=${clock()}`,{signal:controller.signal});
  controller.abort();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
});

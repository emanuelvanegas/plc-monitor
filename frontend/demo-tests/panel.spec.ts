import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('Pages funciona sin API: escenarios, pausa, recuperación, zoom fluido y CSV',async({page})=>{
  const apiRequests:string[]=[], errors:string[]=[];
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('./');
  await expect(page.locator('#browser-demo')).toBeVisible();
  await expect(page.locator('#mode-label')).toHaveText('Demo en navegador');
  await expect(page.locator('[data-device-id]')).toHaveCount(3);
  await expect.poll(()=>page.locator('.trend-line').count()).toBeGreaterThan(0);
  await expect(page.locator('.trend-gap')).toHaveCount(1);
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(page.locator('#metrics-container')).toContainText('Umbral superado');
  await page.locator('#btn-pause').click();
  await expect(page.locator('#info-state')).toHaveText('Adquisición pausada');
  await page.locator('[data-device-id="demo-tank"]').click();
  await page.locator('#btn-sim-off').click();
  await expect(page.locator('#det-badge')).toHaveText('Sin conexión');
  await expect(page.locator('#metrics-container')).toContainText('Datos desactualizados');
  await page.locator('#btn-sim-norm').click();
  await expect(page.locator('#det-badge')).toHaveText('Conectado');
  const animation=await page.locator('#chart-canvas svg').evaluate(async svg=>{
    const span=()=>Number((svg as SVGSVGElement).dataset.to)-Number((svg as SVGSVGElement).dataset.from);
    const before=span(),rect=svg.getBoundingClientRect(),frames:number[]=[];
    svg.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,clientX:rect.left+rect.width*.6,clientY:rect.top+100,bubbles:true,cancelable:true}));
    await new Promise<void>(resolve=>{const start=performance.now();const collect=()=>{frames.push(span());if(performance.now()-start<700)requestAnimationFrame(collect);else resolve();};requestAnimationFrame(collect);});
    return {before,after:span(),frames};
  });
  expect(animation.after).toBeLessThan(animation.before*.6);
  expect(new Set(animation.frames.map(Math.round)).size).toBeGreaterThan(5);
  await page.locator('#chart-live').click();
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#btn-export').click();
  const download=await downloadPromise;
  const csv=await readFile((await download.path())!,'utf8');
  expect(csv).toContain('transport_error');
  expect(csv).not.toContain('demo-oven');
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(page.locator('#info-state')).toHaveText('Adquisición pausada');
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('configuración local, visitantes aislados, reinicio y selector en móvil',async({page,browser,baseURL})=>{
  await page.goto('./');
  await page.locator('#btn-add').click();
  await page.locator('#cfg-name').fill('PLC de mi navegador');
  await page.locator('#cfg-location').fill('Laboratorio');
  await page.getByRole('button',{name:'Guardar equipo',exact:true}).click();
  await expect(page.locator('[data-device-id]')).toHaveCount(4);
  await page.reload();
  await expect(page.locator('[data-device-id]')).toHaveCount(4);
  await expect(page.locator('#device-list')).toContainText('PLC de mi navegador');
  const visitor=await browser.newContext();
  try {
    const other=await visitor.newPage();await other.goto(baseURL!);
    await expect(other.locator('[data-device-id]')).toHaveCount(3);
    await expect(other.locator('#device-list')).not.toContainText('PLC de mi navegador');
  } finally { await visitor.close(); }
  await page.locator('#btn-reset-demo').click();
  await expect(page.locator('[data-device-id]')).toHaveCount(3);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#chart-variable').selectOption('tank-level');
  await expect(page.locator('#chart-unit')).toHaveText('%');
  await expect(page.locator('#chart-canvas svg')).toHaveAttribute('data-variable-id','tank-level');
  await page.locator('#chart-variable').selectOption('tank-cycles');
  await expect(page.locator('#chart-unit')).toHaveText('ciclos');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

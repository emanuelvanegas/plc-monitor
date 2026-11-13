import { expect, test, type Page } from '@playwright/test';
import type { Sample } from '../src/types';

async function showHistory(page: Page, points: { ago: number; value: number | null; revision?: number; unit?: string; quality?: string }[]) {
  await page.route('**/api/plcs/demo-tank/history?*', async route => {
    const now = Date.now();
    const samples: Sample[] = points.map(point => ({
      plc_id: 'demo-tank', variable_id: 'tank-temperature', revision: point.revision ?? 1,
      observed_at: new Date(now - point.ago).toISOString(), value: point.value,
      quality: point.quality ?? 'good', variable_name: 'Temperatura', unit: point.unit ?? '°C',
      plc_name: 'Tanque de mezcla', error: point.value === null ? 'Timeout de lectura' : null,
    }));
    await route.fulfill({ json: { samples, truncated: false } });
  });
  await page.goto('/');
  await expect(page.locator('#chart-canvas svg')).toBeVisible();
}

test('la curva no se corta solo porque cambió la revisión administrativa', async ({ page }) => {
  await showHistory(page, [
    { ago: 4000, value: 25.3, revision: 1 },
    { ago: 3000, value: 25.3, revision: 1 },
    { ago: 2000, value: 25.3, revision: 3 },
    { ago: 1000, value: 25.3, revision: 3 },
  ]);
  await expect(page.locator('.trend-line')).toHaveCount(1);
  await expect(page.locator('.trend-gap')).toHaveCount(0);
  await expect(page.locator('.trend-line')).toHaveAttribute('vector-effect', 'non-scaling-stroke');
});

test('una lectura fallida conserva el hueco y lo identifica sin inventar valores', async ({ page }) => {
  await showHistory(page, [
    { ago: 4000, value: 0 },
    { ago: 3000, value: null, quality: 'timeout' },
    { ago: 2000, value: 0 },
    { ago: 1000, value: 25.3 },
  ]);
  await expect(page.locator('.trend-line')).toHaveCount(2);
  await expect(page.locator('.trend-gap')).toHaveCount(1);
  await expect(page.locator('#chart-quality')).toContainText('1 intervalo sin muestras');
  await expect(page.locator('.trend-gap title')).toContainText('Sin muestras');
});

test('una pausa larga sin registros no se dibuja como una lectura continua', async ({ page }) => {
  await showHistory(page, [
    { ago: 23000, value: 25.3 },
    { ago: 22000, value: 25.3 },
    { ago: 2000, value: 25.3 },
    { ago: 1000, value: 25.3 },
  ]);
  await expect(page.locator('.trend-line')).toHaveCount(2);
  await expect(page.locator('.trend-gap')).toHaveCount(1);
});

test('valores de unidades distintas no se unen en la misma curva', async ({ page }) => {
  await showHistory(page, [
    { ago: 4000, value: 25.3 },
    { ago: 3000, value: 77.5, unit: '°F' },
    { ago: 2000, value: 25.3 },
    { ago: 1000, value: 25.3 },
  ]);
  await expect(page.locator('.trend-line')).toHaveCount(2);
  await expect(page.locator('.trend-gap')).toHaveCount(1);
});

const windowOf = (page: Page) => page.locator('#chart-canvas svg').evaluate(svg => ({
  from:Number((svg as SVGSVGElement).dataset.from), to:Number((svg as SVGSVGElement).dataset.to),
  targetFrom:Number((svg as SVGSVGElement).dataset.targetFrom), targetTo:Number((svg as SVGSVGElement).dataset.targetTo),
}));
async function settled(page: Page) {
  // Let the scheduled animation publish its new target before checking equality.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(async () => {
    const w = await windowOf(page);
    return Math.max(Math.abs(w.from - w.targetFrom), Math.abs(w.to - w.targetTo));
  }).toBeLessThan(1);
}

test('la rueda anima múltiples cuadros alrededor del cursor y el sondeo no restablece el zoom', async ({ page }) => {
  await showHistory(page, Array.from({ length:300 }, (_, i) => ({ ago:(300 - i) * 1000, value:25 + Math.sin(i / 10) })));
  await expect(page.locator('.trend-line')).toHaveCount(1);
  const result = await page.locator('#chart-canvas svg').evaluate(async element => {
    const svg = element as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    const x = 64 + (rect.width - 80) * .72;
    const before = { from:Number(svg.dataset.from), to:Number(svg.dataset.to) };
    const frames: { from:number; to:number; stamp:number }[] = [];
    const wheel = new WheelEvent('wheel', { deltaY:-240, clientX:rect.left + x, clientY:rect.top + 100, bubbles:true, cancelable:true });
    const fraction = (wheel.clientX - rect.left - 64) / (rect.width - 80);
    svg.dispatchEvent(wheel);
    await new Promise<void>(resolve => {
      const start = performance.now();
      const collect = (stamp: number) => {
        frames.push({ from:Number(svg.dataset.from), to:Number(svg.dataset.to), stamp });
        if (stamp - start < 700) requestAnimationFrame(collect); else resolve();
      };
      requestAnimationFrame(collect);
    });
    return { before, frames, fraction, targetFrom:Number(svg.dataset.targetFrom), targetTo:Number(svg.dataset.targetTo) };
  });
  const originalSpan = result.before.to - result.before.from;
  const finalSpan = result.targetTo - result.targetFrom;
  expect(finalSpan).toBeLessThan(originalSpan * .6);
  const spans = result.frames.map(f => f.to - f.from);
  expect(spans.filter(s => s < originalSpan - 10 && s > finalSpan + 10).length).toBeGreaterThan(4);
  expect(new Set(spans.map(Math.round)).size).toBeGreaterThan(5);
  const anchor = result.before.from + originalSpan * result.fraction;
  for (const frame of result.frames) expect(Math.abs(frame.from + (frame.to - frame.from) * result.fraction - anchor)).toBeLessThan(2);
  await settled(page);
  const after = await windowOf(page);
  await expect(page.locator('#chart-status')).toHaveText('Explorando historial');
  // Wait for at least two actual fleet polls; zoom must remain fixed across them.
  await page.waitForResponse(r => r.url().endsWith('/api/plcs') && r.request().method() === 'GET');
  await page.waitForResponse(r => r.url().endsWith('/api/plcs') && r.request().method() === 'GET');
  expect(await windowOf(page)).toEqual(after);
  await page.locator('#chart-live').click();
  await settled(page);
  await expect(page.locator('#chart-status')).toHaveText('● En vivo');
  const live = await windowOf(page);
  expect(Math.round(live.to - live.from)).toBe(300000);
});

test('periodos, desplazamiento, rango personalizado y CSV usan el intervalo visible', async ({ page }) => {
  await showHistory(page, [{ ago:2000, value:25.3 }, { ago:1000, value:25.4 }]);
  const requested = page.waitForRequest(r => r.url().includes('/demo-tank/history?') && new URL(r.url()).searchParams.get('to_ms') !== null && Number(new URL(r.url()).searchParams.get('to_ms')) - Number(new URL(r.url()).searchParams.get('from_ms')) === 3600000);
  await page.locator('#chart-period').selectOption('3600000');
  await requested;
  let w = await windowOf(page);
  expect(w.to - w.from).toBe(3600000);
  await page.locator('#chart-zoom-in').click(); await settled(page);
  const zoomed = await windowOf(page);
  const box = (await page.locator('#chart-canvas svg').boundingBox())!;
  await page.mouse.move(box.x + box.width * .65, box.y + 120);
  await page.mouse.down(); await page.mouse.move(box.x + box.width * .8, box.y + 120, { steps:8 }); await page.mouse.up();
  const panned = await windowOf(page);
  expect(panned.from).toBeLessThan(zoomed.from);
  expect(Math.abs((panned.to - panned.from) - (zoomed.to - zoomed.from))).toBeLessThan(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name:'Exportar CSV' }).click();
  const exported = new URL((await download).url());
  expect(Number(exported.searchParams.get('from_ms'))).toBe(Math.ceil(panned.from));
  expect(Number(exported.searchParams.get('to_ms'))).toBe(Math.floor(panned.to));
  await page.locator('#chart-period').selectOption('custom');
  await page.locator('#chart-from').fill('2026-11-10T10:00:00');
  await page.locator('#chart-to').fill('2026-11-10T11:00:00');
  await page.getByRole('button', { name:'Aplicar', exact:true }).click();
  w = await windowOf(page);
  expect(w.from).toBe(Date.parse('2026-11-10T10:00:00-05:00'));
  expect(w.to).toBe(Date.parse('2026-11-10T11:00:00-05:00'));
  await expect(page.locator('#chart-status')).toHaveText('Periodo fijo');
  await page.locator('#chart-to').fill('2026-11-12T11:00:00');
  await page.getByRole('button', { name:'Aplicar', exact:true }).click();
  await expect(page.locator('#chart-error')).toContainText('máximo 24 horas');
  expect((await windowOf(page)).from).toBe(w.from);
});

test('el resumen conserva picos y huecos, y al acercar pide muestras de detalle', async ({ page }) => {
  const end = Date.now();
  const sample = (ago: number, value: number): Sample => ({ plc_id:'demo-tank', variable_id:'tank-temperature', revision:1, observed_at:new Date(end - ago).toISOString(), value, quality:'good', variable_name:'Temperatura', unit:'°C', plc_name:'Tanque', error:null });
  await page.route('**/api/plcs/demo-tank/history?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    const from = Number(params.get('from_ms')), to = Number(params.get('to_ms'));
    if (to - from > 250000) await route.fulfill({ json: {
      samples:[sample(290000, 25), sample(220000, 95), sample(160000, 25), sample(70000, 26), sample(1000, 25)],
      aggregated:true, bucket_ms:90000, source_count:20000, gaps:[{ from_ms:end - 150000, to_ms:end - 100000 }], truncated:false,
    } });
    else await route.fulfill({ json:{ samples:[sample(220000, 95), sample(219000, 25)], truncated:false } });
  });
  await page.goto('/');
  await expect(page.locator('#chart-quality')).toContainText('picos conservados');
  await expect(page.locator('.trend-gap')).toHaveCount(1);
  // Irregular representative spacing must not introduce additional false gaps.
  await expect(page.locator('.trend-line')).toHaveCount(2);
  const request = page.waitForRequest(r => r.url().includes('/demo-tank/history?') && Number(new URL(r.url()).searchParams.get('to_ms')) - Number(new URL(r.url()).searchParams.get('from_ms')) < 250000);
  await page.locator('#chart-zoom-in').click();
  await page.locator('#chart-zoom-in').click();
  await request; await settled(page);
  await expect(page.locator('#chart-quality')).not.toContainText('Vista resumida');
});

test('movimiento reducido, teclado y móvil mantienen controles utilizables', async ({ page }) => {
  await page.emulateMedia({ reducedMotion:'reduce' });
  await showHistory(page, [{ ago:2000, value:25.3 }, { ago:1000, value:25.4 }]);
  const svg = page.locator('#chart-canvas svg');
  await svg.focus(); await page.keyboard.press('+');
  let w = await windowOf(page);
  expect(w.to - w.from).toBe(180000);
  expect(w.from).toBe(w.targetFrom);
  await page.keyboard.press('ArrowLeft');
  expect((await windowOf(page)).from).toBeLessThan(w.from);
  await page.keyboard.press('+');
  for (let i = 0; i < 24; i++) await page.keyboard.press('+');
  w = await windowOf(page);
  expect(w.to - w.from).toBe(2000);
  await page.keyboard.press('+');
  expect(await windowOf(page)).toEqual(w);
  await page.keyboard.press('Home');
  await expect(page.locator('#chart-status')).toHaveText('● En vivo');
  await page.setViewportSize({ width:390, height:844 });
  await expect(page.locator('#chart-zoom-in')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = (await svg.boundingBox())!;
  expect(box.width).toBeLessThan(390);
});

test('el cursor consulta muestras reales y la rueda fuera del área conserva el scroll de página', async ({ page }) => {
  await showHistory(page, [{ ago:4000, value:25.3123456789 }, { ago:3000, value:null, quality:'timeout' }, { ago:2000, value:25.4123456789 }, { ago:1000, value:25.5123456789 }]);
  await expect(page.locator('.trend-line')).toHaveCount(2);
  const result = await page.locator('#chart-canvas svg').evaluate(svg => {
    const rect = svg.getBoundingClientRect();
    const above = new WheelEvent('wheel', { deltaY:-100, clientX:rect.left + 100, clientY:rect.top + 5, bubbles:true, cancelable:true });
    svg.dispatchEvent(above);
    return above.defaultPrevented;
  });
  expect(result).toBe(false);
  const w = await windowOf(page);
  const box = (await page.locator('#chart-canvas svg').boundingBox())!;
  await page.mouse.move(box.x + box.width - 16 - (box.width - 80) * 1000 / (w.to - w.from), box.y + 120);
  await expect(page.locator('.trend-tooltip')).toContainText('25,5123456789');
  await expect(page.locator('.trend-tooltip')).toContainText('Bogotá');
  await page.mouse.move(box.x + 64 + (box.width - 80) * .5, box.y + 120);
  await expect(page.locator('.trend-tooltip')).toContainText('Sin lectura');
});

test('el selector muestra una sola variable, conserva el zoom y recuerda la elección de cada PLC', async ({ page }) => {
  await page.route('**/api/plcs/*/history?*', async route => {
    const id = new URL(route.request().url()).searchParams.get('variable_id')!;
    const unit = id.includes('temperature') ? '°C' : id.includes('cycles') ? 'ciclos' : '%';
    const value = unit === '°C' ? 25.3 : unit === 'ciclos' ? 1250 : 60;
    const now = Date.now();
    await route.fulfill({ json:{ samples:[4000, 3000, 2000, 1000].map(ago => ({
      plc_id:id.startsWith('oven') ? 'demo-oven' : 'demo-tank', variable_id:id, revision:1,
      observed_at:new Date(now - ago).toISOString(), value, quality:'good', variable_name:id, unit, plc_name:'PLC', error:null,
    })), truncated:false } });
  });
  await page.goto('/');
  const selector = page.getByRole('combobox', { name:'Variable de la gráfica' });
  await expect(selector.locator('option')).toHaveCount(3);
  await expect(selector).toHaveValue('tank-temperature');
  await expect(page.locator('#chart-unit')).toContainText('°C · Límite 80');
  await expect(page.locator('.trend-line')).toHaveCount(1);
  await page.locator('#chart-zoom-in').click(); await settled(page);
  const before = await windowOf(page);
  const levelRequest = page.waitForRequest(r => r.url().includes('/demo-tank/history?') && new URL(r.url()).searchParams.get('variable_id') === 'tank-level');
  await selector.selectOption('tank-level'); await levelRequest;
  await expect(page.locator('#chart-unit')).toHaveText('%');
  await expect(page.locator('#chart-canvas svg')).toHaveAttribute('data-variable-id', 'tank-level');
  await expect(page.locator('#chart-canvas svg')).toHaveAttribute('aria-label', /Historial de Nivel/);
  await expect(page.locator('.trend-line')).toHaveCount(1);
  expect(await windowOf(page)).toEqual(before);
  await page.waitForResponse(r => r.url().endsWith('/api/plcs'));
  await expect(selector).toHaveValue('tank-level');
  expect(await windowOf(page)).toEqual(before);
  await selector.selectOption('tank-cycles');
  await expect(page.locator('#chart-unit')).toHaveText('ciclos');
  await expect(page.locator('#chart-canvas svg')).toHaveAttribute('aria-label', /Historial de Ciclos/);
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(selector).toHaveValue('oven-temperature');
  await selector.selectOption('oven-humidity');
  await page.locator('[data-device-id="demo-tank"]').click();
  await expect(selector).toHaveValue('tank-cycles');
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(selector).toHaveValue('oven-humidity');
  await expect(page.locator('#chart-canvas svg')).toHaveCount(1);
  await page.setViewportSize({ width:390, height:844 });
  await expect(selector).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('una respuesta tardía de otra variable no reemplaza la tendencia elegida', async ({ page }) => {
  let releaseLevel!: () => void;
  const levelGate = new Promise<void>(resolve => { releaseLevel = resolve; });
  await page.route('**/api/plcs/demo-tank/history?*', async route => {
    const id = new URL(route.request().url()).searchParams.get('variable_id')!;
    if (id === 'tank-level') await levelGate;
    const now = Date.now();
    await route.fulfill({ json:{ samples:[2000, 1000].map(ago => ({ plc_id:'demo-tank', variable_id:id, revision:1, observed_at:new Date(now - ago).toISOString(), value:id === 'tank-level' ? 99999 : id === 'tank-cycles' ? 1250 : 25.3, quality:'good', variable_name:id, unit:id === 'tank-level' ? '%' : id === 'tank-cycles' ? 'ciclos' : '°C', plc_name:'Tanque', error:null })), truncated:false } });
  });
  await page.goto('/');
  await expect(page.locator('.trend-line')).toHaveCount(1);
  const selector = page.locator('#chart-variable');
  const pending = page.waitForRequest(r => new URL(r.url()).searchParams.get('variable_id') === 'tank-level');
  await selector.selectOption('tank-level'); await pending;
  await selector.selectOption('tank-cycles');
  await expect(page.locator('.trend-line')).toHaveCount(1);
  releaseLevel();
  await page.waitForResponse(r => r.url().endsWith('/api/plcs'));
  await expect(page.locator('#chart-unit')).toHaveText('ciclos');
  await expect(page.locator('#chart-canvas svg')).toHaveAttribute('data-variable-id', 'tank-cycles');
  const w = await windowOf(page), box = (await page.locator('#chart-canvas svg').boundingBox())!;
  await page.mouse.move(box.x + box.width - 16 - (box.width - 80) * 1000 / (w.to - w.from), box.y + 120);
  await expect(page.locator('.trend-tooltip')).toContainText('1.250 ciclos');
  await expect(page.locator('#chart-canvas')).not.toContainText('99999');
});

test('si se elimina la variable elegida vuelve a una variable disponible', async ({ page }) => {
  let removeLevel = false;
  await page.route('**/api/plcs', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (removeLevel) body.plcs.find((d: { id:string }) => d.id === 'demo-tank').variables = body.plcs.find((d: { id:string }) => d.id === 'demo-tank').variables.filter((v: { id:string }) => v.id !== 'tank-level');
    await route.fulfill({ json:body });
  });
  await page.goto('/');
  const selector = page.locator('#chart-variable');
  await selector.selectOption('tank-level');
  await expect(page.locator('#chart-unit')).toHaveText('%');
  removeLevel = true;
  await expect(selector).toHaveValue('tank-temperature');
  await expect(selector.locator('option')).toHaveCount(2);
  await expect(page.locator('#chart-unit')).toContainText('°C');
  // The real backend retains outages produced by the earlier recovery test.
  await expect.poll(() => page.locator('.trend-line').count()).toBeGreaterThan(0);
});

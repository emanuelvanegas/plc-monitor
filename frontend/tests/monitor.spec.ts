import { expect, test } from '@playwright/test';

test('adquisición TCP, aislamiento, recuperación, pausa, exportación y configuración', async ({page, request}) => {
  await page.goto('/');
  await expect(page.locator('[data-device-id]')).toHaveCount(3);
  await expect(page.locator('#metrics-container')).toContainText('25,3');
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(page.locator('#metrics-container')).toContainText('Umbral superado');
  await page.getByRole('button', {name:'Pausar adquisición de Horno de secado'}).click();
  await expect(page.locator('#info-state')).toHaveText('Adquisición pausada');
  const oven = await (await request.get('/api/plcs/demo-oven')).json();
  await page.locator('[data-device-id="demo-tank"]').click();
  await page.getByRole('button', {name:'Sin conexión',exact:true}).click();
  await expect(page.locator('#det-badge')).toHaveText('Sin conexión');
  await expect(page.locator('#metrics-container')).toContainText('Datos desactualizados');
  expect((await (await request.get('/api/plcs/demo-oven')).json()).state.last_success).toBe(oven.state.last_success);
  await page.getByRole('button', {name:'Normal',exact:true}).click();
  await expect(page.locator('#det-badge')).toHaveText('Conectado');
  await expect(page.locator('#metrics-container')).toContainText('25,3');

  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Exportar CSV'}).click();
  const download=await downloadPromise;
  expect(download.suggestedFilename()).toContain('demo-tank');
  const csv=await (await request.get('/api/plcs/demo-tank/export.csv')).text();
  expect(csv).toContain('id_equipo');expect(csv).toContain('transport_error');expect(csv).not.toContain('demo-oven');

  await page.getByRole('button',{name:'Configurar',exact:true}).click();
  await page.locator('#cfg-name').fill('Tanque principal');
  await page.getByRole('button',{name:'Guardar equipo',exact:true}).click();
  await expect(page.locator('#det-name')).toHaveText('Tanque principal');
  await page.locator('[data-device-id="demo-oven"]').click();
  await expect(page.locator('#info-state')).toHaveText('Adquisición pausada');
  await page.getByRole('button',{name:'Reanudar adquisición de Horno de secado'}).click();
  await expect(page.locator('#info-state')).toHaveText('En ejecución');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('alta persistente y detección de una edición concurrente',async({page,request})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Agregar PLC',exact:true}).click();
  await page.locator('#cfg-name').fill('PLC de prueba');
  await page.locator('#cfg-location').fill('Laboratorio');
  const tank=await(await request.get('/api/plcs/demo-tank')).json();
  await page.locator('#cfg-port').fill(String(tank.port));
  await page.getByRole('button',{name:'Guardar equipo',exact:true}).click();
  await expect(page.locator('#det-name')).toHaveText('PLC de prueba');
  await expect(page.locator('#metrics-container')).toContainText('25,3');
  const id=await page.locator('[data-device-id][aria-pressed="true"]').getAttribute('data-device-id');
  await page.reload();
  await page.locator(`[data-device-id="${id}"]`).click();
  await page.getByRole('button',{name:'Configurar',exact:true}).click();
  const current=await(await request.get(`/api/plcs/${id}`)).json();
  const {id:ignoreId,revision,state,...config}=current;
  const response=await request.put(`/api/plcs/${id}`,{data:{...config,expected_revision:revision,name:'Cambio desde otra pestaña'}});
  expect(response.status()).toBe(200);
  await page.locator('#cfg-name').fill('Edición desactualizada');
  await page.getByRole('button',{name:'Guardar equipo',exact:true}).click();
  await expect(page.locator('#form-error')).toContainText('configuración cambió');
  await page.getByRole('button',{name:'Cancelar',exact:true}).click();
  const final=await(await request.get(`/api/plcs/${id}`)).json();
  expect(final.name).toBe('Cambio desde otra pestaña');
});

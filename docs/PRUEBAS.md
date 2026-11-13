# Pruebas y verificación

La verificación local del 13 de noviembre de 2026 comprende **29 casos automatizados**: 7 unitarios Rust, 6 de integración Rust, 14 de navegador y 2 de validación Python. El benchmark de reloj real se ejecuta por separado y no cuenta dentro de esos 29 casos.

La prueba prolongada registrada el 12 de noviembre es una ejecución adicional de una hora. Sus resultados están en [RESULTADO_PRUEBA_1H.md](RESULTADO_PRUEBA_1H.md).

## Resultado local

Resumen normalizado de la ejecución del 13 de noviembre de 2026:

```text
Rust:        7 unitarias + 6 de integración pasaron; 1 benchmark omitido
Playwright: 14 pasaron; 0 fallos; 0 casos inestables
Python:      2 pasaron
Formato, Clippy, compilación Rust y TypeScript/Vite: correctos
```

El [registro portable de verificación](measurements/tests-20261113.json) conserva comandos, casos del navegador y huellas de los archivos fuente. También se comprobó la compilación en una copia temporal sin `target` ni `node_modules`, instalando de nuevo las dependencias del frontend con la caché de descargas. Esta comprobación no evalúa la disponibilidad de los registros de paquetes en Internet.

## Cobertura funcional

| Suite | Archivos | Casos | Comprobaciones |
|---|---|---:|---|
| Dominio | [domain.rs](../src/domain.rs) | 3 | Tipos, escala, ceros, negativos, float, direcciones, solapamientos y transiciones de aviso |
| Planificación | [schedule.rs](../src/schedule.rs) | 4 | Primer tick, cadencia, ticks omitidos, espera progresiva, recuperación y cancelación |
| Sistema | [system.rs](../tests/system.rs) | 4 | FC03/FC04 y TCP real, independencia entre PLC, persistencia, API, revisión de edición, CSV, resumen con extremos y huecos |
| Lecturas lentas | [cadence.rs](../tests/cadence.rs) | 2 | Consultas secuenciales, timeout, descarte de respuestas tardías y reconexión |
| Recorridos del panel | [monitor.spec.ts](../frontend/tests/monitor.spec.ts) | 2 | Adquisición, simulación, pausa, recuperación, alta, edición concurrente y exportación |
| Gráficas | [trend.spec.ts](../frontend/tests/trend.spec.ts) | 12 | Huecos reales, unidades, zoom animado, anclaje al cursor, sondeo, periodos, CSV visible, teclado, móvil, selector y respuestas tardías |
| Informe prolongado | [test_soak_test.py](../scripts/test_soak_test.py) | 2 | Cero válido, valor fallido ausente, identidad del PLC, pausa y aislamiento |

Estos casos verifican comportamientos concretos; no representan un porcentaje de cobertura de código.

## Ejecutar la verificación

Desde la raíz del proyecto. Se necesita la herramienta Rust fijada por `rust-toolchain.toml`, Node.js y Python 3.8 o posterior. Las pruebas TCP y de navegador necesitan poder abrir puertos locales y crear archivos temporales.

```bash
cargo fmt --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
cargo build --locked
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend exec -- playwright install chromium
npm --prefix frontend run test:e2e
python3 -m unittest discover -s scripts -p 'test_soak_test.py' -v
```

`cargo build` prepara el ejecutable que utiliza Playwright. Las pruebas de navegador inician su propio backend con una base de datos temporal y puertos Modbus libres. El puerto HTTP de prueba es 18088; puedes cambiarlo, por ejemplo, con `PLC_E2E_PORT=18089 npm --prefix frontend run test:e2e`.

## Ver los tests del navegador

```bash
npm --prefix frontend run test:report
```

El comando sirve el reporte HTML de la última ejecución, guardado en `playwright-report/`. Permite consultar casos, resultados y duración. Cuando hay fallos, `test-results/` conserva capturas y trazas para su diagnóstico. Ambos directorios están excluidos de Git.

En GitHub, el workflow [Checks](../.github/workflows/checks.yml) muestra cada etapa por separado y publica el reporte y la evidencia como artefacto `playwright-report`, conservado durante catorce días. Los resultados locales no sustituyen el estado de una ejecución de GitHub Actions.

## Mediciones adicionales

- **Cadencia antes/después:** [CADENCIA.md](CADENCIA.md). El caso `measure_worker_cadence` aparece como `ignored` en una ejecución normal porque es un benchmark de reloj real. Su invocación explícita y las medidas están documentadas allí.
- **Prueba prolongada:** [PRUEBA_PROLONGADA.md](PRUEBA_PROLONGADA.md). Inicia un entorno aislado y produce métricas, CSV y un informe de comprobaciones.
- **Resultado de una hora:** [RESULTADO_PRUEBA_1H.md](RESULTADO_PRUEBA_1H.md). Incluye condiciones y [evidencia portable](measurements/soak-20261112.json).

Las mediciones de capacidad con más PLC y la validación con hardware están pendientes. Los resultados actuales corresponden a los simuladores y a las condiciones registradas en cada informe.

# Historial de versiones

## v0.1.0 — 2026-11-13

Primera versión pública de PLC Monitor: monitoreo local de múltiples PLC con Rust y Modbus TCP, panel web y demo interactiva sin instalación.

### Aplicación local

- Configuración persistente de equipos y hasta 32 variables por PLC.
- Lecturas FC03 y FC04, enteros de 16 bits y `float32`, escala, unidad y orden de palabras.
- Adquisición independiente mediante Tokio, con pausa, timeout, reconexión progresiva y calendario de sondeo con descarte de ticks atrasados.
- Historial y eventos en SQLite; avisos por límite alto, recuperación y calidad de lectura visible.
- Selector de variable, zoom fluido con la rueda, desplazamiento, periodos de hasta 24 horas y exportación CSV del intervalo visible.
- Tres simuladores Modbus TCP para probar el proyecto sin hardware físico.

### Presentación y demo

- [Demo pública en GitHub Pages](https://emanuelvanegas.github.io/plc-monitor/) con PLC virtuales y datos generados en el navegador.
- Configuración local por visitante, escenarios de aviso y fallo, pausa, gráficas y CSV. La demo funciona sin backend Rust ni conexión a PLC físicos.
- Video de presentación en MP4, con textos en español y un recorrido de aproximadamente un minuto, adjunto a la [versión en GitHub](https://github.com/emanuelvanegas/plc-monitor/releases/tag/v0.1.0).
- README con inicio rápido, arquitectura, capturas, pruebas y resultados documentados.

### Validación

- 36 pruebas automatizadas: 13 Rust, 14 de navegador con backend, 7 de la demo de Pages y 2 Python.
- GitHub Actions verifica formato, Clippy, compilación y pruebas antes de publicar Pages desde `main`.
- Prueba de una hora del backend Rust con tres simuladores: 29.421 muestras, sin errores inesperados y RSS observada de 10,23 a 10,27 MiB. [Condiciones y resultados](docs/RESULTADO_PRUEBA_1H.md).

### Alcance y pendientes

Esta versión permite leer registros y no envía órdenes de actuación al PLC. La capacidad máxima y la comunicación con un PLC físico todavía no están validadas. La demo de Pages es una simulación y sus datos no representan mediciones industriales.

El [roadmap](docs/ROADMAP.md) recoge las pruebas de capacidad, validación con hardware, lecturas agrupadas y avisos con límite inferior e histéresis.

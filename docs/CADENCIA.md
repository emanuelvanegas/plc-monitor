# Cadencia del recolector

Comparación medida el 12 de noviembre de 2026 sobre el worker real: Rust/Tokio, peticiones Modbus TCP en loopback y persistencia SQLite. Perfil `cargo test` (debug), Linux x86_64. Una variable, periodo configurado de 100 ms y timeout por lectura de 500 ms. Cada ejecución crea su propia base de datos temporal y usa un puerto TCP libre.

## Cambio

Antes: cada ciclo esperaba `periodo.saturating_sub(tiempo_del_ciclo)`. Esto ya compensaba el tiempo empleado, pero cada nuevo ciclo fijaba su propio origen y los retrasos podían desplazar la cadencia.

Ahora: cada PLC dispone de un `tokio::time::Interval` con `MissedTickBehavior::Skip`. La primera lectura puede comenzar inmediatamente. Cada ciclo, incluida su persistencia, se espera antes del siguiente; no se crean tareas nuevas por tick. Después de un exceso de duración puede recibirse un tick vencido inmediatamente; los demás ticks atrasados se saltan y la planificación vuelve al calendario. Esto permite que algún intervalo entre inicios sea menor al periodo sin reproducir toda la cola de ticks.

Después de un ciclo sin comunicación, `reset_after` reemplaza el plazo siguiente por la espera de reconexión: 500, 1000, 2000, 4000 y como máximo 8000 ms, contados después del ciclo fallido y su persistencia. La recuperación reinicia ese contador en 500 ms y mantiene un calendario nuevo, sin recuperar ticks anteriores a la desconexión. La cancelación interrumpe tanto la espera como una lectura pendiente; pausar, editar o apagar descarta la conexión de esa tarea.

Se conservan los timeouts por conexión y por lectura. Un timeout de lectura descarta la conexión antes de la reconexión para impedir que una respuesta tardía se interprete como la siguiente medición. No se añadió un timeout global del ciclo: la suma de varias lecturas y del almacenamiento puede superar el periodo.

## Resultados

| Escenario | Muestras | Separación media antes | Separación media después |
|---|---:|---:|---:|
| Respuestas de 20 ms | 14 | 101,16 ms | 99,94 ms |
| Una respuesta de 260 ms entre respuestas de 20 ms | 14 | 113,62 ms | 107,74 ms |
| Todas las respuestas tardan 140 ms | 10 | 143,01 ms | 141,49 ms |

En el caso normal, el último inicio se separó del calendario inicial en 15,06 ms antes y 0,80 ms después. Tras la respuesta de 260 ms, el error del último inicio respecto al múltiplo de 100 ms más próximo pasó de 22,92 ms a 0,62 ms. El nuevo calendario omitió una oportunidad de lectura; esa omisión no se considera deriva. Los registros originales incluyen cada inicio y cada duración de respuesta.

Con respuestas sostenidas de 140 ms no se consigue un ciclo de 100 ms: sigue mandando el tiempo real del trabajo. En los tres escenarios se observó como máximo una petición en curso a la vez.

Son ejecuciones cortas, una por escenario y versión, con temporizadores y planificación del sistema operativo. Sirven para observar la cadencia y contrastarla con pruebas deterministas; no demuestran una mejora estadística de rendimiento ni sustituyen la prueba de una hora, una medición de capacidad o la validación con PLC físico.

Datos: [antes](measurements/cadence-before.json) y [después](measurements/cadence-after.json).

## Reproducción

Desde la raíz del proyecto, con Rust en el PATH:

```bash
PLC_CADENCE_OUTPUT=/tmp/plc-cadence.json cargo test --locked --test cadence measure_worker_cadence -- --ignored --nocapture
```

El comando mide la implementación actualmente compilada. El JSON `cadence-before.json` se obtuvo antes de reemplazar el bucle compensado; el JSON `cadence-after.json`, después. Cambiar el nombre de salida no restaura la implementación anterior. La sonda y sus condiciones están en `tests/cadence.rs`.

La comparación está marcada como `ignored` para que CI no use medidas de reloj real como criterio de rendimiento. Se ejecutó explícitamente para esta entrega. Las pruebas de corrección se ejecutan con `cargo test --locked` e incluyen:

- Reloj Tokio pausado: primer tick inmediato, calendario normal y salto de ticks vencidos.
- Reloj pausado: esperas de reconexión hasta el tope, reinicio tras recuperación y cancelación durante la espera.
- TCP real: tres variables lentas en secuencia, una sola conexión y un máximo de una consulta activa.
- TCP real: timeout, registro de calidad y ausencia de valor, descarte de una respuesta tardía distinta y reconexión con el valor correcto.
- Integración existente: independencia entre PLC, pausa, edición, persistencia y recuperación.

Para inspeccionar duración de ciclos durante una demo:

```bash
RUST_LOG=plc_monitor=debug cargo run --locked -- --demo
```

El registro `Ciclo de adquisición completado` incluye `plc_id`, `cycle_ms` (lecturas, procesamiento y persistencia), `period_ms` y `overrun`. Es una observación del ciclo, no una garantía de tiempo real.

Referencias: [Interval y reset_after](https://docs.rs/tokio/1.54.1/tokio/time/struct.Interval.html), [MissedTickBehavior::Skip](https://docs.rs/tokio/1.54.1/tokio/time/enum.MissedTickBehavior.html#variant.Skip).

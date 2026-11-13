# Resultado de la prueba de una hora — 12 de noviembre de 2026

**Resultado verificado: passed.** Se completaron 3600,004 segundos de medición con tres PLC simulados, tres variables por PLC, intervalo de un segundo y timeout de un segundo. Las ocho acciones programadas fueron observadas y los tres PLC terminaron conectados, con calidad correcta en todas sus variables, antes de detener la adquisición para exportar.

La ejecución abarcó aproximadamente de 13:03:14 a 14:03:14, hora de Bogotá (18:03:14–19:03:14 UTC). El arranque, calentamiento y exportación quedan fuera de la duración medida. Se utilizó el ejecutable **release**, Modbus TCP en loopback y SQLite. Plataforma registrada: `Linux-6.18.55-2-cachyos-lts-x86_64-with-glibc2.44`. La sonda consultó la API; no automatizó un navegador.

## Recursos del backend y sus simuladores

| Medida | Resultado |
|---|---:|
| RSS inicial | 10,23 MiB |
| RSS final | 10,27 MiB |
| RSS máxima observada | 11,73 MiB |
| Diferencia final − inicial | 36 KiB |
| CPU media, respecto a un núcleo | 0,278 % |
| CPU máxima observada, respecto a un núcleo | 0,599 % |
| Máximo observado de SQLite + WAL + SHM | 8,88 MiB |

Hubo 719 observaciones, aproximadamente cada cinco segundos; la separación máxima fue de 5,034 segundos. RSS media por cuarto de hora: 9,85, 9,12, 10,90, 10,41 MiB. La memoria final quedó próxima a la inicial; estos datos no constituyen una demostración de ausencia de fugas en otras condiciones.

## API

| Consulta | Observaciones | Mediana | Percentil 95 | Máxima |
|---|---:|---:|---:|---:|
| Salud | 719 | 0,86 ms | 1,21 ms | 4,17 ms |
| Lista y estados de PLC | 719 | 0,78 ms | 1,12 ms | 10,10 ms |
| Historial de cinco minutos | 120 | 3,39 ms | 16,24 ms | 29,26 ms |

El percentil 95 usa rango más próximo sobre las observaciones registradas. Las latencias incluyen la petición HTTP local y la lectura de la respuesta desde Python.

## Lecturas y CSV

| PLC | Total exportado | Correctas | Fallidas esperadas |
|---|---:|---:|---:|
| demo-tank | 9864 | 9720 | 144 |
| demo-oven | 9720 | 9720 | 0 |
| demo-belt | 9837 | 9708 | 129 |

Se conservaron **29421 muestras**, 29148 correctas y 273 fallidas. Las fallidas corresponden a la desconexión solicitada del tanque y a las respuestas lentas de la banda, incluidas sus ventanas de recuperación. Se verificó de forma independiente que no aparecieran fuera de esos intervalos y que mantuvieran valor vacío en CSV. Las esperas progresivas reducen la frecuencia de intentos durante un fallo; durante una pausa no deben aparecer muestras nuevas.

## Comprobaciones

- No se registraron errores inesperados en el informe ni líneas `ERROR` o de pánico en el registro del backend.
- Las ocho acciones se observaron: aviso del tanque y recuperación, desconexión y reconexión, pausa y reanudación del horno, respuesta lenta de la banda y recuperación.
- Las seis comprobaciones de independencia encontraron lecturas correctas de las tres variables de cada PLC no afectado durante el fallo o pausa de otro equipo.
- El horno registró cero muestras dentro del intervalo comprobado de pausa.
- `PRAGMA integrity_check` devolvió `ok`; se volvió a comprobar al revisar la ejecución.
- Se revalidaron identidad y calidad de los tres CSV, y sus cantidades coinciden con SQLite para el intervalo medido.
- El estado final confirmó los tres PLC conectados y todas las variables con calidad `good`.

## Evidencia y límites

El [resumen portable y las huellas de los archivos](measurements/soak-20261112.json) se conservan en el repositorio. Los archivos originales están en `reports/soak/20261112T180314.322081Z/`; esa carpeta está excluida de Git. Incluye SQLite, CSV, observaciones y el registro completo. Las huellas permiten identificar qué archivos se revisaron sin publicar sus rutas absolutas.

Esto cierra la prueba prolongada de una hora para **esta configuración**. Permanecen pendientes la medición de capacidad con más equipos/variables y la validación con un PLC físico. No se registró modelo de CPU ni RAM total, por lo que no se extrapolan estos tiempos a otras máquinas. Para repetir el procedimiento, consulta [PRUEBA_PROLONGADA.md](PRUEBA_PROLONGADA.md).

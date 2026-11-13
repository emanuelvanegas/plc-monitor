# Referencia técnica

Configuración de equipos, decisiones de adquisición y contrato de la API. Los comandos de esta guía se ejecutan desde la raíz del proyecto. Para comenzar, consulta el [README](../README.md).

## Equipos reales y mapas de registros

Para iniciar el servicio y cargar tus configuraciones guardadas:

```bash
cargo run --locked
```

Registra el host/IP, puerto TCP, Unit ID, intervalo y timeout. Configura el mapa de variables según la documentación del dispositivo:

- Holding registers: FC03; input registers: FC04.
- Dirección como offset **desde cero**. Una referencia documental 40001 normalmente corresponde al offset 0 del área holding; se debe confirmar la convención del fabricante.
- Tipos `uint16`, `int16` y `float32`. Un `float32` ocupa dos registros; selecciona orden ABCD o CDAB.
- La escala se aplica después de interpretar el dato: `valor mostrado = valor decodificado × escala`.
- Cada equipo admite entre 1 y 32 variables. El selector de la gráfica permite consultar cualquiera; «Tendencia inicial» define la selección al abrir un PLC por primera vez.
- El intervalo admite 100–60000 ms; el timeout admite 100–30000 ms.

El alcance actual es adquisición de registros. El cliente no envía órdenes de actuación al PLC.

Los simuladores iniciales utilizan `127.0.0.1:5502`, `5503` y `5504`, con Unit ID 1. Puedes cambiar el primer puerto mediante `--demo-base-port 6502`. Para pruebas con una base de datos nueva, `--demo-base-port 0` asigna puertos libres y registra los puertos obtenidos en las configuraciones iniciales. No reutilices una base de datos con puertos efímeros de una ejecución anterior para una nueva demo efímera.

## Arquitectura y almacenamiento

```text
Navegador → API Axum → supervisor → tarea y conexión TCP por PLC
                                  ↓
                         cola de escritura acotada → SQLite
```

Los cambios de configuración se serializan y detienen la tarea anterior antes de iniciar la nueva. Las revisiones evitan sobrescribir una edición más reciente desde otra pestaña. La pausa deseada se guarda en la configuración.

SQLite utiliza WAL, claves foráneas, migraciones y espera acotada por bloqueos. La cola admite 32 lotes. Si una escritura falla, `/api/health` informa el problema; no se presenta como una pérdida de comunicación del PLC.

La primera implementación guarda la configuración completa y su mapa de variables como JSON validado dentro de `plcs`, con una revisión para las actualizaciones atómicas. `samples` y `events` son tablas consultables e indexadas por equipo y tiempo. Las muestras conservan nombre, unidad y revisión originales.

La retención inicial elimina por lotes muestras mayores de 24 horas y eventos mayores de siete días. Los endpoints limitan rangos y tamaños; el CSV se envía en páginas de 512 registros.

## Gráfica interactiva

- Un selector **Variable** presenta las variables del PLC y muestra una sola tendencia a la vez. La elección se recuerda por equipo durante la sesión. Cambiar de variable conserva el intervalo y el zoom; la unidad, el límite y el cursor corresponden a la nueva variable. Las respuestas anteriores se cancelan para evitar mezclar series. Si se elimina la variable elegida, se selecciona una que siga disponible.
- Periodos de 5 y 15 minutos, 1, 6 y 24 horas, o fechas personalizadas de hasta 24 horas. Las fechas del formulario y de los ejes corresponden a Bogotá (UTC−5).
- Rueda del ratón o desplazamiento vertical del trackpad sobre el área de datos: zoom centrado en el cursor. La ventana se anima con `requestAnimationFrame`; las lecturas originales conservan su valor. Fuera del área de datos, la rueda sigue desplazando la página.
- Arrastra horizontalmente para recorrer el periodo. También puedes usar los botones + / − o enfocar la gráfica y pulsar + / −, flechas e Inicio. El límite de acercamiento es de dos intervalos de lectura, con un mínimo de un segundo.
- Al explorar, el intervalo queda fijo y el sondeo del panel no restablece el zoom. **Restablecer** recupera el periodo completo; **En vivo** vuelve a seguir las nuevas lecturas. Desde un periodo personalizado, En vivo regresa a los últimos cinco minutos.
- El cursor muestra la fecha con milisegundos y el valor de una muestra real; los huecos muestran «Sin lectura». Los ejes y la escala vertical se adaptan al intervalo; el límite configurado siempre figura en la cabecera y aparece como línea cuando está dentro de la escala.
- La animación respeta la preferencia del sistema para reducir movimiento. En móvil también están disponibles los botones; el desplazamiento vertical de la página permanece disponible.
- El CSV descarga todas las variables del PLC seleccionado **en el intervalo visible**. Exporta los registros originales, incluso cuando la gráfica presenta un resumen.

El navegador conserva como máximo una vista general y una vista de detalle, de hasta 2000 puntos cada una. Cuando hay más lecturas, Rust recorre el rango y conserva por bloque temporal primera/última muestra, mínimo/máximo y primera/última lectura inválida, con sus fechas originales. La respuesta incluye `aggregated`, `bucket_ms`, `source_count` y `gaps`; no descarta silenciosamente el inicio del periodo. Al acercar o desplazar, se solicita el detalle tras una breve espera para agrupar gestos, sin hacer una petición por cuadro.

La curva mantiene la continuidad entre lecturas válidas de la misma unidad, incluso tras cambios administrativos de revisión. Las muestras fallidas, unidades incompatibles y pausas largas separan la curva. En vistas resumidas, varias interrupciones dentro de un bloque se agrupan en una franja conservadora y los puntos ambiguos se muestran aislados; acerca para ver sus límites precisos. Las franjas nunca representan una medición de valor cero. La frecuencia de consulta del historial varía entre uno y treinta segundos según el periodo; las métricas actuales mantienen su sondeo habitual.

## API principal

| Método | Ruta |
|---|---|
| GET | `/api/health` |
| GET / POST | `/api/plcs` |
| GET / PUT | `/api/plcs/{id}` |
| PUT | `/api/plcs/{id}/acquisition` |
| GET | `/api/plcs/{id}/history?variable_id=...` |
| GET | `/api/plcs/{id}/events` |
| GET | `/api/plcs/{id}/export.csv` |
| PUT | `/api/demo/plcs/{id}/scenario` |

La actualización de un PLC recibe `expected_revision`. El estado de adquisición recibe `{"running": true}` o `false`. Los escenarios reciben `{"scenario":"normal"}`, `high`, `offline`, `slow` o `invalid_address` y actúan sobre los tres simuladores propios de la demo.

Historial y CSV aceptan `from_ms` y `to_ms` en milisegundos UTC, con un rango máximo de 24 horas y una ventana predeterminada de cinco minutos. El historial acepta `limit` (6–10000, 2000 por defecto); por encima del presupuesto devuelve el resumen descrito arriba. Los eventos aceptan `before_id` y `limit` para paginación.

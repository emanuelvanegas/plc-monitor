# Prueba automatizada de una hora

El script `scripts/soak_test.py` inicia su propio backend y tres simuladores Modbus TCP con puertos libres y una base de datos nueva. No utiliza la demo del puerto 8088 ni modifica sus configuraciones. Necesita Linux, Python 3.8 o posterior y el ejecutable del proyecto. Python utiliza únicamente su biblioteca estándar.

## Ejecutar

Desde la raíz del proyecto:

```bash
source "$HOME/.cargo/env"
cargo build --release --locked
npm --prefix frontend run build
python3 scripts/soak_test.py --minutes 60
```

La duración de 60 minutos empieza después del arranque y del calentamiento de los tres PLC. La compilación, el calentamiento y la generación del informe añaden tiempo al comando completo. Mantén abierta la terminal y evita suspender el computador durante la ejecución.

La terminal imprime la carpeta de resultados y la URL de la demo aislada. El script ejerce la API; no automatiza un navegador. Puedes abrir esa URL para observar la prueba; deja los controles y las configuraciones a cargo del script. Para repetir condiciones comparables de recursos, mantén cerrada la interfaz y registra qué otras aplicaciones están ejecutándose.

Cada PLC comienza en modo normal, con tres variables, intervalo de un segundo y timeout de un segundo. Se observa CPU y memoria del proceso backend, disponibilidad del almacenamiento y respuestas de la API aproximadamente cada cinco segundos. Cada seis observaciones también se consulta una gráfica de cinco minutos. Los registros de backend incluyen la duración de los ciclos de adquisición.

## Escenarios de la ejecución de 60 minutos

| Minuto aproximado | Acción |
|---|---|
| 0 | Los tres PLC adquieren datos normalmente |
| 6 | Temperatura del tanque por encima del límite |
| 12 | Tanque vuelve a normal y recupera el aviso |
| 18 | Tanque sin conexión; los otros dos deben seguir leyendo |
| 24 | Se restaura el tanque y se espera su reconexión |
| 30 | Se pausa la adquisición del horno |
| 36 | Se reanuda el horno |
| 42 | Banda responde lentamente para provocar timeouts |
| 48 | Banda vuelve a normal |
| 60 | Validación final, pausa de adquisición para estabilizar los datos, exportación y apagado ordenado |

Las acciones utilizan reloj monotónico y los tiempos reales quedan registrados. Se admite una ventana de transición de hasta doce segundos para reconexiones; no se evalúa una desconexión solicitada como un fallo inesperado del sistema.

## Resultados

Cada ejecución crea una carpeta nueva en `reports/soak/<fecha UTC>/`:

- `summary.json`: resultado, duración medida, configuración, hash del ejecutable, recursos, latencias máximas, acciones observadas, errores, recuento de muestras por calidad y comprobaciones de aislamiento y pausa.
- `metrics.jsonl`: una observación por línea con memoria, CPU, tamaño de base de datos incluyendo WAL y estados de los PLC.
- `backend.log`: registro de Rust con duraciones de adquisición, excesos de periodo y errores.
- `demo-tank.csv`, `demo-oven.csv`, `demo-belt.csv`: las muestras originales del intervalo medido, con calidad y unidad.
- `monitor.db`: SQLite de esta ejecución para inspección posterior.

`status: "passed"` exige completar la duración, observar todos los escenarios, recuperar los tres PLC, no registrar errores inesperados, comprobar integridad SQLite, encontrar lecturas de las tres variables de los equipos no afectados durante cada fallo/pausa y verificar que el horno no guardó muestras durante la pausa. También comprueba que los CSV no mezclen PLC, que las lecturas fallidas tengan valor vacío y que sus cantidades coincidan con SQLite para el mismo periodo.

Los fallos de lectura provocados a propósito quedan en las muestras y son parte esperada del ensayo. Un fallo de almacenamiento, una respuesta HTTP inesperada o un PLC sano sin lecturas nuevas por más de diez segundos se registra como error de la prueba. Un estado `running`, `failed` o `interrupted` no constituye una prueba completada satisfactoriamente. El código de salida es 0 al pasar, 1 al fallar y 130 al interrumpir con Ctrl+C.

CPU se expresa respecto a un núcleo: 100 % corresponde a un núcleo ocupado, aunque el proceso puede usar varios. Memoria RSS y CPU corresponden al backend, que también aloja los simuladores; no incluyen el proceso Python. Los máximos son los observados durante el muestreo. El resultado no es una certificación de ausencia de fugas de memoria ni un límite de capacidad: compara memoria inicial, final y máxima y revisa su evolución en `metrics.jsonl`. Para una comparación de rendimiento utiliza el mismo perfil de compilación, duración, carga y condiciones de la máquina.

Las carpetas `reports/` están excluidas de Git. Conserva la carpeta de la hora y publica después un resumen con condiciones y resultados reales; no presentes el ensayo corto como validación de una hora ni como prueba con PLC físico.

## Verificación corta del procedimiento

Para recorrer los mismos escenarios en dos minutos con el ejecutable de desarrollo:

```bash
cargo build --locked
python3 scripts/soak_test.py --minutes 2 --sample-seconds 2 --binary target/debug/plc-monitor
```

La secuencia se escala con la duración. Dos minutos es el mínimo para dejar tiempo a los timeouts y a la recuperación. Esta ejecución verifica el procedimiento, no sustituye la prueba de una hora.

El 12 de noviembre de 2026 se verificó el recorrido de dos minutos con el ejecutable de desarrollo: se observaron las ocho acciones, se recuperaron los tres equipos, coincidieron los CSV con SQLite y pasaron las comprobaciones de pausa e independencia. También se comprobó la interrupción con Ctrl+C y el guardado del resultado parcial. Posteriormente se completó y revisó la ejecución de 60 minutos con resultado `passed`; consulta [RESULTADO_PRUEBA_1H.md](RESULTADO_PRUEBA_1H.md).

Las comprobaciones de los validadores se ejecutan con:

```bash
python3 -m unittest discover -s scripts -p 'test_soak_test.py' -v
```

Puedes detener la prueba con Ctrl+C; se intentará cerrar el proceso propio y guardar un informe parcial marcado como interrumpido. No reutilices la base de datos de una ejecución con puertos efímeros para arrancar otra demo: el script siempre genera una nueva.

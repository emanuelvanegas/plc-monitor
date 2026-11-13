# Estado y próximos pasos

## Versión 0.1.0

- [x] Configuración persistente de varios PLC y mapas de hasta 32 variables por equipo.
- [x] Lectura FC03 y FC04, tipos enteros y float, escala y orden de palabras.
- [x] Una tarea por PLC, pausa, cancelación, timeout y reconexión progresiva.
- [x] Cadencia mediante `interval` con `Skip`, con pruebas de retrasos y recuperación.
- [x] Avisos por límite alto, eventos e historial con calidad de lectura.
- [x] Gráfica seleccionable, zoom fluido, desplazamiento y CSV por intervalo.
- [x] Simuladores Modbus TCP y pruebas unitarias, de integración y navegador.
- [x] Comparación de cadencia y prueba de una hora con tres PLC simulados.

## Validaciones pendientes

- [ ] Medir capacidad aumentando PLC y variables, con simuladores en un proceso separado.
- [ ] Registrar CPU, memoria, lecturas obtenidas y latencias bajo cada carga probada.
- [ ] Validar el mapa y la comunicación con un PLC físico concreto.

La cantidad máxima de PLC soportada aún no está determinada. El límite de 32 variables es una regla de configuración, no una medida de capacidad.

## Mejoras posteriores

- [ ] Evaluar lecturas agrupadas de registros contiguos a partir de las mediciones.
- [ ] Incorporar límite inferior e histéresis para los avisos.

Evidencia disponible: [pruebas automatizadas](PRUEBAS.md), [cadencia](CADENCIA.md) y [prueba de una hora](RESULTADO_PRUEBA_1H.md).

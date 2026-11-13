import type { HistoryResponse, Plc, Sample } from './types';
import { buildTrend, type Trend, type TrendPoint } from './trend';

interface Window { from: number; to: number }
interface Dataset extends Window { response: HistoryResponse }
const node = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const clock = new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
const calendar = new Intl.DateTimeFormat('es-CO', { timeZone:'America/Bogota', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
const numeric = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 4 });
const precise = new Intl.NumberFormat('es-CO', { maximumSignificantDigits: 12 });
const axisNumber = (value: number) => value !== 0 && (Math.abs(value) >= 100000 || Math.abs(value) < .0001) ? value.toExponential(2).replace('.', ',') : numeric.format(value);
const formatTime = (stamp: number) => clock.format(stamp);
const duration = (range: Window) => range.to - range.from;
const localInput = (stamp: number) => new Date(stamp - 5 * 3600000).toISOString().slice(0, 19);
const overlaps = (a: Window, b: Window) => a.to >= b.from && a.from <= b.to;

/** Persistent viewport: polling never replaces the SVG or interrupts wheel easing. */
export class HistoryChart {
  private plc?: Plc;
  private key = '';
  private selectedVariables = new Map<string, string>();
  private optionsKey = '';
  private period = 300000;
  private fixed = false;
  private live = true;
  private base: Window = { from: Date.now() - this.period, to: Date.now() };
  private view = { ...this.base };
  private target = { ...this.base };
  private overview?: Dataset;
  private detail?: Dataset;
  private request?: AbortController;
  private lastFetch = 0;
  private debounce = 0;
  private animation = 0;
  private lastFrame = 0;
  private width = 640;
  private readonly height = 276;
  private readonly left = 64;
  private readonly top = 18;
  private readonly bottom = 234;
  private svg: SVGSVGElement;
  private layers: SVGGElement;
  private crosshair: SVGGElement;
  private tooltip: HTMLDivElement;
  private trend: Trend = { segments: [], gaps: [] };
  private points: TrendPoint[] = [];
  private dataset?: Dataset;
  private low = 0;
  private high = 1;
  private scaleReady = false;
  private frameAlpha = 1;
  private scaleError = 0;
  private pointer?: { x: number; y: number };
  private drag?: { id: number; x: number; range: Window };
  private error = '';
  private motion = matchMedia('(prefers-reduced-motion: reduce)');

  constructor() {
    const canvas = node('chart-canvas');
    canvas.innerHTML = `<svg role="img" tabindex="0" aria-label="Historial de lecturas. Usa más y menos para ampliar, flechas para desplazar e Inicio para restablecer."><defs><clipPath id="trend-plot"><rect/></clipPath></defs><g class="trend-layers"></g><g class="trend-crosshair" pointer-events="none" visibility="hidden"><line stroke="#62685F" stroke-dasharray="3 3"/><circle r="4" fill="#1A3C2B" stroke="white" stroke-width="2"/></g></svg><div class="trend-tooltip" role="status" hidden></div>`;
    this.svg = canvas.querySelector('svg')!;
    this.layers = canvas.querySelector('.trend-layers')!;
    this.crosshair = canvas.querySelector('.trend-crosshair')!;
    this.tooltip = canvas.querySelector('.trend-tooltip')!;
    new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (width > 0 && width !== this.width) { this.width = width; this.draw(); }
    }).observe(canvas);
    this.svg.addEventListener('wheel', event => {
      const point = this.position(event);
      if (!this.inPlot(point) || !this.plc || event.deltaY === 0) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.height : 1);
      this.zoom(Math.exp(Math.max(-300, Math.min(300, delta)) * .0025), (point.x - this.left) / this.plotWidth);
    }, { passive: false });
    this.svg.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !this.inPlot(this.position(event))) return;
      this.freeze(); this.stopAnimation();
      this.target = { ...this.view };
      this.drag = { id: event.pointerId, x: this.position(event).x, range: { ...this.view } };
      this.svg.setPointerCapture(event.pointerId);
      this.svg.classList.add('dragging'); this.hideTooltip();
    });
    this.svg.addEventListener('pointermove', event => {
      const point = this.position(event);
      if (this.drag) {
        const delta = (this.drag.x - point.x) / this.plotWidth * duration(this.drag.range);
        this.view = this.constrain({ from:this.drag.range.from + delta, to:this.drag.range.to + delta });
        this.target = { ...this.view }; this.draw();
      } else { this.pointer = point; this.showTooltip(); }
    });
    const finishDrag = () => {
      if (!this.drag) return;
      this.drag = undefined; this.svg.classList.remove('dragging'); this.scheduleDetail();
    };
    this.svg.addEventListener('pointerup', finishDrag);
    this.svg.addEventListener('pointercancel', finishDrag);
    this.svg.addEventListener('lostpointercapture', finishDrag);
    this.svg.addEventListener('pointerleave', () => { this.pointer = undefined; this.hideTooltip(); });
    this.svg.addEventListener('keydown', event => {
      if (['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) event.preventDefault();
      if (event.key === '+' || event.key === '=') this.zoom(.6);
      if (event.key === '-') this.zoom(1 / .6);
      if (event.key === 'Home') this.reset();
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        this.freeze(); const delta = duration(this.target) * .2 * (event.key === 'ArrowLeft' ? -1 : 1);
        this.moveTo({ from:this.target.from + delta, to:this.target.to + delta }); this.scheduleDetail();
      }
    });
    node<HTMLButtonElement>('chart-zoom-in').onclick = () => this.zoom(.6);
    node<HTMLButtonElement>('chart-zoom-out').onclick = () => this.zoom(1 / .6);
    node<HTMLButtonElement>('chart-reset').onclick = () => this.reset();
    node<HTMLSelectElement>('chart-variable').onchange = event => {
      if (!this.plc) return;
      const id = (event.target as HTMLSelectElement).value;
      if (!this.plc.variables.some(v => v.id === id) || id === this.variable.id) return;
      this.selectedVariables.set(this.plc.id, id);
      this.update(this.plc);
    };
    node<HTMLButtonElement>('chart-live').onclick = () => {
      if (this.fixed) { this.fixed = false; this.period = 300000; node<HTMLSelectElement>('chart-period').value = '300000'; node('chart-custom').hidden = true; }
      this.live = true; this.reset();
    };
    node<HTMLSelectElement>('chart-period').onchange = event => {
      const value = (event.target as HTMLSelectElement).value;
      node('chart-custom').hidden = value !== 'custom';
      if (value === 'custom') {
        node<HTMLInputElement>('chart-from').value = localInput(this.view.from);
        node<HTMLInputElement>('chart-to').value = localInput(this.view.to);
      } else {
        this.fixed = false; this.live = true; this.period = Number(value); this.selectRange();
      }
    };
    node<HTMLFormElement>('chart-custom').onsubmit = event => {
      event.preventDefault();
      const from = Date.parse(node<HTMLInputElement>('chart-from').value + '-05:00');
      const to = Date.parse(node<HTMLInputElement>('chart-to').value + '-05:00');
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 86400000 || to > Date.now()) {
        this.setError('Selecciona un intervalo pasado, ordenado y de máximo 24 horas.'); return;
      }
      this.fixed = true; this.live = false; this.base = { from, to }; this.selectRange();
    };
  }

  private get variable() {
    const plc = this.plc!;
    return plc.variables.find(v => v.id === this.selectedVariables.get(plc.id))
      ?? plc.variables.find(v => v.primary) ?? plc.variables[0];
  }
  private syncVariables() {
    const plc = this.plc!, selected = this.variable;
    this.selectedVariables.set(plc.id, selected.id);
    const selector = node<HTMLSelectElement>('chart-variable');
    const key = JSON.stringify([plc.id, plc.variables.map(v => [v.id, v.name, v.unit])]);
    // Polling must leave the open native selector and keyboard focus intact.
    if (key !== this.optionsKey) {
      this.optionsKey = key;
      selector.replaceChildren(...plc.variables.map(v => new Option(`${v.name}${v.unit ? ` · ${v.unit}` : ''}`, v.id)));
    }
    selector.value = selected.id;
    selector.title = selected.name;
    this.svg.dataset.variableId = selected.id;
    this.svg.setAttribute('aria-label', `Historial de ${selected.name} de ${plc.name}. Usa más y menos para ampliar, flechas para desplazar e Inicio para restablecer.`);
  }
  private get plotWidth() { return Math.max(1, this.width - this.left - 16); }
  private get minimumSpan() { return Math.min(duration(this.base), Math.max(1000, (this.plc?.interval_ms ?? 1000) * 2)); }
  private position(event: MouseEvent) {
    const rect = this.svg.getBoundingClientRect();
    return { x:(event.clientX - rect.left) * this.width / rect.width, y:(event.clientY - rect.top) * this.height / rect.height };
  }
  private inPlot(point: { x:number; y:number }) { return point.x >= this.left && point.x <= this.width - 16 && point.y >= this.top && point.y <= this.bottom; }
  private x(time: number) { return this.left + (time - this.view.from) / duration(this.view) * this.plotWidth; }
  private y(value: number) { return this.bottom - (value - this.low) / (this.high - this.low) * (this.bottom - this.top); }
  private setError(text: string) { this.error = text; node('chart-error').textContent = text; node('chart-error').hidden = !text; }

  update(plc: Plc) {
    const samePlc = this.plc?.id === plc.id;
    this.plc = plc;
    const v = this.variable;
    this.syncVariables();
    const key = `${plc.id}/${v.id}/${v.unit}/${plc.interval_ms}/${plc.timeout_ms}`;
    if (key !== this.key) {
      this.key = key; this.request?.abort(); clearTimeout(this.debounce); this.stopAnimation();
      this.overview = this.detail = undefined; this.lastFetch = 0;
      this.pointer = this.drag = undefined; this.svg.classList.remove('dragging'); this.hideTooltip();
      if (samePlc) {
        // Compare variables over exactly the same visible time window.
        this.view = this.constrain(this.view); this.target = { ...this.view };
        this.scaleReady = false; this.setError(''); this.draw();
        void this.fetchRange(duration(this.view) < duration(this.base) - 1);
      } else {
        this.live = !this.fixed; this.selectRange();
      }
    } else if (this.live && !this.drag && !this.animation) {
      const end = Date.now(); this.base = { from:end - this.period, to:end };
      this.view = this.target = { ...this.base }; this.draw();
      const cadence = Math.max(1000, Math.min(30000, this.period / 300));
      if (Date.now() - this.lastFetch >= cadence && !this.request) void this.fetchRange(false);
    } else if (!this.animation && !this.drag) this.draw();
    node('chart-title').textContent = 'Tendencia';
    node('chart-unit').textContent = `${v.unit || 'Sin unidad'}${v.high_limit === null ? '' : ` · Límite ${numeric.format(v.high_limit)}`}`;
  }

  private selectRange() {
    this.request?.abort(); this.request = undefined; clearTimeout(this.debounce); this.stopAnimation();
    if (!this.fixed) { const to = Date.now(); this.base = { from:to - this.period, to }; }
    this.view = { ...this.base }; this.target = { ...this.base };
    this.scaleReady = false;
    this.overview = this.detail = undefined; this.setError(''); this.draw();
    if (this.plc) void this.fetchRange(false);
  }

  private freeze() { this.live = false; this.hideTooltip(); }
  private constrain(range: Window): Window {
    const span = Math.min(duration(this.base), Math.max(this.minimumSpan, duration(range)));
    const from = Math.max(this.base.from, Math.min(this.base.to - span, range.from));
    return { from, to:from + span };
  }
  private zoom(factor: number, fraction = .5) {
    if (!this.plc) return;
    this.freeze();
    const span = duration(this.target);
    const anchor = this.target.from + span * fraction;
    const nextSpan = Math.min(duration(this.base), Math.max(this.minimumSpan, span * factor));
    const desired = this.constrain({ from:anchor - nextSpan * fraction, to:anchor + nextSpan * (1 - fraction) });
    this.moveTo(desired); this.scheduleDetail();
  }
  private moveTo(range: Window) {
    this.target = this.constrain(range);
    if (this.motion.matches) { this.stopAnimation(); this.view = { ...this.target }; this.draw(); return; }
    if (!this.animation) { this.lastFrame = performance.now(); this.animation = requestAnimationFrame(stamp => this.frame(stamp)); }
  }
  private frame(stamp: number) {
    const alpha = 1 - Math.exp(-Math.min(64, stamp - this.lastFrame) / 75);
    this.frameAlpha = alpha;
    this.lastFrame = stamp;
    this.view = { from:this.view.from + (this.target.from - this.view.from) * alpha, to:this.view.to + (this.target.to - this.view.to) * alpha };
    const error = Math.max(Math.abs(this.view.from - this.target.from), Math.abs(this.view.to - this.target.to));
    const viewportFinished = error / duration(this.target) * this.plotWidth < .04;
    if (viewportFinished) this.view = { ...this.target };
    this.draw();
    const finished = viewportFinished && this.scaleError < .0001;
    this.animation = finished ? 0 : requestAnimationFrame(next => this.frame(next));
  }
  private stopAnimation() { cancelAnimationFrame(this.animation); this.animation = 0; }
  private reset() {
    if (!this.fixed) { this.live = true; const to = Date.now(); this.base = { from:to - this.period, to }; }
    this.moveTo(this.base); clearTimeout(this.debounce);
    // Reset requests the complete chosen period, including data that arrived while exploring.
    void this.fetchRange(false);
  }
  private scheduleDetail() { clearTimeout(this.debounce); this.debounce = window.setTimeout(() => void this.fetchRange(true), 180); }

  private async fetchRange(detail: boolean) {
    if (!this.plc) return;
    const key = this.key, plcId = this.plc.id, variableId = this.variable.id;
    const span = duration(this.target);
    const range = detail ? { from:Math.max(this.base.from, this.target.from - span * .25), to:Math.min(this.base.to, this.target.to + span * .25) } : { ...this.base };
    range.from = Math.floor(range.from); range.to = Math.ceil(range.to);
    this.request?.abort(); const controller = new AbortController(); this.request = controller;
    this.lastFetch = Date.now();
    this.setError('');
    try {
      const query = new URLSearchParams({ variable_id:variableId, from_ms:String(range.from), to_ms:String(range.to), limit:'2000' });
      const response = await fetch(`/api/plcs/${encodeURIComponent(plcId)}/history?${query}`, { signal:controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body: HistoryResponse = await response.json();
      if (key !== this.key || controller.signal.aborted) return;
      const dataset = { ...range, response:body };
      if (detail) this.detail = dataset;
      else { this.overview = dataset; this.detail = undefined; }
      this.draw();
    } catch (error) {
      if (!controller.signal.aborted) { this.setError(`No se pudo cargar este periodo (${String(error)}).`); this.draw(); }
    } finally { if (this.request === controller) this.request = undefined; }
  }

  exportRange(): Window { return { from:Math.ceil(this.view.from), to:Math.floor(this.view.to) }; }

  private draw() {
    if (!this.plc) return;
    const v = this.variable;
    const detail = this.detail;
    this.dataset = detail && detail.from <= this.view.from + 1 && detail.to >= this.view.to - 1 ? detail : this.overview;
    const data = this.dataset?.response;
    const samples: Sample[] = data?.samples ?? [];
    // Include one sample outside either edge so clipping preserves boundary crossings.
    const ordered = samples.map(s => ({ s, t:Date.parse(s.observed_at) })).sort((a, b) => a.t - b.t);
    const first = ordered.findIndex(p => p.t >= this.view.from);
    let last = ordered.findIndex(p => p.t > this.view.to);
    if (last < 0) last = ordered.length;
    const visible = ordered.slice(Math.max(0, first < 0 ? ordered.length - 1 : first - 1), last + 1);
    const from = Math.min(this.view.from, visible[0]?.t ?? this.view.from), to = Math.max(this.view.to, visible.at(-1)?.t ?? this.view.to);
    this.trend = buildTrend(visible.map(p => p.s), v.unit, from, to, this.plc.interval_ms, this.plc.timeout_ms,
      data?.aggregated ? (data.gaps ?? []).map(g => ({ from:g.from_ms, to:g.to_ms })) : undefined);
    this.points = this.trend.segments.flat().filter(p => p.time >= this.view.from && p.time <= this.view.to);
    const values = this.trend.segments.flat().map(p => p.value);
    let min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
    const padding = max === min ? Math.max(Math.abs(min) * .04, .5) : (max - min) * .12;
    min -= padding; max += padding;
    const rawStep = (max - min) / 4, magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].map(n => n * magnitude).find(n => n >= rawStep)!;
    const targetLow = Math.floor(min / step) * step, targetHigh = Math.ceil(max / step) * step;
    if (this.animation && this.scaleReady && !this.motion.matches) {
      this.low += (targetLow - this.low) * this.frameAlpha;
      this.high += (targetHigh - this.high) * this.frameAlpha;
    } else { this.low = targetLow; this.high = targetHigh; }
    this.scaleReady = true;
    this.scaleError = Math.max(Math.abs(this.low - targetLow), Math.abs(this.high - targetHigh)) / (targetHigh - targetLow);
    const yLabels = [];
    for (let value = Math.ceil(this.low / step) * step; value <= this.high + step * .00001; value += step) {
      yLabels.push(`<line x1="${this.left}" y1="${this.y(value)}" x2="${this.width - 16}" y2="${this.y(value)}" stroke="#E6E9E2"/><text x="${this.left - 10}" y="${this.y(value) + 4}" text-anchor="end">${axisNumber(value)}</text>`);
    }
    const span = duration(this.view), tickCount = Math.max(2, Math.floor(this.plotWidth / (span < 10000 ? 115 : 86)));
    const tickSteps = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000, 1800000, 3600000, 7200000, 14400000, 21600000, 43200000];
    const wantedTick = span / tickCount;
    const tick = tickSteps.reduce((best, value) => Math.abs(Math.log(value / wantedTick)) < Math.abs(Math.log(best / wantedTick)) ? value : best);
    const xLabels = [];
    let previousLabel = -Infinity;
    for (let t = Math.ceil(this.view.from / tick) * tick; t <= this.view.to; t += tick) {
      let text = formatTime(t);
      if (tick >= 60000) text = text.slice(0, 5);
      if (tick < 1000) text += '.' + String(t % 1000).padStart(3, '0');
      const halfWidth = text.length * 3.4;
      const x = Math.max(halfWidth + 2, Math.min(this.width - halfWidth - 2, this.x(t)));
      if (x - previousLabel < halfWidth * 2 + 10) continue;
      previousLabel = x;
      xLabels.push(`<text x="${x}" y="260" text-anchor="middle">${text}</text>`);
    }
    const gaps = this.trend.gaps.filter(g => overlaps({ from:g.from, to:g.to }, this.view));
    const missing = gaps.map(g => `<rect class="trend-gap" x="${this.x(g.from)}" y="${this.top}" width="${Math.max(0, this.x(g.to) - this.x(g.from))}" height="${this.bottom - this.top}" fill="#EEF0EB"><title>Sin muestras${data?.aggregated ? ' dentro de este intervalo resumido' : ''}: ${formatTime(g.from)}–${formatTime(g.to)}</title></rect>`).join('');
    const paths = this.trend.segments.map(s => `<path class="trend-line" d="${s.map((p, i) => `${i ? 'L' : 'M'}${this.x(p.time).toFixed(2)},${this.y(p.value).toFixed(2)}`).join(' ')}" vector-effect="non-scaling-stroke"/>${s.length === 1 ? `<circle cx="${this.x(s[0].time)}" cy="${this.y(s[0].value)}" r="2.5" fill="#1A3C2B"/>` : ''}`).join('');
    const lastPoint = this.points.at(-1);
    const dot = lastPoint ? `<circle cx="${this.x(lastPoint.time)}" cy="${this.y(lastPoint.value)}" r="3" fill="#1A3C2B" stroke="white" stroke-width="1.5"/>` : '';
    const limit = v.high_limit !== null && v.high_limit >= this.low && v.high_limit <= this.high ? `<line x1="${this.left}" y1="${this.y(v.high_limit)}" x2="${this.width - 16}" y2="${this.y(v.high_limit)}" stroke="#865400" stroke-dasharray="5 4"/><text x="${this.width - 20}" y="${this.y(v.high_limit) - 7}" text-anchor="end" fill="#865400">Límite ${numeric.format(v.high_limit)}</text>` : '';
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    this.svg.dataset.from = String(this.view.from); this.svg.dataset.to = String(this.view.to);
    this.svg.dataset.targetFrom = String(this.target.from); this.svg.dataset.targetTo = String(this.target.to);
    this.svg.dataset.live = String(this.live);
    this.svg.querySelector('clipPath rect')!.setAttribute('x', String(this.left));
    this.svg.querySelector('clipPath rect')!.setAttribute('y', String(this.top - 4));
    this.svg.querySelector('clipPath rect')!.setAttribute('width', String(this.plotWidth));
    this.svg.querySelector('clipPath rect')!.setAttribute('height', String(this.bottom - this.top + 8));
    this.layers.innerHTML = `<g clip-path="url(#trend-plot)">${missing}</g>${yLabels.join('')}${limit}<g clip-path="url(#trend-plot)" fill="none" stroke="#1A3C2B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}${dot}</g>${xLabels.join('')}${!values.length ? `<text x="${this.left + this.plotWidth / 2}" y="130" text-anchor="middle">${this.error ? 'Historial no disponible' : data ? 'Sin lecturas válidas en este intervalo' : 'Cargando historial…'}</text>` : ''}`;
    node('chart-range').textContent = `${calendar.format(this.view.from)} — ${calendar.format(this.view.to)}`;
    node('chart-status').textContent = this.live ? '● En vivo' : this.fixed ? 'Periodo fijo' : 'Explorando historial';
    node<HTMLButtonElement>('chart-live').setAttribute('aria-pressed', String(this.live));
    const gapText = gaps.length ? ` · ${gaps.length} ${gaps.length === 1 ? 'intervalo sin muestras' : 'intervalos sin muestras'}${data?.aggregated ? ' dentro de franjas resumidas' : ' (franjas grises)'}` : '';
    node('chart-quality').textContent = (data?.aggregated ? `Vista resumida · ${numeric.format(data.source_count ?? samples.length)} lecturas · picos conservados · acerca para ver el detalle` : 'Historial guardado por Rust · hora de Bogotá') + gapText;
    this.showTooltip();
  }

  private hideTooltip() { this.tooltip.hidden = true; this.crosshair.setAttribute('visibility', 'hidden'); }
  private showTooltip() {
    if (!this.pointer || !this.inPlot(this.pointer) || this.drag || this.animation) { this.hideTooltip(); return; }
    const time = this.view.from + (this.pointer.x - this.left) / this.plotWidth * duration(this.view);
    const gap = this.trend.gaps.some(g => time > g.from && time < g.to);
    let closest: TrendPoint | undefined;
    let left = 0, right = this.points.length;
    while (left < right) { const mid = (left + right) >>> 1; if (this.points[mid].time < time) left = mid + 1; else right = mid; }
    for (const p of [this.points[left - 1], this.points[left]]) { if (p && (!closest || Math.abs(p.time - time) < Math.abs(closest.time - time))) closest = p; }
    const tolerance = this.dataset?.response.aggregated ? (this.dataset.response.bucket_ms ?? 0) : Math.max(this.plc!.interval_ms * 1.5, this.plc!.timeout_ms);
    const valid = !gap && closest && Math.abs(closest.time - time) <= tolerance;
    const stamp = valid ? closest!.time : time;
    this.tooltip.innerHTML = `<span>${escape(calendar.format(stamp))}.${String(Math.floor(stamp) % 1000).padStart(3, '0')} · Bogotá</span><strong>${valid ? `${precise.format(closest!.value)} ${escape(this.variable.unit)}` : 'Sin lectura en este instante'}</strong>${this.dataset?.response.aggregated ? '<span>Muestra de la vista resumida</span>' : ''}`;
    this.tooltip.hidden = false;
    const x = valid ? this.x(closest!.time) : this.pointer.x;
    this.tooltip.style.left = `${Math.max(0, Math.min(this.width - this.tooltip.offsetWidth, x + 12))}px`;
    this.tooltip.style.top = '8px';
    this.crosshair.setAttribute('visibility', 'visible');
    const line = this.crosshair.querySelector('line')!;
    for (const [name, value] of Object.entries({ x1:x, x2:x, y1:this.top, y2:this.bottom })) line.setAttribute(name, String(value));
    const circle = this.crosshair.querySelector('circle')!;
    circle.setAttribute('visibility', valid ? 'visible' : 'hidden');
    if (valid) { circle.setAttribute('cx', String(x)); circle.setAttribute('cy', String(this.y(closest!.value))); }
  }
}

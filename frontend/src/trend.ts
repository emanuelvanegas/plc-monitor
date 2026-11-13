import type { Sample } from './types';

export interface TrendPoint { time: number; value: number }
export interface TrendGap { from: number; to: number }
export interface Trend { segments: TrendPoint[][]; gaps: TrendGap[] }

/** Samples already contain engineering values. Administrative revisions do not
 * change that series; failed samples, incompatible units and missing time do. */
export function buildTrend(
  samples: Sample[], unit: string, from: number, to: number,
  intervalMs: number, timeoutMs: number,
  overviewGaps?: TrendGap[],
): Trend {
  const segments: TrendPoint[][] = [];
  const gaps: TrendGap[] = [];
  const tolerance = Math.max(intervalMs * 2.5, intervalMs + timeoutMs);
  let segment: TrendPoint[] = [];
  let lastGood: TrendPoint | null = null;
  let gapStart: number | null = null;

  const flush = () => { if (segment.length) segments.push(segment); segment = []; };
  const gap = (start: number, end: number) => {
    start = Math.max(from, start); end = Math.min(to, end);
    if (end > start) gaps.push({ from: start, to: end });
  };
  const ordered = samples.map(sample => ({ sample, time: Date.parse(sample.observed_at) }))
    .filter(({ time }) => Number.isFinite(time) && time >= from && time <= to)
    .sort((a, b) => a.time - b.time);

  for (const { sample, time } of ordered) {
    if (overviewGaps) {
      // Sparse overview spacing is not a missing reading. Only raw-data gaps
      // supplied by the server may break it. Ambiguous bucket points stand alone.
      if (sample.quality !== 'good' || sample.value === null || !Number.isFinite(sample.value) || sample.unit !== unit) { flush(); continue; }
      if (lastGood && overviewGaps.some(g => g.from < time && g.to > lastGood!.time)) flush();
      const point = { time, value: sample.value };
      segment.push(point); lastGood = point;
      if (overviewGaps.some(g => g.from <= time && g.to >= time)) flush();
      continue;
    }
    if (sample.quality !== 'good' || sample.value === null || !Number.isFinite(sample.value) || sample.unit !== unit) {
      flush();
      gapStart ??= lastGood ? lastGood.time + intervalMs / 2 : time - intervalMs / 2;
      continue;
    }
    if (gapStart !== null) {
      gap(gapStart, time - intervalMs / 2);
      gapStart = null;
    } else if (lastGood && time - lastGood.time > tolerance) {
      flush();
      gap(lastGood.time + intervalMs / 2, time - intervalMs / 2);
    }
    const point = { time, value: sample.value };
    segment.push(point);
    lastGood = point;
  }
  flush();
  if (overviewGaps) return { segments, gaps: overviewGaps.filter(g => g.to > from && g.from < to).map(g => ({from: Math.max(from, g.from), to: Math.min(to, g.to)})) };
  if (gapStart !== null) gap(gapStart, to);
  else if (lastGood && to - lastGood.time > tolerance) gap(lastGood.time + intervalMs / 2, to);
  return { segments, gaps };
}

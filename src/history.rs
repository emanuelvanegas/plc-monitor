//! Bounded, extrema-preserving overview. Records keep their original timestamps.
use futures_util::TryStreamExt;
use serde::Serialize;
use sqlx::Row;

use crate::{
    domain::{Quality, Sample},
    error::Result,
    storage::{Store, sample_from_row},
};

#[derive(Clone, Serialize)]
pub struct Gap {
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Serialize)]
pub struct History {
    pub samples: Vec<Sample>,
    pub gaps: Vec<Gap>,
    pub aggregated: bool,
    pub bucket_ms: Option<i64>,
    pub source_count: usize,
    pub truncated: bool,
    pub from_ms: i64,
    pub to_ms: i64,
}

#[derive(Default)]
struct Bucket {
    points: Vec<(i64, Sample)>,
    gap: Option<Gap>,
}

impl Bucket {
    fn insert(&mut self, id: i64, sample: Sample, unit: Option<&str>) {
        self.points.push((id, sample));
        // First/last overall, minima/maxima, first/last invalid sample: at most six.
        let mut keep = vec![0, self.points.len() - 1];
        let good = |s: &Sample| {
            s.quality == Quality::Good
                && s.value.is_some_and(f64::is_finite)
                && unit == Some(s.unit.as_str())
        };
        for minimum in [true, false] {
            if let Some((index, _)) = self
                .points
                .iter()
                .enumerate()
                .filter(|(_, (_, s))| good(s))
                .min_by(|(_, (_, a)), (_, (_, b))| {
                    let order = a.value.unwrap().total_cmp(&b.value.unwrap());
                    if minimum { order } else { order.reverse() }
                })
            {
                keep.push(index);
            }
        }
        let bad = self
            .points
            .iter()
            .enumerate()
            .filter(|(_, (_, s))| !good(s))
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if let Some(i) = bad.first() {
            keep.push(*i);
        }
        if let Some(i) = bad.last() {
            keep.push(*i);
        }
        self.points = self
            .points
            .drain(..)
            .enumerate()
            .filter(|(i, _)| keep.contains(i))
            .map(|(_, point)| point)
            .collect();
    }
}

impl Store {
    pub async fn history_view(
        &self,
        plc: &str,
        variable: &str,
        start: i64,
        end: i64,
        limit: i64,
    ) -> Result<History> {
        let recent = self.history(plc, variable, start, end, limit + 1).await?;
        if recent.len() <= limit as usize {
            return Ok(History {
                source_count: recent.len(),
                samples: recent,
                gaps: vec![],
                aggregated: false,
                bucket_ms: None,
                truncated: false,
                from_ms: start,
                to_ms: end,
            });
        }
        let config = self.get(plc).await?.config;
        let unit = config
            .variables
            .iter()
            .find(|v| v.id == variable)
            .map(|v| v.unit.as_str());
        let interval = config.interval_ms as i64;
        let tolerance = (interval * 5 / 2).max(interval + config.timeout_ms as i64);
        let count = (limit as usize / 6).max(1);
        let bucket_ms = ((end - start + 1) / count as i64 + 1).max(1);
        let mut buckets: Vec<Bucket> = (0..count).map(|_| Bucket::default()).collect();
        let mut rows = sqlx::query("SELECT * FROM samples WHERE plc_id=? AND variable_id=? AND observed_at_ms BETWEEN ? AND ? ORDER BY observed_at_ms,id")
            .bind(plc).bind(variable).bind(start).bind(end).fetch(&self.pool);
        let mut last_good = None;
        let mut gap_start = None;
        let mut source_count = 0;
        let mark_gap = |from: i64, to: i64, buckets: &mut Vec<Bucket>| {
            if to <= from {
                return;
            }
            let first = ((from.max(start) - start) / bucket_ms) as usize;
            let last = ((to.min(end) - start) / bucket_ms) as usize;
            for (index, bucket) in buckets
                .iter_mut()
                .enumerate()
                .take((last + 1).min(count))
                .skip(first)
            {
                let from_ms = from.max(start + index as i64 * bucket_ms).max(start);
                let to_ms = to.min(start + (index + 1) as i64 * bucket_ms).min(end);
                if to_ms > from_ms {
                    bucket.gap = Some(match bucket.gap.take() {
                        Some(old) => Gap {
                            from_ms: old.from_ms.min(from_ms),
                            to_ms: old.to_ms.max(to_ms),
                        },
                        None => Gap { from_ms, to_ms },
                    });
                }
            }
        };
        while let Some(row) = rows.try_next().await? {
            source_count += 1;
            let sample = sample_from_row(&row)?;
            let stamp = sample.observed_at.timestamp_millis();
            let good = sample.quality == Quality::Good
                && sample.value.is_some_and(f64::is_finite)
                && unit == Some(sample.unit.as_str());
            if good {
                if let Some(from) = gap_start.take() {
                    mark_gap(from, stamp - interval / 2, &mut buckets);
                } else if let Some(previous) = last_good
                    && stamp - previous > tolerance
                {
                    mark_gap(previous + interval / 2, stamp - interval / 2, &mut buckets);
                }
                last_good = Some(stamp);
            } else {
                gap_start.get_or_insert(last_good.unwrap_or(stamp - interval) + interval / 2);
            }
            let index = (((stamp - start) / bucket_ms) as usize).min(count - 1);
            buckets[index].insert(row.get("id"), sample, unit);
        }
        if let Some(from) = gap_start {
            mark_gap(from, end, &mut buckets);
        } else if let Some(previous) = last_good
            && end - previous > tolerance
        {
            mark_gap(previous + interval / 2, end, &mut buckets);
        }
        let mut samples = Vec::new();
        let mut gaps: Vec<Gap> = Vec::new();
        for bucket in buckets {
            samples.extend(bucket.points.into_iter().map(|(_, sample)| sample));
            if let Some(gap) = bucket.gap {
                if let Some(last) = gaps.last_mut().filter(|last| last.to_ms >= gap.from_ms) {
                    last.to_ms = last.to_ms.max(gap.to_ms);
                } else {
                    gaps.push(gap);
                }
            }
        }
        Ok(History {
            samples,
            gaps,
            aggregated: true,
            bucket_ms: Some(bucket_ms),
            source_count,
            truncated: false,
            from_ms: start,
            to_ms: end,
        })
    }
}

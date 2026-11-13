//! One polling calendar per PLC. The worker awaits each cycle before asking for
//! another tick, including after an overrun. Reconnection has its own deadline.
use std::time::Duration;

use tokio::time::{Interval, MissedTickBehavior, interval};

use crate::domain::Connection;

pub(crate) struct PollSchedule {
    ticks: Interval,
    backoff: Duration,
}

impl PollSchedule {
    pub(crate) fn new(period: Duration) -> Self {
        let mut ticks = interval(period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Skip);
        Self {
            ticks,
            backoff: Duration::from_millis(500),
        }
    }

    pub(crate) async fn tick(&mut self) {
        self.ticks.tick().await;
    }

    pub(crate) fn finish(&mut self, connection: Connection) {
        if connection == Connection::Offline {
            // Start the delay after the failed cycle and its persistence. Reset
            // discards the old calendar, including ticks missed while offline.
            self.ticks.reset_after(self.backoff);
            self.backoff = (self.backoff * 2).min(Duration::from_secs(8));
        } else {
            self.backoff = Duration::from_millis(500);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{Instant, advance};

    #[tokio::test(start_paused = true)]
    async fn normal_work_keeps_the_original_calendar_and_first_tick_is_immediate() {
        let mut schedule = PollSchedule::new(Duration::from_millis(100));
        let origin = Instant::now();
        schedule.tick().await;
        assert_eq!(Instant::now(), origin);
        for tick in 1..=10 {
            advance(Duration::from_millis(20)).await;
            schedule.finish(Connection::Connected);
            schedule.tick().await;
            assert_eq!(Instant::now() - origin, Duration::from_millis(tick * 100));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn overruns_skip_the_backlog_and_return_to_the_calendar() {
        let mut schedule = PollSchedule::new(Duration::from_millis(100));
        let origin = Instant::now();
        schedule.tick().await;
        advance(Duration::from_millis(350)).await;
        schedule.finish(Connection::Connected);
        // One late tick can be delivered immediately. Skip removes the rest of
        // the backlog, so a second fast cycle must wait for the 400 ms boundary.
        schedule.tick().await;
        assert_eq!(Instant::now() - origin, Duration::from_millis(350));
        advance(Duration::from_millis(20)).await;
        schedule.finish(Connection::Connected);
        schedule.tick().await;
        assert_eq!(Instant::now() - origin, Duration::from_millis(400));
    }

    #[tokio::test(start_paused = true)]
    async fn reconnect_backoff_is_capped_and_recovery_does_not_replay_old_ticks() {
        let mut schedule = PollSchedule::new(Duration::from_millis(100));
        schedule.tick().await;
        for delay in [500, 1000, 2000, 4000, 8000, 8000] {
            advance(Duration::from_millis(150)).await;
            let failed = Instant::now();
            schedule.finish(Connection::Offline);
            schedule.tick().await;
            assert_eq!(Instant::now() - failed, Duration::from_millis(delay));
        }
        let recovered = Instant::now();
        advance(Duration::from_millis(20)).await;
        schedule.finish(Connection::Connected);
        schedule.tick().await;
        assert_eq!(Instant::now() - recovered, Duration::from_millis(100));
        schedule.finish(Connection::Offline);
        let failed = Instant::now();
        schedule.tick().await;
        assert_eq!(Instant::now() - failed, Duration::from_millis(500));
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_during_reconnect_does_not_wait_for_the_next_tick() {
        let mut schedule = PollSchedule::new(Duration::from_secs(60));
        schedule.tick().await;
        schedule.finish(Connection::Offline);
        let token = tokio_util::sync::CancellationToken::new();
        let origin = Instant::now();
        let cancellation = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            token.cancel();
        };
        let waiting = async {
            tokio::select! {
                biased;
                _ = token.cancelled() => {},
                _ = schedule.tick() => panic!("cancelled worker polled again"),
            }
        };
        tokio::join!(cancellation, waiting);
        assert_eq!(Instant::now() - origin, Duration::from_millis(10));
    }
}

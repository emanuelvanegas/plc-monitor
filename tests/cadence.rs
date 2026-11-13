//! Real TCP probe for worker timing. The ignored comparison writes a reproducible
//! report without changing the user's PLC configuration or database.
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use chrono::Utc;
use plc_monitor::{acquisition::App, demo::fixtures, domain::Quality, storage::Store};
use serde::Serialize;
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    task::JoinHandle,
    time::{Instant, sleep, timeout},
};
use tokio_modbus::{
    prelude::*,
    server::{Service, tcp::Server},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct Observation {
    started: Instant,
    completed: Option<Instant>,
    address: u16,
}
#[derive(Default)]
struct Trace {
    reads: Mutex<Vec<Observation>>,
    active: AtomicUsize,
    max_active: AtomicUsize,
    connections: AtomicUsize,
}
struct InFlight(Arc<Trace>);
impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
#[derive(Clone)]
struct ProbeService {
    trace: Arc<Trace>,
    delays: Arc<Vec<Duration>>,
}
impl Service for ProbeService {
    type Request = SlaveRequest<'static>;
    type Response = Option<Response>;
    type Exception = ExceptionCode;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Exception>> + Send>>;
    fn call(&self, request: Self::Request) -> Self::Future {
        let service = self.clone();
        Box::pin(async move {
            let (address, count, input) = match request.request {
                Request::ReadHoldingRegisters(address, count) => (address, count, false),
                Request::ReadInputRegisters(address, count) => (address, count, true),
                _ => return Err(ExceptionCode::IllegalFunction),
            };
            let index = {
                let mut reads = service.trace.reads.lock().unwrap();
                let index = reads.len();
                reads.push(Observation {
                    started: Instant::now(),
                    completed: None,
                    address,
                });
                index
            };
            let active = service.trace.active.fetch_add(1, Ordering::SeqCst) + 1;
            service.trace.max_active.fetch_max(active, Ordering::SeqCst);
            let _guard = InFlight(service.trace.clone());
            let delay = service
                .delays
                .get(index)
                .or(service.delays.last())
                .copied()
                .unwrap_or_default();
            sleep(delay).await;
            service.trace.reads.lock().unwrap()[index].completed = Some(Instant::now());
            // A late first reply is deliberately different, so recovery tests
            // detect accidental reuse of a connection containing a stale reply.
            let word = if index == 0 && delay >= Duration::from_millis(300) {
                9999
            } else {
                253
            };
            let words = vec![word; usize::from(count)];
            Ok(Some(if input {
                Response::ReadInputRegisters(words)
            } else {
                Response::ReadHoldingRegisters(words)
            }))
        })
    }
}

struct Probe {
    _directory: TempDir,
    store: Store,
    app: App,
    trace: Arc<Trace>,
    cancel: CancellationToken,
    server: JoinHandle<()>,
}
impl Probe {
    async fn start(delays: Vec<u64>, variables: usize, timeout_ms: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let trace = Arc::new(Trace::default());
        let service = ProbeService {
            trace: trace.clone(),
            delays: Arc::new(delays.into_iter().map(Duration::from_millis).collect()),
        };
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let server = tokio::spawn(async move {
            let on_connected = move |stream, _| {
                let service = service.clone();
                service.trace.connections.fetch_add(1, Ordering::SeqCst);
                async move { Ok(Some((service, stream))) }
            };
            Server::new(listener)
                .serve_until(&on_connected, |_| {}, signal.cancelled_owned())
                .await
                .unwrap();
        });
        let directory = TempDir::new().unwrap();
        let store = Store::open(&directory.path().join("cadence.db"))
            .await
            .unwrap();
        let mut config = fixtures().remove(0).1;
        config.port = port;
        config.interval_ms = 100;
        config.timeout_ms = timeout_ms;
        config.variables.truncate(variables);
        store.create("probe".into(), config).await.unwrap();
        let app = App::start(store.clone()).await.unwrap();
        Self {
            _directory: directory,
            store,
            app,
            trace,
            cancel,
            server,
        }
    }
    async fn wait_samples(&self, count: usize) {
        timeout(Duration::from_secs(12), async {
            loop {
                let samples = self
                    .store
                    .history("probe", "tank-temperature", 0, i64::MAX, 1000)
                    .await
                    .unwrap();
                if samples.len() >= count {
                    return;
                }
                sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("probe did not collect the requested samples");
    }
    async fn stop(self) {
        self.app.shutdown().await;
        self.cancel.cancel();
        self.server.await.unwrap();
        self.store.pool.close().await;
    }
}

#[derive(Serialize)]
struct Measurement {
    scenario: String,
    period_ms: u64,
    configured_delays_ms: Vec<u64>,
    starts_ms: Vec<f64>,
    start_gaps_ms: Vec<f64>,
    response_times_ms: Vec<f64>,
    mean_gap_ms: f64,
    final_phase_offset_ms: f64,
    max_in_flight: usize,
}
fn millis(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 100_000.0).round() / 100.0
}

#[tokio::test]
#[ignore = "wall-clock comparison; run explicitly with PLC_CADENCE_OUTPUT"]
async fn measure_worker_cadence() {
    let mut measurements = Vec::new();
    for (name, delays) in [
        ("normal", vec![20; 14]),
        ("single_overrun", {
            let mut delays = vec![20; 14];
            delays[3] = 260;
            delays
        }),
        ("sustained_overrun", vec![140; 10]),
    ] {
        let probe = Probe::start(delays.clone(), 1, 500).await;
        probe.wait_samples(delays.len()).await;
        probe.app.acquisition("probe", false).await.unwrap();
        let reads = probe
            .trace
            .reads
            .lock()
            .unwrap()
            .iter()
            .take(delays.len())
            .cloned()
            .collect::<Vec<_>>();
        let origin = reads[0].started;
        let starts_ms = reads
            .iter()
            .map(|r| millis(r.started - origin))
            .collect::<Vec<_>>();
        let start_gaps_ms = reads
            .windows(2)
            .map(|r| millis(r[1].started - r[0].started))
            .collect::<Vec<_>>();
        let response_times_ms = reads
            .iter()
            .map(|r| millis(r.completed.unwrap() - r.started))
            .collect();
        let mean_gap_ms = start_gaps_ms.iter().sum::<f64>() / start_gaps_ms.len() as f64;
        let final_phase_offset_ms =
            starts_ms.last().unwrap() - (starts_ms.len() - 1) as f64 * 100.0;
        let max_in_flight = probe.trace.max_active.load(Ordering::SeqCst);
        assert_eq!(max_in_flight, 1);
        measurements.push(Measurement {
            scenario: name.into(),
            period_ms: 100,
            configured_delays_ms: delays,
            starts_ms,
            start_gaps_ms,
            response_times_ms,
            mean_gap_ms,
            final_phase_offset_ms,
            max_in_flight,
        });
        probe.stop().await;
    }
    let report = serde_json::json!({ "measured_at":Utc::now(), "os":std::env::consts::OS, "architecture":std::env::consts::ARCH, "profile":"cargo test (debug)", "transport":"Modbus TCP loopback with SQLite persistence; one variable per PLC", "measurements":measurements });
    if let Ok(path) = std::env::var("PLC_CADENCE_OUTPUT") {
        std::fs::write(path, serde_json::to_string_pretty(&report).unwrap() + "\n").unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

#[tokio::test]
async fn slow_variables_remain_sequential_and_do_not_create_extra_connections() {
    let probe = Probe::start(vec![45], 3, 500).await;
    probe.wait_samples(4).await;
    probe.app.acquisition("probe", false).await.unwrap();
    let reads = probe.trace.reads.lock().unwrap().clone();
    assert_eq!(probe.trace.max_active.load(Ordering::SeqCst), 1);
    assert_eq!(probe.trace.connections.load(Ordering::SeqCst), 1);
    assert!(reads.len() >= 12);
    for (i, read) in reads.iter().take(12).enumerate() {
        assert_eq!(read.address, (i % 3) as u16);
    }
    for pair in reads.windows(2) {
        if let Some(completed) = pair[0].completed {
            assert!(pair[1].started >= completed);
        }
    }
    let samples = probe
        .store
        .history("probe", "tank-temperature", 0, i64::MAX, 100)
        .await
        .unwrap();
    assert!(samples.iter().all(|s| s.quality == Quality::Good));
    probe.stop().await;
}

#[tokio::test]
async fn timeout_discards_the_connection_and_recovery_keeps_backoff_and_normal_cadence() {
    let probe = Probe::start(vec![350, 20], 3, 100).await;
    timeout(Duration::from_secs(3), async {
        loop {
            let view = probe.app.view("probe").await.unwrap();
            if view
                .state
                .variables
                .get("tank-temperature")
                .is_some_and(|state| state.quality == Some(Quality::Timeout))
            {
                assert!(
                    view.state
                        .variables
                        .values()
                        .all(|state| state.last_good.is_none())
                );
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("timeout was not published");
    probe.wait_samples(5).await;
    probe.app.acquisition("probe", false).await.unwrap();
    let reads = probe.trace.reads.lock().unwrap().clone();
    assert_eq!(probe.trace.connections.load(Ordering::SeqCst), 2);
    assert!(reads[1].started - reads[0].started >= Duration::from_millis(580));
    // At most the currently late tick is delivered after recovery; a backlog of
    // requests from the offline period must not produce consecutive fast cycles.
    let cycles = reads
        .iter()
        .skip(1)
        .filter(|read| read.address == 0)
        .collect::<Vec<_>>();
    assert!(cycles.len() >= 4);
    assert!(
        cycles
            .windows(3)
            .all(|window| window[2].started - window[0].started >= Duration::from_millis(140))
    );
    let samples = probe
        .store
        .history("probe", "tank-temperature", 0, i64::MAX, 100)
        .await
        .unwrap();
    assert_eq!(samples[0].quality, Quality::Timeout);
    assert_eq!(samples[0].value, None);
    assert!(
        samples
            .iter()
            .skip(1)
            .all(|sample| sample.quality == Quality::Good && sample.value == Some(25.3))
    );
    assert!(probe.app.storage_error().await.is_none());
    probe.stop().await;
}

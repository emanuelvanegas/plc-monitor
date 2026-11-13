use std::{collections::HashMap, sync::Arc, time::Duration};

use chrono::Utc;
use serde::Serialize;
use tokio::{
    sync::{Mutex, RwLock, mpsc, oneshot},
    task::JoinHandle,
    time::{Instant, timeout},
};
use tokio_modbus::{
    client::{Context, tcp},
    prelude::*,
};
use tokio_util::sync::CancellationToken;

use crate::{
    domain::{
        Connection, Event, Plc, PlcConfig, PlcState, Quality, Sample, VariableState,
        alarm_transition, new_id,
    },
    error::Result,
    schedule::PollSchedule,
    storage::Store,
};

struct Worker {
    cancel: CancellationToken,
    handle: JoinHandle<()>,
}
enum WriteMessage {
    Batch(
        Vec<Sample>,
        Vec<Event>,
        oneshot::Sender<std::result::Result<(), String>>,
    ),
    Stop(oneshot::Sender<()>),
}

struct Inner {
    store: Store,
    states: RwLock<HashMap<String, PlcState>>,
    workers: Mutex<HashMap<String, Worker>>,
    admin: Mutex<()>,
    writer: mpsc::Sender<WriteMessage>,
    storage_error: Arc<RwLock<Option<String>>>,
}

#[derive(Clone)]
pub struct App(Arc<Inner>);

#[derive(Debug, Clone, Serialize)]
pub struct PlcView {
    #[serde(flatten)]
    pub plc: Plc,
    pub state: PlcState,
}

impl App {
    pub async fn start(store: Store) -> Result<Self> {
        let (writer, mut receiver) = mpsc::channel(32);
        let storage_error = Arc::new(RwLock::new(None));
        let error_state = storage_error.clone();
        let writer_store = store.clone();
        tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                match message {
                    WriteMessage::Batch(samples, events, reply) => {
                        let result = writer_store
                            .persist(&samples, &events)
                            .await
                            .map_err(|e| e.to_string());
                        *error_state.write().await = result.as_ref().err().cloned();
                        let _ = reply.send(result);
                    }
                    WriteMessage::Stop(reply) => {
                        let _ = reply.send(());
                        break;
                    }
                }
            }
        });
        let app = Self(Arc::new(Inner {
            store,
            states: RwLock::new(HashMap::new()),
            workers: Mutex::new(HashMap::new()),
            admin: Mutex::new(()),
            writer,
            storage_error,
        }));
        for plc in app.store().list().await? {
            app.launch(plc).await;
        }
        Ok(app)
    }

    pub fn store(&self) -> &Store {
        &self.0.store
    }
    pub async fn storage_error(&self) -> Option<String> {
        self.0.storage_error.read().await.clone()
    }

    pub async fn views(&self) -> Result<Vec<PlcView>> {
        let configs = self.store().list().await?;
        let states = self.0.states.read().await;
        Ok(configs
            .into_iter()
            .map(|plc| PlcView {
                state: states.get(&plc.id).cloned().unwrap_or_default(),
                plc,
            })
            .collect())
    }

    pub async fn view(&self, id: &str) -> Result<PlcView> {
        let plc = self.store().get(id).await?;
        let state = self
            .0
            .states
            .read()
            .await
            .get(id)
            .cloned()
            .unwrap_or_default();
        Ok(PlcView { plc, state })
    }

    pub async fn create(&self, config: PlcConfig) -> Result<PlcView> {
        let _guard = self.0.admin.lock().await;
        let plc = self.store().create(new_id(), config).await?;
        self.launch(plc.clone()).await;
        self.view(&plc.id).await
    }

    pub async fn update(&self, id: &str, expected: u64, config: PlcConfig) -> Result<PlcView> {
        let _guard = self.0.admin.lock().await;
        let old = self.store().get(id).await?;
        let plc = self.store().update(id, expected, config).await?;
        self.stop_worker(id).await;
        let mut states = self.0.states.write().await;
        let state = states.entry(id.into()).or_default();
        state.variables.retain(|key, _| {
            old.config.variables.iter().find(|v| &v.id == key)
                == plc.config.variables.iter().find(|v| &v.id == key)
        });
        state.connection = Connection::Unknown;
        drop(states);
        self.launch(plc).await;
        self.view(id).await
    }

    pub async fn acquisition(&self, id: &str, running: bool) -> Result<PlcView> {
        let _guard = self.0.admin.lock().await;
        let mut plc = self.store().get(id).await?;
        if plc.config.paused == !running {
            return self.view(id).await;
        }
        plc.config.paused = !running;
        let plc = self.store().update(id, plc.revision, plc.config).await?;
        self.stop_worker(id).await;
        self.launch(plc).await;
        self.view(id).await
    }

    async fn launch(&self, plc: Plc) {
        self.0
            .states
            .write()
            .await
            .entry(plc.id.clone())
            .or_default();
        if plc.config.paused {
            return;
        }
        let app = self.clone();
        let id = plc.id.clone();
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let handle = tokio::spawn(async move {
            app.worker(plc, signal).await;
        });
        self.0
            .workers
            .lock()
            .await
            .insert(id, Worker { cancel, handle });
    }

    async fn stop_worker(&self, id: &str) {
        if let Some(worker) = self.0.workers.lock().await.remove(id) {
            worker.cancel.cancel();
            let _ = worker.handle.await;
        }
    }

    async fn commit(&self, samples: Vec<Sample>, events: Vec<Event>) {
        let (reply, received) = oneshot::channel();
        let result = timeout(Duration::from_secs(10), async {
            self.0
                .writer
                .send(WriteMessage::Batch(samples, events, reply))
                .await
                .map_err(|_| "El escritor está detenido".to_string())?;
            received
                .await
                .map_err(|_| "El escritor no respondió".to_string())?
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                tracing::error!(%error, "History write failed");
                *self.0.storage_error.write().await = Some(error);
            }
            Err(_) => {
                *self.0.storage_error.write().await =
                    Some("Tiempo de espera agotado al guardar lecturas".into());
            }
        }
    }

    async fn worker(&self, plc: Plc, cancel: CancellationToken) {
        let mut context = None;
        let period = Duration::from_millis(plc.config.interval_ms);
        let mut schedule = PollSchedule::new(period);
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                _ = schedule.tick() => {},
            }
            let started = Instant::now();
            let (samples, connection) = tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = read_cycle(&plc, &mut context) => result,
            };
            let mut state = self
                .0
                .states
                .read()
                .await
                .get(&plc.id)
                .cloned()
                .unwrap_or_default();
            let mut events = Vec::new();
            if state.connection != connection {
                events.push(Event {
                    plc_id: plc.id.clone(),
                    variable_id: None,
                    occurred_at: Utc::now(),
                    kind: if connection == Connection::Connected {
                        "connection_restored"
                    } else {
                        "connection_lost"
                    }
                    .into(),
                    severity: if connection == Connection::Connected {
                        "info"
                    } else {
                        "error"
                    }
                    .into(),
                    message: if connection == Connection::Connected {
                        "Comunicación Modbus TCP disponible"
                    } else {
                        "No se pudo mantener la comunicación Modbus TCP"
                    }
                    .into(),
                });
            }
            state.connection = connection;
            for sample in &samples {
                let variable = plc
                    .config
                    .variables
                    .iter()
                    .find(|v| v.id == sample.variable_id)
                    .expect("worker owns validated map");
                let current = state
                    .variables
                    .entry(sample.variable_id.clone())
                    .or_insert_with(VariableState::default);
                if let Some(value) = sample.value {
                    let (next, transition) =
                        alarm_transition(current.alarm_active, value, variable.high_limit);
                    current.alarm_active = next;
                    if let Some(active) = transition {
                        events.push(Event {
                            plc_id: plc.id.clone(),
                            variable_id: Some(variable.id.clone()),
                            occurred_at: sample.observed_at,
                            kind: if active {
                                "threshold_exceeded"
                            } else {
                                "threshold_recovered"
                            }
                            .into(),
                            severity: if active { "warning" } else { "info" }.into(),
                            message: format!(
                                "{}: {} {} · {}",
                                variable.name,
                                value,
                                variable.unit,
                                if active {
                                    "umbral superado"
                                } else {
                                    "rango recuperado"
                                }
                            ),
                        });
                    }
                    current.last_good = Some(sample.clone());
                    state.last_success = Some(sample.observed_at);
                }
                if current.quality != Some(sample.quality)
                    && matches!(
                        sample.quality,
                        Quality::InvalidValue | Quality::ModbusException
                    )
                {
                    events.push(Event {
                        plc_id: plc.id.clone(),
                        variable_id: Some(variable.id.clone()),
                        occurred_at: sample.observed_at,
                        kind: "variable_error".into(),
                        severity: "warning".into(),
                        message: format!(
                            "{}: {}",
                            variable.name,
                            sample.error.as_deref().unwrap_or("Lectura inválida")
                        ),
                    });
                }
                current.quality = Some(sample.quality);
                current.error = sample.error.clone();
            }
            self.commit(samples, events).await;
            self.0.states.write().await.insert(plc.id.clone(), state);
            let elapsed = started.elapsed();
            tracing::debug!(
                plc_id = %plc.id,
                cycle_ms = elapsed.as_secs_f64() * 1000.0,
                period_ms = plc.config.interval_ms,
                overrun = elapsed > period,
                "Ciclo de adquisición completado"
            );
            schedule.finish(connection);
        }
    }

    pub async fn shutdown(&self) {
        let _guard = self.0.admin.lock().await;
        let workers = std::mem::take(&mut *self.0.workers.lock().await);
        for worker in workers.values() {
            worker.cancel.cancel();
        }
        for (_, worker) in workers {
            let _ = worker.handle.await;
        }
        let (reply, received) = oneshot::channel();
        let _ = self.0.writer.send(WriteMessage::Stop(reply)).await;
        let _ = received.await;
    }
}

async fn read_cycle(plc: &Plc, context: &mut Option<Context>) -> (Vec<Sample>, Connection) {
    let duration = Duration::from_millis(plc.config.timeout_ms);
    let mut failure = None;
    if context.is_none() {
        let connection = timeout(duration, async {
            let addresses =
                tokio::net::lookup_host((plc.config.host.as_str(), plc.config.port)).await?;
            let mut last = std::io::Error::other("El host no resolvió ninguna dirección");
            for address in addresses {
                match tcp::connect(address).await {
                    Ok(mut ctx) => {
                        ctx.set_slave(Slave(plc.config.unit_id));
                        return Ok(ctx);
                    }
                    Err(error) => last = error,
                }
            }
            Err(last)
        })
        .await;
        match connection {
            Ok(Ok(ctx)) => *context = Some(ctx),
            Ok(Err(error)) => failure = Some((Quality::TransportError, error.to_string())),
            Err(_) => failure = Some((Quality::Timeout, "Timeout de conexión".into())),
        }
    }
    let mut samples = Vec::new();
    for variable in &plc.config.variables {
        let result = if let Some(ctx) = context.as_mut() {
            let read = async {
                match variable.register_type {
                    crate::domain::RegisterType::Holding => {
                        ctx.read_holding_registers(variable.address, variable.register_count())
                            .await
                    }
                    crate::domain::RegisterType::Input => {
                        ctx.read_input_registers(variable.address, variable.register_count())
                            .await
                    }
                }
            };
            match timeout(duration, read).await {
                Ok(Ok(Ok(words))) => variable
                    .decode(&words)
                    .map_err(|error| (Quality::InvalidValue, error.to_string())),
                Ok(Ok(Err(error))) => Err((
                    Quality::ModbusException,
                    format!("Excepción Modbus: {error}"),
                )),
                Ok(Err(error)) => {
                    *context = None;
                    let f = (Quality::TransportError, error.to_string());
                    failure = Some(f.clone());
                    Err(f)
                }
                Err(_) => {
                    *context = None;
                    let f = (Quality::Timeout, "Timeout de lectura".into());
                    failure = Some(f.clone());
                    Err(f)
                }
            }
        } else {
            Err(failure
                .clone()
                .unwrap_or((Quality::TransportError, "Conexión interrumpida".into())))
        };
        let (value, quality, error) = match result {
            Ok(value) => (Some(value), Quality::Good, None),
            Err((quality, message)) => (None, quality, Some(message)),
        };
        samples.push(Sample {
            plc_id: plc.id.clone(),
            variable_id: variable.id.clone(),
            revision: plc.revision,
            observed_at: Utc::now(),
            value,
            quality,
            variable_name: variable.name.clone(),
            unit: variable.unit.clone(),
            plc_name: plc.config.name.clone(),
            error,
        });
    }
    (
        samples,
        if context.is_some() {
            Connection::Connected
        } else {
            Connection::Offline
        },
    )
}

use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle};
use tokio_modbus::{
    prelude::*,
    server::{Service, tcp::Server},
};
use tokio_util::sync::CancellationToken;

use crate::domain::{DataType, PlcConfig, RegisterType, Variable, WordOrder};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Scenario {
    Normal,
    High,
    Offline,
    Slow,
    InvalidAddress,
}

impl Scenario {
    fn code(self) -> u8 {
        match self {
            Self::Normal => 0,
            Self::High => 1,
            Self::Offline => 2,
            Self::Slow => 3,
            Self::InvalidAddress => 4,
        }
    }
}

#[derive(Clone)]
struct RegisterService {
    config: PlcConfig,
    scenario: Arc<AtomicU8>,
}

impl Service for RegisterService {
    type Request = SlaveRequest<'static>;
    type Response = Option<Response>;
    type Exception = ExceptionCode;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Exception>> + Send>>;

    fn call(&self, request: Self::Request) -> Self::Future {
        let config = self.config.clone();
        let scenario = self.scenario.load(Ordering::SeqCst);
        Box::pin(async move {
            if request.slave != config.unit_id {
                return Ok(None);
            }
            if scenario == Scenario::Slow.code() {
                tokio::time::sleep(Duration::from_millis(config.timeout_ms * 3)).await;
            }
            let (space, address, count) = match request.request {
                Request::ReadHoldingRegisters(a, c) => (RegisterType::Holding, a, c),
                Request::ReadInputRegisters(a, c) => (RegisterType::Input, a, c),
                _ => return Err(ExceptionCode::IllegalFunction),
            };
            if scenario == Scenario::InvalidAddress.code()
                && config
                    .variables
                    .iter()
                    .any(|v| v.primary && v.register_type == space && v.address == address)
            {
                return Err(ExceptionCode::IllegalDataAddress);
            }
            let mut map = HashMap::new();
            for (i, variable) in config.variables.iter().enumerate() {
                let baseline = match variable.unit.as_str() {
                    "°C" => 25.3,
                    "%" => 60.0,
                    "m/s" => 1.5,
                    "ciclos" => 1250.0,
                    "pzs" => 8400.0,
                    "estado" => 1.0,
                    _ => (i + 1) as f64,
                };
                let value = if variable.primary && scenario == Scenario::High.code() {
                    variable
                        .high_limit
                        .map_or(baseline + 100.0, |limit| limit + limit.abs().max(1.0) * 0.1)
                } else {
                    baseline
                };
                let raw = if variable.scale == 0.0 {
                    0.0
                } else {
                    value / variable.scale
                };
                let words = match variable.data_type {
                    DataType::Uint16 => vec![raw.round().clamp(0.0, 65535.0) as u16],
                    DataType::Int16 => vec![(raw.round().clamp(-32768.0, 32767.0) as i16) as u16],
                    DataType::Float32 => {
                        let bits = (raw as f32).to_bits();
                        let mut words = vec![(bits >> 16) as u16, bits as u16];
                        if variable.word_order == WordOrder::Cdab {
                            words.reverse();
                        }
                        words
                    }
                };
                for (offset, word) in words.into_iter().enumerate() {
                    map.insert(
                        (
                            variable.register_type == RegisterType::Input,
                            u32::from(variable.address) + offset as u32,
                        ),
                        word,
                    );
                }
            }
            let words = (0..count)
                .map(|offset| {
                    map.get(&(
                        space == RegisterType::Input,
                        u32::from(address) + u32::from(offset),
                    ))
                    .copied()
                    .ok_or(ExceptionCode::IllegalDataAddress)
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(match space {
                RegisterType::Holding => Response::ReadHoldingRegisters(words),
                RegisterType::Input => Response::ReadInputRegisters(words),
            }))
        })
    }
}

pub struct DemoDevice {
    pub address: SocketAddr,
    config: PlcConfig,
    scenario: Arc<AtomicU8>,
    run: Mutex<Option<(CancellationToken, JoinHandle<()>)>>,
}

impl DemoDevice {
    pub async fn start(mut config: PlcConfig, scenario: Scenario) -> anyhow::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", config.port)).await?;
        let address = listener.local_addr()?;
        config.port = address.port();
        let device = Arc::new(Self {
            address,
            config,
            scenario: Arc::new(AtomicU8::new(scenario.code())),
            run: Mutex::new(None),
        });
        device.launch(listener).await;
        if scenario == Scenario::Offline {
            device.stop().await;
        }
        Ok(device)
    }

    async fn launch(&self, listener: TcpListener) {
        let service = RegisterService {
            config: self.config.clone(),
            scenario: self.scenario.clone(),
        };
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let handle = tokio::spawn(async move {
            let on_connected = move |stream, _| {
                let service = service.clone();
                async move { Ok(Some((service, stream))) }
            };
            let server = Server::new(listener);
            if let Err(error) = server
                .serve_until(
                    &on_connected,
                    |error| tracing::debug!(%error, "Demo client closed"),
                    signal.cancelled_owned(),
                )
                .await
            {
                tracing::error!(%error, "Demo server stopped");
            }
        });
        *self.run.lock().await = Some((cancel, handle));
    }

    pub async fn stop(&self) {
        if let Some((cancel, handle)) = self.run.lock().await.take() {
            cancel.cancel();
            let _ = handle.await;
        }
    }

    pub async fn set_scenario(&self, scenario: Scenario) -> anyhow::Result<()> {
        self.scenario.store(scenario.code(), Ordering::SeqCst);
        if scenario == Scenario::Offline {
            self.stop().await;
        } else if self.run.lock().await.is_none() {
            self.launch(TcpListener::bind(self.address).await?).await;
        }
        Ok(())
    }
}

impl Drop for DemoDevice {
    fn drop(&mut self) {
        if let Some((cancel, handle)) = self.run.get_mut().take() {
            cancel.cancel();
            handle.abort();
        }
    }
}

#[derive(Clone, Default)]
pub struct DemoManager {
    devices: Arc<Mutex<HashMap<String, Arc<DemoDevice>>>>,
}

impl DemoManager {
    pub async fn ids(&self) -> Vec<String> {
        let mut ids = self
            .devices
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    pub async fn add(
        &self,
        id: String,
        config: PlcConfig,
        scenario: Scenario,
    ) -> anyhow::Result<Arc<DemoDevice>> {
        let node = DemoDevice::start(config, scenario).await?;
        self.devices.lock().await.insert(id, node.clone());
        Ok(node)
    }

    pub async fn scenario(&self, id: &str, scenario: Scenario) -> crate::error::Result<()> {
        let node = self.devices.lock().await.get(id).cloned().ok_or_else(|| {
            crate::error::Error::Validation(
                "Este PLC no corresponde a un simulador de la demostración".into(),
            )
        })?;
        node.set_scenario(scenario)
            .await
            .map_err(crate::error::Error::Internal)
    }

    pub async fn shutdown(&self) {
        for device in self.devices.lock().await.values() {
            device.stop().await;
        }
    }
}

pub fn fixtures() -> Vec<(String, PlcConfig, Scenario)> {
    let variable = |id: &str, name: &str, address, unit: &str, scale, limit, primary| Variable {
        id: id.into(),
        name: name.into(),
        register_type: RegisterType::Holding,
        address,
        data_type: DataType::Uint16,
        word_order: WordOrder::Abcd,
        scale,
        unit: unit.into(),
        high_limit: limit,
        primary,
    };
    let tank = PlcConfig {
        name: "Tanque de mezcla".into(),
        location: "Área de procesos".into(),
        host: "127.0.0.1".into(),
        port: 5502,
        unit_id: 1,
        interval_ms: 1000,
        timeout_ms: 1000,
        paused: false,
        variables: vec![
            variable(
                "tank-temperature",
                "Temperatura",
                0,
                "°C",
                0.1,
                Some(80.0),
                true,
            ),
            variable("tank-level", "Nivel", 1, "%", 1.0, None, false),
            variable("tank-cycles", "Ciclos", 2, "ciclos", 1.0, None, false),
        ],
    };
    let mut oven = tank.clone();
    oven.name = "Horno de secado".into();
    oven.location = "Producción".into();
    oven.port = 5503;
    oven.variables[0].id = "oven-temperature".into();
    oven.variables[1].id = "oven-humidity".into();
    oven.variables[1].name = "Humedad".into();
    oven.variables[2].id = "oven-cycles".into();
    let mut belt = tank.clone();
    belt.name = "Banda de empaque".into();
    belt.location = "Empaque".into();
    belt.port = 5504;
    belt.variables = vec![
        variable("belt-speed", "Velocidad", 20, "m/s", 1.0, Some(2.0), true),
        variable("belt-pieces", "Piezas", 22, "pzs", 1.0, None, false),
        variable(
            "belt-motor",
            "Motor en marcha",
            23,
            "estado",
            1.0,
            None,
            false,
        ),
    ];
    belt.variables[0].data_type = DataType::Float32;
    vec![
        ("demo-tank".into(), tank, Scenario::Normal),
        ("demo-oven".into(), oven, Scenario::High),
        ("demo-belt".into(), belt, Scenario::Offline),
    ]
}

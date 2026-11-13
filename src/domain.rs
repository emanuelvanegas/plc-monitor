use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegisterType {
    #[default]
    Holding,
    Input,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataType {
    #[default]
    Uint16,
    Int16,
    Float32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum WordOrder {
    #[default]
    Abcd,
    Cdab,
}

fn one() -> f64 {
    1.0
}
fn interval_default() -> u64 {
    1000
}
fn timeout_default() -> u64 {
    2000
}
fn unit_default() -> u8 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Variable {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub register_type: RegisterType,
    pub address: u16,
    #[serde(default)]
    pub data_type: DataType,
    #[serde(default)]
    pub word_order: WordOrder,
    #[serde(default = "one")]
    pub scale: f64,
    pub unit: String,
    #[serde(default)]
    pub high_limit: Option<f64>,
    #[serde(default)]
    pub primary: bool,
}

impl Variable {
    pub fn register_count(&self) -> u16 {
        if self.data_type == DataType::Float32 {
            2
        } else {
            1
        }
    }

    pub fn decode(&self, words: &[u16]) -> Result<f64, &'static str> {
        if words.len() != usize::from(self.register_count()) {
            return Err("La respuesta no contiene los registros esperados");
        }
        let raw = match self.data_type {
            DataType::Uint16 => f64::from(words[0]),
            DataType::Int16 => f64::from(words[0] as i16),
            DataType::Float32 => {
                let (hi, lo) = match self.word_order {
                    WordOrder::Abcd => (words[0], words[1]),
                    WordOrder::Cdab => (words[1], words[0]),
                };
                f64::from(f32::from_bits((u32::from(hi) << 16) | u32::from(lo)))
            }
        };
        let value = raw * self.scale;
        if value.is_finite() {
            Ok(value)
        } else {
            Err("La lectura no es un número finito")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlcConfig {
    pub name: String,
    pub location: String,
    pub host: String,
    pub port: u16,
    #[serde(default = "unit_default")]
    pub unit_id: u8,
    #[serde(default = "interval_default")]
    pub interval_ms: u64,
    #[serde(default = "timeout_default")]
    pub timeout_ms: u64,
    #[serde(default)]
    pub paused: bool,
    pub variables: Vec<Variable>,
}

impl PlcConfig {
    pub fn validate(&self) -> Result<(), String> {
        for (label, value, max) in [
            ("nombre", self.name.as_str(), 80),
            ("ubicación", self.location.as_str(), 80),
            ("host", self.host.as_str(), 253),
        ] {
            if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
                return Err(format!(
                    "El {label} es obligatorio y admite hasta {max} caracteres"
                ));
            }
        }
        if self.host.contains(['/', '\\']) || self.host.chars().any(char::is_whitespace) {
            return Err("El host debe ser una IP o un nombre sin esquema ni puerto".into());
        }
        if self.port == 0
            || !(100..=60_000).contains(&self.interval_ms)
            || !(100..=30_000).contains(&self.timeout_ms)
        {
            return Err("Puerto: 1–65535; intervalo: 100–60000 ms; timeout: 100–30000 ms".into());
        }
        if self.variables.is_empty() || self.variables.len() > 32 {
            return Err("Configura entre 1 y 32 variables por PLC".into());
        }
        if self.variables.iter().filter(|v| v.primary).count() != 1 {
            return Err("Selecciona exactamente una variable de tendencia".into());
        }
        let mut ids = HashSet::new();
        let mut occupied = HashSet::new();
        for v in &self.variables {
            if v.id.is_empty() || v.id.len() > 80 || !ids.insert(&v.id) {
                return Err(
                    "Los identificadores de variables deben ser únicos dentro del PLC".into(),
                );
            }
            if v.name.trim().is_empty()
                || v.name.len() > 80
                || v.unit.len() > 24
                || v.name.chars().chain(v.unit.chars()).any(char::is_control)
            {
                return Err("Revisa el nombre y la unidad de cada variable".into());
            }
            if !v.scale.is_finite() || v.high_limit.is_some_and(|limit| !limit.is_finite()) {
                return Err("La escala y el límite deben ser números finitos".into());
            }
            for offset in 0..v.register_count() {
                let address = v
                    .address
                    .checked_add(offset)
                    .ok_or("La variable excede la dirección 65535")?;
                let space = match v.register_type {
                    RegisterType::Holding => 0,
                    RegisterType::Input => 1,
                };
                if !occupied.insert((space, address)) {
                    return Err(format!("Registros superpuestos en la variable {}", v.name));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plc {
    pub id: String,
    pub revision: u64,
    #[serde(flatten)]
    pub config: PlcConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Good,
    Timeout,
    TransportError,
    ModbusException,
    InvalidValue,
}

impl Quality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Good => "good",
            Self::Timeout => "timeout",
            Self::TransportError => "transport_error",
            Self::ModbusException => "modbus_exception",
            Self::InvalidValue => "invalid_value",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Sample {
    pub plc_id: String,
    pub variable_id: String,
    pub revision: u64,
    pub observed_at: DateTime<Utc>,
    pub value: Option<f64>,
    pub quality: Quality,
    pub variable_name: String,
    pub unit: String,
    pub plc_name: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub plc_id: String,
    pub variable_id: Option<String>,
    pub occurred_at: DateTime<Utc>,
    pub kind: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct VariableState {
    pub last_good: Option<Sample>,
    pub quality: Option<Quality>,
    pub error: Option<String>,
    pub alarm_active: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct PlcState {
    pub connection: Connection,
    pub last_success: Option<DateTime<Utc>>,
    pub variables: std::collections::HashMap<String, VariableState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    #[default]
    Unknown,
    Connected,
    Offline,
}

pub fn alarm_transition(
    previous: Option<bool>,
    value: f64,
    limit: Option<f64>,
) -> (Option<bool>, Option<bool>) {
    let next = limit.map(|limit| value > limit);
    let transition = match (previous, next) {
        (Some(true), Some(false)) => Some(false),
        (None | Some(false), Some(true)) => Some(true),
        _ => None,
    };
    (next, transition)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn variable(data_type: DataType) -> Variable {
        Variable {
            id: "v".into(),
            name: "Temperatura".into(),
            register_type: RegisterType::Holding,
            address: 0,
            data_type,
            word_order: WordOrder::Abcd,
            scale: 1.0,
            unit: "°C".into(),
            high_limit: Some(80.0),
            primary: true,
        }
    }

    #[test]
    fn decodes_zero_signed_scaling_and_float_word_orders() {
        let mut v = variable(DataType::Uint16);
        assert_eq!(v.decode(&[0]), Ok(0.0));
        v.scale = 0.1;
        assert_eq!(v.decode(&[253]), Ok(25.3));
        v.data_type = DataType::Int16;
        assert_eq!(v.decode(&[(-125_i16) as u16]), Ok(-12.5));
        v.data_type = DataType::Float32;
        v.scale = 1.0;
        let bits = (-12.5_f32).to_bits();
        let words = [(bits >> 16) as u16, bits as u16];
        assert_eq!(v.decode(&words), Ok(-12.5));
        v.word_order = WordOrder::Cdab;
        assert_eq!(v.decode(&[words[1], words[0]]), Ok(-12.5));
        assert!(v.decode(&[0]).is_err());
        assert!(v.decode(&[0, 0x7fc0]).is_err());
    }

    #[test]
    fn validates_map_width_overlap_and_primary() {
        let mut c = PlcConfig {
            name: "Prueba".into(),
            location: "Lab".into(),
            host: "127.0.0.1".into(),
            port: 5502,
            unit_id: 1,
            interval_ms: 1000,
            timeout_ms: 2000,
            paused: false,
            variables: vec![variable(DataType::Float32)],
        };
        assert!(c.validate().is_ok());
        c.variables[0].address = u16::MAX;
        assert!(c.validate().is_err());
        c.variables[0].address = 0;
        let mut second = variable(DataType::Uint16);
        second.id = "other".into();
        second.address = 1;
        second.primary = false;
        c.variables.push(second);
        assert!(c.validate().is_err());
        c.variables[1].register_type = RegisterType::Input;
        assert!(c.validate().is_ok());
        c.variables[1].primary = true;
        assert!(c.validate().is_err());
    }

    #[test]
    fn alarms_emit_only_on_transitions_and_equality_recovers() {
        assert_eq!(
            alarm_transition(None, 25.0, Some(80.0)),
            (Some(false), None)
        );
        assert_eq!(
            alarm_transition(None, 81.0, Some(80.0)),
            (Some(true), Some(true))
        );
        assert_eq!(
            alarm_transition(Some(true), 90.0, Some(80.0)),
            (Some(true), None)
        );
        assert_eq!(
            alarm_transition(Some(true), 80.0, Some(80.0)),
            (Some(false), Some(false))
        );
    }
}

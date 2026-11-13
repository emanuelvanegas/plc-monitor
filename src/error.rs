use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Equipo no encontrado")]
    NotFound,
    #[error("La configuración cambió; vuelve a cargar el equipo")]
    Conflict,
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, message) = match &self {
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found", self.to_string()),
            Self::Conflict => (StatusCode::CONFLICT, "revision_conflict", self.to_string()),
            Self::Validation(_) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_configuration",
                self.to_string(),
            ),
            _ => {
                tracing::error!(error = %self, "Request failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "No se pudo completar la operación; revisa el estado del servicio".into(),
                )
            }
        };
        (status, Json(json!({"code":code,"message":message}))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

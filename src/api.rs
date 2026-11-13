use std::path::PathBuf;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tower_http::{services::ServeDir, trace::TraceLayer};

use crate::{
    acquisition::App,
    demo::{DemoManager, Scenario},
    domain::{Connection, PlcConfig},
    error::{Error, Result},
};

#[derive(Clone)]
pub struct ApiState {
    pub app: App,
    pub demo: Option<DemoManager>,
}

pub fn router(state: ApiState, frontend: PathBuf) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/plcs", get(list).post(create))
        .route("/api/plcs/{id}", get(detail).put(update))
        .route("/api/plcs/{id}/acquisition", put(acquisition))
        .route("/api/plcs/{id}/history", get(history))
        .route("/api/plcs/{id}/events", get(events))
        .route("/api/plcs/{id}/export.csv", get(export))
        .route("/api/demo/plcs/{id}/scenario", put(scenario))
        .fallback_service(ServeDir::new(frontend))
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<ApiState>) -> Response {
    let ping = sqlx::query("SELECT 1")
        .execute(&state.app.store().pool)
        .await;
    let storage_error = state.app.storage_error().await;
    let healthy = ping.is_ok() && storage_error.is_none();
    let demo_ids = match &state.demo {
        Some(demo) => demo.ids().await,
        None => vec![],
    };
    (if healthy { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }, Json(json!({
        "status":if healthy {"ok"} else {"degraded"}, "storage_error":storage_error.or_else(|| ping.err().map(|e| e.to_string())),
        "demo":state.demo.is_some(), "demo_ids":demo_ids, "version":env!("CARGO_PKG_VERSION")
    }))).into_response()
}

async fn list(State(state): State<ApiState>) -> Result<Json<serde_json::Value>> {
    let plcs = state.app.views().await?;
    let connected = plcs
        .iter()
        .filter(|v| v.state.connection == Connection::Connected)
        .count();
    let offline = plcs
        .iter()
        .filter(|v| v.state.connection == Connection::Offline)
        .count();
    let warnings = plcs
        .iter()
        .filter(|v| {
            v.state
                .variables
                .values()
                .any(|v| v.alarm_active == Some(true))
        })
        .count();
    Ok(Json(
        json!({"summary":{"total":plcs.len(),"connected":connected,"offline":offline,"warnings":warnings},"plcs":plcs}),
    ))
}

async fn detail(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<crate::acquisition::PlcView>> {
    Ok(Json(state.app.view(&id).await?))
}

async fn create(
    State(state): State<ApiState>,
    Json(config): Json<PlcConfig>,
) -> Result<impl IntoResponse> {
    Ok((StatusCode::CREATED, Json(state.app.create(config).await?)))
}

#[derive(Deserialize)]
struct Update {
    expected_revision: u64,
    #[serde(flatten)]
    config: PlcConfig,
}

async fn update(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(input): Json<Update>,
) -> Result<Json<crate::acquisition::PlcView>> {
    Ok(Json(
        state
            .app
            .update(&id, input.expected_revision, input.config)
            .await?,
    ))
}

#[derive(Deserialize)]
struct Acquisition {
    running: bool,
}

async fn acquisition(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(input): Json<Acquisition>,
) -> Result<Json<crate::acquisition::PlcView>> {
    Ok(Json(state.app.acquisition(&id, input.running).await?))
}

#[derive(Deserialize, Default)]
struct Range {
    from_ms: Option<i64>,
    to_ms: Option<i64>,
}

impl Range {
    fn bounds(&self) -> Result<(i64, i64)> {
        let end = self.to_ms.unwrap_or_else(|| Utc::now().timestamp_millis());
        let start = self.from_ms.unwrap_or(end.saturating_sub(300_000));
        if end < start || end.saturating_sub(start) > 86_400_000 {
            return Err(Error::Validation(
                "El rango debe estar ordenado y abarcar como máximo 24 horas".into(),
            ));
        }
        Ok((start, end))
    }
}

#[derive(Deserialize)]
struct HistoryQuery {
    variable_id: String,
    from_ms: Option<i64>,
    to_ms: Option<i64>,
    limit: Option<i64>,
}

async fn history(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<serde_json::Value>> {
    state.app.store().get(&id).await?;
    let (start, end) = Range {
        from_ms: query.from_ms,
        to_ms: query.to_ms,
    }
    .bounds()?;
    let limit = query.limit.unwrap_or(2000).clamp(6, 10_000);
    let history = state
        .app
        .store()
        .history_view(&id, &query.variable_id, start, end, limit)
        .await?;
    Ok(Json(
        serde_json::to_value(history).map_err(anyhow::Error::from)?,
    ))
}

#[derive(Deserialize)]
struct EventsQuery {
    before_id: Option<i64>,
    limit: Option<i64>,
}

async fn events(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Json<serde_json::Value>> {
    state.app.store().get(&id).await?;
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let events = state
        .app
        .store()
        .events(&id, query.before_id.unwrap_or(i64::MAX), limit)
        .await?;
    let next = if events.len() == limit as usize {
        events.last().map(|e| e.id)
    } else {
        None
    };
    Ok(Json(json!({"events":events,"next_before_id":next})))
}

async fn export(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Query(range): Query<Range>,
) -> Result<Response> {
    state.app.store().get(&id).await?;
    let (start, end) = range.bounds()?;
    let filename = format!("attachment; filename=\"plc-{id}-historial.csv\"");
    let (sender, receiver) = mpsc::channel::<std::io::Result<Vec<u8>>>(2);
    tokio::spawn(async move {
        let mut cursor = 0;
        let mut first = true;
        loop {
            let page = match state.app.store().export_page(&id, start, end, cursor).await {
                Ok(page) => page,
                Err(error) => {
                    let _ = sender
                        .send(Err(std::io::Error::other(error.to_string())))
                        .await;
                    break;
                }
            };
            let mut writer = csv::Writer::from_writer(Vec::new());
            if first {
                let _ = writer.write_record([
                    "id_equipo",
                    "nombre_equipo",
                    "id_variable",
                    "variable",
                    "fecha_hora_utc",
                    "valor",
                    "unidad",
                    "calidad",
                    "revision",
                ]);
            }
            for (row_id, sample) in &page {
                cursor = *row_id;
                if let Err(error) = writer.write_record([
                    sample.plc_id.clone(),
                    sample.plc_name.clone(),
                    sample.variable_id.clone(),
                    sample.variable_name.clone(),
                    sample.observed_at.to_rfc3339(),
                    sample.value.map(|v| v.to_string()).unwrap_or_default(),
                    sample.unit.clone(),
                    sample.quality.as_str().into(),
                    sample.revision.to_string(),
                ]) {
                    let _ = sender
                        .send(Err(std::io::Error::other(error.to_string())))
                        .await;
                    return;
                }
            }
            let chunk = match writer.into_inner() {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = sender
                        .send(Err(std::io::Error::other(error.to_string())))
                        .await;
                    break;
                }
            };
            if sender.send(Ok(chunk)).await.is_err() || page.len() < 512 {
                break;
            }
            first = false;
        }
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|chunk| (chunk, receiver))
    });
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()),
            (header::CONTENT_DISPOSITION, filename),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

#[derive(Deserialize)]
struct ScenarioInput {
    scenario: Scenario,
}

async fn scenario(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Json(input): Json<ScenarioInput>,
) -> Result<Json<serde_json::Value>> {
    state.app.store().get(&id).await?;
    state
        .demo
        .ok_or_else(|| {
            Error::Validation("Los escenarios están disponibles al iniciar con --demo".into())
        })?
        .scenario(&id, input.scenario)
        .await?;
    Ok(Json(
        json!({"plc_id":id,"scenario":input.scenario,"message":"Escenario aplicado al servidor Modbus; el recolector lo detectará en su próxima lectura"}),
    ))
}

use std::{path::PathBuf, time::Duration};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use chrono::Utc;
use plc_monitor::{
    acquisition::App,
    api::{ApiState, router},
    demo::{DemoDevice, DemoManager, Scenario, fixtures},
    domain::{Connection, DataType, PlcConfig, Quality, RegisterType},
    error::Error,
    storage::Store,
};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

async fn wait_for(
    app: &App,
    id: &str,
    predicate: impl Fn(&plc_monitor::acquisition::PlcView) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if predicate(&app.view(id).await.unwrap()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("collector did not reach expected state");
}

fn config() -> PlcConfig {
    let mut config = fixtures().remove(0).1;
    config.interval_ms = 100;
    config.timeout_ms = 150;
    config.port = 0;
    config
}

async fn json_request(
    app: &axum::Router,
    method: &str,
    path: &str,
    value: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)})),
    )
}

#[tokio::test]
async fn tcp_to_sqlite_api_and_recovery_are_independent_per_plc() {
    let directory = TempDir::new().unwrap();
    let store = Store::open(&directory.path().join("monitor.db"))
        .await
        .unwrap();
    let mut nodes: Vec<(&str, std::sync::Arc<DemoDevice>)> = Vec::new();
    for id in ["first", "second"] {
        let mut cfg = config();
        let node = DemoDevice::start(cfg.clone(), Scenario::Normal)
            .await
            .unwrap();
        cfg.port = node.address.port();
        cfg.unit_id = 1;
        store.create(id.into(), cfg).await.unwrap();
        nodes.push((id, node));
    }
    let app = App::start(store.clone()).await.unwrap();
    for id in ["first", "second"] {
        wait_for(&app, id, |v| v.state.connection == Connection::Connected).await;
    }
    let first = app.view("first").await.unwrap();
    let temperature = &first.state.variables["tank-temperature"];
    assert_eq!(temperature.last_good.as_ref().unwrap().value, Some(25.3));
    let before_other = app.view("second").await.unwrap().state.last_success;

    nodes[0].1.set_scenario(Scenario::Offline).await.unwrap();
    wait_for(&app, "first", |v| v.state.connection == Connection::Offline).await;
    wait_for(&app, "second", |v| v.state.last_success > before_other).await;
    let offline = app.view("first").await.unwrap();
    assert_eq!(
        offline.state.variables["tank-temperature"]
            .last_good
            .as_ref()
            .unwrap()
            .value,
        Some(25.3)
    );
    let start = Utc::now().timestamp_millis() - 60_000;
    let rows = store
        .history("first", "tank-temperature", start, i64::MAX, 100)
        .await
        .unwrap();
    assert!(
        rows.iter()
            .any(|s| s.quality != Quality::Good && s.value.is_none())
    );
    assert!(rows.iter().all(|s| s.plc_id == "first"));

    nodes[0].1.set_scenario(Scenario::Normal).await.unwrap();
    wait_for(&app, "first", |v| {
        v.state.connection == Connection::Connected
    })
    .await;
    nodes[0]
        .1
        .set_scenario(Scenario::InvalidAddress)
        .await
        .unwrap();
    wait_for(&app, "first", |v| {
        v.state.variables["tank-temperature"].quality == Some(Quality::ModbusException)
    })
    .await;
    let invalid = app.view("first").await.unwrap();
    assert_eq!(invalid.state.connection, Connection::Connected);
    assert_eq!(
        invalid.state.variables["tank-level"].quality,
        Some(Quality::Good)
    );
    nodes[0].1.set_scenario(Scenario::High).await.unwrap();
    wait_for(&app, "first", |v| {
        v.state.variables["tank-temperature"].alarm_active == Some(true)
    })
    .await;
    let count = store
        .events("first", i64::MAX, 100)
        .await
        .unwrap()
        .iter()
        .filter(|e| e.event.kind == "threshold_exceeded")
        .count();
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        store
            .events("first", i64::MAX, 100)
            .await
            .unwrap()
            .iter()
            .filter(|e| e.event.kind == "threshold_exceeded")
            .count(),
        count
    );
    assert_eq!(count, 1);

    app.acquisition("first", false).await.unwrap();
    let paused = app.view("first").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        app.view("first").await.unwrap().state.last_success,
        paused.state.last_success
    );
    app.acquisition("first", true).await.unwrap();
    wait_for(&app, "first", |v| {
        v.state.last_success > paused.state.last_success
    })
    .await;

    let routes = router(
        ApiState {
            app: app.clone(),
            demo: None,
        },
        PathBuf::from("missing-frontend"),
    );
    let (status, response) = json_request(&routes, "GET", "/api/plcs", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(response["summary"]["total"], 2);
    let mut cfg = app.view("first").await.unwrap().plc.config;
    cfg.name = "Tanque \"uno\", laboratorio".into();
    let mut body = serde_json::to_value(&cfg).unwrap();
    let revision = app.view("first").await.unwrap().plc.revision;
    body["expected_revision"] = json!(revision);
    let (status, edited) = json_request(&routes, "PUT", "/api/plcs/first", body.clone()).await;
    assert_eq!(status, StatusCode::OK, "{edited}");
    let (status, _) = json_request(&routes, "PUT", "/api/plcs/first", body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        app.view("second").await.unwrap().plc.config.name,
        "Tanque de mezcla"
    );

    let response = routes
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/plcs/first/export.csv")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let mut csv = csv::Reader::from_reader(bytes.as_ref());
    let records = csv.records().map(|r| r.unwrap()).collect::<Vec<_>>();
    assert!(!records.is_empty());
    assert!(records.iter().all(|row| &row[0] == "first"));
    assert!(
        records
            .iter()
            .any(|row| &row[7] != "good" && row[5].is_empty())
    );
    app.shutdown().await;
    for (_, node) in nodes {
        node.stop().await;
    }
    store.pool.close().await;
    let reopened = Store::open(&directory.path().join("monitor.db"))
        .await
        .unwrap();
    assert_eq!(reopened.get("first").await.unwrap().config.name, cfg.name);
    assert!(
        !reopened
            .history("first", "tank-temperature", start, i64::MAX, 100)
            .await
            .unwrap()
            .is_empty()
    );
    reopened.pool.close().await;
}

#[tokio::test]
async fn input_registers_float_word_order_and_slow_responses_use_real_tcp() {
    let directory = TempDir::new().unwrap();
    let store = Store::open(&directory.path().join("monitor.db"))
        .await
        .unwrap();
    let mut cfg = config();
    cfg.unit_id = 7;
    cfg.variables.truncate(1);
    cfg.variables[0].register_type = RegisterType::Input;
    cfg.variables[0].data_type = DataType::Float32;
    cfg.variables[0].word_order = plc_monitor::domain::WordOrder::Cdab;
    let node = DemoDevice::start(cfg.clone(), Scenario::Normal)
        .await
        .unwrap();
    cfg.port = node.address.port();
    store.create("float".into(), cfg.clone()).await.unwrap();
    let app = App::start(store.clone()).await.unwrap();
    wait_for(&app, "float", |v| {
        v.state.connection == Connection::Connected
    })
    .await;
    let actual = app.view("float").await.unwrap().state.variables["tank-temperature"]
        .last_good
        .as_ref()
        .unwrap()
        .value
        .unwrap();
    assert!((actual - 25.3).abs() < 0.0001);
    node.set_scenario(Scenario::Slow).await.unwrap();
    wait_for(&app, "float", |v| {
        v.state.variables["tank-temperature"].quality == Some(Quality::Timeout)
    })
    .await;
    cfg.unit_id = 8;
    let revision = app.view("float").await.unwrap().plc.revision;
    app.update("float", revision, cfg).await.unwrap();
    node.set_scenario(Scenario::Normal).await.unwrap();
    wait_for(&app, "float", |v| {
        v.state.variables["tank-temperature"].quality == Some(Quality::Timeout)
    })
    .await;
    app.shutdown().await;
    node.stop().await;
    store.pool.close().await;
}

#[tokio::test]
async fn invalid_configuration_is_rejected_and_demo_routes_are_explicit() {
    let directory = TempDir::new().unwrap();
    let store = Store::open(&directory.path().join("monitor.db"))
        .await
        .unwrap();
    let app = App::start(store.clone()).await.unwrap();
    let manager = DemoManager::default();
    let routes = router(
        ApiState {
            app: app.clone(),
            demo: Some(manager),
        },
        PathBuf::from("missing"),
    );
    let mut cfg = config();
    cfg.port = 502;
    cfg.paused = true;
    cfg.variables[0].primary = false;
    let (status, _) = json_request(
        &routes,
        "POST",
        "/api/plcs",
        serde_json::to_value(&cfg).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(matches!(store.get("missing").await, Err(Error::NotFound)));
    app.shutdown().await;
    store.pool.close().await;
}

#[tokio::test]
async fn historical_overview_covers_the_period_and_preserves_peaks_and_outages() {
    use plc_monitor::domain::Sample;
    let directory = TempDir::new().unwrap();
    let store = Store::open(&directory.path().join("monitor.db"))
        .await
        .unwrap();
    let mut cfg = config();
    cfg.port = 502;
    cfg.interval_ms = 1000;
    cfg.timeout_ms = 1500;
    cfg.paused = true;
    store.create("history".into(), cfg).await.unwrap();
    let start = Utc::now().timestamp_millis() - 120_000;
    let samples: Vec<Sample> = (0..120)
        .filter(|i| !(70..80).contains(i))
        .map(|i| Sample {
            plc_id: "history".into(),
            variable_id: "tank-temperature".into(),
            revision: 1,
            observed_at: chrono::DateTime::from_timestamp_millis(start + i * 1000).unwrap(),
            value: if i == 33 {
                None
            } else {
                Some(if i == 17 {
                    123.4
                } else if i == 28 {
                    -42.0
                } else {
                    25.3
                })
            },
            quality: if i == 33 {
                Quality::Timeout
            } else {
                Quality::Good
            },
            variable_name: "Temperatura".into(),
            unit: "°C".into(),
            plc_name: "Histórico".into(),
            error: None,
        })
        .collect();
    store.persist(&samples, &[]).await.unwrap();
    let overview = store
        .history_view("history", "tank-temperature", start, start + 120_000, 24)
        .await
        .unwrap();
    assert!(overview.aggregated);
    assert!(!overview.truncated);
    assert_eq!(overview.source_count, 110);
    assert!(overview.samples.len() <= 24);
    assert_eq!(
        overview.samples.first().unwrap().observed_at,
        samples.first().unwrap().observed_at
    );
    assert_eq!(
        overview.samples.last().unwrap().observed_at,
        samples.last().unwrap().observed_at
    );
    assert!(overview.samples.iter().any(|s| s.value == Some(123.4)));
    assert!(overview.samples.iter().any(|s| s.value == Some(-42.0)));
    assert!(
        overview
            .samples
            .iter()
            .any(|s| s.quality == Quality::Timeout)
    );
    assert!(
        overview
            .gaps
            .iter()
            .any(|g| g.from_ms <= start + 33000 && g.to_ms >= start + 33000)
    );
    assert!(
        overview
            .gaps
            .iter()
            .any(|g| g.from_ms <= start + 70000 && g.to_ms >= start + 79000)
    );
    assert!(
        overview
            .samples
            .windows(2)
            .all(|p| p[0].observed_at <= p[1].observed_at)
    );
    let detail = store
        .history_view(
            "history",
            "tank-temperature",
            start + 14000,
            start + 20000,
            24,
        )
        .await
        .unwrap();
    assert!(!detail.aggregated);
    assert_eq!(detail.samples.len(), 7);
    assert!(detail.samples.iter().any(|s| s.value == Some(123.4)));
    let app = App::start(store.clone()).await.unwrap();
    let routes = router(
        ApiState {
            app: app.clone(),
            demo: None,
        },
        PathBuf::from("missing"),
    );
    let (status, body) = json_request(&routes, "GET", &format!("/api/plcs/history/history?variable_id=tank-temperature&from_ms={start}&to_ms={}&limit=24", start + 120_000), Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["aggregated"], true);
    assert_eq!(body["source_count"], 110);
    let (status, _) = json_request(
        &routes,
        "GET",
        &format!(
            "/api/plcs/history/history?variable_id=tank-temperature&from_ms={start}&to_ms={}",
            start + 86_400_001
        ),
        Value::Null,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    app.shutdown().await;
    store.pool.close().await;
}

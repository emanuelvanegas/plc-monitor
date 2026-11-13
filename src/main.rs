use std::{net::SocketAddr, path::PathBuf, time::Duration};

use clap::Parser;
use plc_monitor::{
    acquisition::App,
    api::{ApiState, router},
    demo::{DemoManager, fixtures},
    error::Error,
    storage::Store,
};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(version, about = "Monitoreo local de PLC mediante Modbus TCP")]
struct Cli {
    #[arg(long, default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
    #[arg(long, default_value = "data/plc-monitor.db")]
    database: PathBuf,
    #[arg(long, default_value = "frontend/dist")]
    frontend: PathBuf,
    #[arg(long)]
    demo: bool,
    #[arg(
        long,
        default_value_t = 5502,
        help = "Primer puerto de los simuladores; 0 asigna puertos libres (usa una base de datos nueva)"
    )]
    demo_base_port: u16,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "plc_monitor=info,tower_http=info".into()),
        )
        .init();
    let cli = Cli::parse();
    anyhow::ensure!(
        cli.demo_base_port == 0 || cli.demo_base_port <= 65533,
        "El puerto base de demo debe estar entre 1 y 65533, o ser 0"
    );
    let store = Store::open(&cli.database).await?;
    let demo = if cli.demo {
        let manager = DemoManager::default();
        for (index, (id, mut config, scenario)) in fixtures().into_iter().enumerate() {
            config.port = if cli.demo_base_port == 0 {
                0
            } else {
                cli.demo_base_port + index as u16
            };
            let node = manager.add(id.clone(), config.clone(), scenario).await?;
            config.port = node.address.port();
            match store.get(&id).await {
                Err(Error::NotFound) => {
                    store.create(id, config).await?;
                }
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
        }
        Some(manager)
    } else {
        None
    };
    let app = App::start(store.clone()).await?;
    let cancel = CancellationToken::new();
    let cleanup_cancel = cancel.clone();
    let cleanup_store = store.clone();
    let cleanup = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = cleanup_cancel.cancelled() => break,
                _ = tokio::time::sleep(Duration::from_secs(60)) => {
                    if let Err(error) = cleanup_store.cleanup().await { tracing::error!(%error, "Retention cleanup failed"); }
                }
            }
        }
    });
    let listener = TcpListener::bind(cli.listen).await?;
    tracing::info!(address = %listener.local_addr()?, demo = cli.demo, "PLC Monitor listo");
    axum::serve(
        listener,
        router(
            ApiState {
                app: app.clone(),
                demo: demo.clone(),
            },
            cli.frontend,
        ),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    cancel.cancel();
    app.shutdown().await;
    if let Some(demo) = demo {
        demo.shutdown().await;
    }
    let _ = cleanup.await;
    store.pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

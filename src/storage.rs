use std::{path::Path, time::Duration};

use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};

use crate::{
    domain::{Event, Plc, PlcConfig, Quality, Sample},
    error::{Error, Result},
};

#[derive(Clone)]
pub struct Store {
    pub pool: SqlitePool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredEvent {
    pub id: i64,
    #[serde(flatten)]
    pub event: Event,
}

impl Store {
    pub async fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(anyhow::Error::from)?;
        }
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(2));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(3))
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(anyhow::Error::from)?;
        Ok(Self { pool })
    }

    pub async fn list(&self) -> Result<Vec<Plc>> {
        let rows = sqlx::query("SELECT config_json FROM plcs ORDER BY rowid")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter()
            .map(|row| Ok(serde_json::from_str(row.get::<&str, _>(0))?))
            .collect()
    }

    pub async fn get(&self, id: &str) -> Result<Plc> {
        let row = sqlx::query("SELECT config_json FROM plcs WHERE id = ?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or(Error::NotFound)?;
        Ok(serde_json::from_str(row.get::<&str, _>(0))?)
    }

    pub async fn create(&self, id: String, config: PlcConfig) -> Result<Plc> {
        config.validate().map_err(Error::Validation)?;
        let plc = Plc {
            id,
            revision: 1,
            config,
        };
        sqlx::query("INSERT INTO plcs (id, revision, config_json) VALUES (?, ?, ?)")
            .bind(&plc.id)
            .bind(plc.revision as i64)
            .bind(serde_json::to_string(&plc)?)
            .execute(&self.pool)
            .await?;
        Ok(plc)
    }

    pub async fn update(&self, id: &str, expected: u64, config: PlcConfig) -> Result<Plc> {
        config.validate().map_err(Error::Validation)?;
        let plc = Plc {
            id: id.into(),
            revision: expected + 1,
            config,
        };
        let result = sqlx::query(
            "UPDATE plcs SET revision = ?, config_json = ? WHERE id = ? AND revision = ?",
        )
        .bind(plc.revision as i64)
        .bind(serde_json::to_string(&plc)?)
        .bind(id)
        .bind(expected as i64)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            self.get(id).await?;
            return Err(Error::Conflict);
        }
        Ok(plc)
    }

    pub async fn persist(&self, samples: &[Sample], events: &[Event]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for s in samples {
            sqlx::query("INSERT INTO samples (plc_id,variable_id,revision,observed_at_ms,value,quality,variable_name,unit,plc_name,error) VALUES (?,?,?,?,?,?,?,?,?,?)")
                .bind(&s.plc_id).bind(&s.variable_id).bind(s.revision as i64).bind(s.observed_at.timestamp_millis())
                .bind(s.value).bind(s.quality.as_str()).bind(&s.variable_name).bind(&s.unit).bind(&s.plc_name).bind(&s.error)
                .execute(&mut *tx).await?;
        }
        for e in events {
            sqlx::query("INSERT INTO events (plc_id,variable_id,occurred_at_ms,kind,severity,message) VALUES (?,?,?,?,?,?)")
                .bind(&e.plc_id).bind(&e.variable_id).bind(e.occurred_at.timestamp_millis()).bind(&e.kind).bind(&e.severity).bind(&e.message)
                .execute(&mut *tx).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn history(
        &self,
        plc: &str,
        variable: &str,
        start: i64,
        end: i64,
        limit: i64,
    ) -> Result<Vec<Sample>> {
        let rows = sqlx::query("SELECT * FROM samples WHERE plc_id=? AND variable_id=? AND observed_at_ms BETWEEN ? AND ? ORDER BY observed_at_ms DESC,id DESC LIMIT ?")
            .bind(plc).bind(variable).bind(start).bind(end).bind(limit).fetch_all(&self.pool).await?;
        rows.iter().rev().map(sample_from_row).collect()
    }

    pub async fn events(&self, plc: &str, before: i64, limit: i64) -> Result<Vec<StoredEvent>> {
        let rows =
            sqlx::query("SELECT * FROM events WHERE plc_id=? AND id<? ORDER BY id DESC LIMIT ?")
                .bind(plc)
                .bind(before)
                .bind(limit)
                .fetch_all(&self.pool)
                .await?;
        rows.iter()
            .map(|row| {
                Ok(StoredEvent {
                    id: row.get("id"),
                    event: Event {
                        plc_id: row.get("plc_id"),
                        variable_id: row.get("variable_id"),
                        occurred_at: timestamp(row.get("occurred_at_ms"))?,
                        kind: row.get("kind"),
                        severity: row.get("severity"),
                        message: row.get("message"),
                    },
                })
            })
            .collect()
    }

    pub async fn export_page(
        &self,
        plc: &str,
        start: i64,
        end: i64,
        cursor: i64,
    ) -> Result<Vec<(i64, Sample)>> {
        let rows = sqlx::query("SELECT * FROM samples WHERE plc_id=? AND observed_at_ms BETWEEN ? AND ? AND id>? ORDER BY id LIMIT 512")
            .bind(plc).bind(start).bind(end).bind(cursor).fetch_all(&self.pool).await?;
        rows.iter()
            .map(|row| Ok((row.get("id"), sample_from_row(row)?)))
            .collect()
    }

    pub async fn cleanup(&self) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        sqlx::query("DELETE FROM samples WHERE id IN (SELECT id FROM samples WHERE observed_at_ms<? LIMIT 10000)")
            .bind(now - 86_400_000).execute(&self.pool).await?;
        sqlx::query("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE occurred_at_ms<? LIMIT 10000)")
            .bind(now - 7 * 86_400_000).execute(&self.pool).await?;
        Ok(())
    }
}

fn timestamp(ms: i64) -> Result<DateTime<Utc>> {
    DateTime::from_timestamp_millis(ms)
        .ok_or_else(|| Error::Internal(anyhow::anyhow!("Invalid stored timestamp")))
}

pub(crate) fn sample_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Sample> {
    let quality = match row.get::<&str, _>("quality") {
        "good" => Quality::Good,
        "timeout" => Quality::Timeout,
        "transport_error" => Quality::TransportError,
        "modbus_exception" => Quality::ModbusException,
        _ => Quality::InvalidValue,
    };
    Ok(Sample {
        plc_id: row.get("plc_id"),
        variable_id: row.get("variable_id"),
        revision: row.get::<i64, _>("revision") as u64,
        observed_at: timestamp(row.get("observed_at_ms"))?,
        value: row.get("value"),
        quality,
        variable_name: row.get("variable_name"),
        unit: row.get("unit"),
        plc_name: row.get("plc_name"),
        error: row.get("error"),
    })
}

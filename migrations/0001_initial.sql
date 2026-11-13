CREATE TABLE plcs (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    config_json TEXT NOT NULL CHECK (json_valid(config_json))
);

CREATE TABLE samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plc_id TEXT NOT NULL REFERENCES plcs(id),
    variable_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    value REAL,
    quality TEXT NOT NULL,
    variable_name TEXT NOT NULL,
    unit TEXT NOT NULL,
    plc_name TEXT NOT NULL,
    error TEXT,
    CHECK ((quality = 'good' AND value IS NOT NULL) OR
           (quality != 'good' AND value IS NULL))
);
CREATE INDEX samples_by_variable_time ON samples(plc_id, variable_id, observed_at_ms, id);
CREATE INDEX samples_by_plc_time ON samples(plc_id, observed_at_ms, id);
CREATE INDEX samples_retention ON samples(observed_at_ms);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plc_id TEXT NOT NULL REFERENCES plcs(id),
    variable_id TEXT,
    occurred_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE INDEX events_by_plc_time ON events(plc_id, occurred_at_ms, id);

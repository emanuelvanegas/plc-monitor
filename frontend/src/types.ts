export interface Variable {
  id: string;
  name: string;
  register_type: 'holding' | 'input';
  address: number;
  data_type: 'uint16' | 'int16' | 'float32';
  word_order: 'ABCD' | 'CDAB';
  scale: number;
  unit: string;
  high_limit: number | null;
  primary: boolean;
}

export interface Config {
  name: string;
  location: string;
  host: string;
  port: number;
  unit_id: number;
  interval_ms: number;
  timeout_ms: number;
  paused: boolean;
  variables: Variable[];
}

export interface Sample {
  plc_id: string;
  variable_id: string;
  revision: number;
  observed_at: string;
  value: number | null;
  quality: string;
  variable_name: string;
  unit: string;
  plc_name: string;
  error: string | null;
}

export interface VariableState {
  last_good: Sample | null;
  quality: string | null;
  error: string | null;
  alarm_active: boolean | null;
}

export interface Plc extends Config {
  id: string;
  revision: number;
  state: {
    connection: 'unknown' | 'connected' | 'offline';
    last_success: string | null;
    variables: Record<string, VariableState>;
  };
}

export interface Summary { total: number; connected: number; offline: number; warnings: number }
export interface PlcEvent { id: number; plc_id: string; occurred_at: string; severity: string; message: string; kind: string }
export interface Health { status: string; demo: boolean; demo_ids: string[]; storage_error: string | null }
export interface HistoryResponse {
  samples: Sample[];
  truncated: boolean;
  from_ms?: number;
  to_ms?: number;
  aggregated?: boolean;
  bucket_ms?: number | null;
  source_count?: number;
  gaps?: { from_ms: number; to_ms: number }[];
}

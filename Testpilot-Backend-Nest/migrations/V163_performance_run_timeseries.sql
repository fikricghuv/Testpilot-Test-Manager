-- Store aggregated 1-second time-series buckets (RPS, latency, error rate, VUs) for k6 runs.

ALTER TABLE performance_test_runs
  ADD COLUMN IF NOT EXISTS timeseries_json JSONB;

-- Store per-endpoint breakdown, HTTP status code distribution, and per-check details for k6 runs.

ALTER TABLE performance_test_runs
  ADD COLUMN IF NOT EXISTS breakdown_json JSONB;

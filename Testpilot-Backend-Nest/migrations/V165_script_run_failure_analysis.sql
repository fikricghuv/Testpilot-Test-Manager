-- Store structured failure root-cause analysis for failed/errored Playwright script runs.

ALTER TABLE test_script_runs
  ADD COLUMN IF NOT EXISTS failure_analysis JSONB;

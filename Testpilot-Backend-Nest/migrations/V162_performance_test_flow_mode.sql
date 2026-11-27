-- Add multi-step business flow mode ('flow') and flow_config storage to performance_tests.

ALTER TABLE performance_tests
  DROP CONSTRAINT IF EXISTS performance_tests_mode_check;

ALTER TABLE performance_tests
  ADD CONSTRAINT performance_tests_mode_check CHECK (mode IN ('builder', 'flow', 'script'));

ALTER TABLE performance_tests
  ADD COLUMN IF NOT EXISTS flow_config JSONB;

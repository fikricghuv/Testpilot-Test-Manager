-- Performance testing scenarios and execution runs powered by Grafana k6.

CREATE TABLE IF NOT EXISTS performance_tests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name           VARCHAR(255) NOT NULL,
    description    TEXT,
    mode           VARCHAR(16) NOT NULL DEFAULT 'builder',
    builder_config JSONB,
    script_content TEXT NOT NULL,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ,
    CONSTRAINT performance_tests_mode_check CHECK (mode IN ('builder', 'script'))
);

CREATE INDEX IF NOT EXISTS idx_performance_tests_project
    ON performance_tests(project_id, created_at DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS performance_test_runs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    test_id           UUID NOT NULL REFERENCES performance_tests(id) ON DELETE CASCADE,
    status            VARCHAR(16) NOT NULL DEFAULT 'queued',
    vus               INT,
    duration_sec      INT,
    total_requests    INT,
    rps               DOUBLE PRECISION,
    error_rate        DOUBLE PRECISION,
    avg_ms            DOUBLE PRECISION,
    min_ms            DOUBLE PRECISION,
    med_ms            DOUBLE PRECISION,
    p90_ms            DOUBLE PRECISION,
    p95_ms            DOUBLE PRECISION,
    max_ms            DOUBLE PRECISION,
    checks_passed     INT,
    checks_failed     INT,
    thresholds_passed BOOLEAN,
    summary_json      JSONB,
    stdout            TEXT,
    stderr            TEXT,
    error_message     TEXT,
    triggered_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    duration_ms       INT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT performance_test_runs_status_check CHECK (
        status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')
    )
);

CREATE INDEX IF NOT EXISTS idx_performance_test_runs_test
    ON performance_test_runs(test_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_performance_test_runs_project
    ON performance_test_runs(project_id, created_at DESC);

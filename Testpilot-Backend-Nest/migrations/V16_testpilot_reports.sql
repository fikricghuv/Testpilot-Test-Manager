
CREATE TABLE testpilot_report_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    source          VARCHAR(64) NOT NULL DEFAULT 'playwright',
    status          VARCHAR(32) NOT NULL DEFAULT 'Completed',
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testpilot_runs_project ON testpilot_report_runs(project_id);
CREATE INDEX idx_testpilot_runs_created ON testpilot_report_runs(project_id, created_at DESC);

CREATE TABLE testpilot_report_cases (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL REFERENCES testpilot_report_runs(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    spec_name       VARCHAR(512) NOT NULL,
    test_name       VARCHAR(512) NOT NULL,
    status          VARCHAR(32) NOT NULL,
    duration_ms     INTEGER,
    trace_url       TEXT,
    screenshot_url  TEXT,
    video_url       TEXT,
    executed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testpilot_cases_run ON testpilot_report_cases(run_id);
CREATE INDEX idx_testpilot_cases_project ON testpilot_report_cases(project_id);
CREATE INDEX idx_testpilot_cases_spec_test ON testpilot_report_cases(project_id, spec_name, test_name);
CREATE INDEX idx_testpilot_cases_status ON testpilot_report_cases(project_id, status);

CREATE TABLE testpilot_alert_rules (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    condition_type  VARCHAR(64) NOT NULL,
    comparator      VARCHAR(64) NOT NULL,
    threshold       INTEGER,
    recipients_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    frequency       VARCHAR(32) NOT NULL DEFAULT 'IMMEDIATE',
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testpilot_alerts_project ON testpilot_alert_rules(project_id);

CREATE TABLE testpilot_run_shares (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id          UUID NOT NULL UNIQUE REFERENCES testpilot_report_runs(id) ON DELETE CASCADE,
    token           VARCHAR(128) NOT NULL UNIQUE,
    enabled         BOOLEAN NOT NULL DEFAULT true,
    expires_at      TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testpilot_shares_token ON testpilot_run_shares(token);

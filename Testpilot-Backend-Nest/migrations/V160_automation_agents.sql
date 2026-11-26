-- 3-Agent Playwright automation pipeline jobs and encrypted project auth config.
CREATE TABLE IF NOT EXISTS test_agent_jobs (
    id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id                UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id               UUID REFERENCES testcases(id) ON DELETE CASCADE,
    mode                      VARCHAR(16) NOT NULL DEFAULT 'single',
    stage                     VARCHAR(24) NOT NULL DEFAULT 'queued',
    target_url                TEXT NOT NULL,
    instructions              TEXT,
    attempt                   INT NOT NULL DEFAULT 0,
    max_attempts              INT NOT NULL DEFAULT 3,
    plan_json                 JSONB NOT NULL DEFAULT '{}'::jsonb,
    logs_json                 JSONB NOT NULL DEFAULT '[]'::jsonb,
    discovered_scenarios_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    result_script_id          UUID,
    result_version_id         UUID,
    result_run_id             UUID,
    error_message             TEXT,
    created_by                UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT test_agent_jobs_mode_check CHECK (mode IN ('single', 'heal', 'explore')),
    CONSTRAINT test_agent_jobs_stage_check CHECK (
        stage IN ('queued', 'planning', 'generating', 'running', 'healing', 'completed', 'failed')
    )
);

CREATE INDEX IF NOT EXISTS idx_test_agent_jobs_project ON test_agent_jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_agent_jobs_testcase ON test_agent_jobs(testcase_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_automation_auth (
    project_id              UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    login_url               TEXT,
    username                TEXT,
    encrypted_password      TEXT,
    encrypted_storage_state TEXT,
    updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

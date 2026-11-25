-- Foundation for Playwright automation scripts attached to test cases (manual authoring + execution).
-- Built so AI generators (e.g. Zyra / 3-Agent) can later write into the exact same versioned storage
-- and trigger the exact same BullMQ runner without changing the persistence or UI contract.

CREATE TABLE IF NOT EXISTS test_scripts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id       UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    framework         VARCHAR(32) NOT NULL DEFAULT 'playwright-ts',
    target_url        TEXT,
    status            VARCHAR(16) NOT NULL DEFAULT 'draft',
    active_version_id UUID,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT test_scripts_framework_check CHECK (framework IN ('playwright-ts')),
    CONSTRAINT test_scripts_status_check CHECK (status IN ('draft', 'verified', 'archived')),
    CONSTRAINT test_scripts_testcase_framework_unique UNIQUE (testcase_id, framework)
);

CREATE INDEX IF NOT EXISTS idx_test_scripts_project ON test_scripts(project_id);
CREATE INDEX IF NOT EXISTS idx_test_scripts_testcase ON test_scripts(testcase_id);

CREATE TABLE IF NOT EXISTS test_script_versions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    script_id         UUID NOT NULL REFERENCES test_scripts(id) ON DELETE CASCADE,
    version           INT NOT NULL,
    script_content    TEXT NOT NULL,
    source            VARCHAR(16) NOT NULL DEFAULT 'manual',
    notes             TEXT,
    verified_locators JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT test_script_versions_source_check CHECK (source IN ('manual', 'zyra', 'healer')),
    CONSTRAINT test_script_versions_script_version_unique UNIQUE (script_id, version)
);

CREATE INDEX IF NOT EXISTS idx_test_script_versions_script ON test_script_versions(script_id, version DESC);

CREATE TABLE IF NOT EXISTS test_script_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    testcase_id   UUID NOT NULL REFERENCES testcases(id) ON DELETE CASCADE,
    script_id     UUID NOT NULL REFERENCES test_scripts(id) ON DELETE CASCADE,
    version_id    UUID REFERENCES test_script_versions(id) ON DELETE SET NULL,
    cycle_id      UUID REFERENCES cycles(id) ON DELETE SET NULL,
    execution_id  UUID REFERENCES executions(id) ON DELETE SET NULL,
    status        VARCHAR(16) NOT NULL DEFAULT 'queued',
    target_url    TEXT,
    duration_ms   INT,
    stdout        TEXT,
    stderr        TEXT,
    error_message TEXT,
    triggered_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT test_script_runs_status_check CHECK (
        status IN ('queued', 'running', 'passed', 'failed', 'error', 'cancelled')
    )
);

CREATE INDEX IF NOT EXISTS idx_test_script_runs_script ON test_script_runs(script_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_script_runs_testcase ON test_script_runs(testcase_id, created_at DESC);

-- Allow 'recorder' as a valid source for Chrome Extension recorded Playwright scripts.
ALTER TABLE test_script_versions
    DROP CONSTRAINT IF EXISTS test_script_versions_source_check;

ALTER TABLE test_script_versions
    ADD CONSTRAINT test_script_versions_source_check
    CHECK (source IN ('manual', 'zyra', 'healer', 'recorder'));


DELETE FROM testpilot_report_cases
WHERE id NOT IN (
    SELECT DISTINCT ON (run_id, spec_name, test_name) id
    FROM testpilot_report_cases
    ORDER BY run_id, spec_name, test_name,
             CASE status WHEN 'Failed' THEN 1 WHEN 'Passed' THEN 2 ELSE 3 END,
             executed_at DESC NULLS LAST,
             created_at DESC NULLS LAST
);

CREATE UNIQUE INDEX uq_testpilot_cases_run_spec_test
    ON testpilot_report_cases (run_id, spec_name, test_name);

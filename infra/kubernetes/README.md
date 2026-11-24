# Kubernetes Infrastructure

The test execution plane (queued/scheduled Playwright runs) is now handled by
the standalone **TestPilot-Execution** service, deployed from the **TestPilot-Runner** repo.

Kubernetes manifests and deployment workflows live in that repository.

This directory retains shared infrastructure files (e.g. secret templates)
that may be referenced by other services.

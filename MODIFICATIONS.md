# Modifications Notice (Apache License 2.0 — Section 4b)

In accordance with Section 4(b) of the Apache License, Version 2.0, this document records the modifications made to the original work by QAble Testlab (Copyright 2026 QAble Testlab).

## Modified Areas (2026-11-24 – 2026-11-25)

1. **Branding & Assets (`Testpilot-Frontend/`, `Testpilot-Backend-Nest/`, `deploy/`, `e2e/`, `sdk/`, `docs/`, `scripts/`)**
   - Replaced legacy branding, wordmarks, and logos with TestPilot brand assets (`Testpilot-Frontend/public/brand/testpilot-logo-light.svg`, `testpilot-logo-dark.svg`, `Testpilot-Frontend/app/icon.svg`).
   - Updated default branding configuration in `Testpilot-Frontend/lib/branding.ts`, `Testpilot-Frontend/components/BrandLogo.tsx`, `Testpilot-Frontend/app/layout.tsx`, and `Testpilot-Backend-Nest/src/legacy/legacy.service.ts`.

2. **Security Hardening (`docker-compose.yml`, `Testpilot-Backend-Nest/`, `Testpilot-Frontend/`)**
   - Removed hardcoded fallback encryption key in `docker-compose.yml`.
   - Added `SETUP_TOKEN` validation and IP rate limiting to `/api/setup/first-admin` (`app-config.service.ts`, `rate-limit.service.ts`, `setup.controller.ts`, `setup.service.ts`).
   - Upgraded vulnerable dependencies (`next`, `eslint-config-next`, `multer`, `body-parser`).

3. **Frontend Design & Motion System (`Testpilot-Frontend/`)**
   - Updated `Testpilot-Frontend/app/globals.css`, `Button.tsx`, `Modal.tsx`, `Sidebar.tsx`, `TopBar.tsx`, and `agents/zyra/page.tsx` with the TestPilot Zinc/Amber palette, flat hairline-bordered surfaces, tabular numbers, and motion curves.

4. **Repository Hygiene (`.gitignore`)**
   - Excluded local IDE configs, AI agent tooling files, local E2E run logs, and non-code reference PDFs from version control.

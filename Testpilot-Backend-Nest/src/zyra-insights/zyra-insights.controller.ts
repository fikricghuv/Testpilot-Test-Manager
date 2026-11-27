import { Body, Controller, Param, Post, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/request.types";
import { ZyraInsightsService } from "./zyra-insights.service";

@Controller()
export class ZyraInsightsController {
  constructor(private readonly zyraInsights: ZyraInsightsService) {}

  @Post("/api/projects/:projectId/agents/zyra/triage-failure")
  triageFailure(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { runId?: string; executionId?: string; testcaseId?: string }
  ) {
    return this.zyraInsights.triageFailure(req.userId, projectId, body || {});
  }

  @Post("/api/projects/:projectId/agents/zyra/analyze-performance")
  analyzePerformance(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { performanceTestId: string; runId?: string }
  ) {
    return this.zyraInsights.analyzePerformanceRun(
      req.userId,
      projectId,
      body || ({} as { performanceTestId: string })
    );
  }

  @Post("/api/projects/:projectId/agents/zyra/generate-test-data")
  generateTestData(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { testcaseId?: string; prompt?: string }
  ) {
    return this.zyraInsights.generateTestData(req.userId, projectId, body || {});
  }

  @Post("/api/projects/:projectId/agents/zyra/generate-automation")
  generateAutomation(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { testcaseId: string; targetUrl: string; instructions?: string | null }
  ) {
    return this.zyraInsights.generateAutomationForTestCase(
      req.userId,
      projectId,
      body || ({} as { testcaseId: string; targetUrl: string })
    );
  }
}

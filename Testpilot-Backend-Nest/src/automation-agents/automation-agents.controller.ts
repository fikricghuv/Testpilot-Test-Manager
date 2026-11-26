import { Body, Controller, Get, Param, Post, Put, Query, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/request.types";
import { AutomationAgentsService } from "./automation-agents.service";

@Controller()
export class AutomationAgentsController {
  constructor(private readonly agents: AutomationAgentsService) {}

  @Get("/api/projects/:projectId/automation-agents/auth")
  getAuthConfig(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.agents.getAuthConfig(req.userId, projectId);
  }

  @Put("/api/projects/:projectId/automation-agents/auth")
  upsertAuthConfig(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { loginUrl?: string | null; username?: string | null; password?: string | null; storageStateJson?: string | null }
  ) {
    return this.agents.upsertAuthConfig(req.userId, projectId, body || {});
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/ai-generate")
  startSingleGenerate(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: { targetUrl: string; instructions?: string | null }
  ) {
    return this.agents.startSingleGenerate(req.userId, projectId, testcaseId, body || ({} as { targetUrl: string }));
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/ai-heal")
  startHeal(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: { targetUrl?: string | null; instructions?: string | null }
  ) {
    return this.agents.startHeal(req.userId, projectId, testcaseId, body || {});
  }

  @Post("/api/projects/:projectId/automation-agents/explore")
  startExplore(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { targetUrl: string; instructions?: string | null }
  ) {
    return this.agents.startExplore(req.userId, projectId, body || ({} as { targetUrl: string }));
  }

  @Post("/api/projects/:projectId/automation-agents/jobs/:jobId/create-testcases")
  createTestCasesFromExplore(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("jobId") jobId: string,
    @Body() body: { indices: number[] }
  ) {
    return this.agents.createTestCasesFromExplore(
      req.userId,
      projectId,
      jobId,
      Array.isArray(body?.indices) ? body.indices : []
    );
  }

  @Get("/api/projects/:projectId/automation-agents/jobs")
  listJobs(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query("testcaseId") testcaseId?: string
  ) {
    return this.agents.listJobs(req.userId, projectId, testcaseId);
  }

  @Get("/api/projects/:projectId/automation-agents/jobs/:jobId")
  getJob(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("jobId") jobId: string
  ) {
    return this.agents.getJob(req.userId, projectId, jobId);
  }
}

import { Body, Controller, Delete, Get, Param, Post, Put, Req } from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/request.types";
import { ScriptRunnerService } from "./script-runner.service";
import type { TriggerScriptRunInput, UpsertTestScriptInput } from "./script-runner.types";

@Controller()
export class ScriptRunnerController {
  constructor(private readonly scriptRunner: ScriptRunnerService) {}

  @Get("/api/projects/:projectId/testcases/:testcaseId/script")
  getScript(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.scriptRunner.getScript(req.userId, projectId, testcaseId);
  }

  @Put("/api/projects/:projectId/testcases/:testcaseId/script")
  upsertScript(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: UpsertTestScriptInput
  ) {
    return this.scriptRunner.upsertScript(req.userId, projectId, testcaseId, body || ({} as UpsertTestScriptInput));
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/versions/:versionId/activate")
  activateVersion(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Param("versionId") versionId: string
  ) {
    return this.scriptRunner.activateVersion(req.userId, projectId, testcaseId, versionId);
  }

  @Delete("/api/projects/:projectId/testcases/:testcaseId/script/versions/:versionId")
  deleteVersion(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Param("versionId") versionId: string
  ) {
    return this.scriptRunner.deleteVersion(req.userId, projectId, testcaseId, versionId);
  }

  @Delete("/api/projects/:projectId/testcases/:testcaseId/script")
  deleteScript(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.scriptRunner.deleteScript(req.userId, projectId, testcaseId);
  }

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/run")
  triggerRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: TriggerScriptRunInput
  ) {
    return this.scriptRunner.triggerRun(req.userId, projectId, testcaseId, body || {});
  }

  @Get("/api/projects/:projectId/testcases/:testcaseId/script/runs/:runId")
  getRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Param("runId") runId: string
  ) {
    return this.scriptRunner.getRun(req.userId, projectId, testcaseId, runId);
  }
}

import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../common/request.types";
import { ScriptRunnerService } from "./script-runner.service";
import type {
  RecordHeadedRunInput,
  TriggerScriptRunInput,
  TriggerSuiteRunInput,
  UpsertTestScriptInput
} from "./script-runner.types";

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

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/recorder-session")
  createRecorderSession(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string
  ) {
    return this.scriptRunner.issueRecorderSession(req.userId, projectId, testcaseId);
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

  @Post("/api/projects/:projectId/testcases/:testcaseId/script/headed-run")
  recordHeadedRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testcaseId") testcaseId: string,
    @Body() body: RecordHeadedRunInput
  ) {
    return this.scriptRunner.recordHeadedRun(req.userId, projectId, testcaseId, body || ({} as RecordHeadedRunInput));
  }

  @Post("/api/projects/:projectId/suites/:suiteId/script/run")
  triggerSuiteRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("suiteId") suiteId: string,
    @Body() body: TriggerSuiteRunInput
  ) {
    return this.scriptRunner.triggerSuiteRun(req.userId, projectId, suiteId, body || {});
  }

  @Get("/api/projects/:projectId/cycles/:cycleId/script-runs")
  getCycleScriptRuns(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("cycleId") cycleId: string
  ) {
    return this.scriptRunner.getCycleScriptRuns(req.userId, projectId, cycleId);
  }

  @Get("/api/projects/:projectId/cycles/:cycleId/report")
  async downloadCycleReport(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("cycleId") cycleId: string,
    @Query("format") format?: string
  ) {
    const report = await this.scriptRunner.exportCycleReport(req.userId, projectId, cycleId, format);
    res.setHeader("Content-Type", report.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${report.fileName}"`);
    return res.send(report.content);
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

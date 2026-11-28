import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import type { AuthenticatedRequest } from "../common/request.types";
import { PerformanceTestsService } from "./performance-tests.service";
import type {
  CreatePerformanceTestInput,
  PerformanceReportRange,
  UpdatePerformanceTestInput
} from "./performance-tests.types";

@Controller()
export class PerformanceTestsController {
  constructor(private readonly performanceTests: PerformanceTestsService) {}

  @Get("/api/projects/:projectId/performance-tests/report")
  getProjectReport(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Query("range") range?: string
  ) {
    const normalizedRange: PerformanceReportRange =
      range === "7d" || range === "30d" || range === "all" ? range : "30d";
    return this.performanceTests.getProjectReport(req.userId, projectId, normalizedRange);
  }

  @Get("/api/projects/:projectId/performance-tests/report/export/:format")
  async exportProjectReport(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("format") format: string,
    @Query("range") range?: string
  ) {
    const normalizedRange: PerformanceReportRange =
      range === "7d" || range === "30d" || range === "all" ? range : "30d";
    const file = await this.performanceTests.exportProjectReport(
      req.userId,
      projectId,
      format,
      normalizedRange
    );
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    return res.send(file.content);
  }

  @Get("/api/projects/:projectId/performance-tests")
  listTests(@Req() req: AuthenticatedRequest, @Param("projectId") projectId: string) {
    return this.performanceTests.listTests(req.userId, projectId);
  }

  @Post("/api/projects/:projectId/performance-tests")
  createTest(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: CreatePerformanceTestInput
  ) {
    return this.performanceTests.createTest(req.userId, projectId, body || ({} as CreatePerformanceTestInput));
  }

  @Post("/api/projects/:projectId/performance-tests/recorder/start")
  startRecorder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { startUrl: string }
  ) {
    return this.performanceTests.startRecorderSession(req.userId, projectId, body?.startUrl ?? "");
  }

  @Get("/api/projects/:projectId/performance-tests/recorder/:sessionId")
  getRecorder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.performanceTests.getRecorderSession(req.userId, projectId, sessionId);
  }

  @Get("/api/projects/:projectId/performance-tests/recorder/:sessionId/frame")
  async getRecorderFrame(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    const buf = await this.performanceTests.getRecorderFrame(req.userId, projectId, sessionId);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.send(buf);
  }

  @Post("/api/projects/:projectId/performance-tests/recorder/:sessionId/action")
  performRecorderAction(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { type: string; x?: number; y?: number; text?: string; key?: string; url?: string; deltaY?: number; value?: string }
  ) {
    return this.performanceTests.performRecorderAction(req.userId, projectId, sessionId, body || { type: "" });
  }

  @Post("/api/projects/:projectId/performance-tests/recorder/:sessionId/stop")
  stopRecorder(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.performanceTests.stopRecorderSession(req.userId, projectId, sessionId);
  }

  @Post("/api/projects/:projectId/performance-tests/import-har")
  importHar(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Body() body: { har: unknown }
  ) {
    return this.performanceTests.importHar(req.userId, projectId, body?.har);
  }

  @Get("/api/projects/:projectId/performance-tests/:testId")
  getTest(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string
  ) {
    return this.performanceTests.getTest(req.userId, projectId, testId);
  }

  @Put("/api/projects/:projectId/performance-tests/:testId")
  updateTest(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Body() body: UpdatePerformanceTestInput
  ) {
    return this.performanceTests.updateTest(req.userId, projectId, testId, body || ({} as UpdatePerformanceTestInput));
  }

  @Delete("/api/projects/:projectId/performance-tests/:testId")
  deleteTest(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string
  ) {
    return this.performanceTests.deleteTest(req.userId, projectId, testId);
  }

  @Post("/api/projects/:projectId/performance-tests/:testId/run")
  triggerRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string
  ) {
    return this.performanceTests.triggerRun(req.userId, projectId, testId);
  }

  @Get("/api/projects/:projectId/performance-tests/:testId/runs/:runId")
  getRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string
  ) {
    return this.performanceTests.getRun(req.userId, projectId, testId, runId);
  }

  @Get("/api/projects/:projectId/performance-tests/:testId/runs/:runId/live")
  getLiveMetrics(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string
  ) {
    return this.performanceTests.getLiveMetrics(req.userId, projectId, testId, runId);
  }

  @Post("/api/projects/:projectId/performance-tests/:testId/runs/:runId/baseline")
  setBaselineRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string
  ) {
    return this.performanceTests.setBaselineRun(req.userId, projectId, testId, runId);
  }

  @Get("/api/projects/:projectId/performance-tests/:testId/runs/:runId/compare")
  compareRuns(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string,
    @Query("baselineRunId") baselineRunId?: string
  ) {
    return this.performanceTests.compareRuns(req.userId, projectId, testId, runId, baselineRunId);
  }

  @Get("/api/projects/:projectId/performance-tests/:testId/runs/:runId/report")
  async downloadRunReport(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string
  ) {
    const report = await this.performanceTests.exportRunPdf(req.userId, projectId, testId, runId);
    res.setHeader("Content-Type", report.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${report.fileName}"`);
    return res.send(report.content);
  }

  @Post("/api/projects/:projectId/performance-tests/:testId/runs/:runId/cancel")
  cancelRun(
    @Req() req: AuthenticatedRequest,
    @Param("projectId") projectId: string,
    @Param("testId") testId: string,
    @Param("runId") runId: string
  ) {
    return this.performanceTests.cancelRun(req.userId, projectId, testId, runId);
  }
}

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { PERFORMANCE_RUNNER_JOB, PERFORMANCE_RUNNER_QUEUE } from "./performance-tests.constants";
import { PerformanceTestsService } from "./performance-tests.service";
import type { PerformanceRunnerJobPayload } from "./performance-tests.types";

@Processor(PERFORMANCE_RUNNER_QUEUE, { concurrency: 1 })
export class PerformanceTestsProcessor extends WorkerHost {
  private readonly logger = new Logger(PerformanceTestsProcessor.name);

  constructor(private readonly performanceTests: PerformanceTestsService) {
    super();
  }

  async process(job: Job<PerformanceRunnerJobPayload>): Promise<void> {
    if (job.name !== PERFORMANCE_RUNNER_JOB) {
      this.logger.warn(`Unknown performance-runner job name: ${job.name}`);
      return;
    }
    await this.performanceTests.executeRunJob(job.data.runId);
  }
}

import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import { SCRIPT_RUNNER_JOB, SCRIPT_RUNNER_QUEUE } from "./script-runner.constants";
import { ScriptRunnerService } from "./script-runner.service";
import type { ScriptRunnerJobPayload } from "./script-runner.types";

@Processor(SCRIPT_RUNNER_QUEUE)
export class ScriptRunnerProcessor extends WorkerHost {
  private readonly logger = new Logger(ScriptRunnerProcessor.name);

  constructor(private readonly scriptRunner: ScriptRunnerService) {
    super();
  }

  async process(job: Job<ScriptRunnerJobPayload>): Promise<void> {
    if (job.name !== SCRIPT_RUNNER_JOB) {
      this.logger.warn(`Unknown script-runner job name: ${job.name}`);
      return;
    }
    await this.scriptRunner.executeRunJob(job.data.runId, job.data.browser);
  }
}

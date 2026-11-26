import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { AUTOMATION_AGENTS_JOB, AUTOMATION_AGENTS_QUEUE } from "./automation-agents.constants";
import { AutomationAgentsService } from "./automation-agents.service";

@Processor(AUTOMATION_AGENTS_QUEUE)
export class AutomationAgentsProcessor extends WorkerHost {
  constructor(private readonly agents: AutomationAgentsService) {
    super();
  }

  async process(job: Job<{ jobId: string }>): Promise<void> {
    if (job.name !== AUTOMATION_AGENTS_JOB) return;
    await this.agents.executeJob(job.data.jobId);
  }
}

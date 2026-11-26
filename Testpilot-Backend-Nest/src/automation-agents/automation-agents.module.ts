import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { ScriptRunnerModule } from "../script-runner/script-runner.module";
import { AUTOMATION_AGENTS_QUEUE } from "./automation-agents.constants";
import { AutomationAgentsController } from "./automation-agents.controller";
import { AutomationAgentsProcessor } from "./automation-agents.processor";
import { AutomationAgentsService } from "./automation-agents.service";
import { PageInspectorService } from "./page-inspector.service";

@Module({
  imports: [BullModule.registerQueue({ name: AUTOMATION_AGENTS_QUEUE }), LegacyModule, ScriptRunnerModule],
  controllers: [AutomationAgentsController],
  providers: [AutomationAgentsService, AutomationAgentsProcessor, PageInspectorService],
  exports: [AutomationAgentsService]
})
export class AutomationAgentsModule {}

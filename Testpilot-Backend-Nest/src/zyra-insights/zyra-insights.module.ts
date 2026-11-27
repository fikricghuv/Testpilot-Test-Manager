import { Module } from "@nestjs/common";
import { AutomationAgentsModule } from "../automation-agents/automation-agents.module";
import { LegacyModule } from "../legacy/legacy.module";
import { ZyraInsightsController } from "./zyra-insights.controller";
import { ZyraInsightsService } from "./zyra-insights.service";

@Module({
  imports: [LegacyModule, AutomationAgentsModule],
  controllers: [ZyraInsightsController],
  providers: [ZyraInsightsService],
  exports: [ZyraInsightsService]
})
export class ZyraInsightsModule {}

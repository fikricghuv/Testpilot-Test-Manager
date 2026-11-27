import { BullModule } from "@nestjs/bullmq";
import { forwardRef, Module } from "@nestjs/common";
import { LegacyModule } from "../legacy/legacy.module";
import { PERFORMANCE_RUNNER_QUEUE } from "./performance-tests.constants";
import { PerformanceTestsController } from "./performance-tests.controller";
import { PerformanceTestsProcessor } from "./performance-tests.processor";
import { PerformanceTestsService } from "./performance-tests.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: PERFORMANCE_RUNNER_QUEUE }),
    forwardRef(() => LegacyModule)
  ],
  controllers: [PerformanceTestsController],
  providers: [PerformanceTestsService, PerformanceTestsProcessor],
  exports: [PerformanceTestsService]
})
export class PerformanceTestsModule {}

import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { LegacyModule } from "../legacy/legacy.module";
import { StorageModule } from "../storage/storage.module";
import { SCRIPT_RUNNER_QUEUE } from "./script-runner.constants";
import { ScriptRunnerController } from "./script-runner.controller";
import { ScriptRunnerProcessor } from "./script-runner.processor";
import { ScriptRunnerService } from "./script-runner.service";

@Module({
  imports: [BullModule.registerQueue({ name: SCRIPT_RUNNER_QUEUE }), AuthModule, LegacyModule, StorageModule],
  controllers: [ScriptRunnerController],
  providers: [ScriptRunnerService, ScriptRunnerProcessor],
  exports: [ScriptRunnerService]
})
export class ScriptRunnerModule {}

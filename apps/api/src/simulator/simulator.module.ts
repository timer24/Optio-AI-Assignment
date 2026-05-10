import { Module } from '@nestjs/common';
import { SimulatorController } from './simulator.controller';

// SimulatorController only injects services that come from @Global modules
// (PrismaService from PrismaModule, ChangeBufferService exported by the
// global MessagingModule). No imports needed here — that's the payoff for
// marking those modules @Global.
@Module({
  controllers: [SimulatorController],
})
export class SimulatorModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { CustomersModule } from './customers/customers.module';
import { RedisModule } from './redis/redis.module';
import { SegmentsModule } from './segments/segments.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  imports: [
    // Loads .env into process.env at startup. isGlobal so any module can read
    // it via ConfigService without re-importing ConfigModule.
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    MessagingModule,
    SegmentsModule,
    SimulatorModule,
    CustomersModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

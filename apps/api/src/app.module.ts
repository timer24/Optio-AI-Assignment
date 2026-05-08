import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { SegmentsModule } from './segments/segments.module';

@Module({
  imports: [
    // Loads .env into process.env at startup. isGlobal so any module can read
    // it via ConfigService without re-importing ConfigModule.
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    SegmentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}

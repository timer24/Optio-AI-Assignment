import {
  Controller,
  Get,
  HttpCode,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @HttpCode(200)
  async check() {
    const services = { db: 'ok' as 'ok' | 'down' };

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      services.db = 'down';
    }

    const allHealthy = Object.values(services).every((s) => s === 'ok');

    if (!allHealthy) {
      // 503 Service Unavailable. Body still describes per-service state so
      // ops tooling / load balancers can read which dependency is failing.
      throw new ServiceUnavailableException({ status: 'down', services });
    }

    return { status: 'ok', services };
  }
}

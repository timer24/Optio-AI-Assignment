import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Wraps the generated Prisma client as an injectable NestJS service.
// Using lifecycle hooks so we connect at app startup (failing fast if the DB
// is unreachable) and disconnect cleanly on shutdown.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

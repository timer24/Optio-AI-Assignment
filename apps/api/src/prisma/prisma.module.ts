import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// @Global means PrismaService becomes injectable in every module without
// each one having to `imports: [PrismaModule]`. Reasonable here because
// nearly every feature module will touch the database.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}

import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Tiny read-only controller backing the simulator panel's customer-picker
// dropdown. We seed only 200 customers, so a single un-paginated payload
// is fine; if seed grew large we'd add pagination + name search.
@Controller('customers')
export class CustomersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    return this.prisma.customer.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    });
  }
}

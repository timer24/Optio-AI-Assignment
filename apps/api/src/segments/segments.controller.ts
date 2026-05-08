import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import { SegmentEvaluationService } from './segment-evaluation.service';

interface EvaluateBody {
  // Required only for STATIC segments — guards against accidental refresh.
  force?: boolean;
}

@Controller('segments')
export class SegmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    private readonly evaluation: SegmentEvaluationService,
  ) {}

  // ── Debug / dev only ───────────────────────────────────────────────────
  // Returns metrics for the 5 named scenario customers so we can sanity-check
  // the SQL aggregate against the deterministic seed values. Will be retired
  // when we no longer need it; harmless until then.
  @Get('metrics/preview')
  async preview() {
    const named = await this.prisma.customer.findMany({
      where: { email: { endsWith: '@drift.test' } },
      select: { id: true, name: true, email: true },
      orderBy: { name: 'asc' },
    });
    const all = await this.metrics.computeAll();
    return named.map((c) => ({
      name: c.name,
      email: c.email,
      metrics: all.get(c.id),
    }));
  }

  // ── Real endpoints ─────────────────────────────────────────────────────

  /**
   * Recompute one segment's membership and emit a delta. The body is
   * optional; pass `{ force: true }` only to refresh a STATIC segment.
   */
  @Post(':id/evaluate')
  @HttpCode(200)
  async evaluate(@Param('id') id: string, @Body() body: EvaluateBody = {}) {
    try {
      return await this.evaluation.evaluateSegment(id, { force: body.force });
    } catch (err) {
      // Map the orchestrator's "STATIC without force" guard to a 400 so it's
      // distinguishable from an unexpected 500.
      if (err instanceof Error && err.message.includes('STATIC')) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  /**
   * Initial population (and disaster-recovery rebuild). Walks every dynamic
   * segment in topological order and evaluates each. Static segments are
   * skipped — their membership is owned by the caller, not the rules.
   */
  @Post('rebuild')
  @HttpCode(200)
  async rebuild() {
    const results = await this.evaluation.rebuildAllDynamic();
    return {
      evaluatedCount: results.length,
      segments: results.map((r) => ({
        name: r.segmentName,
        added: r.added.length,
        removed: r.removed.length,
        totalMembers: r.totalMembers,
      })),
    };
  }
}

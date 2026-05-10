import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
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
   * List all segments with their current member counts. Used by the UI's
   * segment list page. Member count is materialized via SegmentMember.count
   * — cheap because of the (segmentId, customerId) PK index.
   */
  @Get()
  async list() {
    const segments = await this.prisma.segment.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return segments.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      memberCount: s._count.members,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Single segment detail with the full rule (so the UI can render it) and
   * current member count.
   */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const s = await this.prisma.segment.findUniqueOrThrow({
      where: { id },
      include: { _count: { select: { members: true } } },
    });
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      type: s.type,
      rule: s.rule,
      memberCount: s._count.members,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }

  /**
   * Recent delta history for a segment. Backs the segment-detail "what just
   * changed" feed. Customer name joined for human-readable display.
   */
  @Get(':id/deltas')
  async deltas(
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(parseInt(limitRaw ?? '50', 10) || 50, 1), 200);
    const rows = await this.prisma.segmentDelta.findMany({
      where: { segmentId: id },
      orderBy: { occurredAt: 'desc' },
      take: limit,
      include: { customer: { select: { name: true, email: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      customerId: r.customerId,
      customerName: r.customer.name,
      change: r.change,
      batchId: r.batchId,
      occurredAt: r.occurredAt,
    }));
  }

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

import { Module } from '@nestjs/common';
import { DependencyService } from './dependency.service';
import { EvaluatorService } from './evaluator.service';
import { MetricsService } from './metrics.service';
import { SegmentEvaluationService } from './segment-evaluation.service';
import { SegmentsController } from './segments.controller';

// Feature module for segment-related concerns. Day 2: metric computation,
// rule evaluation, dependency-graph extraction, end-to-end orchestration
// + a debug controller. Day 3 will add a RabbitMQ consumer that calls the
// orchestrator when upstream data changes.
//
// PrismaService is injected from the @Global PrismaModule, so we don't
// re-import it here.
@Module({
  controllers: [SegmentsController],
  providers: [
    MetricsService,
    EvaluatorService,
    DependencyService,
    SegmentEvaluationService,
  ],
  exports: [
    MetricsService,
    EvaluatorService,
    DependencyService,
    SegmentEvaluationService,
  ],
})
export class SegmentsModule {}

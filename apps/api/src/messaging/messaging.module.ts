import { Global, Module } from '@nestjs/common';
import { SegmentsModule } from '../segments/segments.module';
import { CampaignConsumerService } from './campaign-consumer.service';
import { CascadeConsumerService } from './cascade-consumer.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RabbitMQService } from './rabbitmq.service';

// @Global so any feature module can inject RabbitMQService without having
// to import MessagingModule explicitly. Same reasoning as PrismaModule —
// the broker connection is a cross-cutting concern; nearly every part of
// the app will publish or consume.
//
// Imports SegmentsModule because CascadeConsumerService injects
// SegmentEvaluationService to re-evaluate dependent segments. SegmentsModule
// itself does NOT import MessagingModule, so there is no circular import:
// the orchestrator writes to OutboxEvent via Prisma only, never directly
// touching the broker.
@Global()
@Module({
  imports: [SegmentsModule],
  providers: [
    RabbitMQService,
    OutboxPublisherService,
    CascadeConsumerService,
    CampaignConsumerService,
  ],
  exports: [RabbitMQService],
})
export class MessagingModule {}

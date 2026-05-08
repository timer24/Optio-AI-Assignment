import { Global, Module } from '@nestjs/common';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RabbitMQService } from './rabbitmq.service';

// @Global so any feature module can inject RabbitMQService without having
// to import MessagingModule explicitly. Same reasoning as PrismaModule —
// the broker connection is a cross-cutting concern; nearly every part of
// the app will publish or consume.
@Global()
@Module({
  providers: [RabbitMQService, OutboxPublisherService],
  exports: [RabbitMQService],
})
export class MessagingModule {}

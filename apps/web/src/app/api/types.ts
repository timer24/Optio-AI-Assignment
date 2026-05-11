// Wire-format types as returned by the API. Re-exports the shared types
// (kept in @drift/shared so producer + consumer stay in lockstep) plus the
// view-model shapes that come back from the read endpoints.

export type {
  CampaignNotificationPayload,
  SegmentDeltaPayload,
  EventEnvelope,
  SegmentRule,
} from '@drift/shared';
export { EventTypes } from '@drift/shared';

export type SegmentType = 'DYNAMIC' | 'STATIC';

export interface SegmentSummary {
  id: string;
  name: string;
  description: string | null;
  type: SegmentType;
  memberCount: number;
  updatedAt: string;
}

export interface SegmentDetail extends SegmentSummary {
  rule: unknown;
  createdAt: string;
}

export type DeltaChange = 'ADD' | 'REMOVE';

export interface DeltaEntry {
  id: string;
  customerId: string;
  customerName: string;
  change: DeltaChange;
  batchId: string;
  occurredAt: string;
}

export interface CustomerSummary {
  id: string;
  name: string;
  email: string;
}

export interface SegmentMember {
  customerId: string;
  name: string;
  email: string;
  joinedAt: string;
}

export interface SegmentMembersPage {
  total: number;
  limit: number;
  offset: number;
  members: SegmentMember[];
}

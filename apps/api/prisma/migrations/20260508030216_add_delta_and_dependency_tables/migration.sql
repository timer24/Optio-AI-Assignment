-- CreateEnum
CREATE TYPE "DeltaChange" AS ENUM ('ADD', 'REMOVE');

-- CreateTable
CREATE TABLE "SegmentDelta" (
    "id" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "change" "DeltaChange" NOT NULL,
    "batchId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SegmentDelta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SegmentDependency" (
    "parentId" TEXT NOT NULL,
    "childId" TEXT NOT NULL,

    CONSTRAINT "SegmentDependency_pkey" PRIMARY KEY ("parentId","childId")
);

-- CreateIndex
CREATE INDEX "SegmentDelta_segmentId_occurredAt_idx" ON "SegmentDelta"("segmentId", "occurredAt");

-- CreateIndex
CREATE INDEX "SegmentDelta_batchId_idx" ON "SegmentDelta"("batchId");

-- CreateIndex
CREATE INDEX "SegmentDelta_customerId_idx" ON "SegmentDelta"("customerId");

-- AddForeignKey
ALTER TABLE "SegmentDelta" ADD CONSTRAINT "SegmentDelta_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentDelta" ADD CONSTRAINT "SegmentDelta_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentDependency" ADD CONSTRAINT "SegmentDependency_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SegmentDependency" ADD CONSTRAINT "SegmentDependency_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

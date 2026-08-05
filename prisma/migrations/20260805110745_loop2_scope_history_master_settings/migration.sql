-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "pepperVersion" TEXT;

-- AlterTable
ALTER TABLE "FieldAgentApplication" ADD COLUMN     "primaryAgencyId" TEXT,
ADD COLUMN     "secondaryAgencyId" TEXT;

-- CreateTable
CREATE TABLE "StatusHistory" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusMaster" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "tone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatusMaster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatusHistory_entityType_entityId_idx" ON "StatusHistory"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "StatusHistory_changedAt_idx" ON "StatusHistory"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatusMaster_kind_value_key" ON "StatusMaster"("kind", "value");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");

-- AddForeignKey
ALTER TABLE "FieldAgentApplication" ADD CONSTRAINT "FieldAgentApplication_primaryAgencyId_fkey" FOREIGN KEY ("primaryAgencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldAgentApplication" ADD CONSTRAINT "FieldAgentApplication_secondaryAgencyId_fkey" FOREIGN KEY ("secondaryAgencyId") REFERENCES "Agency"("id") ON DELETE SET NULL ON UPDATE CASCADE;

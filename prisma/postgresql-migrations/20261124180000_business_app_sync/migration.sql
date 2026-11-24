-- CreateTable
CREATE TABLE "BusinessAppSyncRun" (
    "id" VARCHAR(96) NOT NULL,
    "instanceId" TEXT NOT NULL,
    "generation" VARCHAR(64) NOT NULL,
    "phoneNumberId" VARCHAR(100) NOT NULL,
    "messagingAccountId" VARCHAR(100) NOT NULL,
    "portalAccountId" INTEGER NOT NULL,
    "portalInboxId" INTEGER NOT NULL,
    "portalBaseUrl" VARCHAR(2048) NOT NULL,
    "onboardedAt" TIMESTAMP(3) NOT NULL,
    "deadline" TIMESTAMP(3) NOT NULL,
    "contactsRequestId" VARCHAR(255),
    "historyRequestId" VARCHAR(255),
    "sourceProgress" INTEGER NOT NULL DEFAULT 0,
    "historyConsent" VARCHAR(32) NOT NULL DEFAULT 'unknown',
    "sourceErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessAppSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAppSyncChunk" (
    "id" VARCHAR(96) NOT NULL,
    "runId" VARCHAR(96) NOT NULL,
    "instanceId" TEXT NOT NULL,
    "field" VARCHAR(32) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" VARCHAR(64),
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "blocked" JSONB,
    "lastErrorCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessAppSyncChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessAppContact" (
    "id" VARCHAR(96) NOT NULL,
    "instanceId" TEXT NOT NULL,
    "identityKey" VARCHAR(128) NOT NULL,
    "userId" VARCHAR(100),
    "phoneNumber" VARCHAR(32),
    "remoteJid" VARCHAR(100),
    "fullName" VARCHAR(255),
    "action" VARCHAR(20) NOT NULL,
    "sourceTimestamp" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessAppContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAppSyncRun_instanceId_key" ON "BusinessAppSyncRun"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAppSyncRun_id_instanceId_key" ON "BusinessAppSyncRun"("id", "instanceId");

-- CreateIndex
CREATE INDEX "BusinessAppSyncChunk_instanceId_state_nextAttemptAt_idx" ON "BusinessAppSyncChunk"("instanceId", "state", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "BusinessAppSyncChunk_runId_idx" ON "BusinessAppSyncChunk"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAppSyncChunk_runId_field_payloadHash_key" ON "BusinessAppSyncChunk"("runId", "field", "payloadHash");

-- CreateIndex
CREATE INDEX "BusinessAppContact_instanceId_idx" ON "BusinessAppContact"("instanceId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessAppContact_instanceId_identityKey_key" ON "BusinessAppContact"("instanceId", "identityKey");

-- AddForeignKey
ALTER TABLE "BusinessAppSyncRun" ADD CONSTRAINT "BusinessAppSyncRun_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAppSyncChunk" ADD CONSTRAINT "BusinessAppSyncChunk_runId_instanceId_fkey" FOREIGN KEY ("runId", "instanceId") REFERENCES "BusinessAppSyncRun"("id", "instanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAppSyncChunk" ADD CONSTRAINT "BusinessAppSyncChunk_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessAppContact" ADD CONSTRAINT "BusinessAppContact_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

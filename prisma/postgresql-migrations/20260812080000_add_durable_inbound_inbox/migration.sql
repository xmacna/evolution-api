ALTER TABLE "Instance"
ADD COLUMN "inboundInboxMode" VARCHAR(20) NOT NULL DEFAULT 'off';

CREATE TABLE "InboundReceipt" (
    "id" TEXT NOT NULL,
    "sourceCluster" VARCHAR(64) NOT NULL,
    "instanceScope" VARCHAR(255) NOT NULL,
    "messageId" VARCHAR(255) NOT NULL,
    "classification" VARCHAR(20) NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "collisionHash" CHAR(64),
    "state" VARCHAR(30) NOT NULL DEFAULT 'received',
    "webhookState" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "chatwootState" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "chatbotState" VARCHAR(30) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" VARCHAR(100),
    "leaseToken" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    "messageRecordId" TEXT,
    CONSTRAINT "InboundReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboundReceipt_sourceCluster_instanceScope_messageId_key"
ON "InboundReceipt"("sourceCluster", "instanceScope", "messageId");
CREATE UNIQUE INDEX "InboundReceipt_messageRecordId_key" ON "InboundReceipt"("messageRecordId");
CREATE INDEX "InboundReceipt_state_availableAt_idx" ON "InboundReceipt"("state", "availableAt");
CREATE INDEX "InboundReceipt_instanceScope_createdAt_idx" ON "InboundReceipt"("instanceScope", "createdAt");

ALTER TABLE "InboundReceipt"
ADD CONSTRAINT "InboundReceipt_messageRecordId_fkey"
FOREIGN KEY ("messageRecordId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

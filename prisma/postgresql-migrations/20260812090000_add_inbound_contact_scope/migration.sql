ALTER TABLE "InboundReceipt" ADD COLUMN "contactScope" VARCHAR(255);

UPDATE "InboundReceipt" receipt
SET "contactScope" = COALESCE(
  message."key"->>'remoteJidAlt',
  message."key"->>'remoteJid',
  'historical-unknown'
)
FROM "Message" message
WHERE message.id = receipt."messageRecordId";

UPDATE "InboundReceipt"
SET "contactScope" = 'historical-unknown'
WHERE "contactScope" IS NULL;

ALTER TABLE "InboundReceipt" ALTER COLUMN "contactScope" SET NOT NULL;

CREATE INDEX "InboundReceipt_instanceScope_contactScope_createdAt_idx"
ON "InboundReceipt"("instanceScope", "contactScope", "createdAt");

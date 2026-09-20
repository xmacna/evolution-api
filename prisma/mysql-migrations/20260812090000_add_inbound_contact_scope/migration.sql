ALTER TABLE `InboundReceipt` ADD COLUMN `contactScope` VARCHAR(255) NULL;

UPDATE `InboundReceipt` receipt
LEFT JOIN `Message` message ON message.id = receipt.`messageRecordId`
SET receipt.`contactScope` = COALESCE(
  JSON_UNQUOTE(JSON_EXTRACT(message.`key`, '$.remoteJidAlt')),
  JSON_UNQUOTE(JSON_EXTRACT(message.`key`, '$.remoteJid')),
  'historical-unknown'
);

ALTER TABLE `InboundReceipt` MODIFY COLUMN `contactScope` VARCHAR(255) NOT NULL;

CREATE INDEX `InboundReceipt_instanceScope_contactScope_createdAt_idx`
ON `InboundReceipt`(`instanceScope`, `contactScope`, `createdAt`);

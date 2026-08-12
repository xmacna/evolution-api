ALTER TABLE `Instance`
ADD COLUMN `inboundInboxMode` VARCHAR(20) NOT NULL DEFAULT 'off';

CREATE TABLE `InboundReceipt` (
    `id` VARCHAR(191) NOT NULL,
    `sourceCluster` VARCHAR(64) NOT NULL,
    `instanceScope` VARCHAR(255) NOT NULL,
    `messageId` VARCHAR(255) NOT NULL,
    `classification` VARCHAR(20) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `collisionHash` CHAR(64) NULL,
    `state` VARCHAR(30) NOT NULL DEFAULT 'received',
    `webhookState` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `chatwootState` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `chatbotState` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `availableAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `leaseOwner` VARCHAR(100) NULL,
    `leaseToken` INTEGER NOT NULL DEFAULT 0,
    `leaseExpiresAt` TIMESTAMP NULL,
    `lastError` TEXT NULL,
    `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updatedAt` TIMESTAMP NOT NULL,
    `messageRecordId` VARCHAR(191) NULL,
    UNIQUE INDEX `InboundReceipt_sourceCluster_instanceScope_messageId_key` (`sourceCluster`, `instanceScope`, `messageId`),
    UNIQUE INDEX `InboundReceipt_messageRecordId_key` (`messageRecordId`),
    INDEX `InboundReceipt_state_availableAt_idx` (`state`, `availableAt`),
    INDEX `InboundReceipt_instanceScope_createdAt_idx` (`instanceScope`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `InboundReceipt`
ADD CONSTRAINT `InboundReceipt_messageRecordId_fkey`
FOREIGN KEY (`messageRecordId`) REFERENCES `Message`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE `BusinessAppSyncRun` (
    `id` VARCHAR(96) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `generation` VARCHAR(64) NOT NULL,
    `phoneNumberId` VARCHAR(100) NOT NULL,
    `messagingAccountId` VARCHAR(100) NOT NULL,
    `portalAccountId` INTEGER NOT NULL,
    `portalInboxId` INTEGER NOT NULL,
    `portalBaseUrl` VARCHAR(2048) NOT NULL,
    `onboardedAt` TIMESTAMP(3) NOT NULL,
    `deadline` TIMESTAMP(3) NOT NULL,
    `contactsRequestId` VARCHAR(255) NULL,
    `historyRequestId` VARCHAR(255) NULL,
    `sourceProgress` INTEGER NOT NULL DEFAULT 0,
    `historyConsent` VARCHAR(32) NOT NULL DEFAULT 'unknown',
    `sourceErrorCode` VARCHAR(64) NULL,
    `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP(3) NOT NULL,

    UNIQUE INDEX `BusinessAppSyncRun_instanceId_key`(`instanceId`),
    UNIQUE INDEX `BusinessAppSyncRun_id_instanceId_key`(`id`, `instanceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BusinessAppSyncChunk` (
    `id` VARCHAR(96) NOT NULL,
    `runId` VARCHAR(96) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `field` VARCHAR(32) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `payload` JSON NOT NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `cursor` INTEGER NOT NULL DEFAULT 0,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `duplicateCount` INTEGER NOT NULL DEFAULT 0,
    `leaseOwner` VARCHAR(64) NULL,
    `leaseVersion` INTEGER NOT NULL DEFAULT 0,
    `leaseExpiresAt` TIMESTAMP(3) NULL,
    `nextAttemptAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `late` BOOLEAN NOT NULL DEFAULT false,
    `blocked` JSON NULL,
    `lastErrorCode` VARCHAR(64) NULL,
    `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP(3) NOT NULL,

    INDEX `BusinessAppSyncChunk_instanceId_state_nextAttemptAt_idx`(`instanceId`, `state`, `nextAttemptAt`),
    INDEX `BusinessAppSyncChunk_runId_idx`(`runId`),
    UNIQUE INDEX `BusinessAppSyncChunk_runId_field_payloadHash_key`(`runId`, `field`, `payloadHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BusinessAppContact` (
    `id` VARCHAR(96) NOT NULL,
    `instanceId` VARCHAR(191) NOT NULL,
    `identityKey` VARCHAR(128) NOT NULL,
    `userId` VARCHAR(100) NULL,
    `phoneNumber` VARCHAR(32) NULL,
    `remoteJid` VARCHAR(100) NULL,
    `fullName` VARCHAR(255) NULL,
    `action` VARCHAR(20) NOT NULL,
    `sourceTimestamp` INTEGER NOT NULL,
    `payload` JSON NOT NULL,
    `createdAt` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` TIMESTAMP(3) NOT NULL,

    INDEX `BusinessAppContact_instanceId_idx`(`instanceId`),
    UNIQUE INDEX `BusinessAppContact_instanceId_identityKey_key`(`instanceId`, `identityKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BusinessAppSyncRun` ADD CONSTRAINT `BusinessAppSyncRun_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BusinessAppSyncChunk` ADD CONSTRAINT `BusinessAppSyncChunk_runId_instanceId_fkey` FOREIGN KEY (`runId`, `instanceId`) REFERENCES `BusinessAppSyncRun`(`id`, `instanceId`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BusinessAppSyncChunk` ADD CONSTRAINT `BusinessAppSyncChunk_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BusinessAppContact` ADD CONSTRAINT `BusinessAppContact_instanceId_fkey` FOREIGN KEY (`instanceId`) REFERENCES `Instance`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

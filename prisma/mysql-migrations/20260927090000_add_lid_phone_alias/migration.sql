CREATE TABLE `LidPhoneAlias` (
    `instanceScope` VARCHAR(67) NOT NULL,
    `lidJid` VARCHAR(100) NOT NULL,
    `phoneJid` VARCHAR(100) NULL,
    `ambiguous` BOOLEAN NOT NULL DEFAULT false,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`instanceScope`,`lidJid`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

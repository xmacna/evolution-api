CREATE TABLE "LidPhoneAlias" (
    "instanceScope" VARCHAR(67) NOT NULL,
    "lidJid" VARCHAR(100) NOT NULL,
    "phoneJid" VARCHAR(100),
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LidPhoneAlias_pkey" PRIMARY KEY ("instanceScope","lidJid")
);

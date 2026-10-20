-- SRS 3.2 "Linking" (secure short-lived deep-link token), SRS 2.2/2.4 (one Telegram
-- destination per candidate), SRS 3.4 (POST /api/telegram/link); ADR-0008.
-- Written by hand because this repo has no `prisma migrate dev` path; verified
-- against the Prisma schema with `prisma migrate diff`.

CREATE TABLE "telegram_link_tokens" (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),

  CONSTRAINT "telegram_link_tokens_pkey" PRIMARY KEY ("id")
);

-- The hash is the lookup key (the resolver knows only the token it was handed) and its
-- uniqueness is free collision checking on a random token.
CREATE UNIQUE INDEX "telegram_link_tokens_tokenHash_key"
  ON "telegram_link_tokens"("tokenHash");

CREATE TABLE "telegram_destinations" (
  "userId" UUID NOT NULL,
  "chatId" TEXT NOT NULL,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "telegram_destinations_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "telegram_link_tokens"
  ADD CONSTRAINT "telegram_link_tokens_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "telegram_destinations"
  ADD CONSTRAINT "telegram_destinations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One destination per user (SRS 2.2/2.4); the primary key is the constraint, and
-- the destination lookup by user is the sender's only read path.

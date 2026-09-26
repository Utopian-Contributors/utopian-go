-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "name" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "pass_salt" TEXT NOT NULL,
    "pass_hash" TEXT NOT NULL,
    "phrase_salt" TEXT NOT NULL,
    "phrase_iv" TEXT NOT NULL,
    "phrase_tag" TEXT NOT NULL,
    "phrase_ct" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "bio" TEXT NOT NULL DEFAULT '',
    "loc" TEXT NOT NULL DEFAULT '',
    "avatar_rev" INTEGER NOT NULL DEFAULT 0,
    "last_post" BIGINT NOT NULL DEFAULT 0,
    "created" BIGINT NOT NULL,
    "passkey_id" TEXT,
    "passkey_cose" TEXT,
    "passkey_alg" INTEGER,
    "passkey_count" INTEGER,
    "epoch" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "friends" (
    "owner" TEXT NOT NULL,
    "friend" TEXT NOT NULL,

    CONSTRAINT "friends_pkey" PRIMARY KEY ("owner","friend")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "by_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "photos" INTEGER NOT NULL DEFAULT 0,
    "repost" TEXT,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "post" TEXT NOT NULL,
    "by_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" BIGINT NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "to_name" TEXT NOT NULL,
    "from_name" TEXT NOT NULL,
    "post" TEXT NOT NULL,
    "at" BIGINT NOT NULL,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'comment',

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saves" (
    "post" TEXT NOT NULL,
    "by_name" TEXT NOT NULL,
    "at" BIGINT NOT NULL,

    CONSTRAINT "saves_pkey" PRIMARY KEY ("post","by_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_uid_key" ON "users"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_address" ON "users"("address");

-- CreateIndex
CREATE UNIQUE INDEX "users_passkey" ON "users"("passkey_id");

-- CreateIndex
CREATE INDEX "posts_at_id" ON "posts"("at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "posts_by_at" ON "posts"("by_name", "at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "posts_repost" ON "posts"("repost", "by_name") WHERE (repost IS NOT NULL);

-- CreateIndex
CREATE INDEX "comments_post" ON "comments"("post");

-- CreateIndex
CREATE INDEX "notes_to" ON "notes"("to_name", "seen");

-- CreateIndex
CREATE INDEX "notes_to_at" ON "notes"("to_name", "at" DESC);

-- CreateIndex
CREATE INDEX "saves_by_at" ON "saves"("by_name", "at" DESC);

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_owner_fkey" FOREIGN KEY ("owner") REFERENCES "users"("name") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "friends" ADD CONSTRAINT "friends_friend_fkey" FOREIGN KEY ("friend") REFERENCES "users"("name") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_by_name_fkey" FOREIGN KEY ("by_name") REFERENCES "users"("name") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_repost_fkey" FOREIGN KEY ("repost") REFERENCES "posts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_fkey" FOREIGN KEY ("post") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_by_name_fkey" FOREIGN KEY ("by_name") REFERENCES "users"("name") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_to_name_fkey" FOREIGN KEY ("to_name") REFERENCES "users"("name") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_from_name_fkey" FOREIGN KEY ("from_name") REFERENCES "users"("name") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saves" ADD CONSTRAINT "saves_post_fkey" FOREIGN KEY ("post") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "saves" ADD CONSTRAINT "saves_by_name_fkey" FOREIGN KEY ("by_name") REFERENCES "users"("name") ON DELETE CASCADE ON UPDATE NO ACTION;


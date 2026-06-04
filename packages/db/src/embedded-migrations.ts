/**
 * Embedded migration SQL — auto-generated from drizzle/ folder.
 *
 * This file bundles all migration SQL as inline strings so the compiled
 * binary can apply migrations without needing the drizzle/ folder on disk.
 *
 * DO NOT EDIT MANUALLY. Regenerate with: bun run scripts/embed-migrations.ts
 */

/** A single embedded migration with its identifying tag, SQL, and content hash. */
export interface EmbeddedMigration {
    tag: string;
    sql: string;
    hash: string;
}

/** Auto-generated array of all embedded migrations, ordered by tag. */
export const embeddedMigrations: EmbeddedMigration[] = [
    {
        tag: '0000_init',
        sql: "CREATE TABLE `queue_jobs` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`type` text NOT NULL,\n\t`payload` text NOT NULL,\n\t`status` text DEFAULT 'pending' NOT NULL,\n\t`attempts` integer DEFAULT 0 NOT NULL,\n\t`max_retries` integer DEFAULT 3 NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`next_retry_at` integer,\n\t`last_error` text,\n\t`processing_at` integer\n);\n",
        hash: '558dea3834348925f79b4d30ca79d0afd0d990b2883341377d369444d50ce76e',
    },
    {
        tag: '0001_salty_red_ghost',
        sql: 'CREATE INDEX `queue_jobs_ready_idx` ON `queue_jobs` (`status`,`next_retry_at`,`created_at`);',
        hash: 'f842da3f49edeec8a17bcab399669410db09996ab258dc4fa781357d0400ddbf',
    },
    {
        tag: '0002_nasty_namora',
        sql: 'ALTER TABLE `queue_jobs` ADD `expires_at` integer;',
        hash: '7380f8c162352a61b15205af5a87e0e7313a499203dae98fe62151a1dc7fec0e',
    },
    {
        tag: '0003_inbox_messages',
        sql: "CREATE TABLE `inbox_messages` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`from_id` text,\n\t`to_id` text NOT NULL,\n\t`body` text NOT NULL,\n\t`status` text DEFAULT 'queued' NOT NULL,\n\t`in_reply_to` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`delivered_at` integer,\n\t`inject_attempts` integer DEFAULT 0 NOT NULL,\n\t`inject_error` text\n);",
        hash: 'c4ba569172d1be276c42b5c164c668404e6229dcf48b41d7fb2bc93e8d29d11b',
    },
    {
        tag: '0004_inbox_messages_to_status_idx',
        sql: 'CREATE INDEX `idx_inbox_messages_to_status` ON `inbox_messages` (`to_id`,`status`);',
        hash: '3c00f1bce4f569e442f3142df31ff478d6c9b3d460824d46575f50a324bfae61',
    },
];

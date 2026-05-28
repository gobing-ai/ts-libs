/**
 * Embedded migration SQL — auto-generated from drizzle/ folder.
 *
 * This file bundles all migration SQL as inline strings so the compiled
 * binary can apply migrations without needing the drizzle/ folder on disk.
 *
 * DO NOT EDIT MANUALLY. Regenerate with: bun run scripts/embed-migrations.ts
 */

export interface EmbeddedMigration {
    tag: string;
    sql: string;
    hash: string;
}

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
];

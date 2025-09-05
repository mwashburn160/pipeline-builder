import { pgTable, boolean, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const plugins = pgTable('plugins', {
    id: uuid('id').primaryKey().defaultRandom(),
    created_by: text('created_by').notNull().default('system'),
    created_at: timestamp('created_at').notNull().defaultNow(),
    updated_by: text('updated_by').notNull().default('system'),
    updated_at: timestamp('updated_at').notNull().defaultNow(),
    is_default: boolean('is_default').default(false)
})
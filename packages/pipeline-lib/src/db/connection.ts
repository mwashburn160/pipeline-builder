import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { plugins } from './schema'

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: Number(process.env.DB_PORT),
})

export const db = drizzle({
    client: pool,
    schema: {plugins}
})

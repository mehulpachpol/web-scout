import * as os from 'os';
import * as path from 'path';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';

export type MemoryChunk = {
    id?: number;
    file_path: string;
    chunk_index: number;
    text_content: string;
    embedding: string;
    source_type?: string | null;
    page_number?: number | null;
    source_title?: string | null;
    source_url?: string | null;
    last_updated?: string;
};

export function memoryDbPath() {
    return path.join(os.homedir(), '.web-scout', 'memory.sqlite');
}

async function ensureColumn(db: Database, table: string, column: string, decl: string) {
    const info = await db.all(`PRAGMA table_info(${table})`);
    const exists = info.some((c: any) => String(c.name).toLowerCase() === column.toLowerCase());
    if (!exists) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl};`);
    }
}

export async function ensureMemorySchema(db: Database) {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS memory_chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            text_content TEXT NOT NULL,
            embedding JSON NOT NULL,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(file_path, chunk_index)
        );
    `);

    // Migration: add optional metadata columns (best-effort).
    await ensureColumn(db, 'memory_chunks', 'source_type', 'TEXT');
    await ensureColumn(db, 'memory_chunks', 'page_number', 'INTEGER');
    await ensureColumn(db, 'memory_chunks', 'source_title', 'TEXT');
    await ensureColumn(db, 'memory_chunks', 'source_url', 'TEXT');

    await db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
            source_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            title TEXT,
            url TEXT,
            file_path TEXT,
            sha256 TEXT,
            page_count INTEGER,
            last_indexed DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

export async function openMemoryDb(): Promise<Database> {
    const db = await open({
        filename: memoryDbPath(),
        driver: sqlite3.Database
    });
    await ensureMemorySchema(db);
    return db;
}


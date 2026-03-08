import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Database, open } from 'sqlite';
import sqlite3 from 'sqlite3';

const ai = new GoogleGenAI({ apiKey: "" });

async function getDb(): Promise<Database> {
    const dbPath = path.join(os.homedir(), '.web-scout', 'memory.sqlite');
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

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

    return db;
}

function chunkText(text: string, maxWords = 400, overlap = 80): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let i = 0;

    while (i < words.length) {
        const chunk = words.slice(i, i + maxWords).join(' ');
        if (chunk.trim().length > 0) {
            chunks.push(chunk);
        }
        i += (maxWords - overlap);
    }
    return chunks;
}

async function getEmbedding(text: string): Promise<number[]> {
    try {

        const response = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: text,
        });
        return response.embeddings?.[0]?.values || [];
    } catch (error) {
        console.error("Failed to generate embedding:", error);
        return [];
    }
}

async function indexFile(db: Database, filePath: string) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (!content.trim()) return;

        const chunks = chunkText(content);

        await db.run(`DELETE FROM memory_chunks WHERE file_path = ?`, filePath);

        for (let i = 0; i < chunks.length; i++) {
            const chunkTextContent = chunks[i];
            const vector = await getEmbedding(chunkTextContent);

            if (vector.length > 0) {
                await db.run(
                    `INSERT INTO memory_chunks (file_path, chunk_index, text_content, embedding) VALUES (?, ?, ?, ?)`,
                    [filePath, i, chunkTextContent, JSON.stringify(vector)]
                );
            }
        }
        // console.log(`\x1b[90m[Indexer: Synced ${chunks.length} chunks from ${path.basename(filePath)}]\x1b[0m`);
    } catch (error) {
        console.error(`Error indexing ${filePath}:`, error);
    }
}

export async function syncMemoryIndex() {
    const db = await getDb();
    const memoryDir = path.join(os.homedir(), '.web-scout');
    const logsDir = path.join(memoryDir, 'logs');

    const coreMemoryPath = path.join(memoryDir, 'MEMORY.md');
    try {
        await fs.access(coreMemoryPath);
        await indexFile(db, coreMemoryPath);
    } catch (e) { /* File doesn't exist yet */ }

    try {
        const files = await fs.readdir(logsDir);
        for (const file of files) {
            if (file.endsWith('.md')) {
                await indexFile(db, path.join(logsDir, file));
            }
        }
    } catch (e) { }

    await db.close();
}
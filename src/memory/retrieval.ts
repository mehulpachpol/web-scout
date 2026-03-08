import { GoogleGenAI } from '@google/genai';
import * as os from 'os';
import * as path from 'path';
import { open } from 'sqlite';
import sqlite3 from 'sqlite3';

const ai = new GoogleGenAI({ apiKey: "" });

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function calculateKeywordScore(query: string, text: string): number {
    const terms = query.toLowerCase().split(/\s+/);
    const textLower = text.toLowerCase();
    let matches = 0;
    for (const term of terms) {
        if (textLower.includes(term)) matches++;
    }
    return matches / terms.length;
}

export async function performHybridSearch(query: string, topK: number = 3): Promise<string> {
    try {
        console.log(`🔎  Vectorizing search query: \x1b[35m${query}\x1b[0m`);

        const response = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: query,
        });
        const queryVector = response.embeddings?.[0]?.values || [];
        if (queryVector.length === 0) return "Failed to generate search vector.";

        const dbPath = path.join(os.homedir(), '.web-scout', 'memory.sqlite');
        const db = await open({ filename: dbPath, driver: sqlite3.Database });
        const rows = await db.all(`SELECT file_path, chunk_index, text_content, embedding FROM memory_chunks`);
        await db.close();

        if (rows.length === 0) return "Memory database is empty.";

        const scoredChunks = rows.map(row => {
            const dbVector = JSON.parse(row.embedding);
            const vecScore = cosineSimilarity(queryVector, dbVector);
            const kwScore = calculateKeywordScore(query, row.text_content);
            const finalScore = (0.7 * vecScore) + (0.3 * kwScore);
            return { ...row, score: finalScore };
        });

        scoredChunks.sort((a, b) => b.score - a.score);
        const topResults = scoredChunks.slice(0, topK);

        let resultText = `Found ${topResults.length} highly relevant memory snippets:\n\n`;
        topResults.forEach((res, i) => {
            resultText += `--- Snippet ${i + 1} [Relevance Score: ${res.score.toFixed(2)}] ---\n`;
            resultText += `Source File: ${res.file_path} (Chunk ${res.chunk_index})\n`;
            resultText += `Content:\n${res.text_content}\n\n`;
        });

        resultText += `*(Note: If a snippet is cut off, you can use the 'read_file' tool on the Source File path to read the surrounding context.)*`;

        return resultText;
    } catch (e: any) {
        return `Hybrid search failed: ${e.message}`;
    }
}
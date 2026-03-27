import 'dotenv/config';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import OpenAI from 'openai';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { openMemoryDb } from '../memory/db';

const execFileAsync = promisify(execFile);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ExtractedPage = { pageNumber: number; text: string };

function decodeXmlEntities(input: string) {
    return input
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function htmlToPlainText(html: string): string {
    const noScript = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');

    const withBreaks = noScript
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|tr)>/gi, '\n')
        .replace(/<(p|div|section|article|header|footer|main|ul|ol|li|h[1-6]|table|tr|td)[^>]*>/gi, '\n');

    return withBreaks
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function chunkText(text: string, maxWords = 400, overlap = 80): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    let i = 0;
    while (i < words.length) {
        const chunk = words.slice(i, i + maxWords).join(' ');
        if (chunk.trim()) chunks.push(chunk);
        i += Math.max(1, (maxWords - overlap));
    }
    return chunks;
}

async function sha256File(filePath: string) {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

async function getEmbedding(text: string): Promise<number[]> {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text
    });
    return response.data[0].embedding;
}

async function extractPdfPages(filePath: string): Promise<ExtractedPage[]> {
    const buffer = await fs.readFile(filePath);
    const pdfParseMod = (await import('pdf-parse')) as any;
    const pdfParse = pdfParseMod?.default || pdfParseMod;
    const pages: ExtractedPage[] = [];
    let pageNo = 0;

    await pdfParse(buffer, {
        pagerender: async (pageData: any) => {
            pageNo += 1;
            try {
                const content = await pageData.getTextContent();
                const strings = (content.items || []).map((it: any) => String(it.str || '')).filter(Boolean);
                const text = strings.join(' ').replace(/\s+/g, ' ').trim();
                pages.push({ pageNumber: pageNo, text });
                return text;
            } catch {
                pages.push({ pageNumber: pageNo, text: '' });
                return '';
            }
        }
    });

    return pages.length > 0 ? pages : [{ pageNumber: 1, text: '' }];
}

async function extractDocxText(filePath: string): Promise<string> {
    if (process.platform !== 'win32') {
        throw new Error('DOCX ingestion is currently supported on Windows only (uses Expand-Archive).');
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-scout-docx-'));
    const outDir = path.join(tmpDir, 'unzipped');
    await fs.mkdir(outDir, { recursive: true });

    const psQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;
    try {
        await execFileAsync(
            'powershell',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Expand-Archive -LiteralPath ${psQuote(filePath)} -DestinationPath ${psQuote(outDir)} -Force`
            ],
            { windowsHide: true }
        );

        const docXmlPath = path.join(outDir, 'word', 'document.xml');
        const xml = await fs.readFile(docXmlPath, 'utf-8');

        const paragraphs = xml.split(/<\/w:p>/i);
        const out: string[] = [];
        for (const p of paragraphs) {
            const runs = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)].map(m => decodeXmlEntities(m[1] || ''));
            const line = runs.join('').replace(/\s+/g, ' ').trim();
            if (line) out.push(line);
        }
        return out.join('\n\n').trim();
    } finally {
        try {
            await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {
        }
    }
}

async function extractTextByType(filePath: string, sourceType: string): Promise<{ pages?: ExtractedPage[]; text?: string; pageCount?: number }> {
    if (sourceType === 'pdf') {
        const pages = await extractPdfPages(filePath);
        return { pages, pageCount: pages.length };
    }
    if (sourceType === 'docx') {
        const text = await extractDocxText(filePath);
        return { text };
    }
    if (sourceType === 'html' || sourceType === 'htm') {
        const raw = await fs.readFile(filePath, 'utf-8');
        return { text: htmlToPlainText(raw) };
    }
    const text = await fs.readFile(filePath, 'utf-8');
    return { text };
}

function guessSourceType(filePath: string) {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    if (ext === 'html' || ext === 'htm') return 'html';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    return 'text';
}

export async function ingestDocument(filePath: string, opts?: { title?: string; url?: string; sourceType?: string }) {
    const abs = path.resolve(filePath);
    const sourceType = (opts?.sourceType || guessSourceType(abs)).toLowerCase();
    const title = opts?.title || path.basename(abs);
    const url = opts?.url || null;
    const sha = await sha256File(abs);

    const db = await openMemoryDb();
    try {
        const existing = await db.get(`SELECT sha256 FROM documents WHERE source_id = ?`, abs);
        if (existing?.sha256 && String(existing.sha256) === sha) {
            return { ok: true, skipped: true, chunks: 0, sourceType, sourceId: abs, title };
        }

        await db.run(`DELETE FROM memory_chunks WHERE file_path = ?`, abs);

        const extracted = await extractTextByType(abs, sourceType);
        let chunkIndex = 0;
        let inserted = 0;

        if (extracted.pages) {
            for (const p of extracted.pages) {
                const pageChunks = chunkText(p.text || '');
                for (const chunk of pageChunks) {
                    const embedding = await getEmbedding(chunk);
                    await db.run(
                        `INSERT INTO memory_chunks (file_path, chunk_index, text_content, embedding, source_type, page_number, source_title, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [abs, chunkIndex, chunk, JSON.stringify(embedding), sourceType, p.pageNumber, title, url]
                    );
                    chunkIndex += 1;
                    inserted += 1;
                }
            }
        } else {
            const chunks = chunkText(extracted.text || '');
            for (const chunk of chunks) {
                const embedding = await getEmbedding(chunk);
                await db.run(
                    `INSERT INTO memory_chunks (file_path, chunk_index, text_content, embedding, source_type, page_number, source_title, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [abs, chunkIndex, chunk, JSON.stringify(embedding), sourceType, null, title, url]
                );
                chunkIndex += 1;
                inserted += 1;
            }
        }

        await db.run(
            `INSERT INTO documents (source_id, source_type, title, url, file_path, sha256, page_count, last_indexed)
             VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(source_id) DO UPDATE SET
               source_type=excluded.source_type,
               title=excluded.title,
               url=excluded.url,
               file_path=excluded.file_path,
               sha256=excluded.sha256,
               page_count=excluded.page_count,
               last_indexed=CURRENT_TIMESTAMP`,
            [abs, sourceType, title, url, abs, sha, extracted.pageCount ?? null]
        );

        return { ok: true, skipped: false, chunks: inserted, sourceType, sourceId: abs, title };
    } finally {
        await db.close();
    }
}

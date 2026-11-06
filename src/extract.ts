import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const SUPPORTED = [".pdf", ".docx", ".txt", ".md"];

export interface Extracted {
  pages: string[]; // one string per PDF page; Word/text files are a single "page"
  likelyScanned: boolean; // PDF with almost no text layer: needs OCR (not done here)
}

export async function extractDoc(path: string): Promise<Extracted> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const avg = pages.reduce((s, p) => s + p.trim().length, 0) / Math.max(1, pages.length);
    return { pages, likelyScanned: avg < 40 };
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ path });
    return { pages: [value], likelyScanned: false };
  }
  if (ext === ".txt" || ext === ".md") return { pages: [await readFile(path, "utf8")], likelyScanned: false };
  throw new Error(`Unsupported file type: ${ext}`);
}

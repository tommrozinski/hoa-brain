export interface Chunk {
  text: string; // includes a "[Article VI, Section 3]" prefix when a structure heading is known
  page: number; // 1-based page (Word/text files are page 1)
  index: number;
  section: string; // "Article VI, Section 3" or ""
}

interface Marker {
  offset: number;
  article?: string;
  section?: string;
}

const ARTICLE_RE = /^[ \t]*(?:ARTICLE|Article)\s+([IVXLC]+|\d+)\b/gm;
const SECTION_RE = /^[ \t]*(?:SECTION|Section|Sec\.)\s+(\d+(?:\.\d+)*)\b/gm;

/** Find Article / Section headings so every chunk can say where it came from (bylaws, CC&Rs, rules). */
function findMarkers(full: string): Marker[] {
  const m: Marker[] = [];
  for (const x of full.matchAll(ARTICLE_RE)) m.push({ offset: x.index!, article: `Article ${x[1].toUpperCase()}` });
  for (const x of full.matchAll(SECTION_RE)) m.push({ offset: x.index!, section: `Section ${x[1]}` });
  return m.sort((a, b) => a.offset - b.offset);
}

function labelAt(markers: Marker[], offset: number): string {
  let article = "",
    section = "";
  for (const k of markers) {
    if (k.offset > offset) break;
    if (k.article) {
      article = k.article;
      section = ""; // a new Article resets the Section
    }
    if (k.section) section = k.section;
  }
  return [article, section].filter(Boolean).join(", ");
}

/**
 * Sliding-window chunker (~500 tokens, ~50 overlap at 4 chars/token) that
 *  - snaps window ends to paragraph/sentence boundaries,
 *  - records the starting page,
 *  - tags each chunk with its Article/Section so citations read "Article VI, Section 3".
 */
export function chunkPages(pages: string[], size = 2000, overlap = 200): Chunk[] {
  const clean = pages.map((p) => p.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
  const starts: number[] = [];
  let full = "";
  clean.forEach((p) => {
    starts.push(full.length);
    full += p + "\n\n";
  });
  const markers = findMarkers(full);
  const pageAt = (offset: number) => {
    let page = 1;
    for (let i = 0; i < starts.length; i++) if (starts[i] <= offset) page = i + 1;
    return page;
  };

  const out: Chunk[] = [];
  let start = 0;
  while (start < full.length) {
    let end = Math.min(full.length, start + size);
    let atHeading = false;
    if (end < full.length) {
      // Prefer to end the chunk just before a new Article/Section heading (once we have a reasonable amount of text),
      // so each chunk is about one section and its citation is accurate.
      const heading = markers.find((k) => k.offset > start + size * 0.4 && k.offset < end);
      if (heading) {
        end = heading.offset;
        atHeading = true;
      } else {
        const slice = full.slice(start, end);
        const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
        if (cut > size * 0.6) end = start + cut + 1;
      }
    }
    const body = full.slice(start, end).trim();
    if (body.length >= 80) {
      const lead = start + Math.max(0, full.slice(start).search(/\S/));
      // Look a little ahead so "ARTICLE VI / Assessments / Section 3." at the top of a chunk labels that chunk.
      const section = labelAt(markers, lead + 150);
      out.push({ text: section ? `[${section}]\n${body}` : body, page: pageAt(lead), index: out.length, section });
    }
    if (end >= full.length) break;
    start = atHeading ? end : Math.max(end - overlap, start + 1);
  }
  return out;
}

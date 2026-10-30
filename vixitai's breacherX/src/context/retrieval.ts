/**
 * Lexical retriever (Phase 2 — hybrid retrieval, the lexical half).
 *
 * A dependency-free BM25-style ranker over code chunks. The blueprint calls for
 * hybrid lexical + vector retrieval over pgvector; this is the lexical component
 * and a working stand-in for the vector half, behind a `Retriever` interface a
 * pgvector-backed implementation can satisfy. Used to pull related code (callers,
 * helpers, similar patterns) into the AI discovery prompt.
 */

export interface Chunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number;
}

export interface Retriever {
  retrieve(query: string, k: number): ScoredChunk[];
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "if", "else", "for", "while", "return", "const",
  "let", "var", "function", "class", "def", "import", "from", "this", "self",
  "new", "null", "true", "false", "in", "of", "is", "to", "as",
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z_][a-z0-9_]{1,}/g) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Split a file's content into overlapping line windows. */
export function chunkFile(filePath: string, content: string, windowLines = 40, overlap = 10): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  if (lines.length === 0) return chunks;
  const step = Math.max(1, windowLines - overlap);
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end).join("\n");
    if (slice.trim()) {
      chunks.push({
        id: `${filePath}:${start + 1}-${end}`,
        filePath,
        startLine: start + 1,
        endLine: end,
        content: slice,
      });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

export class BM25Retriever implements Retriever {
  private readonly chunks: Chunk[];
  private readonly docTokens: string[][];
  private readonly df = new Map<string, number>();
  private readonly avgLen: number;
  private readonly k1 = 1.5;
  private readonly b = 0.75;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.docTokens = chunks.map((c) => tokenize(c.content));
    for (const tokens of this.docTokens) {
      for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    const totalLen = this.docTokens.reduce((s, d) => s + d.length, 0);
    this.avgLen = this.docTokens.length ? totalLen / this.docTokens.length : 0;
  }

  private idf(term: string): number {
    const n = this.chunks.length;
    const df = this.df.get(term) ?? 0;
    // BM25 idf with +1 smoothing to stay non-negative.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  retrieve(query: string, k: number): ScoredChunk[] {
    const qTerms = tokenize(query);
    const qSet = new Set(qTerms);
    const scored: ScoredChunk[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const tokens = this.docTokens[i] ?? [];
      if (tokens.length === 0) continue;
      const tf = new Map<string, number>();
      for (const t of tokens) if (qSet.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
      if (tf.size === 0) continue;
      let score = 0;
      const dl = tokens.length;
      for (const [term, freq] of tf) {
        const idf = this.idf(term);
        const denom = freq + this.k1 * (1 - this.b + (this.b * dl) / (this.avgLen || 1));
        score += idf * ((freq * (this.k1 + 1)) / (denom || 1));
      }
      scored.push({ chunk: this.chunks[i]!, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }
}

/** Build a retriever from a map of filePath -> content. */
export function buildRetriever(
  files: Iterable<{ filePath: string; content: string }>,
): BM25Retriever {
  const chunks: Chunk[] = [];
  for (const f of files) chunks.push(...chunkFile(f.filePath, f.content));
  return new BM25Retriever(chunks);
}

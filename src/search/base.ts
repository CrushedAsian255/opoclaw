export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source: string;
}

export interface SearchProvider {
    name: string;
    search(query: string, maxResults?: number, timeoutMs?: number): Promise<SearchResult[]>;
}

export function dedupeResults(results: SearchResult[]): SearchResult[] {
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of results) {
        const key = r.url.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
}

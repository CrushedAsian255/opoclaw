from __future__ import annotations

import html
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import List

try:
    from .base import SearchProvider, SearchResult
except ImportError:
    from base import SearchProvider, SearchResult


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: List[SearchResult] = []
        self._capture_title = False
        self._capture_snippet = False
        self._current_link = ""
        self._title_parts: List[str] = []
        self._snippet_parts: List[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        if tag == "a" and attrs_dict.get("class") == "result__a":
            self._capture_title = True
            self._current_link = attrs_dict.get("href", "") or ""
            self._title_parts = []
            self._snippet_parts = []
        elif tag == "a" and "result__snippet" in (attrs_dict.get("class") or ""):
            self._capture_snippet = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._capture_title:
            self._capture_title = False
            title = html.unescape("".join(self._title_parts)).strip()
            snippet = html.unescape("".join(self._snippet_parts)).strip()
            if self._current_link:
                self.results.append(
                    SearchResult(
                        title=title,
                        url=self._current_link,
                        snippet=re.sub(r"\\s+", " ", snippet).strip(),
                        source="duckduckgo",
                    )
                )
        if tag == "a" and self._capture_snippet:
            self._capture_snippet = False

    def handle_data(self, data: str) -> None:
        if self._capture_title:
            self._title_parts.append(data)
        elif self._capture_snippet:
            self._snippet_parts.append(data)


class DuckDuckGoSearch(SearchProvider):
    name = "duckduckgo"

    def search(
        self,
        query: str,
        max_results: int = 10,
        timeout: float = 10.0,
    ) -> List[SearchResult]:
        params = {"q": query}
        url = "https://duckduckgo.com/html/?" + urllib.parse.urlencode(params)
        request = urllib.request.Request(url, headers={"User-Agent": "aggregate/1.0"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            html_text = response.read().decode("utf-8", errors="ignore")

        parser = _DuckDuckGoParser()
        parser.feed(html_text)
        results = parser.results
        return results[: max(1, int(max_results))]


if __name__ == "__main__":
    import json
    import sys

    query = sys.argv[1] if len(sys.argv) > 1 else ""
    max_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    if not query:
        print("[]")
        sys.exit(0)

    provider = DuckDuckGoSearch()
    results = provider.search(query, max_results=max_results)
    payload = [
        {"title": r.title, "url": r.url, "snippet": r.snippet, "source": r.source}
        for r in results
    ]
    print(json.dumps(payload, ensure_ascii=False))

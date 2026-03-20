from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, List


@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    source: str


class SearchProvider:
    name = "provider"

    def search(
        self,
        query: str,
        max_results: int = 10,
        timeout: float = 10.0,
    ) -> List[SearchResult]:
        raise NotImplementedError


def dedupe_results(results: Iterable[SearchResult]) -> List[SearchResult]:
    seen = set()
    deduped: List[SearchResult] = []
    for result in results:
        key = result.url.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(result)
    return deduped

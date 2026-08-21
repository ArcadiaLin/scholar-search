"""Provider-call accounting.

Counts what the service has spent so ``GET /budget`` can answer with a number
rather than an estimate.

The scope is the **process**, not an episode. Per-episode accounting needs the
episode-scoped Evidence Store, which does not exist yet
(``docs/07-widi-mapping.md`` §3.2), and reporting a process counter as if it were
an episode's spend would make a long-running service look like a single expensive
search. ``scope`` is part of the response for exactly that reason.
"""

from __future__ import annotations

from threading import Lock


class CallLedger:
    """A counter of issued provider calls, keyed by the endpoint that issued them."""

    scope = "process"

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._lock = Lock()

    def record(self, endpoint: str, count: int = 1) -> None:
        with self._lock:
            self._counts[endpoint] = self._counts.get(endpoint, 0) + count

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return dict(self._counts)

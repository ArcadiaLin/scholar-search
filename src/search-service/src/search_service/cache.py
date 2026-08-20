"""In-memory TTL cache for search responses."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class _CacheEntry(Generic[T]):
    def __init__(self, value: T, expires_at: float) -> None:
        self.value = value
        self.expires_at = expires_at


class TTLCache(Generic[T]):
    """Async-safe in-memory cache with TTL expiration."""

    def __init__(self, ttl_seconds: float) -> None:
        self.ttl_seconds = ttl_seconds
        self._store: dict[str, _CacheEntry[T]] = {}
        self._lock = asyncio.Lock()

    def _stable_key(self, obj: Any) -> str:
        """Return a stable hash key for any JSON-serializable object."""
        payload = json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    async def get(self, key_obj: Any) -> T | None:
        key = self._stable_key(key_obj)
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if time.monotonic() > entry.expires_at:
                del self._store[key]
                return None
            return entry.value

    async def set(self, key_obj: Any, value: T) -> None:
        key = self._stable_key(key_obj)
        expires_at = time.monotonic() + self.ttl_seconds
        async with self._lock:
            self._store[key] = _CacheEntry(value, expires_at)

    async def clear(self) -> None:
        async with self._lock:
            self._store.clear()

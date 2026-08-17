"""JSON stdin/stdout CLI for the local retriever.

Example:
    uv run python -m src.retriever.cli rank < request.json > response.json
"""

from __future__ import annotations

import sys
from pathlib import Path

from pydantic import ValidationError

from src.retriever.ranker import rank
from src.retriever.schema import RankRequest


def _read_stdin() -> str:
    if sys.stdin.isatty():
        return ""
    return sys.stdin.read()


def cmd_rank() -> int:
    """Read a RankRequest from stdin and write a RankResponse to stdout."""
    raw = _read_stdin()
    if not raw.strip():
        print("Error: no JSON input provided on stdin.", file=sys.stderr)
        return 2

    try:
        request = RankRequest.model_validate_json(raw)
    except ValidationError as exc:
        print(f"Error: invalid request: {exc}", file=sys.stderr)
        return 2

    try:
        response = rank(request)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 3
    except TimeoutError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 5
    except Exception as exc:  # pragma: no cover - safety net
        print(f"Error: unexpected failure: {exc}", file=sys.stderr)
        return 1

    print(response.model_dump_json())
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(f"Usage: {Path(sys.argv[0]).name} rank < request.json > response.json", file=sys.stderr)
        return 0

    if argv[0] == "rank":
        return cmd_rank()

    print(f"Error: unknown command {argv[0]!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Download a Hugging Face repository snapshot at a resolved immutable revision."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from huggingface_hub import HfApi, snapshot_download
from huggingface_hub.errors import HfHubHTTPError


def positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Download selected files from Hugging Face. The requested revision is first resolved "
            "to a commit SHA, and that immutable SHA is used for the download."
        )
    )
    parser.add_argument("repo_id", help="Hugging Face repository ID, for example allenai/asta-bench")
    parser.add_argument(
        "--repo-type",
        choices=("dataset", "model", "space"),
        default="dataset",
        help="repository type (default: dataset)",
    )
    parser.add_argument("--revision", required=True, help="commit SHA, tag, or branch to resolve before downloading")
    parser.add_argument("--local-dir", required=True, type=Path, help="destination directory")
    parser.add_argument(
        "--include",
        action="append",
        dest="allow_patterns",
        metavar="GLOB",
        help="file glob to include; repeat for multiple patterns",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        dest="ignore_patterns",
        metavar="GLOB",
        help="file glob to exclude; repeat for multiple patterns",
    )
    parser.add_argument("--max-workers", type=positive_int, default=8, help="parallel download workers (default: 8)")
    parser.add_argument("--force-download", action="store_true", help="download files even when cached")
    parser.add_argument("--dry-run", action="store_true", help="resolve and list files without downloading")
    parser.add_argument(
        "--anonymous",
        action="store_true",
        help="disable implicit credentials; useful for verifying public access",
    )
    parser.add_argument("--receipt", type=Path, help="optionally write the JSON result to this path")
    return parser


def write_json(payload: dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    token: bool | None = False if args.anonymous else None
    local_dir = args.local_dir.expanduser().resolve()

    try:
        info = HfApi(token=token).repo_info(
            repo_id=args.repo_id,
            repo_type=args.repo_type,
            revision=args.revision,
        )
        if not info.sha:
            raise RuntimeError(f"Hugging Face did not return a commit SHA for {args.repo_id!r}")

        result = snapshot_download(
            repo_id=args.repo_id,
            repo_type=args.repo_type,
            revision=info.sha,
            local_dir=local_dir,
            allow_patterns=args.allow_patterns,
            ignore_patterns=args.ignore_patterns,
            max_workers=args.max_workers,
            force_download=args.force_download,
            token=token,
            dry_run=args.dry_run,
        )
    except (HfHubHTTPError, OSError, RuntimeError, ValueError) as error:
        print(f"Hugging Face download failed: {error}", file=sys.stderr)
        return 1

    payload: dict[str, Any] = {
        "repo_id": args.repo_id,
        "repo_type": args.repo_type,
        "requested_revision": args.revision,
        "resolved_revision": info.sha,
        "local_dir": str(local_dir),
        "allow_patterns": args.allow_patterns or [],
        "ignore_patterns": args.ignore_patterns or [],
        "checked_at": datetime.now(UTC).isoformat(),
        "dry_run": args.dry_run,
    }

    if args.dry_run:
        if not isinstance(result, list):
            print("Hugging Face download failed: dry-run returned an unexpected result", file=sys.stderr)
            return 1
        payload.update(
            {
                "files": [
                    {
                        "path": file.filename,
                        "size": file.file_size,
                        "is_cached": file.is_cached,
                        "will_download": file.will_download,
                    }
                    for file in result
                ],
                "file_count": len(result),
                "download_bytes": sum(file.file_size for file in result if file.will_download),
            }
        )
    else:
        if not isinstance(result, str):
            print("Hugging Face download failed: download returned an unexpected result", file=sys.stderr)
            return 1
        payload["snapshot_path"] = result

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if args.receipt:
        write_json(payload, args.receipt.expanduser().resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

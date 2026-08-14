#!/usr/bin/env python3
"""Download benchmark snapshots declared in benchmarks/sources.yaml."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "benchmarks" / "sources.yaml"
HF_DOWNLOADER = ROOT / "scripts" / "download-hf.py"
SOURCE_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SUPPORTED_METHODS = {"huggingface_snapshot", "manual", "unavailable"}


class ManifestError(ValueError):
    """Raised when the benchmark source manifest violates its contract."""


def require_mapping(value: Any, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{field} must be a mapping")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ManifestError(f"{field} must be a non-empty string")
    return value


def require_relative_path(value: Any, field: str) -> str:
    raw_path = require_string(value, field)
    path = Path(raw_path)
    if path.is_absolute() or ".." in path.parts:
        raise ManifestError(f"{field} must be a repository-relative path without '..'")
    return raw_path


def validate_patterns(value: Any, field: str) -> None:
    if not isinstance(value, list) or not all(isinstance(item, str) and item for item in value):
        raise ManifestError(f"{field} must be a list of non-empty strings")


def validate_huggingface_source(source: dict[str, Any], source_config: dict[str, Any], index: int) -> None:
    prefix = f"sources[{index}]"
    require_string(source_config.get("repo_id"), f"{prefix}.source.repo_id")
    repo_type = require_string(source_config.get("repo_type"), f"{prefix}.source.repo_type")
    if repo_type not in {"dataset", "model", "space"}:
        raise ManifestError(f"{prefix}.source.repo_type must be dataset, model, or space")
    revision = require_string(source_config.get("revision"), f"{prefix}.source.revision")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ManifestError(f"{prefix}.source.revision must be an immutable 40-character commit SHA")
    require_relative_path(source.get("local_dir"), f"{prefix}.local_dir")

    default_profile = require_string(source.get("default_profile"), f"{prefix}.default_profile")
    profiles = require_mapping(source.get("profiles"), f"{prefix}.profiles")
    if default_profile not in profiles:
        raise ManifestError(f"{prefix}.default_profile does not exist in profiles")

    for profile_name, raw_profile in profiles.items():
        require_string(profile_name, f"{prefix}.profiles key")
        profile = require_mapping(raw_profile, f"{prefix}.profiles.{profile_name}")
        validate_patterns(profile.get("include", []), f"{prefix}.profiles.{profile_name}.include")
        validate_patterns(profile.get("exclude", []), f"{prefix}.profiles.{profile_name}.exclude")

    receipt = source.get("receipt")
    if receipt is not None:
        require_relative_path(receipt, f"{prefix}.receipt")


def load_manifest(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        raw_manifest = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ManifestError(f"manifest does not exist: {path}") from error
    except yaml.YAMLError as error:
        raise ManifestError(f"invalid YAML in {path}: {error}") from error

    manifest = require_mapping(raw_manifest, "manifest")
    if manifest.get("schema_version") != 1:
        raise ManifestError("schema_version must be 1")

    raw_sources = manifest.get("sources")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ManifestError("sources must be a non-empty list")

    sources: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, raw_source in enumerate(raw_sources):
        source = require_mapping(raw_source, f"sources[{index}]")
        source_id = require_string(source.get("id"), f"sources[{index}].id")
        if not SOURCE_ID_PATTERN.fullmatch(source_id):
            raise ManifestError(f"sources[{index}].id must contain only lowercase letters, digits, and hyphens")
        if source_id in seen_ids:
            raise ManifestError(f"duplicate source id: {source_id}")
        seen_ids.add(source_id)

        source_config = require_mapping(source.get("source"), f"sources[{index}].source")
        method = require_string(source_config.get("method"), f"sources[{index}].source.method")
        if method not in SUPPORTED_METHODS:
            raise ManifestError(f"unsupported acquisition method for {source_id}: {method}")
        if method == "huggingface_snapshot":
            validate_huggingface_source(source, source_config, index)
        elif method == "manual":
            require_relative_path(source.get("local_dir"), f"sources[{index}].local_dir")
            require_string(source_config.get("url"), f"sources[{index}].source.url")
        else:
            require_string(source_config.get("reason"), f"sources[{index}].source.reason")

        sources.append(source)

    return manifest, sources


def print_sources(sources: list[dict[str, Any]]) -> None:
    headings = ("ID", "PRIORITY", "ACCESS", "DEFAULT PROFILE", "LOCAL DIRECTORY")
    rows: list[tuple[str, str, str, str, str]] = []
    for source in sources:
        method = source["source"]["method"]
        access = source.get("access", {}).get("level", method)
        rows.append(
            (
                source["id"],
                source.get("priority", "-"),
                access,
                source.get("default_profile", "-"),
                source.get("local_dir", "-"),
            )
        )

    widths = [max(len(str(row[column])) for row in [headings, *rows]) for column in range(len(headings))]
    print("  ".join(heading.ljust(width) for heading, width in zip(headings, widths, strict=True)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(str(value).ljust(width) for value, width in zip(row, widths, strict=True)))


def select_sources(sources: list[dict[str, Any]], requested_ids: list[str], download_all: bool) -> list[dict[str, Any]]:
    if download_all and requested_ids:
        raise ManifestError("pass either dataset IDs or --all, not both")
    if not download_all and not requested_ids:
        raise ManifestError("pass at least one dataset ID or --all")
    if download_all:
        return sources

    sources_by_id = {source["id"]: source for source in sources}
    unknown_ids = [source_id for source_id in requested_ids if source_id not in sources_by_id]
    if unknown_ids:
        raise ManifestError(f"unknown benchmark source IDs: {', '.join(unknown_ids)}")
    return [sources_by_id[source_id] for source_id in requested_ids]


def print_non_downloadable(source: dict[str, Any]) -> None:
    source_id = source["id"]
    source_config = source["source"]
    if source_config["method"] == "manual":
        print(f"[manual] {source_id}: {source_config['url']}", file=sys.stderr)
        for instruction in source.get("access", {}).get("instructions", []):
            print(f"  - {instruction}", file=sys.stderr)
    else:
        print(f"[unavailable] {source_id}: {source_config['reason']}", file=sys.stderr)


def build_download_command(source: dict[str, Any], profile_name: str, args: argparse.Namespace) -> list[str]:
    source_config = source["source"]
    profiles = source["profiles"]
    if profile_name not in profiles:
        available = ", ".join(profiles)
        raise ManifestError(f"{source['id']} has no profile {profile_name!r}; available profiles: {available}")
    profile = profiles[profile_name]

    command = [
        sys.executable,
        str(HF_DOWNLOADER),
        source_config["repo_id"],
        "--repo-type",
        source_config["repo_type"],
        "--revision",
        source_config["revision"],
        "--local-dir",
        source["local_dir"],
        "--max-workers",
        str(args.max_workers),
    ]
    for pattern in profile.get("include", []):
        command.extend(("--include", pattern))
    for pattern in profile.get("exclude", []):
        command.extend(("--exclude", pattern))
    if args.dry_run:
        command.append("--dry-run")
    if args.force_download:
        command.append("--force-download")

    receipt = source.get("receipt")
    if receipt:
        command.extend(("--receipt", receipt.format(profile=profile_name)))
    return command


def download_sources(selected: list[dict[str, Any]], args: argparse.Namespace) -> int:
    huggingface_sources = [source for source in selected if source["source"]["method"] == "huggingface_snapshot"]
    if huggingface_sources and not os.environ.get("HF_TOKEN", "").strip():
        print(
            "HF_TOKEN is required. Accept the gated dataset terms, then provide a valid read token "
            "through the environment or uv --env-file.",
            file=sys.stderr,
        )
        return 2

    failures: list[str] = []
    explicit_selection = not args.download_all
    for source in selected:
        method = source["source"]["method"]
        if method != "huggingface_snapshot":
            print_non_downloadable(source)
            if explicit_selection:
                failures.append(source["id"])
            continue

        profile_name = args.profile or source["default_profile"]
        try:
            command = build_download_command(source, profile_name, args)
        except ManifestError as error:
            print(f"Benchmark download failed: {error}", file=sys.stderr)
            failures.append(source["id"])
            continue

        print(f"==> {source['id']} [{profile_name}]", file=sys.stderr)
        result = subprocess.run(command, cwd=ROOT, check=False)
        if result.returncode != 0:
            failures.append(source["id"])

    if failures:
        print(f"Benchmark download incomplete: {', '.join(failures)}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate, inspect, or download benchmark sources from benchmarks/sources.yaml."
    )
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST, help="alternate source manifest")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("check", help="validate the manifest without network access")
    subparsers.add_parser("list", help="list benchmark sources, access levels, and default profiles")

    download_parser = subparsers.add_parser("download", help="download one or more immutable HF snapshots")
    download_parser.add_argument("dataset_ids", nargs="*", metavar="DATASET")
    download_parser.add_argument("--all", action="store_true", dest="download_all", help="process every source")
    download_parser.add_argument(
        "--profile",
        help="profile to use for every selected HF source; defaults to each source's default_profile",
    )
    download_parser.add_argument("--dry-run", action="store_true", help="resolve and list files without downloading")
    download_parser.add_argument("--force-download", action="store_true", help="redownload files already cached")
    download_parser.add_argument(
        "--max-workers", type=int, default=8, help="parallel workers per snapshot (default: 8)"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        _, sources = load_manifest(args.manifest.expanduser().resolve())
        if args.command == "check":
            if not HF_DOWNLOADER.is_file():
                raise ManifestError(f"Hugging Face downloader does not exist: {HF_DOWNLOADER}")
            print(f"Validated {len(sources)} benchmark sources in {args.manifest}")
            return 0
        if args.command == "list":
            print_sources(sources)
            return 0
        if args.max_workers < 1:
            raise ManifestError("--max-workers must be at least 1")
        selected = select_sources(sources, args.dataset_ids, args.download_all)
        return download_sources(selected, args)
    except (ManifestError, OSError) as error:
        print(f"Benchmark manifest error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

from types import SimpleNamespace

import pytest
import yaml

from benchmarks import download


def download_args(**overrides: object) -> SimpleNamespace:
    values: dict[str, object] = {
        "download_all": False,
        "profile": None,
        "dry_run": True,
        "force_download": False,
        "max_workers": 8,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_manifest_uses_immutable_hugging_face_revisions() -> None:
    _, sources = download.load_manifest(download.DEFAULT_MANIFEST)

    hugging_face_sources = [source for source in sources if source["source"]["method"] == "huggingface_snapshot"]
    assert hugging_face_sources
    assert all(len(source["source"]["revision"]) == 40 for source in hugging_face_sources)
    assert all(source["default_profile"] in source["profiles"] for source in hugging_face_sources)
    assert all("full" in source["profiles"] for source in hugging_face_sources)


def test_manifest_rejects_a_mutable_hugging_face_revision(tmp_path) -> None:
    manifest_path = tmp_path / "sources.yaml"
    manifest_path.write_text(
        yaml.safe_dump(
            {
                "schema_version": 1,
                "sources": [
                    {
                        "id": "mutable-source",
                        "local_dir": "references/datasets/mutable-source",
                        "source": {
                            "method": "huggingface_snapshot",
                            "repo_id": "example/dataset",
                            "repo_type": "dataset",
                            "revision": "main",
                        },
                        "default_profile": "benchmark",
                        "profiles": {"benchmark": {"include": [], "exclude": []}},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(download.ManifestError, match="immutable 40-character commit SHA"):
        download.load_manifest(manifest_path)


def test_profile_limits_files_and_names_its_receipt() -> None:
    _, sources = download.load_manifest(download.DEFAULT_MANIFEST)
    litsearch = next(source for source in sources if source["id"] == "litsearch")

    command = download.build_download_command(litsearch, "benchmark", download_args())

    assert command.count("--include") == 2
    assert "query/*" in command
    assert "corpus_clean/*" in command
    assert "corpus_s2orc/*" not in command
    assert command[command.index("--receipt") + 1] == "references/datasets/.receipts/litsearch-benchmark.json"
    assert "--dry-run" in command


def test_one_click_download_skips_manual_sources_and_runs_every_hf_source(monkeypatch, capsys) -> None:
    _, sources = download.load_manifest(download.DEFAULT_MANIFEST)
    commands: list[list[str]] = []

    def fake_run(command: list[str], *, cwd, check: bool) -> SimpleNamespace:
        assert cwd == download.ROOT
        assert check is False
        commands.append(command)
        return SimpleNamespace(returncode=0)

    monkeypatch.setenv("HF_TOKEN", "test-read-token")
    monkeypatch.setattr(download.subprocess, "run", fake_run)

    result = download.download_sources(sources, download_args(download_all=True))

    expected_repo_ids = {
        source["source"]["repo_id"] for source in sources if source["source"]["method"] == "huggingface_snapshot"
    }
    called_repo_ids = {command[2] for command in commands}
    assert result == 0
    assert called_repo_ids == expected_repo_ids
    assert "[manual] competition-public" in capsys.readouterr().err


def test_download_fails_before_network_access_without_hf_token(monkeypatch, capsys) -> None:
    _, sources = download.load_manifest(download.DEFAULT_MANIFEST)
    litsearch = next(source for source in sources if source["id"] == "litsearch")
    monkeypatch.delenv("HF_TOKEN", raising=False)

    def unexpected_run(*args, **kwargs):
        pytest.fail("network downloader must not run without HF_TOKEN")

    monkeypatch.setattr(download.subprocess, "run", unexpected_run)

    assert download.download_sources([litsearch], download_args()) == 2
    assert "HF_TOKEN is required" in capsys.readouterr().err

"""Shared provenance helpers for function-definition validation reports."""

from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).expanduser().resolve().open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def provenance_lines(docx: str | Path, **extra: str | Path) -> list[str]:
    lines = [
        f"**文档**: {Path(docx).expanduser().resolve()}",
        f"**文档 SHA256**: {sha256_file(docx)}",
    ]
    for label, value in extra.items():
        lines.append(f"**{label}**: {Path(value).expanduser().resolve()}")
        if label.endswith("SHA256"):
            continue
        lines.append(f"**{label} SHA256**: {sha256_file(value)}")
    return lines

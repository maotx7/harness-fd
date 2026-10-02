#!/usr/bin/env python3
"""Bootstrap the shared Python environment for document-generation skills."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def project_root() -> Path:
    """Find the checkout containing the pinned skill requirements."""
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "requirements.txt").is_file() and (candidate / "skills").is_dir():
            return candidate
    raise RuntimeError("could not find project requirements.txt")


def main() -> None:
    root = project_root()
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv is required; install it from https://docs.astral.sh/uv/")
    print(f"[setup] shared runtime: {root}")
    environment = root / ".venv"
    subprocess.check_call([uv, "venv", "--allow-existing", str(environment)], cwd=root)
    subprocess.check_call(
        [uv, "pip", "install", "--python", str(environment / "bin" / "python"), "-r", "requirements.txt"],
        cwd=root,
    )
    print("[setup] environment ready; run scripts with:")
    print(f"  {environment / 'bin' / 'python'} skills/func-def-gen/scripts/<script>.py ...")


if __name__ == "__main__":
    main()

"""Use Ubuntu's official archive, including GitHub runner mirror+file sources.

This is only called with sudo on the disposable CI runner. It preserves apt's
Signed-By configuration and does not change package verification or test scope.
"""

import argparse
from pathlib import Path
import re


AZURE = re.compile(r"https?://azure\.archive\.ubuntu\.com/ubuntu(?=[/\s]|$)")


def prepare(root: Path) -> list[Path]:
    candidates = [root / "sources.list"]
    for pattern in ("*.list", "*.sources"):
        candidates.extend(sorted((root / "sources.list.d").glob(pattern)))
    # GitHub's mirror+file sources resolve these lists at download time.
    # Editing only sources.list or ubuntu.sources does not change that selection.
    candidates.extend(sorted(root.glob("apt-mirrors*.txt")))
    sources = [path for path in candidates if path.is_file()]
    if not sources:
        raise RuntimeError("No apt source files found")
    changed = []
    for path in sources:
        original = path.read_text(encoding="utf-8")
        updated = AZURE.sub("https://archive.ubuntu.com/ubuntu", original)
        if "azure.archive.ubuntu.com" in updated:
            raise RuntimeError(f"Unrecognized Azure mirror remains in {path.name}")
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed.append(path)
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    changed = prepare(args.root)
    for path in changed:
        print(f"Updated apt source: {path}")
    print("Verified active source files and mirror lists contain no Azure archive")

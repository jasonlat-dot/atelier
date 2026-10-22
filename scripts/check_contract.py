"""Verify Rust OpenAPI and generated TypeScript without a running database."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
actual = subprocess.check_output(
    ["cargo", "run", "--quiet", "-p", "atelier-app", "--example", "export_openapi"],
    cwd=ROOT / "services/api",
)
expected = (ROOT / "docs/openapi.json").read_text(encoding="utf-8")
if json.loads(actual) != json.loads(expected):
    raise SystemExit("docs/openapi.json differs from Rust. Regenerate the contract.")
with tempfile.TemporaryDirectory() as directory:
    generated = Path(directory) / "api.d.ts"
    subprocess.run([
        "node", "node_modules/openapi-typescript/bin/cli.js", "../../docs/openapi.json", "-o", str(generated)
    ], cwd=ROOT / "apps/web", check=True)
    committed = ROOT / "apps/web/src/lib/generated/api.d.ts"
    if generated.read_text(encoding="utf-8") != committed.read_text(encoding="utf-8"):
        raise SystemExit("Generated TypeScript differs. Run npm run api:generate.")
print("OpenAPI and generated TypeScript match Rust definitions")

#!/usr/bin/env bash
# Verify that the Python maintenance tooling works with an interpreter that
# has no site-packages. `-S` disables the system site directory, including
# PyYAML, so this exercises scripts/_vendor/yaml and scripts/_yaml_compat.py.
#
# The query layer is Node.js and has its own tests under tests/js/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

python3 -S - <<'PY'
import re
import sys
from pathlib import Path

sys.path.insert(0, "scripts")
from _yaml_compat import USING_BUNDLED, yaml

assert USING_BUNDLED, "fallback test unexpectedly imported host PyYAML"

frontmatter = Path("wiki/kernels/flash-attention-4.md").read_text(encoding="utf-8")
match = re.match(r"^---\s*\n(.*?)\n---", frontmatter, re.S)
data = yaml.safe_load(match.group(1))
assert data["id"] == "kernel-flash-attention-4"
assert "tcgen05" in data["tags"]

policy = yaml.safe_load(Path("data/inclusion-policy.yaml").read_text(encoding="utf-8"))
assert isinstance(policy["cute-dsl"]["capture_criteria"], list)
assert isinstance(policy["cute-dsl"]["description"], str)

round_trip = yaml.safe_load(yaml.safe_dump({"date": data["id"], "tags": data["tags"]}))
assert round_trip["tags"] == data["tags"]

import pr_policy  # noqa: E402

assert pr_policy.architecture_matches_filter(["sm100"], "exact", "B200")
assert pr_policy.architecture_matches_filter(["blackwell"], "family", "blackwell")
PY

echo "OK: Python maintenance tooling works without host PyYAML"

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


def load_hyphenated(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


indices = load_hyphenated("generate_indices", SCRIPTS / "generate-indices.py")


def page(path, architectures, disposition=None):
    frontmatter = {
        "id": path,
        "title": path,
        "architectures": architectures,
    }
    if disposition is not None:
        frontmatter["architecture_disposition"] = disposition
    return frontmatter


class ArchitectureIndexConsistencyTests(unittest.TestCase):
    def setUp(self):
        self.pages = [
            page("exact-sm100", ["sm100"], "exact"),
            page("exact-sm100a", ["sm100a"], "exact"),
            page("exact-sm120", ["sm120"], "exact"),
            page("family", ["blackwell"], "family"),
            page("hand-authored-family", ["blackwell"]),
            page("mixed", ["sm100", "hopper"], "mixed"),
            page("hopper", ["sm90"], "exact"),
            page("unknown", [], "unknown"),
            page("non-pr-empty", []),
        ]

    def index_pages(self):
        rows = []
        for value in self.pages:
            fm = dict(value)
            fm["_path"] = value["id"]
            rows.append(fm)
        return rows

    def test_index_membership_equals_declared_metadata_sets(self):
        exact, family, unknown = indices.architecture_index_sets(self.index_pages())
        self.assertEqual({"exact-sm100", "mixed"}, {p["_path"] for p in exact["sm100"]})
        self.assertEqual(
            {"family", "hand-authored-family"},
            {p["_path"] for p in family["blackwell"]},
        )
        self.assertEqual({"unknown"}, {p["_path"] for p in unknown})
        self.assertIn("mixed", {p["_path"] for p in family["hopper"]})
        rendered = indices.generate_by_architecture(self.index_pages())
        self.assertIn("## Blackwell family-only", rendered)
        self.assertIn("no supported exact SM in that family", rendered)
        self.assertIn("## Architecture unknown", rendered)
        self.assertIn("validated source-PR unknowns", rendered)
        self.assertIn("Source-PR pages whose validated evidence review", rendered)
        self.assertIn("### `sm100`", rendered)


if __name__ == "__main__":
    unittest.main()

import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "prepare_apt_sources",
    Path(__file__).resolve().parents[1] / "scripts/ci/prepare_apt_sources.py",
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AptSourcesTest(unittest.TestCase):
    def test_runner_mirror_lists_are_rewritten_and_signed_by_is_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            directory = root / "sources.list.d"
            directory.mkdir()
            content = (
                "Types: deb\n"
                "URIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
                "Suites: noble noble-updates\n"
                "Components: main universe\n"
                "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
            )
            config = directory / "ubuntu.sources"
            config.write_text(content, encoding="utf-8")
            for name in ("apt-mirrors.txt", "apt-mirrors-security.txt"):
                (root / name).write_text(
                    "http://azure.archive.ubuntu.com/ubuntu\n"
                    "https://archive.ubuntu.com/ubuntu\n",
                    encoding="utf-8",
                )
            self.assertEqual(len(module.prepare(root)), 2)
            self.assertEqual(config.read_text(encoding="utf-8"), content)
            for path in root.glob("apt-mirrors*.txt"):
                self.assertNotIn("azure.archive", path.read_text(encoding="utf-8"))
                self.assertIn("https://archive.ubuntu.com/ubuntu", path.read_text(encoding="utf-8"))
            self.assertEqual(module.prepare(root), [])

    def test_legacy_and_other_active_source_files_are_handled(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            directory = root / "sources.list.d"
            directory.mkdir()
            for path in (root / "sources.list", directory / "runner.list"):
                path.write_text(
                    "deb https://azure.archive.ubuntu.com/ubuntu/ noble main\n",
                    encoding="utf-8",
                )
            microsoft = directory / "microsoft-prod.list"
            content = "deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n"
            microsoft.write_text(content, encoding="utf-8")
            self.assertEqual(len(module.prepare(root)), 2)
            self.assertEqual(microsoft.read_text(encoding="utf-8"), content)

    def test_unrecognized_azure_url_and_missing_configuration_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaises(RuntimeError):
                module.prepare(root)
            (root / "sources.list").write_text(
                "deb http://azure.archive.ubuntu.com/other noble main\n",
                encoding="utf-8",
            )
            with self.assertRaises(RuntimeError):
                module.prepare(root)


if __name__ == "__main__":
    unittest.main()

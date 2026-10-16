"""Exercise immutable-image/revision/platform rejection without service operations."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "worker-image-preflight.sh"
REVISION = "a" * 40
IMAGE = "ghcr.io/khanson124/regimex-worker@sha256:" + "b" * 64


class PreflightTests(unittest.TestCase):
    def run_check(self, image=IMAGE, revision=REVISION, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "git").write_text('#!/bin/sh\nprintf "%s\\n" "$CHECKOUT_REVISION"\n')
            (root / "docker").write_text('''#!/bin/sh
printf '%s\n' "$*" >> "$CALL_LOG"
[ "$1 $2" = 'image inspect' ] || exit 99
[ "$IMAGE_PRESENT" = 'true' ] || exit 1
case "$4" in
  *Labels*) printf '%s\n' "$IMAGE_REVISION" ;;
  *) printf '%s\n' "$IMAGE_PLATFORM" ;;
esac
''')
            for name in ["git", "docker"]:
                (root / name).chmod(0o755)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"],
                   "CHECKOUT_REVISION": REVISION, "IMAGE_REVISION": REVISION,
                   "IMAGE_PLATFORM": "linux/amd64", "IMAGE_PRESENT": "true",
                   "CALL_LOG": str(root / "calls"), **overrides}
            result = subprocess.run(["sh", str(SCRIPT), image, revision], env=env,
                                    capture_output=True, text=True)
            calls = (root / "calls").read_text().splitlines() if (root / "calls").exists() else []
            self.assertTrue(all(call.startswith("image inspect ") for call in calls))
            return result

    def test_accepts_matching_amd_image_without_service_actions(self):
        self.assertEqual(self.run_check().returncode, 0)

    def test_accepts_immutable_loaded_archive_image_id(self):
        self.assertEqual(self.run_check(image="sha256:" + "b" * 64).returncode, 0)

    def test_rejects_mutable_registry_tag(self):
        self.assertNotEqual(self.run_check(image="ghcr.io/khanson124/regimex-worker:latest").returncode, 0)

    def test_rejects_revision_or_platform_mismatch(self):
        for patch in [{"IMAGE_REVISION": "c" * 40}, {"CHECKOUT_REVISION": "c" * 40},
                      {"IMAGE_PLATFORM": "linux/arm64"}, {"IMAGE_PRESENT": "false"}]:
            with self.subTest(patch=patch):
                self.assertNotEqual(self.run_check(**patch).returncode, 0)

    def test_rejects_abbreviated_commit(self):
        self.assertNotEqual(self.run_check(revision="aaaaaaa").returncode, 0)


if __name__ == "__main__":
    unittest.main()

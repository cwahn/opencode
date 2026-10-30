"""Synthetic graph/diagnostic regressions; actual BuildKit export still gates CI."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("container_oci", Path(__file__).with_name("container-oci.py"))
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)


class ContainerOCI(unittest.TestCase):
    def fixture(self, root, subject=None, corrupt=False, empty_subjects=False):
        files = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}'}

        def blob(value, media):
            data = json.dumps(value).encode()
            digest = hashlib.sha256(data).hexdigest()
            files["blobs/sha256/" + digest] = data
            return {"digest": "sha256:" + digest, "size": len(data), "mediaType": media}

        config = blob({"os": "linux", "architecture": "amd64", "config": {"Entrypoint": ["opencode"]}},
                      "application/vnd.oci.image.config.v1+json")
        image = blob({"schemaVersion": 2, "config": config, "layers": []}, normalizer.MANIFEST)
        statement = blob({"subject": [] if empty_subjects else [{"digest": {"sha256": subject or image["digest"][7:]}}],
                          "predicateType": "https://slsa.dev/provenance/v0.2", "predicate": {}},
                         "application/vnd.in-toto+json")
        attestation = blob({"schemaVersion": 2, "config": blob({}, "application/vnd.oci.image.config.v1+json"),
                            "layers": [statement]}, normalizer.MANIFEST)
        attestation["annotations"] = {"vnd.docker.reference.digest": image["digest"]}
        nested = blob({"manifests": [image, attestation]}, normalizer.INDEX)
        files["index.json"] = json.dumps({"schemaVersion": 2, "manifests": [nested]}).encode()
        if corrupt:
            files["blobs/sha256/" + config["digest"][7:]] += b"corrupt"
        source = root / "source.tar"
        with tarfile.open(source, "w") as archive:
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return source, image, files

    def test_preserves_attested_production_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, image, files = self.fixture(root)
            normalizer.normalize(source, root / "production.tar", root / "evidence.json")
            with tarfile.open(root / "production.tar") as archive:
                index = json.load(archive.extractfile("index.json"))
                self.assertEqual(len(index["manifests"]), 1)
                self.assertEqual(index["manifests"][0]["digest"], image["digest"])
                name = "blobs/sha256/" + image["digest"][7:]
                self.assertEqual(archive.extractfile(name).read(), files[name])
            diagnostic = json.loads((root / "oci-subject-diagnostics.json").read_text())
            self.assertTrue(diagnostic["statements"][0]["bindingMatches"])

    def test_wrong_subject_is_rejected_with_digest_only_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, image, _ = self.fixture(root, subject="0" * 64)
            with self.assertRaisesRegex(ValueError, "subject binding mismatch"):
                normalizer.normalize(source, root / "production.tar", root / "evidence.json")
            diagnostic = json.loads((root / "oci-subject-diagnostics.json").read_text())
            self.assertEqual(diagnostic["statements"][0]["expectedImageDigest"], image["digest"])
            self.assertEqual(diagnostic["statements"][0]["actualSubjectSha256Digests"], ["sha256:" + "0" * 64])
            self.assertFalse((root / "production.tar").exists())

    def test_arbitrary_subject_text_is_not_logged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _, _ = self.fixture(root, subject="private-test-marker")
            with self.assertRaises(ValueError) as error:
                normalizer.normalize(source, root / "production.tar", root / "evidence.json")
            self.assertNotIn("private-test-marker", str(error.exception))
            self.assertNotIn("private-test-marker", (root / "oci-subject-diagnostics.json").read_text())

    def test_unnamed_export_empty_subjects_remain_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _, _ = self.fixture(root, empty_subjects=True)
            with self.assertRaisesRegex(ValueError, "subject binding mismatch"):
                normalizer.normalize(source, root / "production.tar", root / "evidence.json")
            diagnostic = json.loads((root / "oci-subject-diagnostics.json").read_text())
            self.assertEqual(diagnostic["statements"][0]["subjectCount"], 0)
            self.assertEqual(diagnostic["statements"][0]["actualSubjectSha256Digests"], [])
            self.assertFalse(diagnostic["statements"][0]["bindingMatches"])
            self.assertFalse((root / "production.tar").exists())

    def test_corrupt_blob_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, _, _ = self.fixture(root, corrupt=True)
            with self.assertRaisesRegex(AssertionError, "corrupt OCI graph"):
                normalizer.normalize(source, root / "production.tar", root / "evidence.json")


if __name__ == "__main__":
    unittest.main()

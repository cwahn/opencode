"""Verify BuildKit's full graph; export its unchanged production image graph."""

import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def normalize(source, destination, evidence):
    with tarfile.open(source) as archive:
        members = archive.getmembers()
        names = [entry.name for entry in members]
        assert len(names) == len(set(names)), "duplicate archive member"
        files = {entry.name: archive.extractfile(entry).read() for entry in members if entry.isfile()}
    assert json.loads(files["oci-layout"]) == {"imageLayoutVersion": "1.0.0"}
    images = []
    attestations = []

    def blob(descriptor):
        algorithm, digest = descriptor["digest"].split(":")
        assert algorithm == "sha256" and len(digest) == 64
        data = files[f"blobs/sha256/{digest}"]
        assert len(data) == descriptor["size"] and sha(data) == digest, "corrupt OCI graph"
        return data

    def visit(descriptor):
        value = json.loads(blob(descriptor))
        if descriptor["mediaType"] == INDEX:
            for child in value["manifests"]:
                visit(child)
            return
        assert descriptor["mediaType"] == MANIFEST
        config = json.loads(blob(value["config"]))
        for layer in value["layers"]:
            blob(layer)
        if config.get("os") == "linux" and config.get("architecture") == "amd64":
            assert config["config"]["Entrypoint"] == ["opencode"]
            images.append((descriptor, value))
        else:
            attestations.append((descriptor, value))

    index = json.loads(files["index.json"])
    for descriptor in index["manifests"]:
        visit(descriptor)
    assert len(images) == 1, "expected exactly one Linux AMD64 image"
    descriptor, manifest = images[0]
    digest = descriptor["digest"]
    statements = []
    for attestation, value in attestations:
        assert attestation.get("annotations", {}).get("vnd.docker.reference.digest") == digest
        for layer in value["layers"]:
            assert layer["mediaType"] == "application/vnd.in-toto+json"
            statement = json.loads(blob(layer))
            assert any(subject.get("digest", {}).get("sha256") == digest[7:] for subject in statement["subject"])
            statements.append(statement)
    assert any(statement.get("predicateType") in [
        "https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1",
    ] and isinstance(statement.get("predicate"), dict) for statement in statements), "BuildKit provenance absent"

    # Only index.json changes. The image manifest/config/layers remain byte-for-byte
    # identical to the attested subject, including all embedded binary bytes.
    production = {"mediaType": MANIFEST, "digest": digest, "size": descriptor["size"],
                  "platform": {"os": "linux", "architecture": "amd64"}}
    output = {"oci-layout": files["oci-layout"], "index.json": json.dumps({
        "schemaVersion": 2, "mediaType": INDEX, "manifests": [production],
    }, separators=(",", ":")).encode()}
    for item in [descriptor, manifest["config"], *manifest["layers"]]:
        output[f'blobs/sha256/{item["digest"][7:]}'] = blob(item)
    with tarfile.open(destination, "w") as archive:
        for name, data in sorted(output.items()):
            member = tarfile.TarInfo(name)
            member.size = len(data)
            member.mode = 0o644
            archive.addfile(member, io.BytesIO(data))
    Path(evidence).write_text(json.dumps({
        "imageDigest": digest,
        "imageConfigDigest": manifest["config"]["digest"],
        "buildkitArchiveSha256": sha(Path(source).read_bytes()),
        "buildkitIndexSha256": sha(files["index.json"]),
        "attestationManifestDigests": [item[0]["digest"] for item in attestations],
        "verifiedProvenanceSubject": digest,
    }, indent=2) + "\n")


if __name__ == "__main__":
    normalize(*sys.argv[1:])

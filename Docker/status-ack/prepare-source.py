"""Prepare only audited npm files for offline tests, without installing dependencies."""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="new directory outside the checkout")
    parser.add_argument("--archive", type=Path, help="cached npm .tgz; no network when supplied")
    args = parser.parse_args()
    directory = Path(__file__).resolve().parent
    pins = json.loads((directory / "source.json").read_text(encoding="utf-8"))
    lock = json.loads((directory.parents[1] / "package-lock.json").read_text(encoding="utf-8"))
    locked = lock["packages"]["node_modules/baileys"]
    for key in ("version", "resolved", "integrity"):
        if locked[key] != pins[key]:
            raise ValueError("Baileys lockfile drift: " + key)
    if args.destination.exists():
        raise ValueError("Destination must not exist; refusing overwrite")
    if args.archive:
        raw = args.archive.read_bytes()
    else:
        with urllib.request.urlopen(pins["resolved"], timeout=30) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("Unexpected archive size")
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode("ascii")
    if integrity != pins["integrity"]:
        raise ValueError("npm archive integrity mismatch")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for name in ("package.json", *pins["files"]):
            members = [item for item in archive.getmembers() if item.name == "package/" + name]
            if len(members) != 1 or not members[0].isfile():
                raise ValueError("Missing or ambiguous regular file: " + name)
            files[name] = archive.extractfile(members[0]).read()
            if name in pins["files"] and hashlib.sha256(files[name]).hexdigest() != pins["files"][name]:
                raise ValueError("Audited file checksum mismatch: " + name)
    pkg = json.loads(files["package.json"])
    if pkg["name"] != pins["name"] or pkg["version"] != pins["version"]:
        raise ValueError("Unreviewed package identity")
    args.destination.mkdir(parents=True, exist_ok=False)
    for name, data in files.items():
        target = args.destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    print(json.dumps({"source": pins["resolved"], "archiveIntegrity": integrity,
                      "archiveSha256": hashlib.sha256(raw).hexdigest(), "files": pins["files"],
                      "networkUsed": args.archive is None}))


if __name__ == "__main__":
    main()

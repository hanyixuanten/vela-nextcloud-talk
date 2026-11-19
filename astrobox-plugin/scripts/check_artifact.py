#!/usr/bin/env python3
"""Validate a built .abp without AstroBox.

AstroBox reports plugin problems in its own log, which is awkward to reach from
a phone. This script checks the things that actually break installs:

  1. the archive is a zip with a flat layout (manifest.json at the root)
  2. manifest.json is valid JSON with every required field of the right type
  3. `entry` points at a file that is really in the archive, and that file is a
     wasm *component* (not a core module)
  4. the archive file name is ASCII (some installers mishandle CJK + spaces)
  5. permission names are ones we have seen the host accept

Usage:
    python3 scripts/check_artifact.py [path/to/plugin.abp]

Exit code 0 = looks installable, 1 = at least one error, 2 = ambiguous/missing input.
"""

import json
import re
import sys
import zipfile
from pathlib import Path

REQUIRED_STR = ["name", "icon", "version", "description", "author", "website", "entry"]
REQUIRED_INT = ["wasi_version", "api_level"]

# Permissions observed in shipping plugins (device / interconnect / thirdpartyapp
# / network / register_interconnect_recv) plus the v1 documented set. Anything
# else is reported as unknown: the host rejects plugins whose manifest does not
# deserialize, so a typo here looks like "install failed".
KNOWN_PERMISSIONS = {
    "config",
    "device",
    "dialog",
    "event",
    "filesystem",
    "installer",
    "interconnect",
    "lifecycle",
    "native",
    "network",
    "provider",
    "register_interconnect_recv",
    "thirdpartyapp",
}

# Known-useless but harmless; rendering needs no permission.
SUSPICIOUS_PERMISSIONS = {"ui"}

# AstroBox runs level 2/3 plugins on wasmtime 38, whose WASI p2 implementation
# reports 0.2.6. A component that imports a newer 0.2.x cannot be linked there,
# and the failure looks like "the plugin does not install".
MAX_WASI_PATCH = 6

WASI_VERSION_RE = re.compile(rb"@0\.2\.(\d+)")

COMPONENT_MAGIC = b"\x00asm" + b"\x0d\x00\x01\x00"
MODULE_MAGIC = b"\x00asm" + b"\x01\x00\x00\x00"


class Report:
    def __init__(self):
        self.errors = []
        self.warnings = []
        self.notes = []

    def error(self, message):
        self.errors.append(message)

    def warn(self, message):
        self.warnings.append(message)

    def note(self, message):
        self.notes.append(message)

    def dump(self):
        for item in self.notes:
            print("  ok    " + item)
        for item in self.warnings:
            print("  warn  " + item)
        for item in self.errors:
            print("  ERROR " + item)


def check_wasi_version(blob, report):
    """Reject components that need a newer WASI p2 than the host provides."""
    patches = [int(match) for match in WASI_VERSION_RE.findall(blob)]
    if not patches:
        report.note("no wasi:*/@0.2.x imports (WASI-free component)")
        return

    newest = max(patches)
    if newest > MAX_WASI_PATCH:
        report.error(
            f"component imports wasi 0.2.{newest}, but AstroBox's level 2/3 runtime "
            f"(wasmtime 38) provides 0.2.{MAX_WASI_PATCH}; the component will fail to "
            "link, which looks exactly like an install failure. Pin an older toolchain "
            "(see rust-toolchain.toml)."
        )
    else:
        report.note(f"wasi 0.2.{newest} <= 0.2.{MAX_WASI_PATCH} (host ceiling)")


def check(path, report):
    if not path.exists():
        report.error(f"{path} does not exist")
        return

    name = path.name
    if not name.isascii():
        report.warn(
            f"archive file name is not ASCII ({name!r}); "
            "rename it (--archive-name) if the installer refuses the file"
        )
    else:
        report.note(f"archive name is ASCII: {name}")

    if not zipfile.is_zipfile(path):
        report.error("not a zip archive; .abp is expected to be a zip")
        return

    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        report.note(f"{len(names)} entries: {', '.join(names)}")

        if any("/" in entry for entry in names):
            report.error(
                "archive has nested paths; manifest.json, the wasm and the icon "
                "must sit at the archive root"
            )

        if "manifest.json" not in names:
            report.error("manifest.json missing from the archive root")
            return

        raw = archive.read("manifest.json").decode("utf-8")
        try:
            manifest = json.loads(raw)
        except json.JSONDecodeError as exc:
            report.error(f"manifest.json is not valid JSON: {exc}")
            return
        report.note("manifest.json parses")

        for field in REQUIRED_STR:
            value = manifest.get(field)
            if not isinstance(value, str) or not value.strip():
                report.error(f"manifest.{field} must be a non-empty string, got {value!r}")
        for field in REQUIRED_INT:
            value = manifest.get(field)
            if not isinstance(value, int) or isinstance(value, bool):
                report.error(f"manifest.{field} must be an integer, got {value!r}")

        entry = manifest.get("entry") or ""
        if entry:
            if entry not in names:
                report.error(f"manifest.entry {entry!r} is not present in the archive")
            else:
                blob = archive.read(entry)[:8]
                if blob == COMPONENT_MAGIC:
                    report.note(f"{entry} is a wasm component")
                    check_wasi_version(archive.read(entry), report)
                elif blob == MODULE_MAGIC:
                    report.error(
                        f"{entry} is a core wasm module, not a component; "
                        "build with --target wasm32-wasip2"
                    )
                else:
                    report.error(f"{entry} does not start with a wasm header: {blob!r}")

        icon = manifest.get("icon") or ""
        if icon and icon not in names:
            report.error(f"manifest.icon {icon!r} is not present in the archive")

        permissions = manifest.get("permissions")
        if not isinstance(permissions, list) or not all(
            isinstance(item, str) for item in permissions
        ):
            report.error("manifest.permissions must be a list of strings")
        else:
            unknown = [p for p in permissions if p not in KNOWN_PERMISSIONS]
            for perm in unknown:
                if perm in SUSPICIOUS_PERMISSIONS:
                    report.warn(
                        f"permission {perm!r} is not needed for this API level "
                        "(UI rendering is not gated); drop it to be safe"
                    )
                else:
                    report.error(
                        f"unknown permission {perm!r}; the host may reject the "
                        "whole manifest"
                    )
            if not unknown:
                report.note(f"permissions look known: {', '.join(permissions) or '(none)'}")

        api_level = manifest.get("api_level")
        if api_level == 3:
            report.note("api_level 3 requires AstroBox >= 2.1.0")
        elif api_level == 2:
            report.note("api_level 2 runs on AstroBox >= 2.0.0")

        if "additional_files" in manifest and not manifest["additional_files"]:
            report.warn("additional_files is an empty list; omit the key instead")


def main():
    default = Path(__file__).resolve().parent.parent / "dist"
    candidates = sorted(default.glob("*.abp"))
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
    elif len(candidates) == 1:
        target = candidates[0]
    elif candidates:
        sys.stderr.write("multiple .abp files found; pass the intended artifact path explicitly\n")
        return 2
    else:
        target = default

    print(f"checking {target}")
    report = Report()
    check(target, report)
    print()
    report.dump()

    if report.errors:
        print(f"\n{len(report.errors)} error(s), {len(report.warnings)} warning(s)")
        return 1
    if report.warnings:
        print(f"\ninstallable, but {len(report.warnings)} warning(s) to look at")
        return 0
    print("\nlooks installable")
    return 0


if __name__ == "__main__":
    sys.exit(main())

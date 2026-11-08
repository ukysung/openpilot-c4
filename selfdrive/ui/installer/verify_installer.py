#!/usr/bin/env python3
"""Check an installer binary before uploading it, e.g.:

  python3 selfdrive/ui/installer/verify_installer.py carrot
"""
import argparse
import struct
import sys

DEFAULT_GIT_URL = "https://github.com/ukysung/openpilot-c4.git"
DEFAULT_BRANCH = "carrot"
EM_AARCH64 = 183


def read_embedded(data: bytes, prefix: bytes) -> str | None:
  # installer.cc keeps "<value>?<padding>" literals and reads up to the '?'
  idx = data.find(prefix)
  if idx < 0:
    return None
  end = data.find(b"?", idx)
  return data[idx:end].decode("ascii", errors="replace") if end >= 0 else None


def verify(data: bytes, git_url: str, branch: str) -> list[str]:
  errors = []
  if data[:4] != b"\x7fELF":
    errors.append("not an ELF binary (the device setup rejects it)")
  elif len(data) >= 20 and struct.unpack_from("<H", data, 18)[0] != EM_AARCH64:
    errors.append("not an aarch64 binary (build it on the comma device)")

  embedded_url = read_embedded(data, b"https://github.com/")
  if embedded_url != git_url:
    errors.append(f"git url is {embedded_url!r}, expected {git_url!r}")

  if (branch + "?" + " " * 16).encode() not in data:
    errors.append(f"branch {branch!r} not found")

  if len(data) >= 2500 * 1000:
    errors.append(f"binary is {len(data)} bytes, expected < 2.5MB")
  return errors


def main() -> int:
  parser = argparse.ArgumentParser()
  parser.add_argument("path")
  parser.add_argument("--git-url", default=DEFAULT_GIT_URL)
  parser.add_argument("--branch", default=DEFAULT_BRANCH)
  args = parser.parse_args()

  with open(args.path, "rb") as f:
    data = f.read()

  errors = verify(data, args.git_url, args.branch)
  if errors:
    for e in errors:
      print(f"FAIL: {e}")
    return 1
  print(f"OK: {args.path} ({len(data)} bytes) installs {args.git_url} @ {args.branch}")
  return 0


if __name__ == "__main__":
  sys.exit(main())

import struct

from openpilot.selfdrive.ui.installer.verify_installer import verify, DEFAULT_GIT_URL, DEFAULT_BRANCH

PAD = b" " * 64


def fake_installer(git_url=DEFAULT_GIT_URL, branch=DEFAULT_BRANCH, machine=183) -> bytes:
  header = b"\x7fELF" + b"\x00" * 14 + struct.pack("<H", machine) + b"\x00" * 44
  return header + b"\x00junk\x00" + git_url.encode() + b"?" + PAD + b"\x00" + branch.encode() + b"?" + PAD + b"\x00"


def test_valid_installer_passes():
  assert verify(fake_installer(), DEFAULT_GIT_URL, DEFAULT_BRANCH) == []


def test_rejects_non_elf():
  assert any("ELF" in e for e in verify(b"<html>not found</html>", DEFAULT_GIT_URL, DEFAULT_BRANCH))


def test_rejects_wrong_arch():
  assert any("aarch64" in e for e in verify(fake_installer(machine=62), DEFAULT_GIT_URL, DEFAULT_BRANCH))


def test_rejects_stock_url_and_branch():
  data = fake_installer(git_url="https://github.com/commaai/openpilot.git", branch="release3")
  errors = verify(data, DEFAULT_GIT_URL, DEFAULT_BRANCH)
  assert any("git url" in e for e in errors)
  assert any("branch" in e for e in errors)

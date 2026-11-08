#!/usr/bin/env bash
# Build the carrot installer (served from https://i.bomcat.net/carrot) on a comma device.
#
# Run on the device, ideally offroad:
#   bash /data/openpilot/selfdrive/ui/installer/build_carrot_installer.sh
#
# Builds in a temporary git worktree so the running /data/openpilot is not touched.
# Output: /data/installer_carrot
set -e

SRC="${SRC:-/data/openpilot}"
BUILD="${BUILD:-/data/installer_build}"
OUT="${OUT:-/data/installer_carrot}"
TARGET="selfdrive/ui/installer/installers/installer_carrot"
RAYLIB_COMMIT="3425bd9d1fb292ede4d80f97a1f4f258f614cffc"  # keep in line with third_party/raylib/build.sh

if [ ! -f /TICI ]; then
  echo "This must run on a comma device (larch64)."
  exit 1
fi

if ! grep -q '"carrot", "carrot"' "$SRC/selfdrive/ui/SConscript"; then
  echo "$SRC does not have the carrot installer target yet. Update the device to the latest carrot branch first."
  exit 1
fi

cleanup() {
  cd "$SRC"
  git worktree remove --force "$BUILD" 2>/dev/null || rm -rf "$BUILD"
  git worktree prune
}
trap cleanup EXIT

echo "==> creating worktree at $BUILD"
cd "$SRC"
git worktree prune
rm -rf "$BUILD"
git worktree add --detach "$BUILD" HEAD

echo "==> building raylib (larch64)"
RAYLIB_DIR="$BUILD/third_party/raylib"
git clone -b master --no-tags https://github.com/commaai/raylib.git "$RAYLIB_DIR/raylib_repo"
cd "$RAYLIB_DIR/raylib_repo"
git fetch origin "$RAYLIB_COMMIT"
git reset --hard "$RAYLIB_COMMIT"
mkdir -p "$RAYLIB_DIR/larch64"
make -C src -j"$(nproc)" PLATFORM=PLATFORM_COMMA RAYLIB_RELEASE_PATH="$RAYLIB_DIR/larch64"

echo "==> building $TARGET"
cd "$BUILD"
scons -j"$(nproc)" --extras "$TARGET"

head -c 4 "$TARGET" | grep -q "ELF" || { echo "build output is not an ELF binary"; exit 1; }
grep -aq "https://github.com/ukysung/openpilot-c4.git?" "$TARGET" || { echo "git url missing from installer"; exit 1; }

cp "$TARGET" "$OUT"
echo
echo "==> done: $OUT ($(stat -c %s "$OUT") bytes)"
echo "Copy it to your PC, e.g.:  scp comma@<device-ip>:$OUT ./carrot"
echo "Then upload it as the file named 'carrot' at the root of i.bomcat.net."

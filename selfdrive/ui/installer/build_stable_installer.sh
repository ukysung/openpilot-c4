#!/usr/bin/env bash
# Build the stable installer (served from https://i.bombcat.net/stable) on a comma device.
#
# Run on the device, ideally offroad:
#   bash /data/openpilot/selfdrive/ui/installer/build_stable_installer.sh
#
# Builds in a temporary git worktree so the running /data/openpilot is not touched.
# Output: /data/installer_stable
set -e

SRC="${SRC:-/data/openpilot}"
BUILD="${BUILD:-/data/installer_build}"
OUT="${OUT:-/data/installer_stable}"
TARGET="selfdrive/ui/installer/installers/installer_stable"
RAYLIB_COMMIT="3425bd9d1fb292ede4d80f97a1f4f258f614cffc"  # keep in line with third_party/raylib/build.sh

if [ ! -f /TICI ]; then
  echo "This must run on a comma device (larch64)."
  exit 1
fi

if ! grep -q '"stable", "stable"' "$SRC/selfdrive/ui/SConscript"; then
  echo "$SRC does not have the stable installer target yet. Update the device to the latest stable branch first."
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
# prebuilt branches ship compiled models only; SConstruct still stats the .onnx sources
for m in driving_vision driving_policy dmonitoring_model; do
  [ -f "selfdrive/modeld/models/$m.onnx" ] || touch "selfdrive/modeld/models/$m.onnx"
done
export PATH="/usr/local/venv/bin:$PATH"
source ./launch_env.sh
# the installer is an "extras" target, and extras don't build on prebuilt branches,
# so only build the common libs with SCons and compile the installer like selfdrive/ui/SConscript does
python3 -m SCons -j"$(nproc)" common/libcommon.a third_party/libjson11.a

PKG_FLAGS=$(python3 -c "
import capnproto, zeromq
print(' '.join(f'-I{m.INCLUDE_DIR} -L{m.LIB_DIR}' for m in (capnproto, zeromq)))
")
OBJ="$BUILD/installer_obj"
mkdir -p "$OBJ" "$(dirname "$TARGET")"
# symbol names come from these paths, so run ld from the repo root (see extern declarations in installer.cc)
ld -r -b binary -o "$OBJ/continue.o" selfdrive/ui/installer/continue_openpilot.sh
ld -r -b binary -o "$OBJ/inter.o" selfdrive/ui/installer/inter-ascii.ttf
ld -r -b binary -o "$OBJ/inter_bold.o" selfdrive/assets/fonts/Inter-Bold.ttf
ld -r -b binary -o "$OBJ/inter_light.o" selfdrive/assets/fonts/Inter-Light.ttf

g++ -std=c++1z -O2 -fPIC \
  -DBRANCH='"stable"' -DGIT_URL_STR='"https://github.com/ukysung/openpilot-c4.git"' \
  -I. -Imsgq -Ithird_party -Ithird_party/json11 -Ithird_party/linux/include -Ithird_party/raylib/include $PKG_FLAGS \
  -o "$TARGET" selfdrive/ui/installer/installer.cc "$OBJ"/*.o \
  -Lcommon -Lthird_party -L"$RAYLIB_DIR/larch64" $PKG_FLAGS \
  -lcommon -ljson11 -lraylib -lzmq -lGLESv2 -lEGL -lgbm -ldrm -lpthread -Wl,-strip-debug

head -c 4 "$TARGET" | grep -q "ELF" || { echo "build output is not an ELF binary"; exit 1; }
grep -aq "https://github.com/ukysung/openpilot-c4.git?" "$TARGET" || { echo "git url missing from installer"; exit 1; }

cp "$TARGET" "$OUT"
echo
echo "==> done: $OUT ($(stat -c %s "$OUT") bytes)"
echo "Copy it to your PC, e.g.:  scp comma@<device-ip>:$OUT ./stable"
echo "Then upload it as the file named 'stable' at the root of i.bombcat.net."

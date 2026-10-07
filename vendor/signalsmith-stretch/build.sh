#!/bin/bash
# Rebuilds SignalsmithStretch.mjs in this folder from the library's own source plus fix-bass-pitch.patch (v0.9.27).
#
#   bash vendor/signalsmith-stretch/build.sh [work dir]      (Linux or macOS; git, make, python3, cmake, node)
#
# Every version below is pinned because the recipe was proven, not guessed: with the patch left out, this exact recipe
# rebuilds the npm package signalsmith-stretch@1.3.2 byte for byte (07/10). Two things break if they drift:
#  - emsdk newer than 3.1.73 emits a "d8 shell" branch (randomFill -> os.system) that the AudioWorklet scope falls into, so the
#    node is built but never answers - the key lock button would hang with no error. 4.0.10 and 6.0.11 both did this.
#  - a different Signalsmith Linear changes the FFT, so the measured numbers in README.md would no longer describe the file.
set -euo pipefail

STRETCH_COMMIT=222093b4cc13ddb4d07c826bc3c1559326091731 # "Bugfix in web release" - the source of the 1.3.2 web release
LINEAR_TAG=0.1.1
EMSDK_VERSION=3.1.73

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"
cd "$WORK"

[ -d signalsmith-stretch ] || git clone -q https://github.com/Signalsmith-Audio/signalsmith-stretch.git
git -C signalsmith-stretch checkout -q "$STRETCH_COMMIT"
git -C signalsmith-stretch checkout -q -- .
[ -d linear ] || git clone -q https://github.com/Signalsmith-Audio/linear.git
git -C linear checkout -q "$LINEAR_TAG"
[ -d emsdk ] || git clone -q https://github.com/emscripten-core/emsdk.git
(cd emsdk && ./emsdk install "$EMSDK_VERSION" > /dev/null && ./emsdk activate "$EMSDK_VERSION" > /dev/null)
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh > /dev/null 2>&1
export EMSDK="$WORK/emsdk"

cd signalsmith-stretch
patch -p0 signalsmith-stretch.h < "$HERE/fix-bass-pitch.patch"
# The library's compile script expects Linear on its include path (its CMake build fetches it); point it at the pinned copy.
sed -i.bak "s|-I \"\${SCRIPT_DIR}\"|-I \"\${SCRIPT_DIR}\" -I \"$WORK/linear/include\"|" web/emscripten/compile.sh
(cd web && make -B release/SignalsmithStretch.mjs)
cp web/release/SignalsmithStretch.mjs "$HERE/SignalsmithStretch.mjs"
echo "Wrote $HERE/SignalsmithStretch.mjs - now run npm test (tests/platform/keylock-pitch.test.ts measures it)."

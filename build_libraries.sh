#!/bin/sh
set -e

LIBRARY_DIR="libraries/spessasynth_core"
DIST_DIR="$LIBRARY_DIR/dist"

if [ ! -d "$DIST_DIR" ]; then
    echo "Building spessasynth_core..."
    cd "$LIBRARY_DIR"
    npm install
    npm run build:fast
    cd -
    echo "Build complete."
else
    echo "spessasynth_core already built, skipping."
fi

#!/bin/sh
set -e

LIBRARY_DIR="libraries/spessasynth_core"
DIST_DIR="$LIBRARY_DIR/dist"
SERVER_DIR="libraries/spessasynth_core_dist" 

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
mkdir -p "$SERVER_DIR"
cp "$DIST_DIR/index.js" "$SERVER_DIR/"
echo "Copied index.js to $SERVER_DIR."

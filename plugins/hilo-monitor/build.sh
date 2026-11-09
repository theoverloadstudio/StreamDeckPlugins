#!/bin/sh
set -eu
cd "$(dirname "$0")"
clang -fobjc-arc -Wall -Wextra -Wno-unused-parameter -Wno-deprecated-declarations \
    -arch arm64 -arch x86_64 -mmacosx-version-min=13.0 \
    -framework Foundation -framework CoreMIDI hilo-midi.m \
    -o com.theoverloadstudio.hilo-monitor.sdPlugin/hilo-midi
codesign --force --sign - com.theoverloadstudio.hilo-monitor.sdPlugin/hilo-midi

#!/bin/bash
# Writes the two test videos the shell test page plays: H.264 in MP4 and VP9 in WebM.
# Usage: scripts/make-test-media.sh (from spikes/tauri-shell)
set -euo pipefail

mkdir -p ui/media
source=(-f lavfi -i "testsrc2=size=1280x720:rate=30:duration=10" -f lavfi -i "sine=frequency=440:duration=10")
ffmpeg -y -loglevel error "${source[@]}" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -c:a aac -movflags +faststart ui/media/test-h264.mp4
ffmpeg -y -loglevel error "${source[@]}" -c:v libvpx-vp9 -b:v 1M -c:a libopus ui/media/test-vp9.webm
ls -l ui/media

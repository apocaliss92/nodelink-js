#!/bin/bash
# Verify keyframe decoding

cd /Users/gianlucaruocco/Documents/Git/reolink-baichuan-js/downloads/bcmedia-dump

echo "=== File sizes ==="
ls -la *.h264

echo ""
echo "=== Testing keyframe decode ==="
ffmpeg -v warning -f h264 -i frame_1_key.h264 -frames:v 1 -y verify_key.jpg 2>&1

if [ -f verify_key.jpg ]; then
    echo "✓ JPEG created: $(ls -la verify_key.jpg)"
    file verify_key.jpg
else
    echo "✗ JPEG not created"
fi

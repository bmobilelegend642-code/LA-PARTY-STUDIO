#!/usr/bin/env bash
set -o errexit

npm install

mkdir -p bin
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o ./bin/yt-dlp
chmod a+rx ./bin/yt-dlp

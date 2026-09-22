#!/usr/bin/env bash
set -e

# Install system dependencies: ffmpeg, fluidsynth, DejaVu fonts
apt-get update -qq
apt-get install -y --no-install-recommends ffmpeg fluidsynth fonts-dejavu

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt

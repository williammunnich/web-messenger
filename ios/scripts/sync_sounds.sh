#!/bin/sh
# @file sync_sounds.sh
# Copies the notification sounds from assets-src/sounds (the source of truth) into the app's resources.
# Runs as an Xcode pre-build step (see project.yml) and can be run by hand from anywhere.
#
# @project web-messenger
# @usage sh ios/scripts/sync_sounds.sh
# @exit 0 when the sounds are in place; 1 when a source sound is missing.
# @author Claude (Anthropic), written for and prompted by William Munnich
# @date Last edited 2026-11-12
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../assets-src/sounds"
dst="$here/../WMChat/Resources/Sounds"
mkdir -p "$dst"
for f in visit.caf message.caf message-long.caf; do
  if [ ! -f "$src/$f" ]; then echo "error: missing $src/$f" >&2; exit 1; fi
  if ! cmp -s "$src/$f" "$dst/$f"; then cp "$src/$f" "$dst/$f"; echo "updated $f"; fi
done

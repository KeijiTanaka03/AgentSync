#!/bin/sh
# Copies the app built by `npm run dist` into /Applications, replacing an older copy.
# Usage: npm run install:app   (builds first)
set -eu

case "$(uname -m)" in
  arm64) source_app="release/mac-arm64/AgentSync.app" ;;
  *) source_app="release/mac/AgentSync.app" ;;
esac
target_app="/Applications/AgentSync.app"

if [ ! -d "$source_app" ]; then
  echo "$source_app がありません。先に npm run dist を実行してください。" >&2
  exit 1
fi
if pgrep -x AgentSync >/dev/null 2>&1; then
  echo "AgentSync が起動しています。終了してから、もう一度実行してください。" >&2
  exit 1
fi

rm -rf "$target_app"
ditto "$source_app" "$target_app"
echo "インストールしました: $target_app"

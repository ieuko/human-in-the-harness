#!/bin/zsh
set -eu

hith_root="${0:A:h}"
cd -- "$hith_root"

if command -v node >/dev/null 2>&1; then
  hith_node="$(command -v node)"
elif [[ -x /opt/homebrew/bin/node ]]; then
  hith_node=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  hith_node=/usr/local/bin/node
else
  print 'Node.jsが見つかりません。Node.js 24.14以上をインストールしてください。'
  read -k 1 '?何かキーを押すと終了します。'
  exit 1
fi

exec "$hith_node" ./scripts/start-pi.mjs "$@"

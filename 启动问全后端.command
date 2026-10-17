#!/bin/zsh
set -e
cd "$(dirname "$0")"
exec node --env-file-if-exists=.env server/service.mjs

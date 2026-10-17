#!/bin/zsh
set -e
cd "$(dirname "$0")"
npm run build
open -a "MemoMind Plugin Studio"
echo '手机插件选择「问全 · 访谈追问助手 0.2.4」，眼镜应自动匹配「GM Web Bridge v2」。'
echo '如果列表没有更新，点击手机插件右侧的「刷新仓库」。'

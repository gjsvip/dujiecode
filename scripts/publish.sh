#!/usr/bin/env bash
# =============================================================================
# 渡劫code 一键双平台发布脚本（GitHub 国外 + Gitee 国内，数据互通）
#
# 用法：
#   1) 在 GitHub 和 Gitee 各创建一个空仓库（仓库名默认 dujiecode）
#   2)  export GH_USER=你的GitHub用户名
#       export GITEE_USER=你的Gitee用户名
#   3)  ./scripts/publish.sh                # HTTPS 方式推送（会提示输密码/令牌）
#   或  ./scripts/publish.sh --ssh          # SSH 方式推送（需已配置 SSH key）
#
# 环境变量：
#   GH_USER / GITEE_USER   两个平台的用户名
#   REPO_NAME              仓库名（默认 dujiecode）
#   GH_TOKEN / GITEE_TOKEN 个人访问令牌（设置后免交互推送；Gitee 令牌需 projects 权限）
# =============================================================================
set -euo pipefail

REPO_NAME="${REPO_NAME:-dujiecode}"
GH_USER="${GH_USER:-}"
GITEE_USER="${GITEE_USER:-}"
USE_SSH=0
[ "${1:-}" = "--ssh" ] && USE_SSH=1

if [ -z "$GH_USER" ] || [ -z "$GITEE_USER" ]; then
  echo "错误：请先设置 GH_USER 与 GITEE_USER 环境变量" >&2
  echo "  export GH_USER=你的GitHub用户名 GITEE_USER=你的Gitee用户名" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ "$USE_SSH" = "1" ]; then
  GH_URL="git@github.com:$GH_USER/$REPO_NAME.git"
  GITEE_URL="git@gitee.com:$GITEE_USER/$REPO_NAME.git"
else
  if [ -n "${GH_TOKEN:-}" ]; then
    GH_URL="https://$GH_USER:$GH_TOKEN@github.com/$GH_USER/$REPO_NAME.git"
  else
    GH_URL="https://github.com/$GH_USER/$REPO_NAME.git"
  fi
  if [ -n "${GITEE_TOKEN:-}" ]; then
    GITEE_URL="https://$GITEE_USER:$GITEE_TOKEN@gitee.com/$GITEE_USER/$REPO_NAME.git"
  else
    GITEE_URL="https://gitee.com/$GITEE_USER/$REPO_NAME.git"
  fi
fi

git remote remove github 2>/dev/null || true
git remote remove gitee 2>/dev/null || true
git remote add github "$GH_URL"
git remote add gitee "$GITEE_URL"

echo "==> 推送到 GitHub（国外）"
git push -u github main
echo "==> 推送到 Gitee（国内）"
git push -u gitee main

echo ""
echo "完成！双仓库已同步："
echo "  GitHub : https://github.com/$GH_USER/$REPO_NAME"
echo "  Gitee  : https://gitee.com/$GITEE_USER/$REPO_NAME"
echo ""
echo "后续任意 git push github main 后，GitHub Actions 会自动镜像到 Gitee（见 .github/workflows/mirror-to-gitee.yml，需在仓库 Settings > Secrets 配置 GITEE_USER/GITEE_TOKEN）。"

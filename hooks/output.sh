#!/bin/sh
# SessionStart：保存季报输出偏好与本机 CLI 路径，不调用 CLI、不联网。
# 只写插件数据目录；失败不阻断会话。提示至多一行，由模型引导用户配置。
dir=${CLAUDE_PLUGIN_DATA:-}
[ -n "$dir" ] || exit 0

feishu=0
case ${CLAUDE_PLUGIN_OPTION_FEISHU_OUTPUT:-} in
  [tT][rR][uU][eE]|1|[yY][eE][sS]|[oO][nN]) feishu=1 ;;
esac

# 桌面应用的 PATH 往往不包含用户级 npm 目录。只检查可执行文件，绝不运行。
lark_cli=
candidate=$(command -v lark-cli 2>/dev/null) || candidate=
if [ -n "$candidate" ] && [ -f "$candidate" ] && [ -x "$candidate" ]; then
  case $candidate in
    /*) lark_cli=$candidate ;;
    *)
      candidate=$PWD/$candidate
      lark_cli=$(cd -P "${candidate%/*}" 2>/dev/null && printf '%s/%s' "$PWD" "${candidate##*/}") || lark_cli=
      ;;
  esac
fi
if [ -z "$lark_cli" ]; then
  for candidate in \
    "${HOME:-}/.npm-global/bin/lark-cli" \
    "${HOME:-}/.local/bin/lark-cli" \
    /opt/homebrew/bin/lark-cli \
    /usr/local/bin/lark-cli
  do
    if [ -f "$candidate" ] && [ -x "$candidate" ]; then
      case $candidate in
        /*) lark_cli=$candidate ;;
        *)
          candidate=$PWD/$candidate
          lark_cli=$(cd -P "${candidate%/*}" 2>/dev/null && printf '%s/%s' "$PWD" "${candidate##*/}") || lark_cli=
          ;;
      esac
      [ -n "$lark_cli" ] && break
    fi
  done
fi

umask 077
mkdir -p "$dir" 2>/dev/null || exit 0
file=$dir/output.env
tmp=$file.$$
if printf 'feishu=%s\nlark_cli=%s\n' "$feishu" "$lark_cli" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }
else
  rm -f "$tmp" 2>/dev/null
  exit 0
fi

if [ "$feishu" = 1 ] && [ -z "$lark_cli" ]; then
  echo '已开启飞书输出，但本机找不到 lark-cli：本次会话生成的季报只会输出 Markdown。安装并登录 lark-cli 后新开会话即可恢复。'
elif [ "$feishu" = 0 ] && [ -n "$lark_cli" ] && ( set -C; : > "$dir/feishu-hint-shown" ) 2>/dev/null; then
  # noclobber creates the marker atomically, so simultaneous sessions hint once.
  echo '检测到本机已安装 lark-cli（飞书 CLI）。如需把季报输出为飞书云文档（建在个人空间、不共享），请用户在交互式 claude 终端执行 /plugin configure strategic-analytics@strategic 开启「用飞书云文档输出季报」，新开会话后生效；不开启则只输出 Markdown。'
fi
exit 0

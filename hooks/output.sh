#!/bin/sh
# SessionStart：保存季报输出偏好与本机 CLI 路径，不调用 CLI、不联网。
# 只写插件数据目录；失败不阻断会话。飞书提示至多一行，无效目录另提示一行。
dir=${CLAUDE_PLUGIN_DATA:-}
feishu_option=${CLAUDE_PLUGIN_OPTION_FEISHU_OUTPUT:-}
report_dir=${CLAUDE_PLUGIN_OPTION_REPORT_DIR:-}
if [ -z "$dir" ]; then
  dir=${CODEBUDDY_PLUGIN_DATA:-}
  feishu_option=${CODEBUDDY_PLUGIN_OPTION_FEISHU_OUTPUT:-}
  report_dir=${CODEBUDDY_PLUGIN_OPTION_REPORT_DIR:-}
fi
[ -n "$dir" ] || exit 0

feishu=0
case $feishu_option in
  [Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss]|[Oo][Nn]) feishu=1 ;;
esac

case $report_dir in
  '~') report_dir=$HOME ;;
  '~/'*) report_dir=$HOME/${report_dir#\~/} ;;
esac
invalid_dir=0
carriage_return=$(printf '\r')
case $report_dir in
  '') report_dir=$HOME/Documents/战略季报 ;;
  *'
'*|*"$carriage_return"*) invalid_dir=1 ;;
  /*) ;;
  *) invalid_dir=1 ;;
esac
if [ "$invalid_dir" = 1 ]; then
  report_dir=$HOME/Documents/战略季报
fi

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
if printf 'feishu=%s\nlark_cli=%s\nreport_dir=%s\n' "$feishu" "$lark_cli" "$report_dir" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$file" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }
else
  rm -f "$tmp" 2>/dev/null
  exit 0
fi

if [ "$invalid_dir" = 1 ]; then
  echo '「本地报告目录」必须是无换行的绝对路径，本次会话使用 ~/Documents/战略季报。'
fi

if [ "$feishu" = 1 ] && [ -z "$lark_cli" ]; then
  echo '已开启「同步飞书云文档报告」，但本机找不到 lark-cli：本次会话的季报只生成本地 Markdown。安装并登录 lark-cli 后新开会话即可恢复同步。'
elif [ "$feishu" = 0 ] && [ -n "$lark_cli" ] && ( set -C; : > "$dir/feishu-hint-shown" ) 2>/dev/null; then
  # noclobber creates the marker atomically, so simultaneous sessions hint once.
  echo '检测到本机已安装 lark-cli（飞书 CLI）。季报总会生成本地 Markdown；如需同时同步一份飞书云文档（建在个人空间、不共享），请在当前工作台的插件配置中打开「同步飞书云文档报告」，然后新开会话。'
fi
exit 0

#!/bin/sh
# SessionStart：把插件配置里的 MCP 服务地址与访问令牌交给季报脚本。
#
# 插件 MCP 连接直接用 ${user_config.*}；但季报脚本经 Bash 直连服务，Bash 的环境里没有插件配置。
# 所以在这里（钩子进程能拿到 CLAUDE_PLUGIN_OPTION_*）把两项写进插件数据目录下仅本人可读的文件，
# 插件 Agent 用 --connection 把路径交给脚本。令牌不进会话环境变量、不打印；插件卸载时数据目录随之删除。
#
# 标准输出只交接非敏感资料目录；令牌与地址永不进入模型上下文。
dir=${CLAUDE_PLUGIN_DATA:-}
token=${CLAUDE_PLUGIN_OPTION_STRATEGIC_TOKEN:-}
url=${CLAUDE_PLUGIN_OPTION_STRATEGIC_URL:-}
if [ -z "$dir" ]; then
  # 同一插件协议的原生别名；整组取值，不能混配两个命名空间。
  dir=${CODEBUDDY_PLUGIN_DATA:-}
  token=${CODEBUDDY_PLUGIN_OPTION_STRATEGIC_TOKEN:-}
  url=${CODEBUDDY_PLUGIN_OPTION_STRATEGIC_URL:-}
fi
[ -n "$dir" ] || exit 0
file=$dir/connection.env
if [ -z "$token" ]; then
  rm -f "$file" 2>/dev/null
  echo "战略大盘分析插件尚未配置访问令牌：请在当前工作台的插件配置中填写维护者提供的访问令牌后新开会话，接入方式见插件 README。"
  exit 0
fi
umask 077
mkdir -p "$dir" 2>/dev/null || exit 0
tmp=$file.$$
if printf 'url=%s\ntoken=%s\n' "$url" "$token" > "$tmp" 2>/dev/null; then
  if mv -f "$tmp" "$file" 2>/dev/null; then
    carriage_return=$(printf '\r')
    case $dir in
      *'
'*|*"$carriage_return"*|*"$token"*) ;;
      /*) printf 'STRATEGIC_PLUGIN_DATA_DIR=%s\n' "$dir" ;;
    esac
  fi
fi
rm -f "$tmp" 2>/dev/null
exit 0

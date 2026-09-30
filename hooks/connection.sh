#!/bin/sh
# SessionStart：把插件配置里的 MCP 服务地址与访问令牌交给季报脚本。
#
# 插件 MCP 连接直接用 ${user_config.*}；但季报脚本经 Bash 直连服务，Bash 的环境里没有插件配置。
# 所以在这里（钩子进程能拿到 CLAUDE_PLUGIN_OPTION_*）把两项写进插件数据目录下仅本人可读的文件，
# 插件 Agent 用 --connection 把路径交给脚本。令牌不进会话环境变量、不打印；插件卸载时数据目录随之删除。
#
# 任何失败都不阻断会话（hooks.json 里另有 || true）。标准输出会进入模型上下文，所以只在未配置令牌时
# 输出一句提示，其余情况不输出。
dir=${CLAUDE_PLUGIN_DATA:-}
[ -n "$dir" ] || exit 0
file=$dir/connection.env
token=${CLAUDE_PLUGIN_OPTION_STRATEGIC_TOKEN:-}
if [ -z "$token" ]; then
  rm -f "$file" 2>/dev/null
  echo "战略大盘分析插件尚未配置访问令牌：插件的 MCP 工具连不上服务（季报脚本只能退回环境变量 STRATEGIC_MCP_TOKEN）。请用户在交互式 claude 终端执行 /plugin configure strategic-analytics@strategic 填写令牌（向插件维护者申请）后新开会话。"
  exit 0
fi
umask 077
mkdir -p "$dir" 2>/dev/null || exit 0
tmp=$file.$$
if printf 'url=%s\ntoken=%s\n' "${CLAUDE_PLUGIN_OPTION_STRATEGIC_URL:-}" "$token" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$file" 2>/dev/null
fi
rm -f "$tmp" 2>/dev/null
exit 0

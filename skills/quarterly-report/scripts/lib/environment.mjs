// FLYWHEEL_* 已弃用：客户端变量先读 STRATEGIC_*，新名未设置时才回退旧名。
export const clientEnv = (env, suffix) => env[`STRATEGIC_${suffix}`] ?? env[`FLYWHEEL_${suffix}`];

// 两族令牌都参与脱敏，也都不能传给绘图器、pip 或 lark-cli。
export const mcpTokens = (env) => [env.STRATEGIC_MCP_TOKEN, env.FLYWHEEL_MCP_TOKEN].filter(Boolean);
export const withoutMcpTokens = (env) => {
  const { STRATEGIC_MCP_TOKEN: _token, FLYWHEEL_MCP_TOKEN: _deprecatedToken, ...rest } = env;
  return rest;
};

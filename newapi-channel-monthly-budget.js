export const meta = {
  apiVersion: 1,
  key: "channel-monthly-budget",
  name: {en: "Monthly channel budget", zh: "渠道月度消费限制"},
  description: {
    en: "Limits requests using the current calendar month's New API consumption logs",
    zh: "按本自然月的 New API 消费日志限制请求",
  },
  version: "0.1.0",
  author: {name: "Codex"},
  configSchema: {
    type: "object",
    required: ["managementUrl", "readToken"],
    properties: {
      managementUrl: {
        type: "string",
        format: "url",
        title: {en: "New API management origin", zh: "New API 管理地址"},
        description: {
          en: "Use this New API instance's origin, with no path. HTTP is accepted on loopback only",
          zh: "填本实例的域名和端口，不带路径。HTTP 仅允许回环地址",
        },
      },
      readToken: {
        type: "string",
        format: "password",
        pattern: "^nap_[A-Za-z0-9]{43}$",
        title: {en: "Read-only access token", zh: "只读访问令牌"},
        description: {
          en: "Use a New API personal access token with the log:read scope",
          zh: "填写仅授予 log:read 权限的 New API 个人访问令牌",
        },
      },
      budgetMode: {
        type: "string",
        title: {en: "Budget mode", zh: "预算模式"},
        enum: ["per-channel", "shared"],
        enumTitles: [
          {en: "Separate budget for each channel", zh: "每条渠道独立额度"},
          {en: "One shared budget across all channels", zh: "所有渠道共用总额度"},
        ],
        default: "per-channel",
      },
      limitUsd: {
        type: "number",
        minimum: 0.01,
        default: 100,
        title: {en: "Monthly budget (USD)", zh: "月度额度（美元）"},
      },
      quotaPerUsd: {
        type: "number",
        minimum: 1,
        default: 500000,
        title: {en: "Quota points per USD", zh: "每美元配额点数"},
        description: {
          en: "Use the quota_per_unit from this instance's /api/status",
          zh: "与本实例 /api/status 返回的 quota_per_unit 一致",
        },
      },
    },
  },
};

const managementOrigin = /^(https:\/\/[^\s/@?#\\]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?)\/?$/;
const shanghaiOffsetSeconds = 8 * 60 * 60;

export function validateConfig(config) {
  if (!managementOrigin.test(config.managementUrl)) {
    throw new Error("管理地址需为 HTTPS 源地址，或仅通过 HTTP 访问回环地址，不带 API 路径");
  }
  if (config.limitUsd * config.quotaPerUsd > Number.MAX_SAFE_INTEGER) {
    throw new Error("金额阈值超出可精确比较的配额范围");
  }
}

function monthWindow(now) {
  const localDate = new Date((now + shanghaiOffsetSeconds) * 1000);
  const year = localDate.getUTCFullYear();
  const month = localDate.getUTCMonth();
  const start = Date.UTC(year, month, 1) / 1000 - shanghaiOffsetSeconds;
  const nextStart = Date.UTC(year, month + 1, 1) / 1000 - shanghaiOffsetSeconds;
  return {start, end: nextStart - 1};
}

function usageUnavailable() {
  return {
    action: "reject",
    code: "monthly_usage_unavailable",
    message: "暂时无法核实本月消费额度，本次请求已拦截",
  };
}

function checkBudget(config, channelId) {
  const {start, end} = monthWindow(utils.unixNow());
  const origin = config.managementUrl.replace(/\/$/, "");
  let url = origin + "/api/log/stat?type=2&start_timestamp=" + start + "&end_timestamp=" + end;
  if (channelId !== undefined) {
    url += "&channel=" + channelId;
  }

  let response;
  try {
    response = utils.fetch({
      url,
      method: "GET",
      headers: {Authorization: "Bearer " + config.readToken, Accept: "application/json"},
    });
  } catch (_) {
    return usageUnavailable();
  }

  const body = response.body;
  if (response.status !== 200 || !body || body.success !== true || !body.data ||
      !Number.isSafeInteger(body.data.quota) || body.data.quota < 0) {
    return usageUnavailable();
  }

  if (body.data.quota / config.quotaPerUsd >= config.limitUsd) {
    const subject = channelId === undefined ? "本站" : "该渠道";
    return {
      action: "reject",
      code: "monthly_budget_reached",
      message: subject + "本月累计消费已达到 " + config.limitUsd + " 美元",
    };
  }
  return {action: "continue"};
}

export function ingress(ctx) {
  if (ctx.config.budgetMode === "shared") {
    return checkBudget(ctx.config);
  }
  if (ctx.path === "/v1/realtime" && ctx.channel && Number.isSafeInteger(ctx.channel.id) && ctx.channel.id > 0) {
    return checkBudget(ctx.config, ctx.channel.id);
  }
  return {action: "continue"};
}

export function egress(ctx) {
  if (ctx.config.budgetMode === "shared") {
    return {action: "continue"};
  }
  if (!ctx.channel || !Number.isSafeInteger(ctx.channel.id) || ctx.channel.id <= 0) {
    return usageUnavailable();
  }
  return checkBudget(ctx.config, ctx.channel.id);
}

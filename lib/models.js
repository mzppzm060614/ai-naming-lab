// ============================================================
// modelConfigMap：模型配置表（阶段2 核心重构点）
// 把四个模型的「接口根地址、密钥环境变量名、模型名、展示名」集中放一起，
// 调用方只用一套代码，通过 modelKey 切换不同大模型。
// 密钥不写在这里，运行时从 process.env[envKey] 读取。
// 接口根地址 + /chat/completions 即为实际请求地址。
// ============================================================

export const modelConfigMap = {
  doubao: {
    label: '豆包（火山方舟）',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v1',
    envKey: 'DOUBAO_API_KEY',
    model: 'ep-xxxxxxxxxxxx', // 换成你在方舟控制台创建的接入点 ID
    note: '火山方舟 OpenAI 兼容接口',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
    model: 'deepseek-chat',
    note: 'DeepSeek 官方 OpenAI 兼容接口',
  },
  qwen: {
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
    model: 'qwen-plus',
    note: '阿里云 DashScope 兼容模式',
  },
  kimi: {
    label: 'Kimi（月之暗面）',
    baseURL: 'https://api.moonshot.cn/v1',
    envKey: 'MOONSHOT_API_KEY',
    model: 'kimi-k3',
    note: 'Moonshot OpenAI 兼容接口',
  },
};

/**
 * 根据 modelKey 取配置；找不到返回 null
 * @param {string} modelKey
 */
export function getModelConfig(modelKey) {
  if (!modelKey || !modelConfigMap[modelKey]) return null;
  return modelConfigMap[modelKey];
}

/**
 * 给前端用的公开模型列表：只返回展示信息，绝不带出密钥
 */
export function getPublicModelList() {
  return Object.entries(modelConfigMap).map(([key, cfg]) => ({
    key,
    label: cfg.label,
    model: cfg.model,
    note: cfg.note,
  }));
}

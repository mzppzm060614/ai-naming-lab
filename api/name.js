// ============================================================
// 阶段2：多模型切换 AI 起名（一套共用调用代码）
// 接口都挂在这一个文件里：
//   GET  /api/name   读取历史 + 返回可选模型列表（不含密钥）
//   POST /api/name   流式起名（按 modelKey 切换模型，SSE 转发）
//   POST /api/name {action:'history'}  把本次结果存进 Supabase
// 模型地址 / 密钥环境变量名 / 模型名统一放在 lib/models.js 的 modelConfigMap。
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getModelConfig, getPublicModelList } from '../lib/models.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SYSTEM_PROMPT = [
  '你是一名专业的起名顾问。',
  '根据用户给出的需求（姓氏、性别、风格、寓意偏好等），给出 3 组名字方案；',
  '每组名字单独列出，并附上一句简短的寓意解释。语言简洁、条理清楚。',
].join('');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(payload));
}

// ---- Supabase 客户端（anon 密钥，只在服务端使用）----
let supabaseCache = null;
function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  if (!supabaseCache) {
    supabaseCache = createClient(url, anonKey, {
      auth: { persistSession: false },
    });
  }
  return supabaseCache;
}

// ---- 历史：读取；同时把公开模型列表带给前端做下拉框 ----
async function handleHistoryGet(res, supabase) {
  const models = getPublicModelList();

  if (!supabase) {
    return sendJson(res, 200, {
      rows: [],
      models,
      warning: '未配置 Supabase 环境变量，暂时读不到历史',
    });
  }
  const { data, error } = await supabase
    .from('name_history')
    .select('id, user_requirement, name_result, model_name, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return sendJson(res, 500, { error: error.message });
  return sendJson(res, 200, { rows: data || [], models });
}

// ---- 历史：保存（带上本次使用的模型）----
async function handleHistoryPost(res, supabase, body) {
  const { prompt, result, modelKey } = body || {};
  if (!prompt || !result || !String(result).trim()) {
    return sendJson(res, 400, { error: 'prompt 和 result 不能为空' });
  }

  const cfg = getModelConfig(modelKey);
  const modelLabel = cfg ? cfg.label : modelKey || 'unknown';

  if (!supabase) {
    return sendJson(res, 200, {
      skipped: true,
      warning: '未配置 Supabase，本次未入库',
    });
  }
  const { data, error } = await supabase
    .from('name_history')
    .insert({
      user_requirement: String(prompt).slice(0, 500),
      name_result: String(result).slice(0, 5000),
      model_name: modelLabel,
    })
    .select()
    .single();

  if (error) return sendJson(res, 500, { error: error.message });
  return sendJson(res, 200, { row: data });
}

// ---- 流式起名：一套共用代码，按 modelKey 切换上游模型 ----
async function handleStream(req, res, body) {
  const { prompt, modelKey } = body || {};
  if (!prompt || !String(prompt).trim()) {
    return sendJson(res, 400, { error: '请输入起名需求（如：男孩、国风、简约）' });
  }

  const cfg = getModelConfig(modelKey);
  if (!cfg) {
    return sendJson(res, 400, { error: '所选模型不存在，请刷新后重试' });
  }

  const apiKey = process.env[cfg.envKey];
  if (!apiKey) {
    return sendJson(res, 500, {
      error: `未配置环境变量 ${cfg.envKey}，请在 .env 中填写`,
    });
  }

  const endpoint = `${cfg.baseURL}/chat/completions`;
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.8,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: String(prompt).trim() },
        ],
      }),
    });
  } catch (e) {
    return sendJson(res, 502, { error: `连接大模型失败：${e.message}` });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => '');
    return sendJson(res, 502, {
      error: `上游模型返回状态码 ${upstream.status}`,
      detail: detail.slice(0, 500),
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...CORS_HEADERS,
  });

  const reader = upstream.body.getReader();
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    reader.cancel().catch(() => {});
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: String(e) })}\n\n`);
  } finally {
    res.end();
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const supabase = getSupabase();

  if (req.method === 'GET') {
    return handleHistoryGet(res, supabase);
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: '请求体不是合法 JSON' });
    }
    if (body.action === 'history') {
      return handleHistoryPost(res, supabase, body);
    }
    return handleStream(req, res, body);
  }

  return sendJson(res, 405, { error: '仅支持 GET / POST 请求' });
}

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ensureHome } from "./home.js";

// 桥接配置：setup 生成，CLI 与 MCP 进程共读。token 用于本机任务 API 鉴权。

export function loadConfig(home) {
  const paths = ensureHome(home);
  if (!existsSync(paths.configFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(paths.configFile, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      apiPort: Number.isInteger(parsed.apiPort) ? parsed.apiPort : 47821,
      token: typeof parsed.token === "string" ? parsed.token : "",
      // defaultMode：可选字符串（run 的默认派发模式），没有就不带该键（保持旧返回
      // 形状，state.test 的 deepEqual 依赖）；合法性不在这里判——用的时候按枚举校验。
      ...(typeof parsed.defaultMode === "string" ? { defaultMode: parsed.defaultMode } : {}),
      // defaultModel：可选默认模型选择。形体同 create 的 modelSelection（{providerId,
      // modelId, options?{reasoningLevel}}），是纯对象（非 null/数组）才带该键；合法性
      // 在使用处按 /api/models 预校验，这里只管形状。
      ...(
        parsed.defaultModel !== null && typeof parsed.defaultModel === "object" && !Array.isArray(parsed.defaultModel)
          ? { defaultModel: parsed.defaultModel }
          : {}
      ),
    };
  } catch {
    return null;
  }
}

export function createInitialConfig() {
  return { apiPort: 47821, token: "" };
}

// 0600 原子写：token 不扩大可读面。
export function saveConfig(home, config) {
  const paths = ensureHome(home);
  atomicWriteJson(paths.configFile, config, { mode: 0o600 });
  return config;
}

export function updateConfig(home, mutate) {
  const current = loadConfig(home) ?? createInitialConfig();
  const next = { ...current, ...mutate };
  saveConfig(home, next);
  return next;
}

export function atomicWriteJson(file, value, { mode } = {}) {
  const tmp = join(dirname(file), `.${basenameOf(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: mode ?? 0o644 });
  if (mode !== undefined) {
    try {
      chmodSync(tmp, mode);
    } catch {
      // 平台不支持时保留默认权限
    }
  }
  renameSync(tmp, file);
}

function basenameOf(file) {
  return file.split(/[\\/]/u).at(-1) ?? file;
}

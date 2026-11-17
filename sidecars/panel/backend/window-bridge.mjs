/**
 * @fileoverview 双栖模式（Window Overlay）本地回环桥接服务与 CDP 多窗口自动挂载调度器。
 *
 * 职责边界：
 * 1. 在 Sidecar 进程内维护仅绑定 `127.0.0.1` 随机端口的受保护 HTTP 桥接端点，
 *    通过一次性 256-bit 随机令牌 (`X-Usage-Monitor-Token`)、严格 `Origin` 校验与 Private Network CORS 头，
 *    为主窗口 Shadow DOM 内的悬浮面板提供与辅助栏完全一致的 `/api/*` 遥测与控制接口；
 * 2. 周期性探测本机 `Antigravity/DevToolsActivePort`，发现所有打开的主聊天窗口（支持多窗口并存），
 *    按需将最新的 `styles.css` 与 `app.js` 热挂载至窗口顶栏，并在用户关闭双栖开关时立即清理卸载；
 * 3. 完全不触碰宿主 `app.asar` 文件，客户端升级或无调试端口时静默回退至右侧辅助栏。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DATA_DIR,
  computeRuntimeCodeVersion,
  loadJson,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import { createContextWindowSyncExpression } from './context-windows.mjs';

const BRIDGE_MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_BRIDGE_PATHS = new Set([
  '/api/telemetry',
  '/api/settings',
  '/api/settings/reset',
  '/api/cache/rebuild',
  '/api/accounts',
  '/api/accounts/update',
  '/api/context-window',
  '/api/cloud-sync',
  '/api/plugin-update',
]);

/**
 * 解析各操作系统下 Antigravity 2.0 与 Antigravity IDE 写入 `DevToolsActivePort` 的候选路径列表。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @param {string} [homeDir=homedir()]
 * @returns {string[]}
 */
export function resolveDevToolsPortCandidates(
  env = process.env,
  platform = process.platform,
  homeDir = homedir()
) {
  const explicitFile = String(env?.ANTIGRAVITY_DEVTOOLS_PORT_FILE || '').trim();
  if (explicitFile) {
    return [explicitFile];
  }
  if (platform === 'win32') {
    const appData = env?.APPDATA || join(homeDir, 'AppData', 'Roaming');
    const localAppData = env?.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    return [
      join(appData, 'Antigravity', 'DevToolsActivePort'),
      join(localAppData, 'Antigravity', 'DevToolsActivePort'),
      join(appData, 'Antigravity IDE', 'DevToolsActivePort'),
      join(localAppData, 'Antigravity IDE', 'DevToolsActivePort'),
    ];
  }
  if (platform === 'darwin') {
    return [
      join(homeDir, 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
      join(homeDir, 'Library', 'Application Support', 'Antigravity IDE', 'DevToolsActivePort'),
    ];
  }
  const configHome = env?.XDG_CONFIG_HOME || join(homeDir, '.config');
  return [
    join(configHome, 'Antigravity', 'DevToolsActivePort'),
    join(configHome, 'Antigravity IDE', 'DevToolsActivePort'),
  ];
}

/**
 * 解析 Antigravity IDE 启动参数文件 `argv.json` 路径（兼容便携模式 `VSCODE_PORTABLE`）。
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveIdeArgvPath(env = process.env, homeDir = homedir()) {
  const portableRoot = String(env?.VSCODE_PORTABLE || '').trim();
  if (portableRoot) {
    return join(portableRoot, 'argv.json');
  }
  return join(homeDir, '.antigravity-ide', 'argv.json');
}

/**
 * 词法扫描 JSONC 文本（支持 `//`、`/* ... * /` 注释与尾随逗号），提取纯 JSON 字符串及顶层键值坐标。
 *
 * @param {string} rawText
 */
function scanJsoncObject(rawText) {
  const text = rawText.startsWith('\uFEFF') ? rawText.slice(1) : rawText;
  const offsetDelta = rawText.length - text.length;
  const tokens = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const closeIdx = text.indexOf('*/', i + 2);
      if (closeIdx < 0) return null;
      i = closeIdx + 2;
      continue;
    }
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < len) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      const rawToken = text.slice(start, i);
      let strVal = null;
      try {
        strVal = JSON.parse(rawToken);
      } catch {
        return null;
      }
      tokens.push({
        type: 'string',
        value: strVal,
        raw: rawToken,
        start: start + offsetDelta,
        end: i + offsetDelta,
      });
      continue;
    }
    if ('{}[]:,'.includes(ch)) {
      tokens.push({
        type: 'punct',
        raw: ch,
        start: i + offsetDelta,
        end: i + 1 + offsetDelta,
      });
      i += 1;
      continue;
    }
    const start = i;
    while (
      i < len &&
      !' \t\r\n{}[]:,"'.includes(text[i]) &&
      !(text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
    ) {
      i += 1;
    }
    tokens.push({
      type: 'primitive',
      raw: text.slice(start, i),
      start: start + offsetDelta,
      end: i + offsetDelta,
    });
  }

  if (tokens.length < 2 || tokens[0].raw !== '{' || tokens[tokens.length - 1].raw !== '}') {
    return null;
  }

  const cleanParts = [];
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    const nextTok = tokens[idx + 1];
    if (tok.raw === ',' && nextTok && (nextTok.raw === '}' || nextTok.raw === ']')) {
      continue;
    }
    cleanParts.push(tok.raw);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(cleanParts.join(''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const topProps = new Map();
  let depth = 0;
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx];
    if (tok.raw === '{' || tok.raw === '[') {
      depth += 1;
      continue;
    }
    if (tok.raw === '}' || tok.raw === ']') {
      depth -= 1;
      continue;
    }
    if (depth === 1 && tok.type === 'string' && tokens[idx + 1]?.raw === ':') {
      const valFirst = tokens[idx + 2];
      if (!valFirst) break;
      let valLastIdx = idx + 2;
      if (valFirst.raw === '{' || valFirst.raw === '[') {
        let subDepth = 1;
        valLastIdx += 1;
        while (valLastIdx < tokens.length && subDepth > 0) {
          if (tokens[valLastIdx].raw === '{' || tokens[valLastIdx].raw === '[') subDepth += 1;
          else if (tokens[valLastIdx].raw === '}' || tokens[valLastIdx].raw === ']') subDepth -= 1;
          if (subDepth > 0) valLastIdx += 1;
        }
      }
      const valLast = tokens[valLastIdx] || valFirst;
      topProps.set(tok.value, {
        keyStart: tok.start,
        valStart: valFirst.start,
        valEnd: valLast.end,
      });
      idx = valLastIdx;
    }
  }

  const closeTok = tokens[tokens.length - 1];
  const prevTok = tokens[tokens.length - 2];
  return {
    parsed,
    topProps,
    closeBraceIdx: closeTok.start,
    lastSigEndIdx: prevTok.end,
    lastSigRaw: prevTok.raw,
  };
}

/**
 * 在保留全部 JSONC 注释、缩进与既有键的前提下，确保 `argv.json` 包含字符串类型的
 * `"remote-debugging-port"`（Antigravity IDE 主进程仅接受非空字符串值，数值 `0` 会被忽略）。
 *
 * @param {string} rawText
 * @returns {{ changed: boolean, valid: boolean, alreadyConfigured?: boolean, portValue?: string, reason?: string, text: string }}
 */
export function ensureRemoteDebuggingInArgvText(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    const fresh =
      '{\n\t// Automatically configured by Antigravity Usage & Speed Monitor for topbar overlay support.\n\t"remote-debugging-port": "0"\n}\n';
    return { changed: true, valid: true, portValue: '0', text: fresh };
  }

  const scanned = scanJsoncObject(rawText);
  if (!scanned) {
    return { changed: false, valid: false, reason: 'invalid_jsonc', text: rawText };
  }

  const existingVal = scanned.parsed['remote-debugging-port'];
  if (typeof existingVal === 'string' && existingVal.trim().length > 0) {
    return {
      changed: false,
      valid: true,
      alreadyConfigured: true,
      portValue: existingVal.trim(),
      text: rawText,
    };
  }

  const desiredPortStr =
    typeof existingVal === 'number' &&
    Number.isInteger(existingVal) &&
    existingVal >= 0 &&
    existingVal <= 65535
      ? String(existingVal)
      : '0';

  const eol = rawText.includes('\r\n') ? '\r\n' : '\n';
  const indentMatch = rawText.match(/^[ \t]+(?=")/m);
  const indent = indentMatch ? indentMatch[0] : '\t';

  let nextText = '';
  const propSpan = scanned.topProps.get('remote-debugging-port');
  if (propSpan) {
    nextText =
      rawText.slice(0, propSpan.valStart) +
      JSON.stringify(desiredPortStr) +
      rawText.slice(propSpan.valEnd);
  } else {
    let working = rawText;
    let closeIdx = scanned.closeBraceIdx;
    if (scanned.lastSigRaw !== '{' && scanned.lastSigRaw !== ',') {
      working =
        working.slice(0, scanned.lastSigEndIdx) + ',' + working.slice(scanned.lastSigEndIdx);
      closeIdx += 1;
    }
    let insertPos = closeIdx;
    while (insertPos > 0 && (working[insertPos - 1] === ' ' || working[insertPos - 1] === '\t')) {
      insertPos -= 1;
    }
    const hasNewlineBeforeClose =
      insertPos > 0 && (working[insertPos - 1] === '\n' || working[insertPos - 1] === '\r');
    const insertion = hasNewlineBeforeClose
      ? `${indent}"remote-debugging-port": ${JSON.stringify(desiredPortStr)}${eol}`
      : `${eol}${indent}"remote-debugging-port": ${JSON.stringify(desiredPortStr)}${eol}`;
    nextText = working.slice(0, insertPos) + insertion + working.slice(insertPos);
  }

  const verifyScan = scanJsoncObject(nextText);
  if (!verifyScan || verifyScan.parsed['remote-debugging-port'] !== desiredPortStr) {
    return { changed: false, valid: false, reason: 'post_check_failed', text: rawText };
  }

  return {
    changed: true,
    valid: true,
    portValue: desiredPortStr,
    text: nextText,
  };
}

/**
 * 当本机存在 `~/.antigravity-ide` 配置目录且开启双栖模式时，自动补齐 `argv.json` 中的
 * `"remote-debugging-port": "0"`，使 Antigravity IDE 下次启动时自动生成 `DevToolsActivePort`。
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, enabled?: boolean }} [options]
 */
export function ensureIdeRemoteDebuggingArgv({
  env = process.env,
  homeDir = homedir(),
  enabled = true,
} = {}) {
  if (!enabled) {
    return { checked: false, updated: false, reason: 'disabled' };
  }
  const argvPath = resolveIdeArgvPath(env, homeDir);
  try {
    const dirPath = dirname(argvPath);
    if (!existsSync(dirPath)) {
      return { checked: true, updated: false, reason: 'ide_dir_missing', argvPath };
    }
    const rawText = existsSync(argvPath) ? readFileSync(argvPath, 'utf8') : '';
    const patched = ensureRemoteDebuggingInArgvText(rawText);
    if (!patched.valid) {
      return { checked: true, updated: false, reason: patched.reason || 'invalid_jsonc', argvPath };
    }
    if (!patched.changed) {
      return {
        checked: true,
        updated: false,
        alreadyConfigured: true,
        portValue: patched.portValue,
        argvPath,
      };
    }
    const tmpPath = `${argvPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, patched.text, 'utf8');
      renameSync(tmpPath, argvPath);
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {
        // 忽略临时文件清理异常
      }
      writeFileSync(argvPath, patched.text, 'utf8');
    }
    return {
      checked: true,
      updated: true,
      portValue: patched.portValue,
      argvPath,
    };
  } catch (err) {
    return {
      checked: true,
      updated: false,
      reason: err?.code || 'io_error',
      argvPath,
    };
  }
}

/**
 * 从 `DevToolsActivePort` 文件文本首行提取合法的本地调试端口号。
 *
 * @param {string} rawText
 * @returns {number|null}
 */
export function parseDevToolsPortFile(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const firstLine = rawText.split(/\r?\n/)[0]?.trim() || '';
  if (!/^\d+$/.test(firstLine)) return null;
  const port = Number(firstLine);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

const IDE_WORKBENCH_URL_RE =
  /^vscode-file:\/\/vscode-app\/.+\/workbench(?:\.esm|-jetski-agent)?\.html(?:[?#]|$)/i;

/**
 * 判断 CDP `/json/list` 返回的目标是否为 Antigravity 2.0 或 Antigravity IDE 主窗口页面，
 * 严格排除 `vscode-webview://` 子视图、`sharedProcess.html`、DevTools 面板与非本机回环地址。
 *
 * @param {object} target
 * @returns {boolean}
 */
export function isAntigravityMainPageTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.type !== 'page') return false;
  const url = String(target.url || '').trim();
  const wsUrl = String(target.webSocketDebuggerUrl || '').trim();
  const isLoopbackAppPage = /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url);
  const isIdeWorkbenchPage = IDE_WORKBENCH_URL_RE.test(url);
  if (!isLoopbackAppPage && !isIdeWorkbenchPage) {
    return false;
  }
  if (!/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(wsUrl)) {
    return false;
  }
  return true;
}

/**
 * 从 Antigravity IDE 内嵌扩展聊天 iframe 地址（如 `http://127.0.0.1:41362/c/<uuid>?extensionView=true`）
 * 中提取当前正在查看的会话 UUID。
 *
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function extractIdeExtensionCascadeId(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(url)) {
    return '';
  }
  if (!/[?&]extension(?:View|Variant)=/i.test(url)) {
    return '';
  }
  const m = url.match(
    /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
  );
  return m ? m[1] : '';
}

/**
 * 判断 CDP 目标是否为 Antigravity IDE 内嵌扩展聊天视图（OOPIF `iframe`），
 * 严格限定本机回环地址并校验 `extensionView`/`extensionVariant` 参数、`/c/<uuid>` 路由或已发现的 LS Hub 端口。
 *
 * @param {object} target
 * @param {string} [lsAddr='']
 * @returns {boolean}
 */
export function isIdeExtensionChatTarget(target, lsAddr = '') {
  if (!target || typeof target !== 'object') return false;
  if (isAntigravityMainPageTarget(target)) return false;
  const type = String(target.type || '').trim().toLowerCase();
  if (type !== 'iframe' && type !== 'webview' && type !== 'page') return false;
  const url = String(target.url || '').trim();
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(url)) {
    return false;
  }
  if (/[?&]extension(?:View|Variant)=/i.test(url)) {
    return true;
  }
  if (
    /\/c\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(url)
  ) {
    return true;
  }
  const cleanLsAddr = String(lsAddr || '').trim().toLowerCase();
  if (cleanLsAddr) {
    try {
      const parsed = new URL(url);
      if (parsed.host.toLowerCase() === cleanLsAddr) {
        return true;
      }
    } catch {
      // 忽略非法 URL
    }
  }
  return false;
}

/**
 * 将同一调试端口下的扩展聊天子 iframe 会话路由与可注入聊天目标（按 `parentId` 树隔离，单窗口缺省时安全兜底）
 * 关联到对应的 Antigravity IDE `workbench.html` 主窗口目标上。
 *
 * @param {Array<object>} rawTargets
 * @param {Array<object>} mainTargets
 * @param {{ lsAddr?: string, cdpPort?: number }} [options]
 * @returns {Array<object>}
 */
export function associateIdeIframeRoutes(rawTargets, mainTargets, options = undefined) {
  if (!Array.isArray(mainTargets) || mainTargets.length === 0) return [];
  const lsAddr = String(options?.lsAddr || '').trim();
  const cdpPort = Number(options?.cdpPort || 0);
  const allList = Array.isArray(rawTargets) ? rawTargets : mainTargets;
  const byId = new Map();
  for (const t of allList) {
    if (t && typeof t === 'object' && t.id) {
      byId.set(String(t.id), t);
    }
  }

  const ideTargets = mainTargets.filter((t) =>
    IDE_WORKBENCH_URL_RE.test(String(t?.url || '').trim())
  );
  const mainIdeIds = new Set(ideTargets.map((t) => String(t?.id || '')).filter(Boolean));
  const routeByMainId = new Map();
  const unanchoredRoutes = [];
  const chatTargetsByMainId = new Map();
  const unanchoredChatTargets = [];

  for (const t of allList) {
    if (!t || typeof t !== 'object') continue;
    if (t.type !== 'iframe' && isAntigravityMainPageTarget(t)) continue;

    const isChatFrame = isIdeExtensionChatTarget(t, lsAddr);
    const cascadeId = extractIdeExtensionCascadeId(t.url);
    if (!cascadeId && !isChatFrame) continue;

    let matchedMainId = '';
    let curId = String(t.parentId || '').trim();
    const visited = new Set();
    while (curId && !visited.has(curId)) {
      visited.add(curId);
      if (mainIdeIds.has(curId)) {
        matchedMainId = curId;
        break;
      }
      const parentTarget = byId.get(curId);
      curId = parentTarget ? String(parentTarget.parentId || '').trim() : '';
    }

    if (cascadeId) {
      if (matchedMainId) {
        if (!routeByMainId.has(matchedMainId)) {
          routeByMainId.set(matchedMainId, cascadeId);
        }
      } else {
        unanchoredRoutes.push(cascadeId);
      }
    }

    if (isChatFrame) {
      const rawUrl = String(t.url || '').trim();
      const rawWs = String(t.webSocketDebuggerUrl || '').trim();
      let wsUrl = '';
      if (/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(rawWs)) {
        wsUrl = rawWs;
      } else if (cdpPort > 0 && t.id) {
        wsUrl = `ws://127.0.0.1:${cdpPort}/devtools/page/${encodeURIComponent(String(t.id))}`;
      }
      let origin = '';
      try {
        origin = new URL(rawUrl).origin;
      } catch {
        // 忽略非法 URL
      }
      const fallbackUuidMatch = rawUrl.match(
        /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
      );
      const chatEntry = {
        id: String(t.id || ''),
        url: rawUrl,
        origin,
        cascadeId: cascadeId || (fallbackUuidMatch ? fallbackUuidMatch[1] : ''),
        webSocketDebuggerUrl: wsUrl,
        isIdeChatFrame: true,
      };
      if (matchedMainId) {
        if (!chatTargetsByMainId.has(matchedMainId)) {
          chatTargetsByMainId.set(matchedMainId, []);
        }
        chatTargetsByMainId.get(matchedMainId).push(chatEntry);
      } else {
        unanchoredChatTargets.push(chatEntry);
      }
    }
  }

  return mainTargets.map((t) => {
    const isIde = IDE_WORKBENCH_URL_RE.test(String(t?.url || '').trim());
    if (!isIde) {
      return {
        ...t,
        isIdeWorkbench: false,
        ideRouteCascadeId: '',
        ideChatTargets: [],
      };
    }
    const tid = String(t?.id || '');
    let routeId = (tid && routeByMainId.get(tid)) || '';
    if (!routeId && ideTargets.length === 1 && unanchoredRoutes.length > 0) {
      routeId = unanchoredRoutes[0];
    }
    let chatTargets = tid && chatTargetsByMainId.has(tid) ? [...chatTargetsByMainId.get(tid)] : [];
    if (chatTargets.length === 0 && ideTargets.length === 1 && unanchoredChatTargets.length > 0) {
      chatTargets = [...unanchoredChatTargets];
    }
    return {
      ...t,
      isIdeWorkbench: true,
      ideRouteCascadeId: routeId,
      ideChatTargets: chatTargets,
    };
  });
}

/**
 * 校验桥接请求的 `Origin` 是否来自本机 Antigravity 2.0 HTTPS 回环源或 Antigravity IDE `vscode-file` 源。
 *
 * @param {unknown} origin
 * @returns {boolean}
 */
export function isAllowedBridgeOrigin(origin) {
  const text = String(origin || '').trim();
  return (
    /^https:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(text) ||
    /^vscode-file:\/\/vscode-app$/i.test(text)
  );
}

/**
 * 固定时间比较两个等长 ASCII 令牌字符串，避免时序侧信道泄露。
 *
 * @param {string} actual
 * @param {string} expected
 * @param {typeof import('node:crypto').timingSafeEqual|null} [timingSafeEqualFn=null]
 * @returns {boolean}
 */
function verifyBridgeToken(actual, expected, timingSafeEqualFn = null) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  if (actual.length !== expected.length) return false;
  if (typeof timingSafeEqualFn === 'function') {
    return timingSafeEqualFn(Buffer.from(actual, 'utf8'), Buffer.from(expected, 'utf8'));
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 创建双栖模式桥接与 CDP 热挂载控制器实例。
 *
 * @param {{
 *   handleApiRequest: (pathname: string, method: string, data: Record<string, any>) => Promise<{ status: number, contentType?: string, headers?: Record<string, string>, body: string }>,
 *   readAssetFn: (relPath: string) => Promise<string>,
 *   getSettingsFn?: () => { enableWindowOverlay?: boolean },
 *   getBundleVersionFn?: () => string,
 *   env?: Record<string, string|undefined>,
 *   platform?: string,
 *   homeDir?: string,
 *   pollIntervalMs?: number,
 *   cdpTimeoutMs?: number,
 *   WebSocketImpl?: typeof WebSocket,
 * }} options
 */
export function createWindowBridgeController(options) {
  const {
    handleApiRequest,
    readAssetFn,
    getSettingsFn = loadSettings,
    getBundleVersionFn = computeRuntimeCodeVersion,
    env = process.env,
    platform = process.platform,
    homeDir = homedir(),
    pollIntervalMs = 3000,
    fastPollIntervalMs = 1500,
    cdpTimeoutMs = 3500,
    bootBundleVersion = '',
    onVersionDrift = null,
    leaseFilePath = '',
    autoConfigureIdeArgv = options?.env === undefined && options?.homeDir === undefined,
    WebSocketImpl = null,
  } = options || {};
  const customWebSocketImpl = typeof WebSocketImpl === 'function' ? WebSocketImpl : null;

  function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  }

  let server = null;
  let serverStartPromise = null;
  let bridgePort = 0;
  let bridgeToken = '';
  let pollTimer = null;
  let initialTimer = null;
  let stopped = false;
  let syncInFlight = null;
  let hadInjectedTargets = false;
  let hadInjectedChatFrames = false;
  let cdpFallbackActive = false;
  let ideArgvProvisioned = false;
  let hadContextWindows = false;
  let contextWindowBootId = `${process.pid}:${Date.now()}`;
  let nodeDepsPromise = null;
  const allowedDynamicOrigins = new Set();

  async function loadNodeDeps() {
    if (!nodeDepsPromise) {
      nodeDepsPromise = Promise.all([import('node:http'), import('node:crypto')]).then(
        ([httpMod, cryptoMod]) => ({
          http: httpMod.default || httpMod,
          crypto: cryptoMod.default || cryptoMod,
        })
      );
    }
    return nodeDepsPromise;
  }

  function applyCorsHeaders(res, origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Usage-Monitor-Token');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
  }

  async function executeRpcBatch(rpcBatch) {
    const responses = [];
    for (const item of rpcBatch) {
      const reqId = String(item?.id || '');
      if (!reqId) continue;
      try {
        const parsedUrl = new URL(String(item.path || '/'), 'http://127.0.0.1');
        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          responses.push({ id: reqId, ok: false, status: 404, error: 'Not found' });
          continue;
        }
        const method = String(item.method || 'GET').toUpperCase();
        const reqData =
          method === 'GET'
            ? Object.fromEntries(parsedUrl.searchParams.entries())
            : item.body && typeof item.body === 'object'
              ? item.body
              : {};
        const out = await handleApiRequest(parsedUrl.pathname, method, reqData);
        const status = Number(out?.status || 200);
        const parsedBody = out?.body ? JSON.parse(out.body) : {};
        if (status >= 200 && status < 300) {
          responses.push({ id: reqId, ok: true, status, data: parsedBody });
        } else {
          responses.push({
            id: reqId,
            ok: false,
            status,
            error: parsedBody?.error || `HTTP ${status}`,
          });
        }
      } catch (err) {
        responses.push({
          id: reqId,
          ok: false,
          status: 500,
          error: err?.message || 'Internal bridge error',
        });
      }
    }
    return responses;
  }

  async function ensureBridgeServer() {
    if (server && bridgePort > 0) {
      return { port: bridgePort, token: bridgeToken };
    }
    if (serverStartPromise) {
      return serverStartPromise;
    }
    serverStartPromise = (async () => {
      const { http, crypto } = await loadNodeDeps();
      const persistedLease = leaseFilePath ? loadJson(leaseFilePath, null) : null;
      const persistedToken = String(persistedLease?.bridgeToken || '').trim();
      const persistedPort = Number(persistedLease?.bridgePort || 0);
      if (!bridgeToken) {
        bridgeToken = /^[0-9a-f]{64}$/i.test(persistedToken)
          ? persistedToken
          : crypto.randomBytes(32).toString('hex');
      }

      const srv = http.createServer((req, res) => {
        // 注意：主窗口为 https://127.0.0.1，桥接为 http://127.0.0.1，跨协议请求在 Chromium 中必然携带
        // Sec-Fetch-Site: cross-site；此处通过严格 Origin 白名单 + Host 校验 + 256-bit 随机令牌保障回环安全。
        const origin = String(req.headers.origin || '').trim();
        if (!isAllowedBridgeOrigin(origin) && !allowedDynamicOrigins.has(origin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden origin' }));
          return;
        }

        const hostHeader = String(req.headers.host || '').trim().toLowerCase();
        if (
          hostHeader &&
          hostHeader !== `127.0.0.1:${bridgePort}` &&
          hostHeader !== `localhost:${bridgePort}` &&
          hostHeader !== `[::1]:${bridgePort}`
        ) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden host' }));
          return;
        }

        applyCorsHeaders(res, origin);

        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        let parsedUrl;
        try {
          parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${bridgePort}`);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Malformed URL' }));
          return;
        }

        if (!ALLOWED_BRIDGE_PATHS.has(parsedUrl.pathname)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        const headerToken = String(req.headers['x-usage-monitor-token'] || '');
        if (!verifyBridgeToken(headerToken, bridgeToken, crypto.timingSafeEqual)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid bridge token' }));
          return;
        }

        if (method === 'GET') {
          const queryData = Object.fromEntries(parsedUrl.searchParams.entries());
          Promise.resolve(handleApiRequest(parsedUrl.pathname, 'GET', queryData))
            .then((out) => {
              const hdrs = {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              };
              res.writeHead(out.status || 200, hdrs);
              res.end(out.body);
            })
            .catch(() => {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
              }
              res.end(JSON.stringify({ error: 'Internal bridge error' }));
            });
          return;
        }

        if (method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        let aborted = false;
        req.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > BRIDGE_MAX_BODY_BYTES) {
            aborted = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Payload too large' }));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          let bodyObj = {};
          try {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            bodyObj = raw ? JSON.parse(raw) : {};
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
            return;
          }
          Promise.resolve(handleApiRequest(parsedUrl.pathname, 'POST', bodyObj))
            .then((out) => {
              const hdrs = {
                'Content-Type': out.contentType || 'application/json',
                ...(out.headers || {}),
              };
              res.writeHead(out.status || 200, hdrs);
              res.end(out.body);
            })
            .catch(() => {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
              }
              res.end(JSON.stringify({ error: 'Internal bridge error' }));
            });
        });
      });

      const listenOnLoopback = (targetPort) =>
        new Promise((resolve, reject) => {
          const onErr = (err) => {
            srv.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            srv.removeListener('error', onErr);
            resolve();
          };
          srv.once('error', onErr);
          srv.once('listening', onListening);
          srv.listen(targetPort, '127.0.0.1');
        });

      const preferredPort =
        Number.isInteger(persistedPort) && persistedPort >= 1024 && persistedPort <= 65535
          ? persistedPort
          : 0;
      if (preferredPort > 0) {
        try {
          await listenOnLoopback(preferredPort);
        } catch {
          await listenOnLoopback(0);
        }
      } else {
        await listenOnLoopback(0);
      }
      srv.unref?.();
      const addr = srv.address();
      bridgePort = typeof addr === 'object' && addr ? Number(addr.port || 0) : 0;
      server = srv;
      if (leaseFilePath && bridgePort > 0) {
        saveJson(leaseFilePath, {
          pid: process.pid,
          bundleVersion: String(getBundleVersionFn() || ''),
          bridgePort,
          bridgeToken,
          updatedAtMs: Date.now(),
        });
      }
      return { port: bridgePort, token: bridgeToken };
    })().finally(() => {
      serverStartPromise = null;
    });

    return serverStartPromise;
  }

  function findActiveDevToolsPorts() {
    const candidates = resolveDevToolsPortCandidates(env, platform, homeDir);
    const ports = [];
    const seen = new Set();
    for (const filePath of candidates) {
      try {
        if (!existsSync(filePath)) continue;
        const port = parseDevToolsPortFile(readFileSync(filePath, 'utf8'));
        if (port && !seen.has(port)) {
          seen.add(port);
          ports.push(port);
        }
      } catch {
        // 忽略不可读候选文件
      }
    }
    return ports;
  }

  async function listMainWindowTargets(cdpPort) {
    const { http } = await loadNodeDeps();
    const rawBody = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`CDP HTTP ${res.statusCode}`));
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve(text));
      });
      req.setTimeout(1500, () => req.destroy(new Error('CDP list timeout')));
      req.on('error', reject);
    });
    const parsed = JSON.parse(rawBody);
    if (!Array.isArray(parsed)) return [];
    const associated = associateIdeIframeRoutes(
      parsed,
      parsed.filter(isAntigravityMainPageTarget),
      { lsAddr: lsRuntimeEndpoint.addr, cdpPort }
    );
    for (const mainT of associated) {
      if (Array.isArray(mainT.ideChatTargets)) {
        for (const ct of mainT.ideChatTargets) {
          if (ct.origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/i.test(ct.origin)) {
            allowedDynamicOrigins.add(ct.origin);
          }
        }
      }
    }
    return associated;
  }

  function collectAllChatDebuggerUrls(mainTargets) {
    const urls = [];
    const seen = new Set();
    for (const t of mainTargets) {
      if (!Array.isArray(t?.ideChatTargets)) continue;
      for (const ct of t.ideChatTargets) {
        const wsUrl = String(ct?.webSocketDebuggerUrl || '').trim();
        if (wsUrl && !seen.has(wsUrl)) {
          seen.add(wsUrl);
          urls.push(wsUrl);
        }
      }
    }
    return urls;
  }

  async function collectAllMainWindowTargets(cdpPorts) {
    const settled = await Promise.allSettled(cdpPorts.map((p) => listMainWindowTargets(p)));
    let reachableCount = 0;
    const merged = [];
    const seenWs = new Set();
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        reachableCount += 1;
        for (const target of item.value) {
          const wsKey = String(target.webSocketDebuggerUrl || '');
          if (wsKey && !seenWs.has(wsKey)) {
            seenWs.add(wsKey);
            merged.push(target);
          }
        }
      }
    }
    return { reachableCount, targets: merged };
  }

  function isLoopbackWsUrl(rawUrl) {
    return /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/|$)/i.test(String(rawUrl || '').trim());
  }

  function encodeMaskedWsFrame(cryptoMod, opcode, textOrBuf) {
    const payload = Buffer.isBuffer(textOrBuf) ? textOrBuf : Buffer.from(String(textOrBuf || ''), 'utf8');
    const len = payload.length;
    let hdr;
    if (len < 126) {
      hdr = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | len]);
    } else if (len <= 65535) {
      hdr = Buffer.allocUnsafe(4);
      hdr[0] = 0x80 | (opcode & 0x0f);
      hdr[1] = 0x80 | 126;
      hdr.writeUInt16BE(len, 2);
    } else {
      hdr = Buffer.allocUnsafe(10);
      hdr[0] = 0x80 | (opcode & 0x0f);
      hdr[1] = 0x80 | 127;
      hdr.writeUInt32BE(Math.floor(len / 4294967296), 2);
      hdr.writeUInt32BE(len >>> 0, 6);
    }
    const mask = cryptoMod.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) {
      masked[i] = payload[i] ^ mask[i & 3];
    }
    return Buffer.concat([hdr, mask, masked]);
  }

  async function evaluateViaRawLoopbackWebSocket(wsUrl, expression) {
    const { http, crypto } = await loadNodeDeps();
    const parsed = new URL(wsUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = Number(parsed.port) || 80;
    const pathWithQuery = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const wsKey = crypto.randomBytes(16).toString('base64');

    return new Promise((resolve, reject) => {
      let settled = false;
      let sock = null;
      let recvBuf = Buffer.alloc(0);
      let msgChunks = [];
      const timer = setTimeout(() => {
        finish(new Error('CDP Runtime.evaluate timeout'));
      }, cdpTimeoutMs);

      function finish(err, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sock) {
          try {
            sock.destroy();
          } catch {
            // 忽略 socket 销毁异常
          }
        }
        if (err) reject(err);
        else resolve(value);
      }

      const req = http.request({
        hostname,
        port,
        path: pathWithQuery,
        method: 'GET',
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': wsKey,
        },
      });

      req.on('error', (err) => finish(err));
      req.on('response', (res) => {
        res.resume();
        finish(new Error(`CDP WebSocket upgrade rejected (${res.statusCode || 0})`));
      });

      function pumpFrames() {
        while (recvBuf.length >= 2 && !settled) {
          const b0 = recvBuf[0];
          const b1 = recvBuf[1];
          const fin = (b0 & 0x80) !== 0;
          const opcode = b0 & 0x0f;
          const isMasked = (b1 & 0x80) !== 0;
          let len = b1 & 0x7f;
          let offset = 2;

          if (len === 126) {
            if (recvBuf.length < offset + 2) break;
            len = recvBuf.readUInt16BE(offset);
            offset += 2;
          } else if (len === 127) {
            if (recvBuf.length < offset + 8) break;
            len = recvBuf.readUInt32BE(offset) * 4294967296 + recvBuf.readUInt32BE(offset + 4);
            offset += 8;
          }

          let maskKey = null;
          if (isMasked) {
            if (recvBuf.length < offset + 4) break;
            maskKey = recvBuf.subarray(offset, offset + 4);
            offset += 4;
          }

          if (recvBuf.length < offset + len) break;
          let payload = recvBuf.subarray(offset, offset + len);
          recvBuf = recvBuf.subarray(offset + len);

          if (maskKey) {
            const unmasked = Buffer.allocUnsafe(payload.length);
            for (let i = 0; i < payload.length; i += 1) {
              unmasked[i] = payload[i] ^ maskKey[i & 3];
            }
            payload = unmasked;
          }

          if (opcode === 0x8) {
            finish(new Error('CDP WebSocket closed before response'));
            return;
          }
          if (opcode === 0x9) {
            try {
              sock?.write(encodeMaskedWsFrame(crypto, 0x0a, payload));
            } catch {
              // 忽略 Pong 写入异常
            }
            continue;
          }
          if (opcode === 0xa) {
            continue;
          }
          if (opcode === 0x1 || opcode === 0x0) {
            msgChunks.push(payload);
            if (fin) {
              const rawText = Buffer.concat(msgChunks).toString('utf8');
              msgChunks = [];
              try {
                const msg = JSON.parse(rawText);
                if (msg && msg.id === 1) {
                  finish(null, msg);
                  return;
                }
              } catch {
                // 忽略无关事件帧
              }
            }
          }
        }
      }

      req.on('upgrade', (_res, socket, head) => {
        sock = socket;
        sock.setNoDelay?.(true);
        sock.on('error', (err) => finish(err));
        sock.on('close', () => finish(new Error('CDP WebSocket socket closed')));
        sock.on('data', (chunk) => {
          recvBuf = recvBuf.length > 0 ? Buffer.concat([recvBuf, chunk]) : chunk;
          pumpFrames();
        });

        try {
          const cmd = JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression,
              returnByValue: true,
              awaitPromise: true,
            },
          });
          sock.write(encodeMaskedWsFrame(crypto, 0x1, cmd));
        } catch (err) {
          finish(err);
          return;
        }

        if (head && head.length > 0) {
          recvBuf = Buffer.concat([recvBuf, head]);
          pumpFrames();
        }
      });

      req.end();
    });
  }

  async function evaluateWithWebSocketImpl(WS, wsUrl, expression) {
    let ws = null;
    let timer = null;
    try {
      ws = new WS(wsUrl);
      const evalResult = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('CDP Runtime.evaluate timeout'));
        }, cdpTimeoutMs);

        const onOpen = () => {
          try {
            ws.send(
              JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                  expression,
                  returnByValue: true,
                  awaitPromise: true,
                },
              })
            );
          } catch (err) {
            reject(err);
          }
        };

        const onMessage = (ev) => {
          try {
            const raw = typeof ev?.data === 'string' ? ev.data : String(ev?.data || '');
            const msg = JSON.parse(raw);
            if (msg && msg.id === 1) {
              resolve(msg);
            }
          } catch {
            // 忽略无关事件帧
          }
        };

        const onError = (err) => {
          reject(err instanceof Error ? err : new Error('CDP WebSocket error'));
        };

        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('message', onMessage);
        ws.addEventListener('error', onError, { once: true });
      });
      return evalResult;
    } finally {
      if (timer) clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch {
          // 忽略关闭异常
        }
      }
    }
  }

  async function evaluateOnTarget(wsUrl, expression) {
    const WS = customWebSocketImpl || globalThis.WebSocket;
    if (typeof WS === 'function') {
      try {
        return await evaluateWithWebSocketImpl(WS, wsUrl, expression);
      } catch (err) {
        // Node.js 24 内置 undici WebSocket 会按 WHATWG Fetch 规范拦截 6665-6669 等端口；
        // 当无显式注入 Mock WebSocket 且目标为本机回环地址时，无缝降级为 node:http RFC 6455 直连。
        if (!customWebSocketImpl && isLoopbackWsUrl(wsUrl)) {
          return evaluateViaRawLoopbackWebSocket(wsUrl, expression);
        }
        throw err;
      }
    }
    if (isLoopbackWsUrl(wsUrl)) {
      return evaluateViaRawLoopbackWebSocket(wsUrl, expression);
    }
    throw new Error('WebSocket runtime unavailable');
  }

  async function runSyncInternal({ forceReinject = false } = {}) {
    if (stopped) return { ok: false, reason: 'stopped' };
    const bundleVersion = String(getBundleVersionFn() || '');
    if (bootBundleVersion && bundleVersion && bundleVersion !== String(bootBundleVersion)) {
      onVersionDrift?.();
      return { ok: false, reason: 'version_drift_restarting', injected: 0 };
    }

    const curSettings = getSettingsFn() || {};
    const mountMode = normalizeWindowMountMode(
      curSettings.windowMountMode,
      curSettings.enableWindowOverlay
    );
    const enabled = Boolean(curSettings.enableWindowOverlay !== false && mountMode !== 'sidebar');
    const contextWindows = curSettings.modelContextWindows || {};
    const hasContextWindows = Object.keys(contextWindows).length > 0;
    if ((enabled || hasContextWindows) && autoConfigureIdeArgv && !ideArgvProvisioned) {
      const prov = ensureIdeRemoteDebuggingArgv({ env, homeDir, enabled: true });
      if (prov.updated || prov.alreadyConfigured || prov.reason === 'ide_dir_missing') {
        ideArgvProvisioned = true;
      }
    }

    if ((enabled || hasContextWindows) && leaseFilePath && !forceReinject) {
      const lease = loadJson(leaseFilePath, null);
      const leasePid = Number(lease?.pid || 0);
      const leaseAgeMs = Date.now() - Number(lease?.updatedAtMs || 0);
      if (leasePid > 0 && leasePid !== process.pid && leaseAgeMs >= 0 && leaseAgeMs < 9000 && isPidAlive(leasePid)) {
        const leaseVerNum = Number(lease?.bundleVersion) || 0;
        const myVerNum = Number(bundleVersion) || 0;
        if (leaseVerNum > myVerNum) {
          onVersionDrift?.();
          return { ok: false, enabled: true, reason: 'older_than_leader', injected: 0 };
        }
        if (leaseVerNum === myVerNum || String(lease?.bundleVersion || '') === bundleVersion) {
          return { ok: true, enabled: true, reason: 'follower_yield', leaderPid: leasePid, injected: 0 };
        }
      }
      saveJson(leaseFilePath, {
        pid: process.pid,
        bundleVersion,
        bridgePort: bridgePort > 0 ? bridgePort : Number(lease?.bridgePort || 0) || undefined,
        bridgeToken: bridgeToken || String(lease?.bridgeToken || '') || undefined,
        updatedAtMs: Date.now(),
      });
    }

    const cdpPorts = findActiveDevToolsPorts();
    if (!cdpPorts.length) {
      return { ok: false, enabled, reason: 'no_devtools_port', injected: 0 };
    }

    const { reachableCount, targets } = await collectAllMainWindowTargets(cdpPorts);
    if (reachableCount === 0) {
      return { ok: false, enabled, reason: 'cdp_unreachable', injected: 0 };
    }
    if (!targets.length) {
      return { ok: true, enabled, reason: 'no_targets', injected: 0 };
    }

    if (hasContextWindows || hadContextWindows) {
      const chatUrls = [
        ...targets.filter((target) => !target.isIdeWorkbench).map((target) => target.webSocketDebuggerUrl),
        ...collectAllChatDebuggerUrls(targets),
      ];
      const expression = createContextWindowSyncExpression(contextWindows, contextWindowBootId);
      await Promise.allSettled([...new Set(chatUrls)].map((url) => evaluateOnTarget(url, expression)));
      hadContextWindows = hasContextWindows;
    }

    const disposeExpr = `(() => {
      try {
        const existed = Boolean(window.__AGUsageMonitorOverlay || window.__AGUsageMonitorBridge);
        window.__AGUsageMonitorOverlay?.dispose?.();
        delete window.__AGUsageMonitorOverlay;
        delete window.__AGUsageMonitorBridge;
        return existed;
      } catch {
        return false;
      }
    })()`;

    async function disposeSingleTarget(wsUrl) {
      if (!wsUrl) return false;
      try {
        const res = await evaluateOnTarget(wsUrl, disposeExpr);
        return res?.result?.result?.value === true;
      } catch {
        return false;
      }
    }

    if (!enabled) {
      if (!hadInjectedTargets && !hadInjectedChatFrames && !forceReinject) {
        return { ok: true, enabled: false, removed: 0 };
      }
      let removed = 0;
      const allDisposeUrls = [
        ...targets.map((t) => String(t.webSocketDebuggerUrl || '')).filter(Boolean),
        ...collectAllChatDebuggerUrls(targets),
      ];
      for (const wsUrl of new Set(allDisposeUrls)) {
        if (await disposeSingleTarget(wsUrl)) removed += 1;
      }
      hadInjectedTargets = false;
      hadInjectedChatFrames = false;
      return { ok: true, enabled: false, removed };
    }

    const { port, token } = await ensureBridgeServer();
    const probeExpr = `(() => {
      try {
        const ov = window.__AGUsageMonitorOverlay;
        const br = window.__AGUsageMonitorBridge;
        const alive = Boolean(ov && typeof ov.ensureAlive === 'function' && ov.ensureAlive());
        const dockKind = String(ov?.getDockKind?.() || '');
        const clientMountMode = String(ov?.getMountMode?.() || '');
        const visible = Boolean(
          (window.innerWidth === undefined || Number(window.innerWidth) > 80) &&
          (window.innerHeight === undefined || Number(window.innerHeight) > 80) &&
          !(typeof document !== 'undefined' && document?.hidden === true)
        );
        const rpcBatch = Array.isArray(br?.rpcQueue) && br.rpcQueue.length > 0
          ? br.rpcQueue.splice(0, 8)
          : [];
        let routeCascadeId = '';
        if (!alive) {
          const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const m = String(window.location?.pathname || '').match(/^\\/c\\/([0-9a-f-]{36})(?:\\/|$)/i);
          if (m && uuidRe.test(m[1])) {
            routeCascadeId = m[1];
          } else if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
            const el =
              document.querySelector('[data-testid="conversation-view"][data-cascade-id]') ||
              document.querySelector('[data-testid^="conversation-row-"][data-selected="true"][data-cascade-id]');
            const cand = String(el?.getAttribute?.('data-cascade-id') || '').trim();
            if (uuidRe.test(cand)) routeCascadeId = cand;
          }
        }
        return {
          alive,
          dockKind,
          clientMountMode,
          visible,
          bundleVersion: String(ov?.bundleVersion || ''),
          bridgePort: Number(br?.port || 0),
          hasToken: Boolean(br?.token),
          transportMode: String(br?.transportMode || 'http'),
          hostRouteCascadeId: String(br?.hostRouteCascadeId || ''),
          routeCascadeId,
          rpcBatch,
        };
      } catch {
        return { alive: false, dockKind: '', visible: true, bundleVersion: '', bridgePort: 0, hasToken: false, transportMode: 'http', hostRouteCascadeId: '', routeCascadeId: '', rpcBatch: [] };
      }
    })()`;

    let cachedAssets = null;
    let injected = 0;
    let aliveCount = 0;
    let relayedRpcCount = 0;
    let sawCdpTransport = false;

    async function syncSingleTarget(targetObj, { ideRouteOverride = '', isIdeChatFrame = false } = {}) {
      const wsUrl = String(targetObj?.webSocketDebuggerUrl || '').trim();
      if (!wsUrl) return { alive: false, dockKind: '', visible: false };
      let probedRouteId = '';
      const ideRouteId = String(ideRouteOverride || targetObj.ideRouteCascadeId || '').trim();
      if (!forceReinject) {
        const probeRes = await evaluateOnTarget(wsUrl, probeExpr);
        const snap = probeRes?.result?.result?.value;
        probedRouteId = String(snap?.routeCascadeId || '').trim();
        if (snap && snap.alive === true) {
          const snapVerNum = Number(snap.bundleVersion) || 0;
          const curVerNum = Number(bundleVersion) || 0;
          if (snapVerNum > 0 && curVerNum > 0 && snapVerNum > curVerNum) {
            onVersionDrift?.();
            aliveCount += 1;
            return {
              alive: true,
              dockKind: String(snap.dockKind || ''),
              visible: snap.visible !== false,
            };
          }
          if (snap.bundleVersion === bundleVersion) {
            if (snap.bridgePort !== port || snap.hasToken !== true) {
              const rebindExpr = `window.__AGUsageMonitorOverlay?.updateBridge?.(${JSON.stringify({ port, token })})`;
              await evaluateOnTarget(wsUrl, rebindExpr);
            }
            let effectiveDockKind = String(snap.dockKind || '');
            if (snap.clientMountMode && snap.clientMountMode !== mountMode) {
              const modeSyncExpr = `(() => { window.__AGUsageMonitorOverlay?.applyMountMode?.(${JSON.stringify(mountMode)}); return String(window.__AGUsageMonitorOverlay?.getDockKind?.() || ''); })()`;
              const modeRes = await evaluateOnTarget(wsUrl, modeSyncExpr);
              if (typeof modeRes?.result?.result?.value === 'string') {
                effectiveDockKind = modeRes.result.result.value;
              }
            }
            if (
              (targetObj.isIdeWorkbench || isIdeChatFrame) &&
              ideRouteId &&
              String(snap.hostRouteCascadeId || '') !== ideRouteId
            ) {
              const routeSyncExpr = `(() => { if (window.__AGUsageMonitorBridge) { window.__AGUsageMonitorBridge.hostRouteCascadeId = ${JSON.stringify(ideRouteId)}; } window.__AGUsageMonitorOverlay?.syncHostRoute?.(); })()`;
              await evaluateOnTarget(wsUrl, routeSyncExpr);
            }
            aliveCount += 1;
            if (isIdeChatFrame) {
              hadInjectedChatFrames = true;
            } else {
              hadInjectedTargets = true;
            }
            if (snap.transportMode === 'cdp') {
              sawCdpTransport = true;
            }
            if (Array.isArray(snap.rpcBatch) && snap.rpcBatch.length > 0) {
              sawCdpTransport = true;
              const rpcResults = await executeRpcBatch(snap.rpcBatch);
              relayedRpcCount += rpcResults.length;
              const deliverExpr = `window.__AGUsageMonitorOverlay?.deliverRpc?.(${JSON.stringify(rpcResults)})`;
              await evaluateOnTarget(wsUrl, deliverExpr);
            }
            return {
              alive: true,
              dockKind: effectiveDockKind,
              visible: snap.visible !== false,
            };
          }
        }
      }

      if (!cachedAssets) {
        const [stylesCss, appJs] = await Promise.all([
          readAssetFn('styles.css'),
          readAssetFn('app.js'),
        ]);
        cachedAssets = { stylesCss, appJs };
      }

      let initialTelemetry = null;
      try {
        const routeMatch = String(targetObj.url || '').match(/\/c\/([a-f0-9-]{36})(?:[/?#]|$)/i);
        const targetConvId = routeMatch ? routeMatch[1] : ideRouteId || probedRouteId;
        const initOut = await handleApiRequest('/api/telemetry', 'GET', {
          conversationId: targetConvId,
          range: 'today',
          stepDetails: 'display',
          stepRevision: '',
        });
        if (Number(initOut?.status || 200) === 200 && initOut?.body) {
          initialTelemetry = JSON.parse(initOut.body);
        }
      } catch {
        // 预取首帧遥测异常不阻塞注入本身
      }

      const bridgeConfigJson = JSON.stringify({
        port,
        token,
        bundleVersion,
        mountMode,
        hostRouteCascadeId: ideRouteId || '',
        isIdeChatFrame: Boolean(isIdeChatFrame),
        stylesCss: cachedAssets.stylesCss,
        initialTelemetry,
      });
      const injectionScript = `(() => {\nwindow.__AGUsageMonitorBridge = ${bridgeConfigJson};\n})();\n${cachedAssets.appJs}\n(() => { const ov = window.__AGUsageMonitorOverlay; const alive = Boolean(ov && ov.ensureAlive && ov.ensureAlive()); return { alive, dockKind: String(ov?.getDockKind?.() || ''), visible: Boolean((window.innerWidth === undefined || Number(window.innerWidth) > 80) && (window.innerHeight === undefined || Number(window.innerHeight) > 80) && !(typeof document !== 'undefined' && document?.hidden === true)) }; })();`;

      const evalRes = await evaluateOnTarget(wsUrl, injectionScript);
      const evalVal = evalRes?.result?.result?.value;
      const isInjectedAlive =
        Boolean(evalRes && !evalRes.error && !evalRes.result?.exceptionDetails) &&
        (evalVal === true || evalVal?.alive === true);
      if (isInjectedAlive) {
        injected += 1;
        aliveCount += 1;
        if (isIdeChatFrame) {
          hadInjectedChatFrames = true;
        } else {
          hadInjectedTargets = true;
        }
        return {
          alive: true,
          dockKind: typeof evalVal === 'object' && evalVal ? String(evalVal.dockKind || '') : '',
          visible: typeof evalVal === 'object' && evalVal ? evalVal.visible !== false : true,
        };
      }
      return { alive: false, dockKind: '', visible: false };
    }

    if (mountMode !== 'composer' && (hadInjectedChatFrames || forceReinject)) {
      for (const chatWsUrl of collectAllChatDebuggerUrls(targets)) {
        await disposeSingleTarget(chatWsUrl);
      }
      hadInjectedChatFrames = false;
    }

    for (const target of targets) {
      try {
        if (mountMode === 'composer' && target.isIdeWorkbench) {
          const chatList = Array.isArray(target.ideChatTargets) ? target.ideChatTargets : [];
          let chatComposerActive = false;
          for (const chatTarget of chatList) {
            if (!chatTarget.webSocketDebuggerUrl) continue;
            try {
              const chatState = await syncSingleTarget(chatTarget, {
                ideRouteOverride: chatTarget.cascadeId || target.ideRouteCascadeId,
                isIdeChatFrame: true,
              });
              if (chatState.alive && chatState.visible && chatState.dockKind === 'composer') {
                chatComposerActive = true;
              }
            } catch {
              // 单个聊天子视图异常不阻断主窗口兜底
            }
          }
          if (chatComposerActive) {
            await disposeSingleTarget(target.webSocketDebuggerUrl);
          } else {
            await syncSingleTarget(target);
          }
          continue;
        }

        await syncSingleTarget(target);
      } catch {
        // 单个窗口注入异常不阻断其他窗口
      }
    }

    cdpFallbackActive = sawCdpTransport;
    return {
      ok: true,
      enabled: true,
      port,
      targets: targets.length,
      injected,
      aliveCount,
      relayedRpcCount,
    };
  }

  function syncAllWindows(opts = {}) {
    if (syncInFlight) {
      return syncInFlight.then(() => runSyncInternal(opts));
    }
    syncInFlight = runSyncInternal(opts).finally(() => {
      syncInFlight = null;
    });
    return syncInFlight;
  }

  function scheduleNextPoll() {
    if (stopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delayMs = cdpFallbackActive ? fastPollIntervalMs : pollIntervalMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, delayMs);
    pollTimer.unref?.();
  }

  function start() {
    stopped = false;
    contextWindowBootId = `${process.pid}:${Date.now()}`;
    if (initialTimer) clearTimeout(initialTimer);
    if (pollTimer) clearTimeout(pollTimer);

    if (leaseFilePath) {
      const curSettings = getSettingsFn() || {};
      const mountMode = normalizeWindowMountMode(
        curSettings.windowMountMode,
        curSettings.enableWindowOverlay
      );
      if (curSettings.enableWindowOverlay !== false && mountMode !== 'sidebar') {
        ensureBridgeServer().catch(() => {});
      }
    }

    initialTimer = setTimeout(() => {
      initialTimer = null;
      syncAllWindows()
        .catch(() => {})
        .finally(() => {
          scheduleNextPoll();
        });
    }, 120);
    initialTimer.unref?.();
  }

  async function stop({ disposeWindows = false } = {}) {
    if (initialTimer) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (disposeWindows && (hadInjectedTargets || hadInjectedChatFrames || hadContextWindows)) {
      const prevStopped = stopped;
      stopped = false;
      try {
        const cdpPorts = findActiveDevToolsPorts();
        if (cdpPorts.length) {
          const { targets } = await collectAllMainWindowTargets(cdpPorts).catch(() => ({
            targets: [],
          }));
          const disposeExpr = `(() => { try { window.__AGUsageMonitorContextWindows?.dispose?.(); window.__AGUsageMonitorOverlay?.dispose?.(); delete window.__AGUsageMonitorOverlay; delete window.__AGUsageMonitorBridge; return true; } catch { return false; } })()`;
          const allUrls = [
            ...targets.map((t) => String(t.webSocketDebuggerUrl || '')).filter(Boolean),
            ...collectAllChatDebuggerUrls(targets),
          ];
          for (const wsUrl of new Set(allUrls)) {
            await evaluateOnTarget(wsUrl, disposeExpr).catch(() => {});
          }
        }
      } finally {
        stopped = prevStopped;
      }
    }
    stopped = true;
    hadInjectedTargets = false;
    hadInjectedChatFrames = false;
    hadContextWindows = false;
    if (server) {
      const srv = server;
      server = null;
      bridgePort = 0;
      await new Promise((resolve) => srv.close(() => resolve()));
    }
  }

  function notifySettingChanged(enabled) {
    if (!enabled) {
      hadInjectedTargets = true;
      hadInjectedChatFrames = true;
    } else {
      ideArgvProvisioned = false;
      hadInjectedChatFrames = true;
    }
    return syncAllWindows({ forceReinject: false }).catch(() => ({ ok: false }));
  }

  return {
    ensureBridgeServer,
    syncAllWindows,
    notifySettingChanged,
    start,
    stop,
    getBridgeInfo: () => ({ port: bridgePort, token: bridgeToken, running: Boolean(server) }),
  };
}

let defaultBridgeController = null;

/**
 * 启动进程级默认的双栖窗口桥接控制器（幂等）。
 *
 * @param {Parameters<typeof createWindowBridgeController>[0]} options
 */
export function startDefaultWindowBridge(options) {
  if (!defaultBridgeController) {
    defaultBridgeController = createWindowBridgeController({
      leaseFilePath: join(DATA_DIR, 'window-bridge-lease.json'),
      ...options,
    });
    defaultBridgeController.start();
  }
  return defaultBridgeController;
}

/**
 * 在用户保存设置切换 `enableWindowOverlay` 时立即同步所有打开的主窗口挂载状态。
 *
 * @param {boolean} enabled
 */
export function notifyWindowOverlaySetting(enabled) {
  if (!defaultBridgeController) return Promise.resolve({ ok: false });
  return defaultBridgeController.notifySettingChanged(enabled);
}

export function notifyModelContextWindowsChanged() {
  return defaultBridgeController?.syncAllWindows().catch(() => {});
}

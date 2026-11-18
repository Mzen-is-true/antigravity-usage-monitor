/**
 * @fileoverview Sidecar Webview 与主窗口双栖桥接共享的 API 路由分发与运行时引导层。
 *
 * 与 `sidecar_sdk` 完全解耦，使同一套遥测聚合、偏好持久化、云端目录同步与自更新逻辑可同时服务于：
 * 1. Antigravity 2.0 客户端右侧辅助栏 (`main.mjs` -> `SidecarApp`)；
 * 2. Antigravity IDE / 2.0 后台守护桥接进程 (`mcp-entry.mjs` -> `bridge-daemon.mjs`)。
 */

import { readFileSync, promises as fsPromises } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { handleAccountCredentialAction } from './account-switch.mjs';
import {
  HERE,
  SETTINGS_FILE,
  clearRuntimeCaches,
  cloudSyncState,
  computeRuntimeCodeVersion,
  createDefaultSettingsObject,
  isPlainObject,
  loadSettings,
  lsRuntimeEndpoint,
  normalizeFullSettings,
  normalizeModelDisplayMode,
  normalizePluginUpdateMode,
  normalizeWindowMountMode,
  saveJson,
} from './config.mjs';
import {
  getContextWindowModels,
  getContextWindowGroups,
  isContextWindowSettingId,
  isContextWindowOption,
  resolveContextWindowOption,
} from './context-windows.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog } from './ls-rpc.mjs';
import {
  performPluginUpdate,
  scheduleSidecarRestart,
  setSidecarRestartHandler,
  syncCloudCatalog,
} from './plugin-updater.mjs';
import { getCloudStatus } from './pricing-catalog.mjs';
import { buildTelemetryPayload } from './telemetry-builder.mjs';
import {
  notifyModelContextWindowsChanged,
  notifyWindowOverlaySetting,
  startDefaultWindowBridge,
} from './window-bridge.mjs';
import {
  applyHostCdpSetup,
  inspectHostCdpSetup,
  restoreHostCdpSetup,
} from './host-cdp-config.mjs';
import { ensureCliStatusLineConfigured } from './cli-statusline-config.mjs';

export const bootBundleVersion = computeRuntimeCodeVersion();

let standalonePortListener = null;

export function setStandalonePortListener(listener) {
  standalonePortListener = typeof listener === 'function' ? listener : null;
}

/**
 * 异步读取 `sidecars/panel` 目录下的静态资源文件（兼容单元测试同步沙箱）。
 *
 * @param {string} relPath 相对路径
 * @returns {Promise<string>}
 */
export const readLocalAsync = async (relPath) => {
  const fullPath = join(HERE, relPath);
  if (typeof fsPromises !== 'undefined' && fsPromises?.readFile) {
    return fsPromises.readFile(fullPath, 'utf8');
  }
  return readFileSync(fullPath, 'utf8');
};

/**
 * 校验请求是否来自本机回环同端口地址 (`127.0.0.1` / `localhost` / `[::1]`) 或受信 Webview Origin，
 * 阻止跨端口本地服务（如本地其他端口的开发服务器）或跨站 DNS Rebinding 访问 API。
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLocalHostRequest(req) {
  if (!req?.headers) return true;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const hostMatch = host.match(/^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/);
  if (host && !hostMatch) {
    return false;
  }
  const origin = String(req.headers.origin || '').trim().toLowerCase();
  if (origin && /^vscode-webview:\/\/[a-z0-9._-]+$/.test(origin)) {
    return true;
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return false;
  }
  if (origin) {
    const originMatch = origin.match(
      /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/
    );
    if (!originMatch) {
      return false;
    }
    if (hostMatch) {
      const defaultPort = originMatch[1] === 'https' ? '443' : '80';
      const originPort = originMatch[3] || defaultPort;
      const hostPort = hostMatch[2] || defaultPort;
      if (originPort !== hostPort) {
        return false;
      }
    }
  }
  return true;
}

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;

function sanitizePositiveFiniteMs(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 && num <= MAX_SAFE_DATE_MS ? Math.floor(num) : 0;
}

function projectDisplayStep(st) {
  const {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    streamDurationSec, selectedSpeedReason, contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentLabel, agentBadge,
    agentRole, agentIndex, isSubagent, turnIndex, isTurnStart, isLatestTurn,
    turnPrompt, rootTurnIndex, isRootTurnStart, isRootLatestTurn, rootTurnPrompt,
  } = st;
  return {
    stepIndex, createdAtMs, isCompactionStep, modelKey, modelShort, modelLabel,
    modelUpstream, responseModel, modelSource, tokPerSec, ttftSec, totalDurationSec,
    streamDurationSec, selectedSpeedReason, contextTokens, inputTokens, cacheReadTokens,
    outputTokens, thinkingTokens, responseTokens, cacheHitPct, costUsd, inCostUsd,
    cacheCostUsd, outCostUsd, agentId, agentCascadeId, agentLabel, agentBadge,
    agentRole, agentIndex, isSubagent, turnIndex, isTurnStart, isLatestTurn,
    turnPrompt, rootTurnIndex, isRootTurnStart, isRootLatestTurn, rootTurnPrompt,
  };
}

let lastDisplaySteps = null;
const displayStepFields = Object.keys(projectDisplayStep({}));

function haveSameDisplaySteps(previous, current) {
  if (!previous || !current) return previous === current;
  if (previous.length !== current.length) return false;
  for (let i = 0; i < current.length; i++) {
    const before = previous[i];
    const after = current[i];
    for (const key of displayStepFields) {
      if (before[key] !== after[key]) return false;
    }
  }
  return true;
}

function projectDisplayTelemetry(payload, requestedRevision) {
  const active = payload.activeConversation;
  const agents = active.agents;
  const sourceSteps = [active.recentSteps, ...agents.map((agent) => agent.recentSteps)];
  let projected;
  let revision;
  if (typeof requestedRevision === 'string') {
    const scope = [
      payload.account?.status,
      payload.account?.email || payload.account?.name || '',
      active.cascadeId,
      ...agents.map((agent) => agent.agentId),
    ];
    const previous = lastDisplaySteps;
    if (previous && isDeepStrictEqual(scope, previous.scope) &&
        sourceSteps.every((steps, index) => (steps && previous.sources[index]?.deref() === steps) ||
          haveSameDisplaySteps(previous.steps[index], steps))) {
      ({ revision, steps: projected } = previous);
      previous.sources = sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined);
    } else {
      revision = randomUUID();
      projected = sourceSteps.map((steps) => steps?.map(projectDisplayStep));
      lastDisplaySteps = { scope, steps: projected, revision,
        sources: sourceSteps.map((steps) => steps ? new WeakRef(steps) : undefined) };
    }
  }
  projected ||= sourceSteps.map((steps) => steps?.map(projectDisplayStep));
  const stepsUnchanged = revision !== undefined && requestedRevision === revision;
  return {
    ...payload,
    ...(revision ? { stepRevision: revision, stepsUnchanged } : {}),
    activeConversation: {
      ...active,
      recentSteps: stepsUnchanged ? undefined : projected[0],
      agents: agents.map((agent, index) => projected[index + 1]
        ? { ...agent, recentSteps: stepsUnchanged ? undefined : projected[index + 1] }
        : agent),
    },
  };
}

export async function executeTelemetryAction(data, { onRestart = null } = {}) {
  const rawConvId = String(
    data?.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || ''
  ).trim();
  const convId = rawConvId && !/[\\/]|\.\./.test(rawConvId) ? rawConvId : '';
  const force = data?.force === '1' || data?.force === true;
  if (lsRuntimeEndpoint.addr !== 'test.invalid') {
    if (!lsRuntimeEndpoint.baseUrl) {
      await ensureLsEndpointDiscovered({ force: false });
    }
    if (lsRuntimeEndpoint.baseUrl) {
      if (force && Date.now() - cloudSyncState.lastAttemptMs > 15_000) {
        await Promise.race([
          syncCloudCatalog({ force: true }).catch(() => {}),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } else {
        syncCloudCatalog({ force: false }).catch(() => {});
      }
    }
  }
  const filterOpts = {
    range: data?.range || 'all',
    startMs: sanitizePositiveFiniteMs(data?.startMs),
    endMs: sanitizePositiveFiniteMs(data?.endMs),
  };
  let payload;
  try {
    payload = await buildTelemetryPayload(convId, force, filterOpts);
  } catch (err) {
    if (
      lsRuntimeEndpoint.addr !== 'test.invalid' &&
      bootBundleVersion &&
      String(computeRuntimeCodeVersion()) !== String(bootBundleVersion)
    ) {
      if (typeof onRestart === 'function') {
        onRestart();
      } else {
        scheduleSidecarRestart(150);
      }
    }
    throw err;
  }
  if (
    bootBundleVersion &&
    payload.uiBundleVersion &&
    String(payload.uiBundleVersion) !== String(bootBundleVersion)
  ) {
    if (typeof onRestart === 'function') {
      onRestart();
    } else {
      scheduleSidecarRestart(150);
    }
  }
  const responsePayload = data?.stepDetails === 'display'
    ? projectDisplayTelemetry(payload, data.stepRevision)
    : payload;
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(responsePayload),
  };
}

function sanitizePositiveSettingNumber(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

export function executeSettingsAction(data) {
  const current = loadSettings();
  const payload = isPlainObject(data) ? data : {};
  const nextPluginUpdateMode =
    payload.pluginUpdateMode !== undefined
      ? normalizePluginUpdateMode(payload.pluginUpdateMode)
      : typeof payload.autoUpdatePlugin === 'boolean'
        ? payload.autoUpdatePlugin
          ? 'auto'
          : 'manual'
        : normalizePluginUpdateMode(current.pluginUpdateMode, current.autoUpdatePlugin);
  const nextWindowMountMode =
    payload.windowMountMode !== undefined
      ? normalizeWindowMountMode(payload.windowMountMode)
      : typeof payload.enableWindowOverlay === 'boolean'
        ? payload.enableWindowOverlay
          ? current.windowMountMode === 'composer'
            ? 'composer'
            : 'dual'
          : 'sidebar'
        : normalizeWindowMountMode(current.windowMountMode, current.enableWindowOverlay);
  const nextModelDisplayMode =
    payload.modelDisplayMode !== undefined
      ? normalizeModelDisplayMode(payload.modelDisplayMode)
      : typeof payload.showUpstreamModel === 'boolean'
        ? payload.showUpstreamModel
          ? 'upstream'
          : 'short'
        : normalizeModelDisplayMode(current.modelDisplayMode, current.showUpstreamModel);
  const updated = normalizeFullSettings({
    ...current,
    ...payload,
    modelContextWindows: current.modelContextWindows,
    weeklyTokenBudget: sanitizePositiveSettingNumber(
      payload.weeklyTokenBudget ?? payload.weeklyTokenLimit,
      current.weeklyTokenBudget
    ),
    weeklyCostBudget: sanitizePositiveSettingNumber(
      payload.weeklyCostBudget,
      current.weeklyCostBudget
    ),
    modelDisplayMode: nextModelDisplayMode,
    pluginUpdateMode: nextPluginUpdateMode,
    windowMountMode: nextWindowMountMode,
  });
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to persist settings' }),
    };
  }
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  }
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export async function executeModelContextWindowAction(data) {
  const { modelId, option } = data || {};
  const respond = (status, payload) => ({
    status,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
  });
  if (!isContextWindowSettingId(modelId) || (option !== null && !isContextWindowOption(option))) {
    return respond(400, { error: 'Invalid model context window' });
  }
  let group;
  try {
    const [{ userStatus }, catalog] = await Promise.all([callLsRpc('GetUserStatus'), getContextModelCatalog()]);
    const models = getContextWindowModels(userStatus?.cascadeModelConfigData?.clientModelConfigs, catalog);
    group = getContextWindowGroups(models).find(({ id }) => id === modelId);
  } catch {
    if (option !== null || modelId.startsWith('model:')) {
      return respond(503, { error: 'Unable to verify the host model configuration' });
    }
  }
  if (option !== null && (!group || resolveContextWindowOption(group, option) === null)) {
    return respond(400, { error: 'This context window is not available for the selected model' });
  }
  const current = loadSettings();
  for (const id of group?.members || []) delete current.modelContextWindows[id];
  if (option === null) {
    delete current.modelContextWindows[modelId];
  } else {
    current.modelContextWindows[modelId] = option;
  }
  if (!saveJson(SETTINGS_FILE, current)) {
    return respond(500, { error: 'Failed to persist model context window' });
  }
  void notifyModelContextWindowsChanged();
  return respond(200, { modelContextWindows: current.modelContextWindows });
}

export function executeResetSettingsAction() {
  const current = loadSettings();
  const updated = createDefaultSettingsObject();
  if (!saveJson(SETTINGS_FILE, updated)) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to reset settings' }),
    };
  }
  const prevMountMode = normalizeWindowMountMode(
    current.windowMountMode,
    current.enableWindowOverlay
  );
  if (
    updated.enableWindowOverlay !== (current.enableWindowOverlay !== false) ||
    updated.windowMountMode !== prevMountMode
  ) {
    void notifyWindowOverlaySetting(updated.enableWindowOverlay);
  } else if (Object.keys(current.modelContextWindows).length) {
    void notifyModelContextWindowsChanged();
  }
  if ((updated.enableCliStatusLine !== false) !== (current.enableCliStatusLine !== false)) {
    ensureCliStatusLineConfigured({ enabled: updated.enableCliStatusLine !== false });
  }
  if (
    typeof standalonePortListener === 'function' &&
    Number(updated.standalonePort || 0) !== Number(current.standalonePort || 0)
  ) {
    try {
      standalonePortListener(Number(updated.standalonePort || 0));
    } catch {
      // 忽略独立端口热重载回调异常
    }
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    updated,
    body: JSON.stringify(updated),
  };
}

export function executeRebuildCacheAction() {
  const ok = clearRuntimeCaches();
  if (!ok) {
    return {
      ok: false,
      status: 500,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: 'Failed to clear trajectory cache' }),
    };
  }
  return {
    ok: true,
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: true, clearedAt: Date.now() }),
  };
}

export async function executeCloudSyncAction() {
  const cloudStatus = await syncCloudCatalog({ force: true });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ok: !cloudStatus.lastSyncError, cloudStatus }),
  };
}

export async function executePluginUpdateAction() {
  const result = await performPluginUpdate({ isAuto: false });
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...result, cloudStatus: getCloudStatus() }),
  };
}

export async function executeAccountCredentialAction(data) {
  const result = await handleAccountCredentialAction(data);
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify(result),
  };
}

export async function executeCdpSetupAction(method, data) {
  const upperMethod = String(method || 'GET').toUpperCase();
  if (upperMethod === 'GET') {
    const cdpSetup = await inspectHostCdpSetup({ force: true });
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, cdpSetup }),
    };
  }
  const action = String(data?.action || 'apply').trim().toLowerCase();
  if (action === 'restore') {
    const result = await restoreHostCdpSetup();
    const curSettings = loadSettings();
    const nextSettings = normalizeFullSettings({
      ...curSettings,
      autoMaintainCdpShortcuts: false,
    });
    saveJson(SETTINGS_FILE, nextSettings);
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ...result, settings: nextSettings }),
    };
  }
  if (action === 'check' || action === 'inspect') {
    const cdpSetup = await inspectHostCdpSetup({ force: true });
    return {
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, cdpSetup }),
    };
  }
  const port = Number.isInteger(Number(data?.port)) ? Number(data.port) : 0;
  const result = await applyHostCdpSetup({ port });
  let nextSettings = loadSettings();
  if (result.ok) {
    nextSettings = normalizeFullSettings({
      ...nextSettings,
      autoMaintainCdpShortcuts: true,
    });
    saveJson(SETTINGS_FILE, nextSettings);
  }
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'Cache-Control': 'no-store' },
    body: JSON.stringify({ ...result, settings: nextSettings }),
  };
}

export async function dispatchBridgeApiRequest(pathname, method, data, opts = undefined) {
  if (pathname === '/api/cdp-setup' && (method === 'GET' || method === 'POST')) {
    return executeCdpSetupAction(method, data);
  }
  if (pathname === '/api/telemetry' && method === 'GET') {
    return executeTelemetryAction(data, opts);
  }
  if (pathname === '/api/settings' && method === 'POST') {
    return executeSettingsAction(data);
  }
  if (pathname === '/api/accounts' && method === 'GET') {
    return executeAccountCredentialAction();
  }
  if (pathname === '/api/accounts/update' && method === 'POST') {
    return executeAccountCredentialAction(data);
  }
  if (pathname === '/api/context-window' && method === 'POST') {
    return executeModelContextWindowAction(data);
  }
  if (pathname === '/api/settings/reset' && method === 'POST') {
    return executeResetSettingsAction();
  }
  if (pathname === '/api/cache/rebuild' && method === 'POST') {
    return executeRebuildCacheAction();
  }
  if (pathname === '/api/cloud-sync' && method === 'POST') {
    return executeCloudSyncAction();
  }
  if (pathname === '/api/plugin-update' && method === 'POST') {
    return executePluginUpdateAction();
  }
  return {
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'Not found' }),
  };
}

/**
 * 启动进程级双栖窗口桥接器（兼容 Sidecar 环境与独立后台守护进程环境）。
 *
 * @param {{ allowDynamicLs?: boolean, onRestart?: () => void }} [options]
 */
export function bootWindowBridgeRuntime({ allowDynamicLs = false, onRestart = null } = {}) {
  if (lsRuntimeEndpoint.addr === 'test.invalid') return null;
  if (!allowDynamicLs && !lsRuntimeEndpoint.addr) return null;

  ensureCliStatusLineConfigured({ enabled: loadSettings().enableCliStatusLine !== false });

  const triggerRestart =
    typeof onRestart === 'function' ? onRestart : () => scheduleSidecarRestart(150);
  if (typeof onRestart === 'function') {
    setSidecarRestartHandler(onRestart);
  }

  if (lsRuntimeEndpoint.baseUrl) {
    syncCloudCatalog({ force: false }).catch(() => {});
  } else {
    ensureLsEndpointDiscovered({ force: false })
      .then((ok) => {
        if (ok) {
          syncCloudCatalog({ force: false }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  return startDefaultWindowBridge({
    handleApiRequest: (pathname, method, data) =>
      dispatchBridgeApiRequest(pathname, method, data, { onRestart: triggerRestart }),
    readAssetFn: readLocalAsync,
    bootBundleVersion,
    onVersionDrift: triggerRestart,
  });
}


/**
 * @fileoverview Reactive telemetry store with async non-overlapping poll scheduler
 * and granular slice updates.
 */

import { createReactiveStore } from '../core/reactive.js';
import { callSidecarApi, getWindowBridgeConfig, isWindowOverlayMode } from '../core/httpClient.js';
import { isEnglishLocale, normalizeI18nLanguage, t } from '../i18n/index.js';
import { normalizeClientFontScale, normalizeClientThemeAccent } from '../core/appearance.js';

const CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 在主窗口双栖模式下，提取当前正在浏览的会话 ID：
 * 1. 优先解析 Antigravity 2.0 路由路径 `/c/<uuid>`；
 * 2. 在 Antigravity IDE (`workbench.html`) 无路径路由时，回退读取活跃对话视图
 *    `[data-testid="conversation-view"][data-cascade-id]` 或侧栏选中项。
 *
 * @returns {string}
 */
export function extractHostRouteCascadeId() {
  if (typeof window === 'undefined' || !isWindowOverlayMode()) return '';
  const pathname = String(window.location?.pathname || '');
  const m = pathname.match(/^\/c\/([a-f0-9-]{36})(?:\/|$)/i);
  if (m && CASCADE_UUID_RE.test(m[1])) {
    return m[1];
  }
  const extBridgeRouteId = String(window.__AGUsageMonitorBridge?.hostRouteCascadeId || '').trim();
  if (extBridgeRouteId && CASCADE_UUID_RE.test(extBridgeRouteId)) {
    return extBridgeRouteId;
  }
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return '';
    }
    const selectedRow = document.querySelector(
      '[data-testid^="conversation-row-"][data-selected="true"][data-cascade-id]'
    );
    const selectedRowId = String(selectedRow?.getAttribute?.('data-cascade-id') || '').trim();

    if (typeof document.querySelectorAll === 'function') {
      const views = document.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
      const visibleIds = [];
      let focusedId = '';
      const activeEl = document.activeElement || null;
      for (const viewEl of views) {
        const cid = String(viewEl?.getAttribute?.('data-cascade-id') || '').trim();
        if (!CASCADE_UUID_RE.test(cid)) continue;
        if (viewEl.hasAttribute?.('hidden')) continue;
        if (viewEl.getBoundingClientRect) {
          const r = viewEl.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) continue;
        }
        visibleIds.push(cid);
        if (activeEl && viewEl.contains?.(activeEl)) {
          focusedId = cid;
        }
      }
      if (focusedId) return focusedId;
      if (
        selectedRowId &&
        CASCADE_UUID_RE.test(selectedRowId) &&
        visibleIds.some((id) => id.toLowerCase() === selectedRowId.toLowerCase())
      ) {
        return selectedRowId;
      }
      if (visibleIds.length > 0) return visibleIds[0];
    }

    const singleView = document.querySelector('[data-testid="conversation-view"][data-cascade-id]');
    const singleViewId = String(singleView?.getAttribute?.('data-cascade-id') || '').trim();
    if (CASCADE_UUID_RE.test(singleViewId)) {
      return singleViewId;
    }
    if (CASCADE_UUID_RE.test(selectedRowId)) {
      return selectedRowId;
    }
  } catch {
    // 忽略宿主 DOM 查询异常
  }
  return '';
}

const initialConversationId =
  (typeof window !== 'undefined' && window.sidecar?.conversationId) || '';

export const telemetryStore = createReactiveStore({
  selectedConversationId: initialConversationId,
  hostRouteConversationId: extractHostRouteCascadeId(),
  selectedTimeRange: 'today',
  customStartMs: Date.now() - 24 * 3600 * 1000,
  customEndMs: Date.now(),
  syncState: 'idle', // 'idle' | 'syncing' | 'synced' | 'error'
  minuteTick: 0,
  telemetry: null,
});

let pollTimer = null;
let feedbackTimer = null;
let activeBundleVersion = 0;
let latestRequestSeq = 0;
let activeForceCount = 0;
let consecutivePollFailures = 0;
let inFlightTelemetryPoll = null;
let lastReceivedSteps = null;
let loopActive = false;
let loopIntervalMs = 2000;
let loopTickFn = null;

export const CLIENT_TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_5h',
  'gemini_weekly',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_CLIENT_TOPBAR_SLOTS = Object.freeze(['tps', 'ttft', 'context']);

export const CLIENT_OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'used_quotas',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_CLIENT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'used_quotas',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_CLIENT_HOVER_MODULES = Object.freeze(['metrics', 'context', 'quotas']);

export const CLIENT_OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_CLIENT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const CLIENT_STEP_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_CLIENT_STEP_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'ttft',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_CLIENT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

const CLIENT_STEP_TOKEN_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  '上下文': 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  '输入': 'in',
  '新输入': 'in',
  out: 'out',
  output: 'out',
  '输出': 'out',
  '总输出': 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  '缓存': 'cache',
  '缓存读': 'cache',
  think: 'think',
  thinking: 'think',
  '思考': 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  '正文': 'reply',
  '回复': 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
  '总计': 'total',
  '总token': 'total',
});

export function parseClientStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(CLIENT_STEP_TOKEN_ALIASES, key)
        ? CLIENT_STEP_TOKEN_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(mapped);
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

export function normalizeClientStepTokenComboFormat(raw) {
  return parseClientStepTokenComboSegments(raw).join(':');
}

export const MIN_CLIENT_POPOVER_WIDTH = 440;
export const MAX_CLIENT_POPOVER_WIDTH = 1080;
export const DEFAULT_CLIENT_POPOVER_WIDTH = 580;

export function normalizeClientPopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

export function normalizeClientPopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_CLIENT_POPOVER_WIDTH;
  return Math.max(MIN_CLIENT_POPOVER_WIDTH, Math.min(MAX_CLIENT_POPOVER_WIDTH, Math.round(num)));
}

export function normalizeClientModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

function normalizeClientOrderedList(raw, { allowedKeys, defaultItems, minLen, maxLen }) {
  if (!Array.isArray(raw)) {
    return [...defaultItems];
  }
  const allowedSet = new Set(allowedKeys);
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const key = String(item ?? '').trim();
    if (!key || key === 'none' || !allowedSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= maxLen) break;
  }
  if (out.length < minLen) {
    for (const fallbackKey of [...defaultItems, ...allowedKeys]) {
      if (!seen.has(fallbackKey) && allowedSet.has(fallbackKey)) {
        seen.add(fallbackKey);
        out.push(fallbackKey);
        if (out.length >= minLen) break;
      }
    }
  }
  return out;
}

/**
 * 归一化前端顶栏胶囊动态槽位配置数组（支持 1..5 项不重复指标，兼容迁移旧版 `'none'` 占位）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeClientTopbarSlots(raw) {
  return normalizeClientOrderedList(raw, {
    allowedKeys: CLIENT_TOPBAR_SLOT_KEYS,
    defaultItems: DEFAULT_CLIENT_TOPBAR_SLOTS,
    minLen: 1,
    maxLen: 5,
  });
}

/**
 * 归一化鼠标悬浮速览窗展示模块列表（支持 0..4 项，`0` 项代表关闭悬浮窗）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeClientHoverModules(raw) {
  return normalizeClientOrderedList(raw, {
    allowedKeys: CLIENT_OVERVIEW_MODULE_KEYS,
    defaultItems: DEFAULT_CLIENT_HOVER_MODULES,
    minLen: 0,
    maxLen: 4,
  });
}

/**
 * 归一化实时监控视图展示模块列表（支持 1..4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeClientOverviewModules(raw) {
  return normalizeClientOrderedList(raw, {
    allowedKeys: CLIENT_OVERVIEW_MODULE_KEYS,
    defaultItems: DEFAULT_CLIENT_OVERVIEW_MODULES,
    minLen: 1,
    maxLen: CLIENT_OVERVIEW_MODULE_KEYS.length,
  });
}

/**
 * 归一化实时监控第一行指标矩阵配置（支持 1..4 项）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeClientOverviewMetrics(raw) {
  return normalizeClientOrderedList(raw, {
    allowedKeys: CLIENT_OVERVIEW_METRIC_KEYS,
    defaultItems: DEFAULT_CLIENT_OVERVIEW_METRICS,
    minLen: 1,
    maxLen: 4,
  });
}

/**
 * 归一化调用明细「按步查看」显示列配置（支持 2..12 列）。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeClientStepColumns(raw) {
  return normalizeClientOrderedList(raw, {
    allowedKeys: CLIENT_STEP_COLUMN_KEYS,
    defaultItems: DEFAULT_CLIENT_STEP_COLUMNS,
    minLen: 2,
    maxLen: CLIENT_STEP_COLUMN_KEYS.length,
  });
}

/**
 * 归一化前端插件更新策略（`'off'` | `'manual'` | `'auto'`），兼容旧版布尔字段。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
export function normalizeClientUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'manual' || m === 'auto') return m;
  if (legacyAutoUpdate === true) return 'auto';
  return 'manual';
}

export function normalizeClientOrchestratorIdMode(mode) {
  return String(mode ?? '').trim().toLowerCase() === 'full' ? 'full' : 'compact';
}

/**
 * 归一化前端面板挂载方式（`'dual'` | `'composer'` | `'sidebar'`），兼容旧版 `enableWindowOverlay` 布尔字段。
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function normalizeClientWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'dual';
}

function isEquivalentTelemetry(prev, next) {
  if (!prev || !next) return false;
  if (prev === next) return true;

  const sameArr = (a, b) => {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  };
  const normMount = (mode, legacyEnableOverlay) => {
    const m = String(mode ?? '').trim().toLowerCase();
    if (m === 'composer' || m === 'input') return 'composer';
    if (m === 'sidebar' || m === 'off') return 'sidebar';
    if (m === 'dual' || m === 'topbar') return 'dual';
    if (legacyEnableOverlay === false) return 'sidebar';
    return 'dual';
  };

  // 1. 比对系统设置项（外观语言/主题/字号、模型显示策略、更新策略、挂载与结构布局配置）
  const pAct = prev.activeConversation;
  const nAct = next.activeConversation;
  const pSet = prev.settings;
  const nSet = next.settings;

  if ((pSet?.language ?? 'zh-CN') !== (nSet?.language ?? 'zh-CN')) return false;
  if ((pSet?.themeAccent ?? 'host') !== (nSet?.themeAccent ?? 'host')) return false;
  if ((pSet?.fontScale ?? 'md') !== (nSet?.fontScale ?? 'md')) return false;
  if (Boolean(pSet?.contextWindowRiskAccepted) !== Boolean(nSet?.contextWindowRiskAccepted)) {
    return false;
  }
  if (
    JSON.stringify(pSet?.modelContextWindows) !== JSON.stringify(nSet?.modelContextWindows) ||
    JSON.stringify(prev.contextWindowModels) !== JSON.stringify(next.contextWindowModels)
  ) {
    return false;
  }
  const normModelMode = (mode, legacyShowUpstream) => {
    const m = String(mode ?? '').trim().toLowerCase();
    if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
    if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
      return 'upstream_compact';
    }
    if (m === 'short') return 'short';
    return legacyShowUpstream === true ? 'upstream' : 'short';
  };
  const normPopMode = (mode) => {
    const m = String(mode ?? '').trim().toLowerCase();
    return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
  };
  const normPopW = (w) => {
    const n = Number(w);
    return Number.isFinite(n) && n > 0 ? Math.max(440, Math.min(1080, Math.round(n))) : 580;
  };
  if (
    normModelMode(pSet?.modelDisplayMode, pSet?.showUpstreamModel) !==
    normModelMode(nSet?.modelDisplayMode, nSet?.showUpstreamModel)
  ) {
    return false;
  }
  if (pSet?.showUpstreamModel !== nSet?.showUpstreamModel) return false;
  if (normPopMode(pSet?.popoverWidthMode) !== normPopMode(nSet?.popoverWidthMode)) {
    return false;
  }
  if (normPopW(pSet?.popoverWidth) !== normPopW(nSet?.popoverWidth)) {
    return false;
  }
  if (
    String(pSet?.stepTokenComboFormat ?? 'context:in:cache').trim() !==
    String(nSet?.stepTokenComboFormat ?? 'context:in:cache').trim()
  ) {
    return false;
  }
  const prevOrchIdMode =
    String(pSet?.orchestratorIdMode ?? 'compact').trim().toLowerCase() === 'full'
      ? 'full'
      : 'compact';
  const nextOrchIdMode =
    String(nSet?.orchestratorIdMode ?? 'compact').trim().toLowerCase() === 'full'
      ? 'full'
      : 'compact';
  if (prevOrchIdMode !== nextOrchIdMode) {
    return false;
  }
  if (pSet?.weeklyLimitMode !== nSet?.weeklyLimitMode) return false;
  if (pSet?.weeklyTokenBudget !== nSet?.weeklyTokenBudget) return false;
  if (pSet?.weeklyCostBudget !== nSet?.weeklyCostBudget) return false;
  if ((pSet?.pluginUpdateMode ?? '') !== (nSet?.pluginUpdateMode ?? '')) return false;
  if (pSet?.autoUpdatePlugin !== nSet?.autoUpdatePlugin) return false;
  if (
    normMount(pSet?.windowMountMode, pSet?.enableWindowOverlay) !==
    normMount(nSet?.windowMountMode, nSet?.enableWindowOverlay)
  ) {
    return false;
  }
  if (pSet?.enableWindowOverlay !== nSet?.enableWindowOverlay) return false;
  if ((pSet?.enableCliStatusLine !== false) !== (nSet?.enableCliStatusLine !== false)) {
    return false;
  }
  if ((pSet?.showTopbarMultiSession !== false) !== (nSet?.showTopbarMultiSession !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepTurnRail) !== Boolean(nSet?.showStepTurnRail)) {
    return false;
  }
  if ((pSet?.showStepAgentBadge !== false) !== (nSet?.showStepAgentBadge !== false)) {
    return false;
  }
  if (Boolean(pSet?.showStepSpeedColor) !== Boolean(nSet?.showStepSpeedColor)) {
    return false;
  }
  if (!sameArr(pSet?.topbarCapsuleSlots, nSet?.topbarCapsuleSlots)) return false;
  if (!sameArr(pSet?.hoverModules, nSet?.hoverModules)) return false;
  if (!sameArr(pSet?.overviewModules, nSet?.overviewModules)) return false;
  if (!sameArr(pSet?.overviewMetrics, nSet?.overviewMetrics)) return false;
  if (!sameArr(pSet?.stepTableColumns, nSet?.stepTableColumns)) return false;

  // 2. 比对云端状态
  const pCloud = prev.cloudStatus;
  const nCloud = next.cloudStatus;
  if (
    pCloud?.currentPluginVersion !== nCloud?.currentPluginVersion ||
    pCloud?.latestPluginVersion !== nCloud?.latestPluginVersion ||
    pCloud?.updateAvailable !== nCloud?.updateAvailable ||
    pCloud?.installMode !== nCloud?.installMode ||
    pCloud?.catalogVersion !== nCloud?.catalogVersion ||
    pCloud?.source !== nCloud?.source ||
    pCloud?.lastSyncedAtMs !== nCloud?.lastSyncedAtMs ||
    pCloud?.modelCount !== nCloud?.modelCount ||
    pCloud?.isSyncing !== nCloud?.isSyncing ||
    pCloud?.isUpdating !== nCloud?.isUpdating ||
    pCloud?.lastSyncError !== nCloud?.lastSyncError ||
    pCloud?.lastUpdateError !== nCloud?.lastUpdateError ||
    pCloud?.lastUpdateResult?.updatedAtMs !== nCloud?.lastUpdateResult?.updatedAtMs
  ) {
    return false;
  }

  // 3. 比对活跃会话的实时测速指标
  if (pAct?.cascadeId !== nAct?.cascadeId) return false;
  if (pAct?.stepCount !== nAct?.stepCount) return false;
  if (pAct?.subagentCount !== nAct?.subagentCount) return false;
  if (pAct?.totalStepsAllAgents !== nAct?.totalStepsAllAgents) return false;
  if (pAct?.isRunning !== nAct?.isRunning) return false;
  if (
    pAct?.inputTokens !== nAct?.inputTokens ||
    pAct?.cacheReadTokens !== nAct?.cacheReadTokens ||
    pAct?.outputTokens !== nAct?.outputTokens ||
    pAct?.totalTokens !== nAct?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.liveActivity?.signature !== nAct?.liveActivity?.signature ||
    pAct?.liveActivity?.startedAtMs !== nAct?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.isRunning !== nAct?.aggregated?.isRunning) return false;
  if (
    pAct?.aggregated?.inputTokens !== nAct?.aggregated?.inputTokens ||
    pAct?.aggregated?.cacheReadTokens !== nAct?.aggregated?.cacheReadTokens ||
    pAct?.aggregated?.outputTokens !== nAct?.aggregated?.outputTokens ||
    pAct?.aggregated?.totalTokens !== nAct?.aggregated?.totalTokens
  ) {
    return false;
  }
  if (
    pAct?.aggregated?.liveActivity?.signature !== nAct?.aggregated?.liveActivity?.signature ||
    pAct?.aggregated?.liveActivity?.startedAtMs !== nAct?.aggregated?.liveActivity?.startedAtMs
  ) {
    return false;
  }
  if (pAct?.aggregated?.liveActivity?.agentId !== nAct?.aggregated?.liveActivity?.agentId) return false;
  if (pAct?.aggregated?.activeAgentId !== nAct?.aggregated?.activeAgentId) return false;
  if (pAct?.aggregated?.activeAgentBadge !== nAct?.aggregated?.activeAgentBadge) return false;
  if (pAct?.aggregated?.latestTokPerSec !== nAct?.aggregated?.latestTokPerSec) return false;
  if (pAct?.aggregated?.latestTtftSec !== nAct?.aggregated?.latestTtftSec) return false;
  if (pAct?.aggregated?.avgTokPerSec !== nAct?.aggregated?.avgTokPerSec) return false;
  if (pAct?.aggregated?.latestStepCostUsd !== nAct?.aggregated?.latestStepCostUsd) return false;
  if (pAct?.aggregated?.sessionCostUsd !== nAct?.aggregated?.sessionCostUsd) return false;
  if (pAct?.aggregated?.sessionUnpricedCalls !== nAct?.aggregated?.sessionUnpricedCalls) return false;
  if (pAct?.aggregated?.sessionCacheHitPct !== nAct?.aggregated?.sessionCacheHitPct) return false;
  if (pAct?.aggregated?.activeModelShort !== nAct?.aggregated?.activeModelShort) return false;
  if (pAct?.aggregated?.activeModelUpstream !== nAct?.aggregated?.activeModelUpstream) return false;
  if (pAct?.aggregated?.latestCacheHitPct !== nAct?.aggregated?.latestCacheHitPct) return false;
  if (pAct?.aggregated?.latestSpeedReason !== nAct?.aggregated?.latestSpeedReason) return false;
  if (pAct?.latestTokPerSec !== nAct?.latestTokPerSec) return false;
  if (pAct?.latestTtftSec !== nAct?.latestTtftSec) return false;
  if (pAct?.avgTokPerSec !== nAct?.avgTokPerSec) return false;
  if (pAct?.latestCacheHitPct !== nAct?.latestCacheHitPct) return false;
  if (pAct?.sessionCacheHitPct !== nAct?.sessionCacheHitPct) return false;
  if (pAct?.latestSpeedReason !== nAct?.latestSpeedReason) return false;
  if (pAct?.ttftSummary?.avgSec !== nAct?.ttftSummary?.avgSec) return false;
  if (pAct?.speedSummary?.sampleCount !== nAct?.speedSummary?.sampleCount) return false;
  if (
    pAct?.activeModelShort !== nAct?.activeModelShort ||
    pAct?.activeModelLabel !== nAct?.activeModelLabel ||
    pAct?.activeModelUpstream !== nAct?.activeModelUpstream
  ) {
    return false;
  }
  if (
    pAct?.latestStepCostUsd !== nAct?.latestStepCostUsd ||
    pAct?.sessionCostUsd !== nAct?.sessionCostUsd ||
    pAct?.sessionUnpricedCalls !== nAct?.sessionUnpricedCalls
  ) {
    return false;
  }

  const pAgents = pAct?.agents || [];
  const nAgents = nAct?.agents || [];
  if (pAgents.length !== nAgents.length) return false;
  for (let i = 0; i < pAgents.length; i++) {
    const pa = pAgents[i];
    const na = nAgents[i];
    if (
      pa?.agentId !== na?.agentId ||
      pa?.role !== na?.role ||
      pa?.stepCount !== na?.stepCount ||
      pa?.isRunning !== na?.isRunning ||
      pa?.liveActivity?.signature !== na?.liveActivity?.signature ||
      pa?.latestTokPerSec !== na?.latestTokPerSec ||
      pa?.latestTtftSec !== na?.latestTtftSec ||
      pa?.avgTokPerSec !== na?.avgTokPerSec ||
      pa?.latestCacheHitPct !== na?.latestCacheHitPct ||
      pa?.sessionCacheHitPct !== na?.sessionCacheHitPct ||
      pa?.latestSpeedReason !== na?.latestSpeedReason ||
      pa?.latestStepCostUsd !== na?.latestStepCostUsd ||
      pa?.sessionCostUsd !== na?.sessionCostUsd ||
      pa?.sessionUnpricedCalls !== na?.sessionUnpricedCalls ||
      pa?.activeModelShort !== na?.activeModelShort ||
      pa?.activeModelUpstream !== na?.activeModelUpstream ||
      pa?.context?.totalTokens !== na?.context?.totalTokens ||
      pa?.context?.compactionLimitTokens !== na?.context?.compactionLimitTokens ||
      pa?.context?.limitTokens !== na?.context?.limitTokens ||
      pa?.context?.messagesTokens !== na?.context?.messagesTokens ||
      pa?.context?.toolResultsTokens !== na?.context?.toolResultsTokens ||
      pa?.context?.assistantTokens !== na?.context?.assistantTokens ||
      pa?.context?.userInputTokens !== na?.context?.userInputTokens ||
      pa?.context?.subagentTokens !== na?.context?.subagentTokens ||
      pa?.context?.checkpointTokens !== na?.context?.checkpointTokens ||
      pa?.context?.systemToolsTokens !== na?.context?.systemToolsTokens ||
      pa?.context?.mcpToolsTokens !== na?.context?.mcpToolsTokens ||
      pa?.context?.skillsTokens !== na?.context?.skillsTokens ||
      pa?.context?.systemPromptTokens !== na?.context?.systemPromptTokens ||
      pa?.context?.userRulesTokens !== na?.context?.userRulesTokens
    ) {
      return false;
    }
    // 主代理步骤由根会话统一比对，避免明细视图组装后的引用造成重复比对。
    const paSteps = pa?.isMain && pAct?.recentSteps ? [] : pa?.recentSteps || [];
    const naSteps = na?.isMain && nAct?.recentSteps ? [] : na?.recentSteps || [];
    if (paSteps.length !== naSteps.length) return false;
    for (let j = 0; paSteps !== naSteps && j < paSteps.length; j++) {
      const bs = paSteps[j];
      const as = naSteps[j];
      if (
        bs?.stepIndex !== as?.stepIndex ||
        bs?.createdAtMs !== as?.createdAtMs ||
        bs?.totalDurationSec !== as?.totalDurationSec ||
        bs?.streamDurationSec !== as?.streamDurationSec ||
        bs?.modelKey !== as?.modelKey ||
        bs?.modelShort !== as?.modelShort ||
        bs?.modelLabel !== as?.modelLabel ||
        bs?.modelUpstream !== as?.modelUpstream ||
        bs?.responseModel !== as?.responseModel ||
        bs?.modelSource !== as?.modelSource ||
        bs?.costUsd !== as?.costUsd ||
        bs?.tokPerSec !== as?.tokPerSec ||
        bs?.ttftSec !== as?.ttftSec ||
        bs?.outputTokens !== as?.outputTokens ||
        bs?.thinkingTokens !== as?.thinkingTokens ||
        bs?.responseTokens !== as?.responseTokens ||
        bs?.inputTokens !== as?.inputTokens ||
        bs?.cacheReadTokens !== as?.cacheReadTokens ||
        bs?.contextTokens !== as?.contextTokens ||
        bs?.cacheHitPct !== as?.cacheHitPct ||
        bs?.selectedSpeedReason !== as?.selectedSpeedReason ||
        bs?.turnIndex !== as?.turnIndex ||
        bs?.rootTurnIndex !== as?.rootTurnIndex ||
        bs?.isTurnStart !== as?.isTurnStart ||
        bs?.isRootTurnStart !== as?.isRootTurnStart ||
        bs?.isLatestTurn !== as?.isLatestTurn ||
        bs?.isRootLatestTurn !== as?.isRootLatestTurn ||
        bs?.turnPrompt !== as?.turnPrompt ||
        bs?.rootTurnPrompt !== as?.rootTurnPrompt
      ) {
        return false;
      }
    }
  }

  // 4. 比对 10 通道上下文窗口构成及近期步骤明细
  const pCtx = pAct?.context;
  const nCtx = nAct?.context;
  if (pCtx?.totalTokens !== nCtx?.totalTokens) return false;
  if (pCtx?.compactionLimitTokens !== nCtx?.compactionLimitTokens) return false;
  if (pCtx?.limitTokens !== nCtx?.limitTokens) return false;
  if (pCtx?.messagesTokens !== nCtx?.messagesTokens) return false;
  if (pCtx?.assistantTokens !== nCtx?.assistantTokens) return false;
  if (pCtx?.toolResultsTokens !== nCtx?.toolResultsTokens) return false;
  if (pCtx?.userInputTokens !== nCtx?.userInputTokens) return false;
  if (pCtx?.subagentTokens !== nCtx?.subagentTokens) return false;
  if (pCtx?.checkpointTokens !== nCtx?.checkpointTokens) return false;
  if (pCtx?.systemToolsTokens !== nCtx?.systemToolsTokens) return false;
  if (pCtx?.mcpToolsTokens !== nCtx?.mcpToolsTokens) return false;
  if (pCtx?.skillsTokens !== nCtx?.skillsTokens) return false;
  if (pCtx?.systemPromptTokens !== nCtx?.systemPromptTokens) return false;
  if (pCtx?.userRulesTokens !== nCtx?.userRulesTokens) return false;
  if ((pAct?.recentSteps?.length || 0) !== (nAct?.recentSteps?.length || 0)) return false;
  for (let i = 0; pAct?.recentSteps !== nAct?.recentSteps && i < (pAct?.recentSteps?.length || 0); i++) {
    const before = pAct.recentSteps[i], after = nAct.recentSteps[i];
    if (
      before.stepIndex !== after.stepIndex ||
      before.createdAtMs !== after.createdAtMs ||
      before.totalDurationSec !== after.totalDurationSec ||
      before.streamDurationSec !== after.streamDurationSec ||
      before.modelKey !== after.modelKey ||
      before.modelShort !== after.modelShort ||
      before.modelLabel !== after.modelLabel ||
      before.modelUpstream !== after.modelUpstream ||
      before.responseModel !== after.responseModel ||
      before.modelSource !== after.modelSource ||
      before.costUsd !== after.costUsd ||
      before.tokPerSec !== after.tokPerSec ||
      before.ttftSec !== after.ttftSec ||
      before.outputTokens !== after.outputTokens ||
      before.thinkingTokens !== after.thinkingTokens ||
      before.responseTokens !== after.responseTokens ||
      before.inputTokens !== after.inputTokens ||
      before.cacheReadTokens !== after.cacheReadTokens ||
      before.contextTokens !== after.contextTokens ||
      before.cacheHitPct !== after.cacheHitPct ||
      before.selectedSpeedReason !== after.selectedSpeedReason ||
      before.turnIndex !== after.turnIndex ||
      before.rootTurnIndex !== after.rootTurnIndex ||
      before.isTurnStart !== after.isTurnStart ||
      before.isRootTurnStart !== after.isRootTurnStart ||
      before.isLatestTurn !== after.isLatestTurn ||
      before.isRootLatestTurn !== after.isRootLatestTurn ||
      before.turnPrompt !== after.turnPrompt ||
      before.rootTurnPrompt !== after.rootTurnPrompt
    ) {
      return false;
    }
  }

  // 5. 比对消费统计所选时间区间、当前会话累计消费与账号全局累计消费
  const pRange = prev.consumption?.selectedRange;
  const nRange = next.consumption?.selectedRange;
  if (pRange?.key !== nRange?.key) return false;
  if (nRange?.key === 'custom') {
    if (pRange?.startMs !== nRange?.startMs || pRange?.endMs !== nRange?.endMs) return false;
  }

  const pCons = prev.consumption?.session;
  const nCons = next.consumption?.session;
  if (pCons?.totalTokens !== nCons?.totalTokens) return false;
  if (pCons?.costUsd !== nCons?.costUsd) return false;
  if (pCons?.unpricedCalls !== nCons?.unpricedCalls) return false;

  const pAcct = prev.consumption?.account;
  const nAcct = next.consumption?.account;
  if (pAcct?.totalTokens !== nAcct?.totalTokens) return false;
  if (pAcct?.inputTokens !== nAcct?.inputTokens) return false;
  if (pAcct?.cacheReadTokens !== nAcct?.cacheReadTokens) return false;
  if (pAcct?.outputTokens !== nAcct?.outputTokens) return false;
  if (pAcct?.calls !== nAcct?.calls) return false;
  if (pAcct?.costUsd !== nAcct?.costUsd) return false;
  if (pAcct?.savedCostUsd !== nAcct?.savedCostUsd) return false;
  if (pAcct?.cacheHitPct !== nAcct?.cacheHitPct) return false;
  if (pAcct?.unpricedCalls !== nAcct?.unpricedCalls) return false;

  // 6. 比对历史趋势时间分桶序列与年度分月序列
  const pTrend = prev.consumption?.trendSeries || [];
  const nTrend = next.consumption?.trendSeries || [];
  if (pTrend.length !== nTrend.length) return false;
  for (let i = 0; i < pTrend.length; i++) {
    if (
      pTrend[i]?.tokens !== nTrend[i]?.tokens ||
      pTrend[i]?.calls !== nTrend[i]?.calls ||
      pTrend[i]?.label !== nTrend[i]?.label ||
      pTrend[i]?.fullLabel !== nTrend[i]?.fullLabel
    ) {
      return false;
    }
  }
  if (prev.consumption?.monthlyYear !== next.consumption?.monthlyYear) return false;
  const pMonthly = prev.consumption?.monthlySeries || [];
  const nMonthly = next.consumption?.monthlySeries || [];
  if (pMonthly.length !== nMonthly.length) return false;
  for (let i = 0; i < pMonthly.length; i++) {
    if (
      pMonthly[i]?.totalTokens !== nMonthly[i]?.totalTokens ||
      pMonthly[i]?.costUsd !== nMonthly[i]?.costUsd ||
      pMonthly[i]?.calls !== nMonthly[i]?.calls
    ) {
      return false;
    }
  }

  // 7. 比对按模型汇总明细与数据来源汇总明细
  const pModels = prev.modelBreakdown || [];
  const nModels = next.modelBreakdown || [];
  if (pModels.length !== nModels.length) return false;
  for (let i = 0; i < pModels.length; i++) {
    if (
      pModels[i]?.label !== nModels[i]?.label ||
      pModels[i]?.shortName !== nModels[i]?.shortName ||
      pModels[i]?.upstreamName !== nModels[i]?.upstreamName ||
      pModels[i]?.costUsd !== nModels[i]?.costUsd ||
      pModels[i]?.unpricedCalls !== nModels[i]?.unpricedCalls ||
      pModels[i]?.totalTokens !== nModels[i]?.totalTokens ||
      pModels[i]?.calls !== nModels[i]?.calls
    ) {
      return false;
    }
  }

  const pSources = prev.consumption?.sourcesBreakdown || [];
  const nSources = next.consumption?.sourcesBreakdown || [];
  if (pSources.length !== nSources.length) return false;
  for (let i = 0; i < pSources.length; i++) {
    if (
      pSources[i]?.name !== nSources[i]?.name ||
      pSources[i]?.costUsd !== nSources[i]?.costUsd ||
      pSources[i]?.unpricedCalls !== nSources[i]?.unpricedCalls ||
      pSources[i]?.totalTokens !== nSources[i]?.totalTokens ||
      pSources[i]?.calls !== nSources[i]?.calls
    ) {
      return false;
    }
  }

  // 8. 比对账号订阅档位与动态多配额池
  if (
    prev.account?.email !== next.account?.email ||
    prev.account?.name !== next.account?.name ||
    prev.account?.status !== next.account?.status ||
    prev.account?.tierName !== next.account?.tierName ||
    prev.account?.planName !== next.account?.planName ||
    prev.account?.aiCredits !== next.account?.aiCredits
  ) {
    return false;
  }

  if (
    prev.quotas?.meta?.refreshFailed !== next.quotas?.meta?.refreshFailed ||
    prev.quotas?.meta?.isStale !== next.quotas?.meta?.isStale
  ) {
    return false;
  }

  const pQuot = prev.quotas?.activePool;
  const nQuot = next.quotas?.activePool;
  if (pQuot?.family !== nQuot?.family) return false;
  if (pQuot?.usedPct !== nQuot?.usedPct) return false;
  if (pQuot?.remainingPct !== nQuot?.remainingPct) return false;
  if (pQuot?.weeklyUsedPct !== nQuot?.weeklyUsedPct) return false;
  if (pQuot?.weeklyRemainingPct !== nQuot?.weeklyRemainingPct) return false;
  if (prev.quotas?.weekly?.usedPct !== next.quotas?.weekly?.usedPct) return false;
  if (prev.quotas?.weekly?.remainingPct !== next.quotas?.weekly?.remainingPct) return false;
  if (prev.quotas?.weekly?.tokens !== next.quotas?.weekly?.tokens) return false;
  if (prev.quotas?.weekly?.costUsd !== next.quotas?.weekly?.costUsd) return false;
  if (prev.quotas?.weekly?.calls !== next.quotas?.weekly?.calls) return false;
  if (prev.quotas?.weekly?.unpricedCalls !== next.quotas?.weekly?.unpricedCalls) return false;
  if (prev.quotas?.weekly?.resetTime !== next.quotas?.weekly?.resetTime) return false;

  const pPools = prev.quotas?.pools || [];
  const nPools = next.quotas?.pools || [];
  if (pPools.length !== nPools.length) return false;
  for (let i = 0; i < pPools.length; i++) {
    if (
      pPools[i]?.poolKey !== nPools[i]?.poolKey ||
      pPools[i]?.poolLabel !== nPools[i]?.poolLabel ||
      pPools[i]?.usedPct !== nPools[i]?.usedPct ||
      pPools[i]?.remainingPct !== nPools[i]?.remainingPct ||
      pPools[i]?.resetTime !== nPools[i]?.resetTime ||
      pPools[i]?.weeklyUsedPct !== nPools[i]?.weeklyUsedPct ||
      pPools[i]?.weeklyRemainingPct !== nPools[i]?.weeklyRemainingPct ||
      pPools[i]?.weeklyResetTime !== nPools[i]?.weeklyResetTime ||
      pPools[i]?.cycle5h?.tokens !== nPools[i]?.cycle5h?.tokens ||
      pPools[i]?.cycle5h?.costUsd !== nPools[i]?.cycle5h?.costUsd ||
      pPools[i]?.cycle5h?.calls !== nPools[i]?.cycle5h?.calls ||
      pPools[i]?.cycleWeekly?.tokens !== nPools[i]?.cycleWeekly?.tokens ||
      pPools[i]?.cycleWeekly?.costUsd !== nPools[i]?.cycleWeekly?.costUsd ||
      pPools[i]?.cycleWeekly?.calls !== nPools[i]?.cycleWeekly?.calls
    ) {
      return false;
    }
  }

  if (prev.quotas?.sessionUsed?.cascadeId !== next.quotas?.sessionUsed?.cascadeId) return false;
  if (prev.quotas?.sessionUsed?.totalTokens !== next.quotas?.sessionUsed?.totalTokens) return false;
  if (prev.quotas?.sessionUsed?.totalCalls !== next.quotas?.sessionUsed?.totalCalls) return false;
  if (prev.quotas?.sessionUsed?.totalCostUsd !== next.quotas?.sessionUsed?.totalCostUsd) return false;
  const pSessPools = prev.quotas?.sessionUsed?.pools || [];
  const nSessPools = next.quotas?.sessionUsed?.pools || [];
  if (pSessPools.length !== nSessPools.length) return false;
  for (let i = 0; i < pSessPools.length; i++) {
    if (
      pSessPools[i]?.poolKey !== nSessPools[i]?.poolKey ||
      pSessPools[i]?.calls !== nSessPools[i]?.calls ||
      pSessPools[i]?.totalTokens !== nSessPools[i]?.totalTokens ||
      pSessPools[i]?.used5hPct !== nSessPools[i]?.used5hPct ||
      pSessPools[i]?.source5h !== nSessPools[i]?.source5h ||
      pSessPools[i]?.usedWeeklyPct !== nSessPools[i]?.usedWeeklyPct ||
      pSessPools[i]?.sourceWeekly !== nSessPools[i]?.sourceWeekly
    ) {
      return false;
    }
  }

  const pConsConvs = prev.consumption?.conversationsBreakdown || [];
  const nConsConvs = next.consumption?.conversationsBreakdown || [];
  if (pConsConvs.length !== nConsConvs.length) return false;
  for (let i = 0; i < pConsConvs.length; i++) {
    if (
      pConsConvs[i]?.cascadeId !== nConsConvs[i]?.cascadeId ||
      pConsConvs[i]?.totalTokens !== nConsConvs[i]?.totalTokens ||
      pConsConvs[i]?.costUsd !== nConsConvs[i]?.costUsd ||
      pConsConvs[i]?.calls !== nConsConvs[i]?.calls ||
      pConsConvs[i]?.lastActivityMs !== nConsConvs[i]?.lastActivityMs ||
      pConsConvs[i]?.isCurrent !== nConsConvs[i]?.isCurrent ||
      pConsConvs[i]?.title !== nConsConvs[i]?.title
    ) {
      return false;
    }
  }

  const pConvs = prev.conversations || [];
  const nConvs = next.conversations || [];
  if (pConvs.length !== nConvs.length) return false;
  for (let i = 0; i < pConvs.length; i++) {
    if (
      pConvs[i]?.cascadeId !== nConvs[i]?.cascadeId ||
      pConvs[i]?.title !== nConvs[i]?.title ||
      pConvs[i]?.status !== nConvs[i]?.status ||
      pConvs[i]?.stepCount !== nConvs[i]?.stepCount ||
      pConvs[i]?.subagentCount !== nConvs[i]?.subagentCount ||
      pConvs[i]?.totalStepCount !== nConvs[i]?.totalStepCount
    ) {
      return false;
    }
  }

  const pRunning = prev.runningConversations || [];
  const nRunning = next.runningConversations || [];
  if (pRunning.length !== nRunning.length) return false;
  for (let i = 0; i < pRunning.length; i++) {
    const pr = pRunning[i];
    const nr = nRunning[i];
    if (
      pr?.cascadeId !== nr?.cascadeId ||
      pr?.title !== nr?.title ||
      pr?.isCurrentSelected !== nr?.isCurrentSelected ||
      pr?.isMainRunning !== nr?.isMainRunning ||
      pr?.subagentCount !== nr?.subagentCount ||
      pr?.runningSubagentCount !== nr?.runningSubagentCount ||
      pr?.mainActivity?.signature !== nr?.mainActivity?.signature ||
      pr?.mainActivity?.startedAtMs !== nr?.mainActivity?.startedAtMs
    ) {
      return false;
    }
    const pSubs = pr?.subagents || [];
    const nSubs = nr?.subagents || [];
    if (pSubs.length !== nSubs.length) return false;
    for (let j = 0; j < pSubs.length; j++) {
      if (
        pSubs[j]?.cascadeId !== nSubs[j]?.cascadeId ||
        pSubs[j]?.role !== nSubs[j]?.role ||
        pSubs[j]?.isRunning !== nSubs[j]?.isRunning ||
        pSubs[j]?.stepCount !== nSubs[j]?.stepCount ||
        pSubs[j]?.liveActivity?.signature !== nSubs[j]?.liveActivity?.signature ||
        pSubs[j]?.liveActivity?.startedAtMs !== nSubs[j]?.liveActivity?.startedAtMs
      ) {
        return false;
      }
    }
  }

  return true;
}

export async function fetchTelemetry({ force = false } = {}) {
  if (!force && activeForceCount > 0) {
    return telemetryStore.getState().telemetry;
  }

  const overlay = isWindowOverlayMode();
  if (overlay) {
    const st = telemetryStore.getState();
    const liveRouteId = extractHostRouteCascadeId();
    if (liveRouteId !== st.hostRouteConversationId) {
      const patch = { hostRouteConversationId: liveRouteId };
      if (liveRouteId && st.selectedConversationId && st.selectedConversationId !== liveRouteId) {
        patch.selectedConversationId = '';
      }
      telemetryStore.setState(patch);
    }
  }
  const current = telemetryStore.getState();
  const effectiveConvId = current.selectedConversationId || current.hostRouteConversationId || '';
  const params = new URLSearchParams();
  if (effectiveConvId) params.set('conversationId', effectiveConvId);
  if (current.selectedTimeRange) params.set('range', current.selectedTimeRange);
  if (current.selectedTimeRange === 'custom') {
    if (current.customStartMs > 0) params.set('startMs', String(current.customStartMs));
    if (current.customEndMs > 0) params.set('endMs', String(current.customEndMs));
  }
  if (force) params.set('force', '1');
  params.set('stepDetails', 'display');

  if (force) {
    inFlightTelemetryPoll = null;
    return requestTelemetry(params, true);
  }
  const query = params.toString();
  const bridge = overlay ? getWindowBridgeConfig() : null;
  const existing = inFlightTelemetryPoll;
  if (existing?.query === query && existing.port === bridge?.port && existing.token === bridge?.token) {
    return existing.promise;
  }
  const poll = { query, port: bridge?.port, token: bridge?.token, promise: null };
  poll.promise = requestTelemetry(params, false).finally(() => {
    if (inFlightTelemetryPoll === poll) inFlightTelemetryPoll = null;
  });
  inFlightTelemetryPoll = poll;
  return poll.promise;
}

function readDisplaySteps(payload) {
  const active = payload?.activeConversation;
  if (!payload?.stepRevision || !Array.isArray(active?.recentSteps)) return null;
  return {
    revision: payload.stepRevision,
    recentSteps: active.recentSteps,
    agentSteps: active.agents.map((agent) => agent.recentSteps === active.recentSteps
      ? undefined
      : agent.recentSteps),
  };
}

async function requestTelemetry(params, force) {
  const reqSeq = ++latestRequestSeq;
  const startMs = Date.now();

  if (force) {
    activeForceCount += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    telemetryStore.setState({ syncState: 'syncing' });
  }

  try {
    const previousSteps = lastReceivedSteps || readDisplaySteps(telemetryStore.getState().telemetry);
    params.set('stepRevision', previousSteps?.revision || '');
    const payload = await callSidecarApi(`/api/telemetry?${params}`, {
      method: 'GET',
      abortKey: force ? 'telemetry-force' : 'telemetry-poll',
    });

    const active = payload?.activeConversation;
    if (payload?.stepsUnchanged) {
      if (!active || !previousSteps || payload.stepRevision !== previousSteps.revision) {
        throw new Error('Telemetry step revision mismatch');
      }
      active.recentSteps = previousSteps.recentSteps;
      active.agents.forEach((agent, index) => {
        const steps = previousSteps.agentSteps[index];
        if (steps) agent.recentSteps = steps;
      });
    }
    if (reqSeq !== latestRequestSeq) {
      return payload;
    }
    lastReceivedSteps = readDisplaySteps(payload);

    if (payload?.uiBundleVersion) {
      if (activeBundleVersion && activeBundleVersion !== payload.uiBundleVersion) {
        if (
          !isWindowOverlayMode() &&
          typeof window !== 'undefined' &&
          typeof window.location?.reload === 'function'
        ) {
          window.location.reload();
          return payload;
        }
      }
      activeBundleVersion = payload.uiBundleVersion;
    }
    consecutivePollFailures = 0;

    const latestSt = telemetryStore.getState();
    const previousAccount = latestSt.telemetry?.account;
    const nextAccount = payload?.account;
    const accountChanged = previousAccount?.status === 'signedIn' &&
      (nextAccount?.status === 'signedOut' || (nextAccount?.status === 'signedIn' &&
        (previousAccount.email || previousAccount.name) !== (nextAccount.email || nextAccount.name)));
    const accountPatch = accountChanged ? { selectedConversationId: '' } : {};
    if (force) {
      const elapsed = Date.now() - startMs;
      if (elapsed < 220) {
        await new Promise((r) => setTimeout(r, 220 - elapsed));
      }
      if (reqSeq !== latestRequestSeq) {
        return payload;
      }
      if (feedbackTimer) clearTimeout(feedbackTimer);
      telemetryStore.setState({
        ...accountPatch,
        telemetry: payload,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: 'synced',
      });
      feedbackTimer = setTimeout(() => {
        feedbackTimer = null;
        telemetryStore.setState({ syncState: 'idle' });
      }, 1100);
    } else {
      const isSame = isEquivalentTelemetry(latestSt.telemetry, payload);
      const nextTelemetry = isSame ? latestSt.telemetry : payload;
      telemetryStore.setState({
        ...accountPatch,
        telemetry: nextTelemetry,
        minuteTick: Math.floor(Date.now() / 30000),
        syncState: latestSt.syncState === 'synced' ? 'synced' : 'idle',
      });
    }
    return payload;
  } catch (err) {
    if (err?.name === 'AbortError' || reqSeq !== latestRequestSeq) return null;
    consecutivePollFailures += 1;
    if (force || consecutivePollFailures >= 2 || !telemetryStore.getState().telemetry) {
      telemetryStore.setState({ syncState: 'error' });
    }
    return null;
  } finally {
    if (force) {
      activeForceCount = Math.max(0, activeForceCount - 1);
      if (activeForceCount === 0 && loopActive && loopTickFn && !pollTimer) {
        pollTimer = setTimeout(loopTickFn, loopIntervalMs);
      }
    }
  }
}

export async function saveSettingsPatch(patch) {
  const safePatch = patch && typeof patch === 'object' ? { ...patch } : {};
  if (Object.prototype.hasOwnProperty.call(safePatch, 'language')) {
    safePatch.language = normalizeI18nLanguage(safePatch.language);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'themeAccent')) {
    safePatch.themeAccent = normalizeClientThemeAccent(safePatch.themeAccent);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'fontScale')) {
    safePatch.fontScale = normalizeClientFontScale(safePatch.fontScale);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'weeklyLimitMode')) {
    const mode = safePatch.weeklyLimitMode;
    safePatch.weeklyLimitMode =
      mode === 'custom_tokens' || mode === 'custom_cost' ? mode : 'official';
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'enableCliStatusLine')) {
    safePatch.enableCliStatusLine = Boolean(safePatch.enableCliStatusLine);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showTopbarMultiSession')) {
    safePatch.showTopbarMultiSession = Boolean(safePatch.showTopbarMultiSession);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepTurnRail')) {
    safePatch.showStepTurnRail = Boolean(safePatch.showStepTurnRail);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepAgentBadge')) {
    safePatch.showStepAgentBadge = Boolean(safePatch.showStepAgentBadge);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'showStepSpeedColor')) {
    safePatch.showStepSpeedColor = Boolean(safePatch.showStepSpeedColor);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'topbarCapsuleSlots')) {
    safePatch.topbarCapsuleSlots = normalizeClientTopbarSlots(safePatch.topbarCapsuleSlots);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'hoverModules')) {
    safePatch.hoverModules = normalizeClientHoverModules(safePatch.hoverModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewModules')) {
    safePatch.overviewModules = normalizeClientOverviewModules(safePatch.overviewModules);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'overviewMetrics')) {
    safePatch.overviewMetrics = normalizeClientOverviewMetrics(safePatch.overviewMetrics);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTableColumns')) {
    safePatch.stepTableColumns = normalizeClientStepColumns(safePatch.stepTableColumns);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'stepTokenComboFormat')) {
    safePatch.stepTokenComboFormat = normalizeClientStepTokenComboFormat(
      safePatch.stepTokenComboFormat
    );
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'modelDisplayMode')) {
    const normDisp = normalizeClientModelDisplayMode(
      safePatch.modelDisplayMode,
      safePatch.showUpstreamModel
    );
    safePatch.modelDisplayMode = normDisp;
    safePatch.showUpstreamModel = normDisp !== 'short';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'showUpstreamModel')) {
    safePatch.showUpstreamModel = Boolean(safePatch.showUpstreamModel);
    safePatch.modelDisplayMode = safePatch.showUpstreamModel ? 'upstream' : 'short';
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidthMode')) {
    safePatch.popoverWidthMode = normalizeClientPopoverWidthMode(safePatch.popoverWidthMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'popoverWidth')) {
    safePatch.popoverWidth = normalizeClientPopoverWidth(safePatch.popoverWidth);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'contextWindowRiskAccepted')) {
    safePatch.contextWindowRiskAccepted = Boolean(safePatch.contextWindowRiskAccepted);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'orchestratorIdMode')) {
    safePatch.orchestratorIdMode = normalizeClientOrchestratorIdMode(safePatch.orchestratorIdMode);
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'standalonePort')) {
    const numPort = Number(safePatch.standalonePort);
    safePatch.standalonePort =
      Number.isInteger(numPort) && numPort >= 1024 && numPort <= 65535 ? numPort : 0;
  }
  if (Object.prototype.hasOwnProperty.call(safePatch, 'windowMountMode')) {
    const normMount = normalizeClientWindowMountMode(
      safePatch.windowMountMode,
      safePatch.enableWindowOverlay
    );
    safePatch.windowMountMode = normMount;
    safePatch.enableWindowOverlay = normMount !== 'sidebar';
  } else if (Object.prototype.hasOwnProperty.call(safePatch, 'enableWindowOverlay')) {
    safePatch.enableWindowOverlay = Boolean(safePatch.enableWindowOverlay);
    safePatch.windowMountMode = safePatch.enableWindowOverlay ? 'dual' : 'sidebar';
  }
  const prevTelemetry = telemetryStore.getState().telemetry;
  if (prevTelemetry?.settings) {
    telemetryStore.setState({
      telemetry: {
        ...prevTelemetry,
        settings: { ...prevTelemetry.settings, ...safePatch },
      },
    });
  }
  try {
    await callSidecarApi('/api/settings', { method: 'POST', body: safePatch });
  } catch (err) {
    if (prevTelemetry) {
      telemetryStore.setState({ telemetry: prevTelemetry });
    }
    throw err;
  }
  await fetchTelemetry({ force: true });
}

export async function saveModelContextWindow(modelId, option) {
  const result = await callSidecarApi('/api/context-window', {
    method: 'POST',
    body: { modelId, option },
  });
  const telemetry = telemetryStore.getState().telemetry;
  if (telemetry?.settings) {
    telemetryStore.setState({
      telemetry: {
        ...telemetry,
        settings: { ...telemetry.settings, modelContextWindows: result.modelContextWindows },
      },
    });
  }
  return result.modelContextWindows;
}

export async function resetAllSettings() {
  const res = await callSidecarApi('/api/settings/reset', { method: 'POST', body: {} });
  const prevTelemetry = telemetryStore.getState().telemetry;
  if (res?.settings && prevTelemetry) {
    telemetryStore.setState({
      telemetry: {
        ...prevTelemetry,
        settings: { ...res.settings },
      },
    });
  }
  await fetchTelemetry({ force: true });
  return res;
}

export async function rebuildTrajectoryCache() {
  const res = await callSidecarApi('/api/cache/rebuild', { method: 'POST', body: {} });
  await fetchTelemetry({ force: true });
  return res;
}

export async function triggerCloudSync() {
  const res = await callSidecarApi('/api/cloud-sync', { method: 'POST', body: {} });
  await fetchTelemetry({ force: true });
  return res;
}

export async function triggerPluginUpdate() {
  const res = await callSidecarApi('/api/plugin-update', { method: 'POST', body: {} });
  if (res?.ok && res?.restarting) {
    await new Promise((r) => setTimeout(r, 1100));
    if (
      !isWindowOverlayMode() &&
      typeof window !== 'undefined' &&
      typeof window.location?.reload === 'function'
    ) {
      window.location.reload();
      return res;
    }
  }
  await fetchTelemetry({ force: true });
  return res;
}

export function startAsyncTelemetryLoop(intervalMs = 2000) {
  stopAsyncTelemetryLoop();
  loopActive = true;
  loopIntervalMs = intervalMs;

  const resolveNextDelay = () => {
    if (isWindowOverlayMode() && typeof document !== 'undefined' && document.hidden) {
      return Math.max(loopIntervalMs, 8000);
    }
    return loopIntervalMs;
  };

  const tick = async () => {
    pollTimer = null;
    if (!loopActive) return;
    await fetchTelemetry({ force: false });
    if (!loopActive || activeForceCount > 0) return;
    if (!pollTimer) {
      pollTimer = setTimeout(tick, resolveNextDelay());
    }
  };
  loopTickFn = tick;

  tick();
  return () => {
    stopAsyncTelemetryLoop();
  };
}

export function stopAsyncTelemetryLoop() {
  loopActive = false;
  loopTickFn = null;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
}

/**
 * 根据代理索引返回对应的微边框语义徽章样式类名。
 *
 * @param {number} [index=0]
 * @param {boolean} [isMain=false]
 * @returns {string}
 */
export function getAgentBadgeClass(index = 0, isMain = false) {
  if (isMain || index <= 0) return 'badge-main';
  const slot = ((index - 1) % 3) + 1;
  return `badge-sub-${slot}`;
}

/**
 * 格式化主/子代理的紧凑短徽章文本（中文如 `主` / `子1`，英文如 `Main` / `S1`）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentBadgeText(agent) {
  if (!isEnglishLocale()) {
    if (!agent || agent.isMain) return agent?.badgeText || '主';
    return agent.badgeText || `子${agent.index || ''}`;
  }
  if (!agent || agent.isMain) return t('fmt.mainBadge');
  return agent.index ? t('fmt.subBadge', { index: agent.index }) : t('fmt.subBadgeShort');
}

/**
 * 格式化主/子代理的完整显示名称（如 `子代理 #1 · Codebase Researcher`）。
 *
 * @param {object|null|undefined} agent
 * @returns {string}
 */
export function formatAgentLabel(agent) {
  if (!isEnglishLocale()) {
    if (!agent) return '主代理';
    if (agent.isMain) return agent.shortLabel || '主代理';
    const rolePart = agent.role && agent.role !== '子代理' ? ` · ${agent.role}` : '';
    return `${agent.shortLabel || '子代理'}${rolePart}`;
  }
  if (!agent || agent.isMain) return t('fmt.mainAgent');
  const idx = Number(agent.index || 0);
  const baseLabel = idx > 0 ? `${t('fmt.subAgent')} #${idx}` : t('fmt.subAgent');
  const rolePart =
    agent.role && agent.role !== '子代理' && agent.role !== 'Subagent' ? ` · ${agent.role}` : '';
  return `${baseLabel}${rolePart}`;
}

/**
 * 解析当前选中的主/子代理作用域视图数据与独立上下文窗口检视目标。
 * 同时在客户端按需组装主代理与全部汇总的 `recentSteps`，避免后端 JSON 载荷重复序列化 2-3 倍步骤列表。
 *
 * @param {object|null} telemetry
 * @param {string} [selectedAgentScope='all']
 * @param {string} [ctxInspectorAgentId='auto']
 * @param {boolean} [includeSteps=false] 是否组装调用明细所需的步骤列表
 */
export function resolveScopedConversation(
  telemetry,
  selectedAgentScope = 'all',
  ctxInspectorAgentId = 'auto',
  includeSteps = false
) {
  const active = telemetry?.activeConversation || {};
  const agents = Array.isArray(active.agents) && active.agents.length > 0 ? active.agents : [];
  const hasSubagents = Boolean(active.hasSubagents && agents.length > 1);
  const subagents = agents.filter((a) => !a.isMain);
  const mainAgent = agents.find((a) => a.isMain) || active;
  if (includeSteps && !Array.isArray(mainAgent.recentSteps) && Array.isArray(active.recentSteps)) {
    mainAgent.recentSteps = active.recentSteps;
  }
  const aggregated = active.aggregated || active;
  if (includeSteps && hasSubagents && !Array.isArray(aggregated.recentSteps)) {
    const combined = [];
    for (const ag of agents) {
      const steps = ag.isMain ? ag.recentSteps || active.recentSteps || [] : ag.recentSteps || [];
      for (const step of steps) combined.push(step);
    }
    combined.sort(
      (a, b) =>
        (b.createdAtMs || 0) - (a.createdAtMs || 0) ||
        (b.agentIndex || 0) - (a.agentIndex || 0) ||
        (b.stepIndex || 0) - (a.stepIndex || 0)
    );
    aggregated.recentSteps = combined;
  }

  if (!hasSubagents) {
    return {
      hasSubagents: false,
      effectiveScope: 'main',
      effectiveCtxScope: 'main',
      agents,
      subagents: [],
      mainAgent,
      aggregated,
      scopedConv: active,
      ctxAgent: mainAgent,
    };
  }

  const isValidSub = subagents.some((s) => s.agentId === selectedAgentScope);
  const effectiveScope =
    selectedAgentScope === 'main'
      ? 'main'
      : isValidSub
        ? selectedAgentScope
        : 'all';

  const scopedConv =
    effectiveScope === 'all'
      ? aggregated
      : agents.find((a) => a.agentId === effectiveScope) || mainAgent;

  let ctxAgent = scopedConv;
  let effectiveCtxScope = effectiveScope;
  if (effectiveScope === 'all') {
    if (ctxInspectorAgentId && ctxInspectorAgentId !== 'auto') {
      const matched = agents.find((a) => a.agentId === ctxInspectorAgentId);
      if (matched) {
        ctxAgent = matched;
        effectiveCtxScope = matched.agentId;
      } else {
        effectiveCtxScope = 'auto';
      }
    } else {
      effectiveCtxScope = 'auto';
    }
    if (effectiveCtxScope === 'auto') {
      ctxAgent =
        agents.find((a) => a.agentId === aggregated.activeAgentId) ||
        agents.find((a) => a.isRunning) ||
        mainAgent;
    }
  }

  return {
    hasSubagents: true,
    effectiveScope,
    effectiveCtxScope,
    agents,
    subagents,
    mainAgent,
    aggregated,
    scopedConv,
    ctxAgent,
  };
}

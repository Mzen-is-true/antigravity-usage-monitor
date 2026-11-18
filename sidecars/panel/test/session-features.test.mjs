import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { backendHarness } from './backend-harness.mjs';
import { normalizeWindowMountMode } from '../shared/settings-normalization.mjs';

const FLASH = 'MODEL_PLACEHOLDER_M318';
const ARGON = 'MODEL_PLACEHOLDER_M417';
const CARBON = 'MODEL_PLACEHOLDER_M427';
const CLAUDE = 'MODEL_PLACEHOLDER_M35';

function makeDatedStep(index, model, createdAtMs, { inp = 1000, cache = 4000, out = 500 } = {}) {
  return {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex: index },
      createdAt: new Date(createdAtMs).toISOString(),
      completedAt: new Date(createdAtMs + 4000).toISOString(),
      modelUsage: {
        model,
        apiProvider:
          model === CLAUDE ? 'API_PROVIDER_GOOGLE_VERTEX_ANTHROPIC' : 'API_PROVIDER_GOOGLE_GEMINI',
        inputTokens: String(inp),
        cacheReadTokens: String(cache),
        outputTokens: String(out),
      },
    },
  };
}

function buildProUserStatus(geminiRem = 0.9, argonRem = 0.7, resetBaseMs = Date.now()) {
  const fiveHourReset = new Date(resetBaseMs + 2 * 3600_000).toISOString();
  const geminiWkReset = new Date(resetBaseMs + 48 * 3600_000).toISOString();
  const argonWkReset = new Date(resetBaseMs + 72 * 3600_000).toISOString();
  const claudeWkReset = new Date(resetBaseMs + 96 * 3600_000).toISOString();
  return {
    userStatus: {
      email: 'pro@example.com',
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
      planStatus: { planInfo: { planName: 'Pro' } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Argon (High)',
            modelId: 'gemini-4-argon-high',
            modelOrAlias: { model: ARGON },
            quotaInfo: { remainingFraction: argonRem, resetTime: argonWkReset },
          },
          {
            label: 'Gemini 3.8 Flash (High)',
            modelId: 'gemini-3.8-flash-high',
            modelOrAlias: { model: FLASH },
            quotaInfo: { remainingFraction: geminiRem, resetTime: geminiWkReset },
          },
          {
            label: 'Claude Opus 4.6',
            modelId: 'claude-opus-4-6',
            modelOrAlias: { model: CLAUDE },
            quotaInfo: { remainingFraction: 0.95, resetTime: claudeWkReset },
          },
        ],
      },
    },
    quotaSummary: {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: fiveHourReset },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: geminiRem, resetTime: geminiWkReset },
          ],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [
            { bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: argonRem, resetTime: argonWkReset },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: fiveHourReset },
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.95, resetTime: claudeWkReset },
          ],
        },
      ],
    },
  };
}

test('Feature 1 backend: sessionUsed lists ONLY quota groups actually used by main+subagents and omits unused groups', async () => {
  const now = Date.now();
  const { userStatus, quotaSummary } = buildProUserStatus(0.9, 0.7, now);

  const h = backendHarness({
    userStatus,
    quotaSummary,
    summaries: {
      rootConv: {
        stepCount: 2,
        lastModifiedTime: new Date(now - 5_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Main Argon + Sub Flash' },
      },
      subConv: {
        stepCount: 1,
        createdTime: new Date(now - 10_000).toISOString(),
        lastModifiedTime: new Date(now - 2_000).toISOString(),
        status: 'IDLE',
        trajectoryMetadata: {
          rootConversationId: 'rootConv',
          parentConversationId: 'rootConv',
          subagentSpec: { typeName: 'research', role: 'Helper' },
        },
      },
      otherConv: {
        stepCount: 1,
        lastModifiedTime: new Date(now - 60_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Claude Session' },
      },
    },
    trajectories: {
      rootConv: {
        trajectory: { steps: [makeDatedStep(1, ARGON, now - 15_000, { inp: 10000, cache: 20000, out: 2000 })] },
      },
      subConv: {
        trajectory: { steps: [makeDatedStep(1, FLASH, now - 8_000, { inp: 5000, cache: 10000, out: 1000 })] },
      },
      otherConv: {
        trajectory: { steps: [makeDatedStep(1, CLAUDE, now - 60_000, { inp: 4000, cache: 0, out: 1000 })] },
      },
    },
  });

  const payload = await h.buildTelemetryPayloadInternal('rootConv');
  const usedPools = payload.quotas.sessionUsed.pools;

  assert.deepEqual(
    Array.from(usedPools, (p) => p.poolKey),
    ['Gemini', 'Argon'],
    'must include Gemini (from subagent) and Argon (from root), and exclude unused Claude & GPT'
  );
  const geminiUsed = usedPools.find((p) => p.poolKey === 'Gemini');
  const argonUsed = usedPools.find((p) => p.poolKey === 'Argon');
  assert.equal(geminiUsed.calls, 1);
  assert.equal(geminiUsed.totalTokens, 16000);
  assert.equal(geminiUsed.has5h, true);
  assert.equal(geminiUsed.hasWeekly, true);
  assert.equal(geminiUsed.usedWeeklyPct, 10);
  assert.equal(geminiUsed.sourceWeekly, 'estimated');

  assert.equal(argonUsed.calls, 1);
  assert.equal(argonUsed.totalTokens, 32000);
  assert.equal(argonUsed.has5h, false);
  assert.equal(argonUsed.hasWeekly, true);
  assert.equal(argonUsed.usedWeeklyPct, 30);
  assert.equal(argonUsed.sourceWeekly, 'estimated');
});

test('Feature 1 backend: live quota delta attribution distributes fresh increases across concurrent sessions and avoids negative delta on reset', async () => {
  const now = Date.now();
  const { userStatus, quotaSummary } = buildProUserStatus(0.9, 0.8, now);
  const summaries = {
    convA: {
      stepCount: 1,
      lastModifiedTime: new Date(now - 500_000).toISOString(),
      status: 'IDLE',
      annotations: { title: 'Session A' },
    },
    convB: {
      stepCount: 1,
      lastModifiedTime: new Date(now - 500_000).toISOString(),
      status: 'IDLE',
      annotations: { title: 'Session B' },
    },
  };

  const h = backendHarness({
    userStatus,
    quotaSummary,
    summaries,
    trajectories: {
      convA: {
        trajectory: { steps: [makeDatedStep(1, ARGON, now - 500_000, { inp: 100000, cache: 0, out: 10000 })] },
      },
      convB: {
        trajectory: { steps: [makeDatedStep(1, ARGON, now - 500_000, { inp: 100000, cache: 0, out: 10000 })] },
      },
    },
  });

  // Poll 1: baseline initialization (each pre-existing session shares 50% of existing 20% weekly used -> 10% est)
  const p1 = await h.buildTelemetryPayloadInternal('convA');
  const a1 = p1.quotas.sessionUsed.pools.find((p) => p.poolKey === 'Argon');
  assert.equal(a1.observedWeeklyPct, 0);
  assert.equal(a1.estimatedWeeklyPct, 10);

  // Add new steps: convA adds 3x weight vs convB 1x weight; Argon weekly used increases from 20% -> 28% (+8%)
  summaries.convA.stepCount = 2;
  summaries.convA.lastModifiedTime = new Date(now - 2_000).toISOString();
  summaries.convB.stepCount = 2;
  summaries.convB.lastModifiedTime = new Date(now - 2_000).toISOString();
  h.state.trajectories.convA = {
    trajectory: {
      steps: [
        makeDatedStep(1, ARGON, now - 500_000, { inp: 100000, cache: 0, out: 10000 }),
        makeDatedStep(2, ARGON, now - 2_000, { inp: 300000, cache: 0, out: 30000 }),
      ],
    },
  };
  h.state.trajectories.convB = {
    trajectory: {
      steps: [
        makeDatedStep(1, ARGON, now - 500_000, { inp: 100000, cache: 0, out: 10000 }),
        makeDatedStep(2, ARGON, now - 2_000, { inp: 100000, cache: 0, out: 10000 }),
      ],
    },
  };
  h.state.quotaSummary.groups[1].buckets[0].remainingFraction = 0.72; // 28% used (+8% delta)

  const p2A = await h.buildTelemetryPayloadInternal('convA', true);
  const a2 = p2A.quotas.sessionUsed.pools.find((p) => p.poolKey === 'Argon');
  assert.equal(a2.observedWeeklyPct, 6); // 8% * 3/4 = 6%
  assert.equal(a2.estimatedWeeklyPct, 10);
  assert.equal(a2.usedWeeklyPct, 16);
  assert.equal(a2.sourceWeekly, 'mixed');

  const p2B = await h.buildTelemetryPayloadInternal('convB');
  const b2 = p2B.quotas.sessionUsed.pools.find((p) => p.poolKey === 'Argon');
  assert.equal(b2.observedWeeklyPct, 2); // 8% * 1/4 = 2%

  // Simulate weekly quota reset (+10 days resetTime jump, remaining jumps back up to 0.99 -> 1% used)
  const nextReset = new Date(now + 10 * 24 * 3600_000).toISOString();
  h.state.quotaSummary.groups[1].buckets[0].resetTime = nextReset;
  h.state.quotaSummary.groups[1].buckets[0].remainingFraction = 0.99;

  const p3A = await h.buildTelemetryPayloadInternal('convA', true);
  const a3 = p3A.quotas.sessionUsed.pools.find((p) => p.poolKey === 'Argon');
  assert.equal(a3.observedWeeklyPct, 6, 'reset must never subtract negative delta from session total');
});

test('Feature 2 backend: conversationsBreakdown compares all conversations within selected time range and merges subagents under root title', async () => {
  const now = Date.now();
  const h = backendHarness({
    summaries: {
      heavyRoot: {
        stepCount: 1,
        lastModifiedTime: new Date(now - 3600_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Heavy Root Task' },
      },
      heavySub: {
        stepCount: 1,
        createdTime: new Date(now - 3000_000).toISOString(),
        lastModifiedTime: new Date(now - 1800_000).toISOString(),
        status: 'IDLE',
        trajectoryMetadata: {
          rootConversationId: 'heavyRoot',
          parentConversationId: 'heavyRoot',
          subagentSpec: { typeName: 'research', role: 'Deep Subagent Role' },
        },
      },
      lightRoot: {
        stepCount: 1,
        lastModifiedTime: new Date(now - 1200_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Light Chat' },
      },
      oldRoot: {
        stepCount: 1,
        lastModifiedTime: new Date(now - 10 * 24 * 3600_000).toISOString(),
        status: 'IDLE',
        annotations: { title: 'Last Week Archive' },
      },
    },
    trajectories: {
      heavyRoot: {
        trajectory: { steps: [makeDatedStep(1, ARGON, now - 3600_000, { inp: 10000, cache: 40000, out: 5000 })] },
      },
      heavySub: {
        trajectory: { steps: [makeDatedStep(1, FLASH, now - 1800_000, { inp: 20000, cache: 80000, out: 10000 })] },
      },
      lightRoot: {
        trajectory: { steps: [makeDatedStep(1, FLASH, now - 1200_000, { inp: 1000, cache: 2000, out: 500 })] },
      },
      oldRoot: {
        trajectory: { steps: [makeDatedStep(1, CARBON, now - 10 * 24 * 3600_000, { inp: 50000, cache: 100000, out: 10000 })] },
      },
    },
  });

  const todayPayload = await h.buildTelemetryPayloadInternal('lightRoot', false, { range: 'today' });
  const todayList = todayPayload.consumption.conversationsBreakdown;
  assert.equal(todayList.length, 2, 'today range must exclude 10-day-old session');
  assert.equal(todayList[0].cascadeId, 'heavyroot');
  assert.equal(todayList[0].title, 'Heavy Root Task', 'must keep root title rather than subagent role');
  assert.equal(todayList[0].totalTokens, 165000);
  assert.equal(todayList[0].subagentCount, 1);
  assert.equal(todayList[0].isCurrent, false);

  assert.equal(todayList[1].cascadeId, 'lightroot');
  assert.equal(todayList[1].totalTokens, 3500);
  assert.equal(todayList[1].isCurrent, true);

  const allPayload = await h.buildTelemetryPayloadInternal('lightRoot', false, { range: 'all' });
  const allList = allPayload.consumption.conversationsBreakdown;
  assert.equal(allList.length, 3, 'all range must include 10-day-old session');
  assert.equal(allList[0].cascadeId, 'heavyroot');
  assert.equal(allList[1].cascadeId, 'oldroot');
  assert.equal(allList[2].cascadeId, 'lightroot');
});

test('Frontend store equivalence and UI panel placement / rendering verification (v1.5.0 widgets)', async () => {
  const storeSrc = fs.readFileSync(new URL('../src/store/telemetryStore.js', import.meta.url), 'utf8');
  const eqSrc = storeSrc.slice(
    storeSrc.indexOf('function isEquivalentTelemetry'),
    storeSrc.indexOf('export async function fetchTelemetry')
  );
  const storeCtx = { normalizeClientWindowMountMode: normalizeWindowMountMode };
  vm.runInNewContext(`${eqSrc}\nglobalThis.eq=isEquivalentTelemetry;`, storeCtx);

  const base = {
    quotas: {
      sessionUsed: {
        cascadeId: 'c1',
        totalCalls: 2,
        totalTokens: 5000,
        totalCostUsd: 0.1,
        pools: [{ poolKey: 'Gemini', calls: 2, totalTokens: 5000, costUsd: 0.1, used5hPct: 1.0, source5h: 'observed', usedWeeklyPct: 0.5, sourceWeekly: 'observed' }],
      },
    },
    consumption: {
      conversationsBreakdown: [
        { cascadeId: 'c1', title: 'Chat 1', isCurrent: true, totalTokens: 5000, costUsd: 0.1, calls: 2, lastActivityMs: 1000 },
      ],
    },
  };
  assert.equal(storeCtx.eq(base, structuredClone(base)), true);

  const diffUsed = structuredClone(base);
  diffUsed.quotas.sessionUsed.pools[0].used5hPct = 2.5;
  assert.equal(storeCtx.eq(base, diffUsed), false);

  const diffConv = structuredClone(base);
  diffConv.consumption.conversationsBreakdown[0].totalTokens = 9000;
  assert.equal(storeCtx.eq(base, diffConv), false);

  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

  class MiniEl {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.id = '';
      this.textContent = '';
      this.children = [];
      this.parentNode = null;
      this.attributes = new Map();
      this.dataset = {};
      this.style = {
        _vars: new Map(),
        setProperty(k, v) { this._vars.set(k, String(v)); },
        getPropertyValue(k) { return this._vars.get(k) || ''; },
      };
      this.listeners = new Map();
      const self = this;
      this.classList = {
        _set() { return new Set(String(self.className || '').split(/\s+/).filter(Boolean)); },
        add(...tokens) {
          const s = this._set();
          for (const t of tokens) if (t) s.add(t);
          self.className = Array.from(s).join(' ');
        },
        remove(...tokens) {
          const s = this._set();
          for (const t of tokens) s.delete(t);
          self.className = Array.from(s).join(' ');
        },
        contains(t) { return this._set().has(t); },
        toggle(t, f) {
          const s = this._set();
          if (f === undefined ? !s.has(t) : Boolean(f)) s.add(t);
          else s.delete(t);
          self.className = Array.from(s).join(' ');
        },
      };
    }
    set hidden(val) {
      if (val) this.attributes.set('hidden', '');
      else this.attributes.delete('hidden');
    }
    get hidden() { return this.attributes.has('hidden'); }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'class') this.className = String(v);
      if (k === 'id') this.id = String(v);
      if (String(k).startsWith('data-')) {
        const camel = String(k).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[camel] = String(v);
      }
    }
    getAttribute(k) { return this.attributes.get(k) ?? null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.children.push(c);
      return c;
    }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      const idx = this.children.indexOf(ref);
      c.parentNode = this;
      if (idx < 0) this.children.push(c);
      else this.children.splice(idx, 0, c);
      return c;
    }
    removeChild(c) {
      const idx = this.children.indexOf(c);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        c.parentNode = null;
      }
      return c;
    }
    addEventListener(t, fn) {
      if (!this.listeners.has(t)) this.listeners.set(t, []);
      this.listeners.get(t).push(fn);
    }
    removeEventListener() {}
    dispatchEvent(e) {
      for (const fn of this.listeners.get(e?.type) || []) fn(e);
      return true;
    }
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 320, bottom: 20, width: 320, height: 20 };
    }
    querySelectorAll(sel) {
      const out = [];
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = (n) => {
        for (const ch of n.children) {
          if (cls ? ch.classList.contains(cls) : ch.tagName === sel.toUpperCase()) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  const rootMount = new MiniEl('div');
  rootMount.id = 'app-root';
  const body = new MiniEl('body');
  body.appendChild(rootMount);
  const mockDoc = {
    readyState: 'complete',
    body,
    documentElement: new MiniEl('html'),
    getElementById: (id) => (id === 'app-root' ? rootMount : null),
    createElement: (tag) => new MiniEl(tag),
    createElementNS: (_ns, tag) => new MiniEl(tag),
    createTextNode: (txt) => {
      const t = new MiniEl('#text');
      t.textContent = String(txt);
      return t;
    },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const payload = {
    uiBundleVersion: 'test-1',
    settings: {
      language: 'zh-CN',
      overviewModules: ['metrics', 'context', 'used_quotas', 'quotas', 'live_tasks'],
      showUpstreamModel: false,
      orchestratorIdMode: 'compact',
      weeklyLimitMode: 'official',
      pluginUpdateMode: 'manual',
    },
    cloudStatus: {},
    account: { tierName: 'Google AI Pro', planName: 'Pro', totalConversations: 2 },
    conversations: [
      { cascadeId: 'c1', title: 'Session Alpha', stepCount: 2, subagentCount: 0, totalStepCount: 2 },
      { cascadeId: 'c2', title: 'Session Beta', stepCount: 1, subagentCount: 0, totalStepCount: 1 },
    ],
    runningConversations: [],
    activeConversation: {
      cascadeId: 'c1',
      title: 'Session Alpha',
      stepCount: 2,
      hasSubagents: false,
      agents: [{ agentId: 'main', isMain: true, context: {}, recentSteps: [] }],
      context: { totalTokens: 1000, limitTokens: 256000 },
      recentSteps: [],
      modelBreakdown: [],
    },
    quotas: {
      meta: { fetchedAtMs: Date.now(), hasOfficialData: true, isStale: false, refreshFailed: false },
      pools: [
        { poolKey: 'Gemini', poolLabel: 'Gemini', family: 'Gemini', has5h: true, hasWeekly: true, usedPct: 12, remainingPct: 88, weeklyUsedPct: 20, weeklyRemainingPct: 80 },
        { poolKey: 'Argon', poolLabel: 'Gemini 4 Argon', family: 'Argon', has5h: false, hasWeekly: true, usedPct: null, remainingPct: null, weeklyUsedPct: 35, weeklyRemainingPct: 65 },
        { poolKey: 'Claude & GPT', poolLabel: 'Claude & GPT', family: 'Claude & GPT', has5h: true, hasWeekly: true, usedPct: 5, remainingPct: 95, weeklyUsedPct: 10, weeklyRemainingPct: 90 },
      ],
      sessionUsed: {
        cascadeId: 'c1',
        totalCalls: 4,
        totalTokens: 120000,
        totalCostUsd: 1.5,
        unpricedCalls: 0,
        unknownPoolCalls: 0,
        unknownPoolTokens: 0,
        pools: [
          {
            poolKey: 'Argon',
            poolLabel: 'Gemini 4 Argon',
            family: 'Argon',
            calls: 4,
            totalTokens: 120000,
            costUsd: 1.5,
            unpricedCalls: 0,
            has5h: false,
            hasWeekly: true,
            used5hPct: null,
            source5h: 'none',
            usedWeeklyPct: 8.5,
            observedWeeklyPct: 8.5,
            sourceWeekly: 'observed',
          },
        ],
      },
      weekly: { isOfficial: true, tokens: 120000, costUsd: 1.5, calls: 4 },
    },
    consumption: {
      selectedRange: { key: 'today', label: '今天', startMs: Date.now() - 3600_000, endMs: Date.now() },
      account: { totalTokens: 200000, inputTokens: 50000, cacheReadTokens: 120000, outputTokens: 30000, responseTokens: 20000, thinkingTokens: 10000, costUsd: 2.0, savedCostUsd: 0.5, calls: 6, cacheHitPct: 70.6 },
      session: { totalTokens: 150000 },
      trendSeries: [],
      sourcesBreakdown: [],
      monthlyYear: 2026,
      monthlySeries: [],
      conversationsBreakdown: [
        { cascadeId: 'c1', title: 'Session Alpha', isCurrent: true, totalTokens: 150000, inputTokens: 40000, cacheReadTokens: 90000, responseTokens: 15000, thinkingTokens: 5000, costUsd: 1.5, calls: 4, lastActivityMs: Date.now(), models: ['Gemini 4 Argon'] },
        { cascadeId: 'c2', title: 'Session Beta', isCurrent: false, totalTokens: 50000, inputTokens: 10000, cacheReadTokens: 30000, responseTokens: 5000, thinkingTokens: 5000, costUsd: 0.5, calls: 2, lastActivityMs: Date.now() - 60000, models: ['Gemini 3.8 Flash'] },
      ],
    },
    modelBreakdown: [],
  };

  const timers = [];
  const win = {
    document: mockDoc,
    innerWidth: 1280,
    innerHeight: 800,
    location: { pathname: '/' },
    sidecar: { conversationId: 'c1' },
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    addEventListener() {},
    removeEventListener() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
  };

  vm.runInNewContext(appJs, {
    window: win,
    document: mockDoc,
    globalThis: win,
    fetch: win.fetch,
    EventSource: undefined,
    ResizeObserver: undefined,
    MutationObserver: undefined,
    URL,
    URLSearchParams,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    Promise,
    queueMicrotask,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    console,
  });

  await new Promise((resolve) => setTimeout(resolve, 40));

  const viewPanes = rootMount.querySelectorAll('.view-pane');
  assert.ok(viewPanes.length >= 2, 'must mount overview and consumption panes');

  const collectText = (n) => [n.textContent, ...n.children.map(collectText)].filter(Boolean).join(' ');

  const overviewSections = viewPanes[0].querySelectorAll('.panel');
  const overviewTitles = overviewSections.map((s) => collectText(s.querySelector('.panel-title') || s));
  const usedIdx = overviewTitles.findIndex((txt) => txt.includes('已使用额度'));
  const availIdx = overviewTitles.findIndex((txt) => txt.includes('可用额度'));
  assert.ok(usedIdx >= 0, 'overview must contain 已使用额度 panel');
  assert.equal(usedIdx + 1, availIdx, '已使用额度 must be directly above 可用额度');

  const usedText = collectText(overviewSections[usedIdx]);
  assert.ok(usedText.includes('Gemini 4 Argon'), 'used panel must list Gemini 4 Argon');
  assert.ok(usedText.includes('8.5%'), 'used panel must render observed percentage');
  assert.equal(usedText.includes('Claude & GPT'), false, 'used panel must NOT list unused Claude & GPT');
  assert.equal(usedText.includes('(Gemini)'), false, 'used panel must NOT list unused Gemini');

  // Switch activeView -> 'consumption' and trigger lazy render
  const navBtns = rootMount.querySelectorAll('.pill-tab');
  const consTabBtn = navBtns.find((b) => collectText(b).includes('用量统计'));
  assert.ok(consTabBtn, 'must render 用量统计 tab button');
  for (const fn of consTabBtn.listeners.get('click') || []) fn({ preventDefault() {}, stopPropagation() {} });

  await new Promise((r2) => setTimeout(r2, 20));
  const consSections = viewPanes[1].querySelectorAll('.panel');
  const consTitles = consSections.map((s) => collectText(s.querySelector('.panel-title') || s));
  const monthlyIdx = consTitles.findIndex((txt) => txt.includes('月度统计'));
  const compareIdx = consTitles.findIndex((txt) => txt.includes('会话消耗对比'));
  assert.ok(
    monthlyIdx >= 0 && compareIdx === monthlyIdx + 1 && compareIdx === consTitles.length - 1,
    '会话消耗对比 must be directly below 月度统计 at bottom'
  );

  const comparePanel = consSections[compareIdx];
  const compareText = collectText(comparePanel);
  assert.ok(compareText.includes('Session Alpha') && compareText.includes('Session Beta'));

  const segBars = comparePanel.querySelectorAll('.cons-seg-bar');
  assert.equal(segBars.length, 2);
  const sumSegPct = (bar) =>
    bar.children.reduce((acc, seg) => acc + parseFloat(seg.style.getPropertyValue('--seg-w') || '0'), 0);
  assert.ok(Math.abs(sumSegPct(segBars[0]) - 100) < 0.2, 'top session bar spans ~100%');
  assert.ok(Math.abs(sumSegPct(segBars[1]) - 33.33) < 0.3, 'second session bar scales to 50k/150k = ~33.3%');
});

test('Built-in CDP shortcut manager: inspects, applies --remote-debugging-port=0 with backup + autoMaintainCdpShortcuts, and restores cleanly', async () => {
  const mockShortcuts = [
    { path: 'C:\\Users\\demo\\Desktop\\Antigravity.lnk', args: '--disable-gpu' },
    { path: 'C:\\Users\\demo\\StartMenu\\Antigravity.lnk', args: '' },
  ];

  const h = backendHarness({
    execFileImpl: (_cmd, _args, opts, cb) => {
      const env = opts?.env || {};
      const mode = env.AG_CDP_CFG_MODE || 'inspect';
      const port = Number(env.AG_CDP_CFG_PORT || 0);
      const restoreMap = env.AG_CDP_CFG_RESTORE_JSON
        ? JSON.parse(env.AG_CDP_CFG_RESTORE_JSON)
        : {};
      let updatedCount = 0;
      let restoredCount = 0;
      const outList = mockShortcuts.map((item) => {
        const prevArgs = item.args;
        if (mode === 'apply') {
          const clean = prevArgs.replace(/(?:^|\s+)--remote-debugging-port(?:=|\s+)\d+/gi, '').trim();
          const nextArgs = clean
            ? `${clean} --remote-debugging-port=${port}`
            : `--remote-debugging-port=${port}`;
          if (item.args !== nextArgs) {
            item.args = nextArgs;
            updatedCount += 1;
          }
        } else if (mode === 'restore') {
          const key = item.path.toLowerCase();
          const nextArgs = Object.prototype.hasOwnProperty.call(restoreMap, key)
            ? restoreMap[key]
            : prevArgs.replace(/(?:^|\s+)--remote-debugging-port(?:=|\s+)\d+/gi, '').trim();
          if (item.args !== nextArgs) {
            item.args = nextArgs;
            restoredCount += 1;
          }
        }
        return {
          path: item.path,
          previousArgs: prevArgs,
          arguments: item.args,
          hasCdpFlag: /--remote-debugging-port=\d+/i.test(item.args),
        };
      });
      cb(
        null,
        JSON.stringify({
          ok: true,
          mode,
          updatedCount,
          restoredCount,
          hostRunning: true,
          hostHasCdpFlag: false,
          launchedByUpdater: true,
          explicitCdpPort: 0,
          shortcuts: outList,
        })
      );
    },
  });

  // 1. Initial inspect: 0/2 configured
  const rCheck = JSON.parse((await h.executeCdpSetupAction('GET')).body);
  assert.equal(rCheck.ok, true);
  assert.equal(rCheck.cdpSetup.totalShortcuts, 2);
  assert.equal(rCheck.cdpSetup.configuredShortcuts, 0);
  assert.equal(rCheck.cdpSetup.shortcutsConfigured, false);
  assert.equal(rCheck.cdpSetup.launchedByUpdater, true);

  // 2. Apply: patches both shortcuts, backs up original args, enables autoMaintainCdpShortcuts
  const rApply = JSON.parse((await h.executeCdpSetupAction('POST', { action: 'apply' })).body);
  assert.equal(rApply.ok, true);
  assert.equal(rApply.updatedShortcuts, 2);
  assert.equal(rApply.configuredShortcuts, 2);
  assert.equal(rApply.shortcutsConfigured, true);
  assert.equal(rApply.needsColdRestart, true);
  assert.equal(rApply.settings.autoMaintainCdpShortcuts, true);
  assert.equal(mockShortcuts[0].args, '--disable-gpu --remote-debugging-port=0');
  assert.equal(mockShortcuts[1].args, '--remote-debugging-port=0');

  // 3. Restore: recovers exact original '--disable-gpu' and '' args, disables autoMaintainCdpShortcuts
  const rRestore = JSON.parse((await h.executeCdpSetupAction('POST', { action: 'restore' })).body);
  assert.equal(rRestore.ok, true);
  assert.equal(rRestore.restoredShortcuts, 2);
  assert.equal(rRestore.configuredShortcuts, 0);
  assert.equal(rRestore.settings.autoMaintainCdpShortcuts, false);
  assert.equal(mockShortcuts[0].args, '--disable-gpu');
  assert.equal(mockShortcuts[1].args, '');
});

test('Responsive sidebar CSS & structured quota spans prevent fixed-width bar lock and tab clipping', () => {
  const stylesCss = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const appJs = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

  assert.match(stylesCss, /\.view-pane\s*\{[\s\S]*?container-type:\s*inline-size;/);
  assert.match(stylesCss, /\.panel\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;/);
  assert.match(stylesCss, /@container\s*\(max-width:\s*28\.5em\)\s*\{[\s\S]*?\.quota-meta-extra\s*\{\s*display:\s*none;/);
  assert.match(stylesCss, /\.cdp-setup-box\s*\{/);
  assert.match(stylesCss, /\.cdp-inline-banner\s*\{/);
  assert.ok(appJs.includes('quota-meta-reset') && appJs.includes('quota-meta-extra'));
  assert.ok(appJs.includes('cdp-setup-box') && appJs.includes('cdp-inline-banner'));
});

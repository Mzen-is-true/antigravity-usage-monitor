/**
 * @fileoverview View 2: ConsumptionView (全景消耗统计视图).
 * 采用 5 段式分析布局展示指定时间窗口内的全量 Token 与费用消耗：
 * 1. 用量概览：支持预设时间段与自定义区间筛选，通过 3+3 组合矩阵展示总 Token/调用次数、
 *    USD/CNY 预估费用、缓存命中率与命中量、新输入/缓存读取（含节省费用）/输出细分占比，以及底部 4 段比例条 (`FourSegmentBar`)。
 * 2. 历史趋势：基于 `TrendAreaChart` 渲染纯 SVG 三次贝塞尔平滑曲线面积图、峰值气泡、对齐多刻度时间轴与悬停详情浮层。
 * 3. 热门模型：按 Token 总量降序展示各模型的消耗占比徽章、4 段构成条及输入/缓存/输出/思考/调用明细。
 * 4. 数据来源：按调用来源聚合展示 Token 构成、占比与费用明细。
 * 5. 按月细分：12 个月垂直 4 段堆叠柱状图，直观对比全年各月费用、Token 总量与缓存/思考结构。
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import {
  formatCnyApprox,
  formatDateSpanBadge,
  formatTokensPrecise,
  formatUsd,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
} from '../core/formatters.js';
import { i18nStore, isEnglishLocale, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { fetchTelemetry, telemetryStore } from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

/** 消耗统计顶栏支持的时间范围预设项 */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

function getConvSortOptions() {
  return [
    { value: 'tokens', label: t('cons.convSortTokens') },
    { value: 'cost', label: t('cons.convSortCost') },
    { value: 'recent', label: t('cons.convSortRecent') },
  ];
}

const CONV_COLLAPSE_THRESHOLD = 30;

function formatConvActivityTime(ms) {
  const num = Number(ms || 0);
  if (!Number.isFinite(num) || num <= 0) return '';
  const d = new Date(num);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- 时间筛选栏：快速时间段分段控制器与自定义起止时间选择条 ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        telemetryStore.setState({ selectedTimeRange: nextRange });
        fetchTelemetry({ force: false });
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const minMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const maxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          telemetryStore.setState({
            selectedTimeRange: 'custom',
            customStartMs: minMs,
            customEndMs: maxMs,
          });
          fetchTelemetry({ force: true });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        style:
          'display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 8px; background: var(--surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-xs);',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: 用量概览矩阵 (上层 3 列核心总量 + 下层 3 列新输入/缓存读取/输出拆分 + 底部 4 段比例条) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: '≈ ¥0' });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-input); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const inputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.uncachedInput') });

    const cacheSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-cached); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const cacheSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.savedCost', { cost: '$0.00' }) });

    const outputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-output); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const outputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.replyAndThink', { resp: 0, think: 0 }) });

    const overviewSegBar = createFourSegmentBar();
    const overviewTitleSpan = h('span', { text: t('cons.overviewTitle') });
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          overviewTitleSpan,
          dateSpanBadge,
        ]),
        timeFilterSwitch.el,
      ]),
      customRangeBar,
      h('div', { className: 'cons-box cons-unified-matrix' }, [
        h('div', { className: 'cons-split-3' }, [
          h('div', { className: 'cons-col' }, [
            totalTokensLabel,
            h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            estCostLabel,
            h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheHitRateLabel,
            ]),
            h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
          ]),
        ]),
        h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
          h('div', { className: 'cons-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-input' }),
                newInputLabel,
              ]),
              inputSharePct,
            ]),
            inputMainTokens,
            inputSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-cached' }),
                cacheReadLabel,
              ]),
              cacheSharePct,
            ]),
            cacheMainTokens,
            cacheSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-output' }),
                outputUsageLabel,
              ]),
              outputSharePct,
            ]),
            outputMainTokens,
            outputSubText,
          ]),
        ]),
      ]),
      overviewSegBar.el,
    ]);

    // --- Section 2: 历史趋势 (交互式 SVG 平滑曲线图 + 悬停精确日期/小时浮层 + 多刻度时间轴) ---
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const trendChart = createTrendAreaChart();

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        trendGranularityHint,
      ]),
      trendChart.el,
    ]);

    // --- Section 3: 模型排行列表 ---
    const modelsTitleSpan = h('span', { className: 'panel-title', text: t('cons.topModels') });
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const modelsPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        modelsTitleSpan,
      ]),
      modelsListEl,
    ]);

    // --- Section 4: 客户端来源列表 ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: 按月细分 (12 个月垂直 4 段堆叠柱状图) ---
    const monthlyTitleSpan = h('span', { className: 'panel-title', text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const barThink = h('div', { className: 'month-seg seg-thinking' });
      const barOut = h('div', { className: 'month-seg seg-output' });
      const barCache = h('div', { className: 'month-seg seg-cached' });
      const barIn = h('div', { className: 'month-seg seg-input' });
      const stackWrap = h('div', { className: 'month-stack' }, [
        barThink,
        barOut,
        barCache,
        barIn,
      ]);
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colEl = h('div', { className: 'month-col' }, [
        costText,
        h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
        monthLabel,
        tokText,
      ]);
      return {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        barThink,
        barOut,
        barCache,
        barIn,
        monthLabel,
        tokText,
      };
    });

    const legInputSpan = h('span', { text: t('cons.legInput') });
    const legCacheSpan = h('span', { text: t('cons.legCache') });
    const legOutputSpan = h('span', { text: t('cons.legOutput') });
    const legThinkingSpan = h('span', { text: t('cons.legThinking') });

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        monthlyTitleSpan,
        monthlyYearBadge,
      ]),
      h(
        'div',
        { className: 'monthly-grid' },
        monthlyCols.map((c) => c.el)
      ),
      h('div', { className: 'monthly-legend' }, [
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-input' }),
          legInputSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-cached' }),
          legCacheSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-output' }),
          legOutputSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-thinking' }),
          legThinkingSpan,
        ]),
      ]),
    ]);

    // --- Section 6: 会话消耗对比 (所选时间段内所有会话 Token 与费用横向对比，位于月度统计最下方) ---
    let convSortMode = 'tokens';
    let convsExpanded = false;

    const convTitleSpan = h('span', { text: t('cons.convTitle') });
    const convRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const convCountBadge = h('span', {
      className: 'cons-badge text-mono',
      text: t('cons.convCount', { count: 0 }),
    });
    const convSortSwitch = SegmentedControl({
      ariaLabel: t('cons.convSortAria'),
      modelValue: convSortMode,
      options: getConvSortOptions(),
      onUpdateModelValue: (nextSort) => {
        convSortMode = nextSort || 'tokens';
        if (latestSlice) renderConsumptionData(latestSlice);
      },
    });
    const convEmptyEl = h('div', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md); padding: 4px 0;',
      text: t('cons.convEmpty'),
    });
    const conversationsListEl = h('div', { className: 'cons-item-list', hidden: true });
    const convExpandBtn = h('button', {
      type: 'button',
      className: 'cons-conv-expand-btn',
      hidden: true,
      text: t('cons.convExpandMore', { count: 0 }),
      onClick: () => {
        convsExpanded = !convsExpanded;
        if (latestSlice) renderConsumptionData(latestSlice);
      },
    });

    const conversationsPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          convTitleSpan,
          convRangeBadge,
          convCountBadge,
        ]),
        convSortSwitch.el,
      ]),
      convEmptyEl,
      conversationsListEl,
      convExpandBtn,
    ]);

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        modelsPanel,
        sourcesPanel,
        monthlyPanel,
        conversationsPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });

    /**
     * 创建热门模型或数据来源的通用单行 DOM 结构（含标题、占比胶囊、总量、费用、4 段条与底部分项脚标）。
     */
    function createBreakdownItemRow() {
      const nameEl = h('strong', { className: 'cons-row-title' });
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        h('div', { className: 'cons-item-foot' }, [
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            inLbl,
            inVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheLbl,
            cacheVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outLbl,
            outVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-thinking' }),
            thinkLbl,
            thinkVal,
          ]),
          h('span', { className: 'legend-left' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
        },
      };
    }

    /**
     * 增量更新热门模型或数据来源单行的指标文本与 4 段比例条宽度。
     */
    function updateBreakdownItemRow(refs, item, grandTotalTokens, showTokensInHeader = true) {
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || item.shortName || '—';
      patchText(refs.nameEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);
      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, showTokensInHeader ? formatTokensPrecise(total) : '');
      patchAttr(refs.totalTokEl, 'hidden', !showTokensInHeader);
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      patchText(
        refs.costEl,
        formatUsd(isAllUnpriced ? null : costVal, {
          precise: costVal > 0 && costVal < 0.1,
        })
      );

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
      });

      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(Number(item.calls || 0)));
    }

    /**
     * 创建单个会话消耗对比行 DOM 结构（含排名、标题、当前标识、占比胶囊、总量、费用、相对 4 段比较条及明细脚标）。
     */
    function createConversationCompareRow() {
      const rankEl = h('span', { className: 'cons-rank-pill text-mono', text: '#1' });
      const titleEl = h('strong', { className: 'cons-row-title cons-conv-title' });
      const currentBadge = h('span', {
        className: 'agent-badge badge-main',
        hidden: true,
        text: t('cons.convCurrentBadge'),
      });
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });
      const timeTagEl = h('span', { className: 'text-muted text-mono', hidden: true, text: '' });

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          h('div', { className: 'cons-conv-title-wrap' }, [rankEl, titleEl, currentBadge]),
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        h('div', { className: 'cons-item-foot' }, [
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            inLbl,
            inVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheLbl,
            cacheVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outLbl,
            outVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-thinking' }),
            thinkLbl,
            thinkVal,
          ]),
          h('span', { className: 'legend-left' }, [
            callsLbl,
            callsVal,
          ]),
          timeTagEl,
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          rowEl,
          rankEl,
          titleEl,
          currentBadge,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
          timeTagEl,
        },
      };
    }

    /**
     * 增量更新单个会话消耗对比行（4 段条按峰值会话 Token `maxConvTokens` 等比缩放以便横向比对）。
     */
    function updateConversationCompareRow(refs, item, idx, grandTotalTokens, maxConvTokens) {
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      patchText(refs.currentBadge, t('cons.convCurrentBadge'));

      const shortFallback = String(item.cascadeId || '').slice(0, 8);
      const displayTitle =
        item.title || (shortFallback ? t('cons.convDefaultTitle', { id: shortFallback }) : '—');
      patchText(refs.rankEl, `#${idx + 1}`);
      patchText(refs.titleEl, displayTitle);
      patchAttr(refs.titleEl, 'title', displayTitle);
      patchAttr(refs.currentBadge, 'hidden', !item.isCurrent);

      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchAttr(refs.pctBadge, 'title', t('cons.convShareTooltip', { pct: share.toFixed(1) }));
      patchText(refs.totalTokEl, formatTokensPrecise(total));
      const costDisplay =
        item.unpricedCalls > 0 && Number(item.costUsd || 0) === 0
          ? t('cons.convCostPending')
          : formatUsd(item.costUsd || 0);
      patchText(refs.costEl, costDisplay);

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
        scaleMax: maxConvTokens,
      });

      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(Number(item.calls || 0)));

      const actTime = formatConvActivityTime(item.lastActivityMs);
      const subText = item.subagentCount > 0 ? t('cons.convSubShort', { count: item.subagentCount }) : '';
      const timeMeta = [subText, actTime].filter(Boolean).join(' · ');
      patchAttr(refs.timeTagEl, 'hidden', !timeMeta);
      if (timeMeta) patchText(refs.timeTagEl, timeMeta);

      const tooltipParts = [
        displayTitle,
        t('cons.convRowTooltip', {
          tok: formatTokensPrecise(total),
          share: share.toFixed(1),
          cost: costDisplay,
          calls: item.calls || 0,
        }),
        item.cacheHitPct != null
          ? t('cons.convTooltipCache', { pct: Number(item.cacheHitPct).toFixed(1) })
          : '',
        item.models?.length ? t('cons.convTooltipModels', { models: item.models.join(', ') }) : '',
        item.appSource ? t('cons.convTooltipSource', { source: item.appSource }) : '',
        actTime ? t('cons.convTooltipRecent', { time: actTime }) : '',
      ].filter(Boolean);
      patchAttr(refs.rowEl, 'title', tooltipParts.join('\n'));
    }

    let latestSlice = null;
    let isDirty = false;

    let lastRenderedUsage = '';

    /**
     * 将遥测状态切片同步渲染至消费统计视图的 5 个子面板。
     */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = preset?.account || cons.account || {};
      const rangeInfo = cons.selectedRange || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      // 额度与会话状态也会发布遥测更新，只对用量页实际展示的数据重绘。
      const signature = JSON.stringify([
        locale, slice.range, slice.customStartMs, slice.customEndMs, slice.modelDisplayMode,
        slice.showUpstreamModel, slice.orchestratorIdMode, dateSpan,
        preset?.label || rangeInfo.label, acct,
        cons.trendSeries, slice.modelBreakdown, cons.sourcesBreakdown,
        cons.conversationsBreakdown, convSortMode, convsExpanded,
        monthlyYear, currentMonthIdx, cons.monthlySeries,
      ]);
      if (signature === lastRenderedUsage) return;
      drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear });
      lastRenderedUsage = signature;
    }

    function drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear }) {
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 1. 同步用量概览矩阵与顶部 4 段比例条
      patchText(dateSpanBadge, dateSpan);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const savedCostUsd = Number(acct.savedCostUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(heroCostCny, formatCnyApprox(costUsd));

      patchText(cacheHitPctEl, `${Number(acct.cacheHitPct ?? 0).toFixed(1)}%`);
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const rawTenths = [
          (inputTokens / totalTokens) * 1000,
          (cacheTokens / totalTokens) * 1000,
          (outputTokens / totalTokens) * 1000,
        ];
        const floored = rawTenths.map((v) => Math.max(0, Math.floor(v)));
        const rem = Math.max(0, 1000 - (floored[0] + floored[1] + floored[2]));
        const order = [0, 1, 2].sort(
          (a, b) => rawTenths[b] - floored[b] - (rawTenths[a] - floored[a])
        );
        for (let k = 0; k < rem && k < 3; k++) {
          floored[order[k]] += 1;
        }
        inPct = +(floored[0] / 10).toFixed(1);
        cachePct = +(floored[1] / 10).toFixed(1);
        outPct = +(floored[2] / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));
      patchText(inputSubText, t('cons.uncachedInput'));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));
      patchText(
        cacheSubText,
        t('cons.savedCost', {
          cost: formatUsd(savedCostUsd, { precise: savedCostUsd > 0 && savedCostUsd < 0.01 }),
        })
      );

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      patchText(
        outputSubText,
        t('cons.replyAndThink', {
          resp: formatTokensPrecise(responseTokens),
          think: formatTokensPrecise(thinkingTokens),
        })
      );

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2. 同步历史趋势交互式 SVG 面积图 / 类 GitHub 每日热力图（>90天）与粒度提示
      const rangeBadgeText = isEnglishLocale()
        ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
          t('cons.allTime')
        : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const trendSeries = cons.trendSeries || [];
      const isHourlyTrend =
        trendSeries[0]?.granularity === 'hour' ||
        (trendSeries[0]?.label || '').includes(':');
      const isHeatmapTrend = !isHourlyTrend && trendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchText(
        trendGranularityHint,
        isHeatmapTrend
          ? t('cons.trendHeatmapHint', { days: trendSeries.length })
          : isHourlyTrend
            ? t('cons.trendPointsHintHourly', { points: trendSeries.length || 0 })
            : t('cons.trendPointsHintDaily', { points: trendSeries.length || 0 })
      );
      trendChart.update(trendSeries);

      // 3. 同步热门模型列表（按最终展示名称去重归并后按总 Token 数降序排列并执行键值增量对账）
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);

      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) =>
          `${localeSig}:${m.displayText}:${m.displayTitle}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${modelsTotalTok}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) =>
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalTok,
            true
          ),
      });

      // 4. 同步数据来源列表
      const sources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = sources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      patchKeyedList(sourcesListEl, sources, {
        keyFn: (s) => s.name,
        sigFn: (s) => `${localeSig}:${s.name}:${s.totalTokens}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, s) => updateBreakdownItemRow(refs, s, sourcesTotalTok, true),
      });

      // 5. 同步 12 个月垂直堆叠柱状图（相对于年度峰值月缩放柱高，最低保留 8% 可视高度）
      patchText(monthlyYearBadge, String(monthlyYear));
      const monthlySeries = cons.monthlySeries || [];
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0 };
        const mTot = Number(m.totalTokens || 0);
        const hasData = mTot > 0;

        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
        } else {
          const cVal = Number(m.costUsd || 0);
          patchText(
            col.costText,
            cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const inPctM = (Number(m.inputTokens || 0) / mTot) * 100;
          const cachePctM = (Number(m.cacheReadTokens || 0) / mTot) * 100;
          const outPctM = (Number(m.responseTokens || 0) / mTot) * 100;
          const thinkPctM = (Number(m.thinkingTokens || 0) / mTot) * 100;

          patchStyleVar(col.barIn, '--seg-h', `${inPctM.toFixed(1)}%`);
          patchStyleVar(col.barCache, '--seg-h', `${cachePctM.toFixed(1)}%`);
          patchStyleVar(col.barOut, '--seg-h', `${outPctM.toFixed(1)}%`);
          patchStyleVar(col.barThink, '--seg-h', `${thinkPctM.toFixed(1)}%`);
        }
      }

      // 6. 同步所选时间段内所有会话 Token 消耗对比列表（位于月度统计最下方）
      patchText(convRangeBadge, rangeBadgeText);
      const rawConvs = Array.isArray(cons.conversationsBreakdown)
        ? cons.conversationsBreakdown
        : [];
      const sortedConvs = rawConvs.slice().sort((a, b) => {
        if (convSortMode === 'cost') {
          return (
            Number(b.costUsd || 0) - Number(a.costUsd || 0) ||
            Number(b.totalTokens || 0) - Number(a.totalTokens || 0)
          );
        }
        if (convSortMode === 'recent') {
          return (
            Number(b.lastActivityMs || 0) - Number(a.lastActivityMs || 0) ||
            Number(b.totalTokens || 0) - Number(a.totalTokens || 0)
          );
        }
        return (
          Number(b.totalTokens || 0) - Number(a.totalTokens || 0) ||
          Number(b.costUsd || 0) - Number(a.costUsd || 0)
        );
      });
      const convGrandTotalTok = rawConvs.reduce((s, c) => s + Number(c.totalTokens || 0), 0);
      const maxConvTok = Math.max(1, ...rawConvs.map((c) => Number(c.totalTokens || 0)));
      const hasConvs = sortedConvs.length > 0;
      const canCollapseConvs = sortedConvs.length > CONV_COLLAPSE_THRESHOLD;
      const visibleConvs =
        canCollapseConvs && !convsExpanded
          ? sortedConvs.slice(0, CONV_COLLAPSE_THRESHOLD)
          : sortedConvs;

      patchText(convCountBadge, t('cons.convCount', { count: sortedConvs.length }));
      patchAttr(convEmptyEl, 'hidden', hasConvs);
      patchAttr(conversationsListEl, 'hidden', !hasConvs);
      patchAttr(convExpandBtn, 'hidden', !canCollapseConvs);
      if (canCollapseConvs) {
        patchText(
          convExpandBtn,
          convsExpanded
            ? t('cons.convCollapse', { count: CONV_COLLAPSE_THRESHOLD })
            : t('cons.convExpandMore', { count: sortedConvs.length })
        );
      }

      patchKeyedList(conversationsListEl, visibleConvs, {
        keyFn: (c) => c.cascadeId,
        sigFn: (c, idx) =>
          `${localeSig}:${idx}:${c.cascadeId}:${c.title}:${Boolean(c.isCurrent)}:${c.totalTokens}:${c.costUsd}:${c.unpricedCalls}:${c.calls}:${c.lastActivityMs}:${c.subagentCount}:${maxConvTok}:${convGrandTotalTok}`,
        createRow: createConversationCompareRow,
        updateRow: (refs, c, idx) =>
          updateConversationCompareRow(refs, c, idx, convGrandTotalTok, maxConvTok),
      });

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView === 'consumption' && isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(overviewTitleSpan, t('cons.overviewTitle'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      patchText(trendTitleSpan, t('cons.trendTitle'));
      patchText(modelsTitleSpan, t('cons.topModels'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
      patchText(legInputSpan, t('cons.legInput'));
      patchText(legCacheSpan, t('cons.legCache'));
      patchText(legOutputSpan, t('cons.legOutput'));
      patchText(legThinkingSpan, t('cons.legThinking'));
      patchText(convTitleSpan, t('cons.convTitle'));
      patchText(convEmptyEl, t('cons.convEmpty'));
      convSortSwitch.setProps({
        ariaLabel: t('cons.convSortAria'),
        options: getConvSortOptions(),
      });
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      unsub();
      unsubView();
      unsubI18n();
      trendChart.destroy?.();
      timeFilterSwitch.destroy();
      convSortSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { timeFilterSwitch, startPicker, endPicker, viewScrollbar },
    };
  },
});

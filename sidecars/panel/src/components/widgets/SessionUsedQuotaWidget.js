/**
 * @fileoverview Standalone decoupled Session Used Quota Widget (`SessionUsedQuotaWidget.js`).
 * Displays quota consumed per quota pool by the active session (including subagents),
 * omitting any unused quota groups, styled to match `QuotaPoolsWidget`.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../../core/domPatch.js';
import { formatTokens, formatUsd } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t } from '../../i18n/index.js';
import { createPoolQuotaRow } from './QuotaPoolsWidget.js';

/**
 * 构建当前会话「已使用额度」展示项列表（仅包含本会话实际调用过的配额分组，未使用的分组绝不列出）。
 *
 * @param {object|null|undefined} sessionUsed
 * @returns {Array<object>}
 */
export function buildSessionUsedQuotaItems(sessionUsed) {
  const rawPools = Array.isArray(sessionUsed?.pools) ? sessionUsed.pools : [];
  return rawPools
    .filter((p) => Number(p?.calls || 0) > 0 || Number(p?.totalTokens || 0) > 0)
    .map((p) => ({
      key: p.poolKey || p.family || p.poolLabel || 'Other',
      poolLabel: p.poolLabel || p.family || p.poolKey || 'Other',
      poolData: p,
    }));
}

function formatUsedQuotaPctLabel(pct, source, observedPct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return t('usedQuota.pctUntracked');
  }
  const num = Number(pct);
  if (source === 'observed') return t('usedQuota.pctObserved', { pct: num.toFixed(1) });
  if (source === 'mixed') {
    return t('usedQuota.pctMixed', {
      pct: num.toFixed(1),
      obs: Number(observedPct || 0).toFixed(1),
    });
  }
  if (source === 'estimated') return t('usedQuota.pctEstimated', { pct: num.toFixed(1) });
  return t('usedQuota.pctUsed', { pct: num.toFixed(1) });
}

/**
 * 同步当前会话在单个已使用配额池中的 5h 与每周消耗进度条（样式严格对齐 `syncPoolQuotaRow`）。
 */
export function syncUsedPoolQuotaRow(refs, item, idx, rowEl) {
  const { poolData, poolLabel } = item;
  patchAttr(
    rowEl,
    'style',
    idx === 0
      ? 'display: flex; flex-direction: column; gap: 8px;'
      : 'display: flex; flex-direction: column; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-hairline);'
  );

  const has5h = Boolean(poolData?.has5h);
  const hasWk = Boolean(poolData?.hasWeekly);
  const show5h = has5h;
  const showWk = hasWk || !has5h;

  refs.row5h.hidden = !show5h;
  refs.row5h.style.display = show5h ? 'flex' : 'none';
  refs.rowWk.hidden = !showWk;
  refs.rowWk.style.display = showWk ? 'flex' : 'none';
  refs.usage5h.hidden = true;
  refs.usageWk.hidden = true;

  const calls = Number(poolData?.calls || 0);
  const totalTok = Number(poolData?.totalTokens || 0);
  const costUsd =
    poolData?.unpricedCalls > 0 && poolData?.costUsd === 0 ? null : (poolData?.costUsd ?? 0);

  patchAttr(
    rowEl,
    'title',
    t('usedQuota.poolTooltip', {
      pool: poolLabel,
      calls,
      tok: formatTokens(totalTok),
      cost: formatUsd(costUsd),
    })
  );

  if (show5h) {
    const pct5hRaw = poolData?.used5hPct;
    const hasPct5h = pct5hRaw != null && Number.isFinite(Number(pct5hRaw));
    const pct5hVal = hasPct5h ? Math.max(0, Number(pct5hRaw)) : 0;
    const pctText5h = formatUsedQuotaPctLabel(pct5hRaw, poolData?.source5h, poolData?.observed5hPct);
    const tok5h =
      hasWk && Number(poolData?.win5hCalls || 0) > 0
        ? Number(poolData.win5hTokens || 0)
        : totalTok;
    const cost5h =
      hasWk && Number(poolData?.win5hCalls || 0) > 0
        ? (poolData.win5hCostUsd ?? costUsd)
        : costUsd;

    patchText(refs.title5h, t('usedQuota.win5hTitle', { pool: poolLabel }));
    patchText(refs.metaReset5h, '');
    patchText(
      refs.metaPrimary5h,
      hasWk
        ? `${pctText5h} · ${formatTokens(tok5h)} (${formatUsd(cost5h)})`
        : `${pctText5h} · ${formatTokens(totalTok)} (${formatUsd(costUsd)})`
    );
    patchText(
      refs.metaExtra5h,
      hasWk ? '' : ` · ${t('usedQuota.callsInline', { calls })}`
    );
    const bar5hPct = hasPct5h && pct5hVal > 0 ? Math.min(100, Math.max(1.2, pct5hVal)) : 0;
    patchStyleVar(refs.fill5h, '--fill-w', `${bar5hPct}%`);
    patchClasses(refs.fill5h, {
      'tone-warn': pct5hVal >= 60 && pct5hVal < 85,
      'tone-danger': pct5hVal >= 85,
    });
  }

  if (showWk) {
    const isOfflineFallback = !has5h && !hasWk;
    const pctWkRaw = isOfflineFallback ? null : poolData?.usedWeeklyPct;
    const hasPctWk = pctWkRaw != null && Number.isFinite(Number(pctWkRaw));
    const pctWkVal = hasPctWk ? Math.max(0, Number(pctWkRaw)) : 0;
    const pctTextWk = isOfflineFallback
      ? t('usedQuota.pctNoCycle')
      : formatUsedQuotaPctLabel(pctWkRaw, poolData?.sourceWeekly, poolData?.observedWeeklyPct);

    patchText(
      refs.titleWk,
      isOfflineFallback
        ? t('usedQuota.winFallbackTitle', { pool: poolLabel })
        : t('usedQuota.winWkTitle', { pool: poolLabel })
    );
    patchText(refs.metaResetWk, '');
    patchText(
      refs.metaPrimaryWk,
      `${pctTextWk} · ${formatTokens(totalTok)} (${formatUsd(costUsd)})`
    );
    patchText(refs.metaExtraWk, ` · ${t('usedQuota.callsInline', { calls })}`);
    const barWkPct = hasPctWk && pctWkVal > 0 ? Math.min(100, Math.max(1.2, pctWkVal)) : 0;
    patchStyleVar(refs.fillWk, '--fill-w', `${barWkPct}%`);
    patchClasses(refs.fillWk, {
      'tone-warn': pctWkVal >= 60 && pctWkVal < 85,
      'tone-danger': pctWkVal >= 85,
    });
  }
}

export function usedQuotaPoolRowSig(item, idx) {
  const p = item.poolData || {};
  return `${getEffectiveLocale()}:${idx}:${item.key}:${item.poolLabel}:${p.calls}:${p.totalTokens}:${p.costUsd}:${p.unpricedCalls}:${Boolean(p.has5h)}:${Boolean(p.hasWeekly)}:${p.used5hPct}:${p.observed5hPct}:${p.source5h}:${p.win5hTokens}:${p.win5hCostUsd}:${p.win5hCalls}:${p.usedWeeklyPct}:${p.observedWeeklyPct}:${p.sourceWeekly}`;
}

export const SessionUsedQuotaWidget = defineComponent({
  name: 'SessionUsedQuotaWidget',
  setup({ props }) {
    const compactHover = Boolean(props.compactHover);
    const titleTextEl = h('span', { text: t('module.used_quotas') });
    const usedMetaBadge = h('span', {
      className: 'panel-meta',
      text: t('usedQuota.metaBadge', { count: 0 }),
    });
    const usedEmptyEl = h('div', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md); padding: 2px 0;',
      text: t('usedQuota.empty'),
    });
    const usedPoolsListEl = h(
      'div',
      compactHover
        ? { className: 'wm-hover-quota-pools', hidden: true }
        : { style: 'display: flex; flex-direction: column; gap: 0;', hidden: true }
    );
    const usedFootLeft = h('span', {
      className: 'text-muted',
      text: t('usedQuota.footTotal', { tok: '0', cost: '$0.00' }),
    });
    const usedFootRight = h('span', {
      className: 'text-muted',
      text: t('usedQuota.footCalls', { calls: 0 }),
    });

    const panel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('pulse', { size: 13 }),
          titleTextEl,
        ]),
        usedMetaBadge,
      ]),
      usedEmptyEl,
      usedPoolsListEl,
      h(
        'div',
        compactHover
          ? { className: 'panel-header wm-hover-quota-foot quota-card-foot' }
          : { className: 'panel-header quota-card-foot', style: 'font-size: var(--fs-md); padding-top: 2px;' },
        [usedFootLeft, usedFootRight]
      ),
    ]);

    function update({ data } = {}) {
      patchText(titleTextEl, t('module.used_quotas'));
      patchText(usedEmptyEl, t('usedQuota.empty'));
      if (!data) {
        return;
      }

      const quotas = data.quotas || {};
      const active = data.activeConversation || {};
      const hasSubagents = Boolean(active.hasSubagents);
      const sessionUsed = quotas.sessionUsed || {};
      const usedPoolItems = buildSessionUsedQuotaItems(sessionUsed);
      const hasUsedPools = usedPoolItems.length > 0;

      patchAttr(usedEmptyEl, 'hidden', hasUsedPools);
      patchAttr(usedPoolsListEl, 'hidden', !hasUsedPools);
      patchText(
        usedMetaBadge,
        hasUsedPools && hasSubagents
          ? t('usedQuota.metaWithSubs', { count: usedPoolItems.length })
          : t('usedQuota.metaBadge', { count: usedPoolItems.length })
      );

      patchKeyedList(usedPoolsListEl, usedPoolItems, {
        keyFn: (item) => item.key,
        sigFn: usedQuotaPoolRowSig,
        createRow: createPoolQuotaRow,
        updateRow: syncUsedPoolQuotaRow,
      });

      const usedTotalTok =
        Number(sessionUsed.totalTokens || 0) + Number(sessionUsed.unknownPoolTokens || 0);
      const usedTotalCalls =
        Number(sessionUsed.totalCalls || 0) + Number(sessionUsed.unknownPoolCalls || 0);
      const usedTotalCost = active.sessionCostUsd ?? sessionUsed.totalCostUsd ?? 0;

      patchText(
        usedFootLeft,
        t('usedQuota.footTotal', {
          tok: formatTokens(usedTotalTok),
          cost: formatUsd(usedTotalCost),
        })
      );
      patchText(
        usedFootRight,
        sessionUsed.unknownPoolCalls > 0
          ? t('usedQuota.footCallsUnknown', {
              calls: usedTotalCalls,
              unk: sessionUsed.unknownPoolCalls,
            })
          : hasSubagents
            ? t('usedQuota.footCallsSub', { calls: usedTotalCalls })
            : t('usedQuota.footCalls', { calls: usedTotalCalls })
      );
    }

    return {
      el: panel,
      refs: { update, usedPoolsListEl },
    };
  },
});

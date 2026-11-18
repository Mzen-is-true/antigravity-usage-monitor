/**
 * @fileoverview Reusable Decoupled Step Table Widget (`StepTableWidget.js`).
 * Powers both `StepsDetailView` ("按步查看") and `SettingsStructureTab` live preview,
 * dynamically rendering 2..12 columns via `stepColumnRegistry.js`, turn rail + prompt
 * preview tooltips, and independent Main/Sub agent badges.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { getEffectiveLocale, isEnglishLocale, t } from '../../i18n/index.js';
import {
  DEFAULT_STEP_COLUMN_KEYS,
  STEP_COLUMN_REGISTRY,
} from '../../registries/stepColumnRegistry.js';
import {
  formatAgentBadgeText,
  formatAgentLabel,
  getAgentBadgeClass,
  normalizeClientStepTokenComboFormat,
} from '../../store/telemetryStore.js';

export function formatTurnPromptText(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  if (!text || !isEnglishLocale()) return text;
  if (text === '[图片/附件提问]') return t('steps.turnMediaOnly');
  if (text.endsWith(' [附图]')) {
    return `${text.slice(0, -5)} ${t('steps.turnMediaSuffix')}`;
  }
  return text;
}

export const StepTableWidget = defineComponent({
  name: 'StepTableWidget',
  setup({ props, onCleanup }) {
    const standalone = Boolean(props.standalone);
    const interactiveBadges = props.interactiveBadges !== false;
    const onSelectAgentScopes =
      typeof props.onSelectAgentScopes === 'function' ? props.onSelectAgentScopes : null;

    const stepsTheadRow = h('tr');
    const stepsTbody = h('tbody');

    function syncTableHeaderColumns(colKeys, headerCtx = {}) {
      const locale = getEffectiveLocale();
      const fmtKey = normalizeClientStepTokenComboFormat(headerCtx?.stepTokenComboFormat);
      const ctx = { stepTokenComboFormat: fmtKey };
      patchKeyedList(stepsTheadRow, colKeys, {
        keyFn: (colKey) => colKey,
        sigFn: (colKey) => `${locale}:${colKey}:${fmtKey}:${STEP_COLUMN_REGISTRY[colKey].thLabel(ctx)}`,
        createRow: (colKey) => {
          const th = h('th', { text: STEP_COLUMN_REGISTRY[colKey].thLabel(ctx) });
          return { el: th, refs: { th } };
        },
        updateRow: (refs, colKey) => {
          patchText(refs.th, STEP_COLUMN_REGISTRY[colKey].thLabel(ctx));
        },
      });
    }

    syncTableHeaderColumns(DEFAULT_STEP_COLUMN_KEYS);

    const stepsTableEl = h('table', { className: 'data-table steps-data-table' }, [
      h('thead', {}, [stepsTheadRow]),
      stepsTbody,
    ]);
    const stepsTablePane = h('div', { className: 'table-viewport is-step-table' }, [stepsTableEl]);

    const turnTipEl = h('div', {
      className: 'turn-prompt-tip',
      role: 'tooltip',
      hidden: true,
    });
    const hideTurnTip = () => patchAttr(turnTipEl, 'hidden', true);

    const standaloneHostEl = standalone
      ? h('div', { className: 'step-table-preview-host' }, [stepsTablePane, turnTipEl])
      : null;

    let boundsContainerGetter =
      typeof props.getBoundsEl === 'function'
        ? props.getBoundsEl
        : () => standaloneHostEl || stepsTablePane;

    function setBoundsElGetter(fn) {
      if (typeof fn === 'function') {
        boundsContainerGetter = fn;
      }
    }

    function showTurnTip(anchorCell, promptText) {
      const text = String(promptText || '').trim();
      const boundsEl = boundsContainerGetter?.();
      if (!anchorCell || !text) {
        hideTurnTip();
        return;
      }
      patchText(turnTipEl, text);
      patchAttr(turnTipEl, 'hidden', false);
      if (
        boundsEl &&
        typeof boundsEl.getBoundingClientRect === 'function' &&
        typeof anchorCell.getBoundingClientRect === 'function'
      ) {
        const panelRect = boundsEl.getBoundingClientRect();
        const cellRect = anchorCell.getBoundingClientRect();
        if (panelRect.width > 0 && panelRect.height > 0) {
          const tipH = turnTipEl.offsetHeight || 36;
          const tipW = turnTipEl.offsetWidth || 180;
          const placeAbove =
            panelRect.bottom - cellRect.bottom < tipH + 10 &&
            cellRect.top - panelRect.top > tipH + 6;
          const topPx = placeAbove
            ? Math.max(4, Math.round(cellRect.top - panelRect.top - tipH - 4))
            : Math.round(cellRect.bottom - panelRect.top + 4);
          const maxLeft = Math.max(6, Math.round(panelRect.width - tipW - 8));
          const leftPx = Math.min(
            maxLeft,
            Math.max(6, Math.round(cellRect.left - panelRect.left + 4))
          );
          turnTipEl.style.top = `${topPx}px`;
          turnTipEl.style.left = `${leftPx}px`;
        }
      }
    }

    stepsTablePane.addEventListener('scroll', hideTurnTip);
    stepsTbody.addEventListener('mouseleave', hideTurnTip);
    const hoverRows = new WeakMap();
    let lastRenderedRows = null;
    let lastRenderOptions = '';

    function enterStepCell(event) {
      const { badge, prompt } = hoverRows.get(this);
      if (event?.target === badge) hideTurnTip();
      else showTurnTip(this, prompt);
    }

    function moveInStepCell(event) {
      if (event?.target === hoverRows.get(this).badge) hideTurnTip();
    }

    function moveAlongTurnRail(event) {
      const { badge, prompt } = hoverRows.get(this);
      const rect = this.getBoundingClientRect?.();
      const relX = rect ? (event?.clientX ?? 0) - rect.left : 0;
      if (event?.target !== badge && relX <= 18) showTurnTip(this, prompt);
      else hideTurnTip();
    }

    function clearCellHover(cell) {
      if (!cell || !hoverRows.delete(cell)) return;
      cell.onmouseenter = null;
      cell.onmousemove = null;
      cell.onmouseleave = null;
    }

    function renderStepTable(
      tableSteps,
      cascadeId,
      colKeys,
      locale,
      {
        effectiveScopes = ['all'],
        hasSubagents = false,
        isMergedMultiAgents = false,
        showStepTurnRail = false,
        showStepAgentBadge = true,
        showStepSpeedColor = false,
        stepTokenComboFormat = undefined,
        displaySettings = {},
      } = {}
    ) {
      const colOrderSig = colKeys.join(',');
      const normTokenFmt = normalizeClientStepTokenComboFormat(stepTokenComboFormat);
      const renderOptions = JSON.stringify([
        cascadeId, locale, colOrderSig, effectiveScopes, hasSubagents, isMergedMultiAgents,
        showStepTurnRail, showStepAgentBadge, showStepSpeedColor, normTokenFmt,
        displaySettings.modelDisplayMode, displaySettings.showUpstreamModel,
        displaySettings.orchestratorIdMode,
      ]);
      if (lastRenderOptions === renderOptions && lastRenderedRows &&
          (lastRenderedRows === tableSteps || (lastRenderedRows.length === tableSteps.length &&
            tableSteps.every((step, i) => step === lastRenderedRows[i])))) {
        return;
      }
      const wantedSet = new Set(colKeys);
      syncTableHeaderColumns(colKeys, { stepTokenComboFormat: normTokenFmt });

      const showAgentBadge = Boolean(hasSubagents && showStepAgentBadge);
      const cellCtx = {
        hasSubagents,
        showAgentBadge,
        showStepSpeedColor,
        stepTokenComboFormat: normTokenFmt,
        effectiveScopes,
        scopeSigKey: effectiveScopes.join(','),
        displaySettings,
        onSelectAgentScopes,
      };

      const useRootTurn = Boolean(hasSubagents && isMergedMultiAgents);
      const getStepTurnIdx = (st) =>
        useRootTurn ? (st?.rootTurnIndex ?? st?.turnIndex) : st?.turnIndex;
      const getStepIsStart = (st) =>
        Boolean(useRootTurn ? (st?.isRootTurnStart ?? st?.isTurnStart) : st?.isTurnStart);
      const getStepIsLatest = (st) =>
        Boolean(useRootTurn ? (st?.isRootLatestTurn ?? st?.isLatestTurn) : st?.isLatestTurn);
      const getStepPrompt = (st) =>
        (useRootTurn ? (st?.rootTurnPrompt ?? st?.turnPrompt) : st?.turnPrompt) || '';
      const turnKeys = showStepTurnRail ? tableSteps.map((st) => {
        const tIdx = getStepTurnIdx(st);
        if (!Number.isInteger(tIdx) || tIdx <= 0) return '';
        return useRootTurn ? `root:${tIdx}` : `${st?.agentId || 'main'}:${tIdx}`;
      }) : [];
      const formattedPrompts = new Map();
      function formattedTurnPrompt(st) {
        const raw = getStepPrompt(st);
        if (!formattedPrompts.has(raw)) formattedPrompts.set(raw, formatTurnPromptText(raw));
        return formattedPrompts.get(raw);
      }

      const decoratedSteps = tableSteps.map((st, idx) => {
        const tKey = turnKeys[idx];
        const hasTurn = Boolean(tKey);
        const hasUp = hasTurn && turnKeys[idx - 1] === tKey;
        const hasDown = hasTurn && turnKeys[idx + 1] === tKey;
        return {
          st,
          rowKey: `${st.agentCascadeId || cascadeId || 'conv'}-${st.stepIndex}`,
          hasTurn,
          hasUp,
          hasDown,
          isStart: Boolean(hasTurn && (getStepIsStart(st) || !hasDown)),
          isLatest: hasTurn && getStepIsLatest(st),
          prompt: hasTurn ? formattedTurnPrompt(st) : '',
        };
      });

      const railActive = Boolean(showStepTurnRail && decoratedSteps.some((d) => d.hasTurn));
      if (!railActive) {
        hideTurnTip();
      }
      patchClasses(stepsTableEl, { 'has-turn-rail': railActive });

      patchKeyedList(stepsTbody, decoratedSteps, {
        keyFn: (item) => item.rowKey,
        sigFn: (item) => {
          const { st } = item;
          const parts = colKeys
            .map((colKey) => STEP_COLUMN_REGISTRY[colKey].sigPart(st, cellCtx))
            .join('|');
          const badgeSig = showAgentBadge
            ? `${cellCtx.scopeSigKey}:${st.agentId || 'main'}:${st.agentBadge || ''}:${st.agentLabel || ''}`
            : '';
          return `${locale}:${colOrderSig}:${badgeSig}:${railActive}:${item.hasTurn}:${item.hasUp}:${item.hasDown}:${item.isStart}:${item.isLatest}:${item.prompt}:${parts}`;
        },
        createRow: () => {
          const tr = h('tr');
          return {
            el: tr,
            refs: {
              cellMap: new Map(),
              colOrderSig: '',
              railEl: null,
              agentBadgeEl: null,
              hoverTd: null,
            },
          };
        },
        updateRow: (refs, item, _idx, tr) => {
          const { st, hasTurn, hasUp, hasDown, isStart, isLatest, prompt } = item;

          if (refs.colOrderSig !== colOrderSig) {
            if (refs.hoverTd) {
              clearCellHover(refs.hoverTd);
              refs.hoverTd = null;
            }
            for (const [oldColKey, entry] of refs.cellMap) {
              if (!wantedSet.has(oldColKey)) {
                if (refs.railEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.railEl);
                }
                if (refs.agentBadgeEl?.parentNode === entry.td) {
                  entry.td.removeChild(refs.agentBadgeEl);
                }
                tr.removeChild(entry.td);
                refs.cellMap.delete(oldColKey);
              }
            }

            const isNewRow = refs.colOrderSig === '';
            for (let i = 0; i < colKeys.length; i++) {
              const colKey = colKeys[i];
              let cell = refs.cellMap.get(colKey);
              if (!cell) {
                cell = STEP_COLUMN_REGISTRY[colKey].createCell();
                refs.cellMap.set(colKey, cell);
              }
              if (isNewRow) {
                tr.appendChild(cell.td);
              } else {
                const currentTd = tr.children[i] || null;
                if (currentTd !== cell.td) tr.insertBefore(cell.td, currentTd);
              }
            }
            refs.colOrderSig = colOrderSig;
          }

          for (const colKey of colKeys) {
            const cellEntry = refs.cellMap.get(colKey);
            STEP_COLUMN_REGISTRY[colKey].updateCell(cellEntry.refs, st, cellCtx);
          }

          const firstColKey = colKeys[0];
          const firstTd = firstColKey ? refs.cellMap.get(firstColKey)?.td || null : null;
          const showRowRail = Boolean(hasTurn && firstTd);
          if (showRowRail && !refs.railEl) {
            refs.railEl = h('span', { className: 'turn-rail', 'aria-hidden': 'true' });
          }
          if (showAgentBadge && firstTd && !refs.agentBadgeEl) {
            refs.agentBadgeEl = h('span', { className: 'agent-badge', style: 'margin-right: 4px;' });
          }
          if (firstTd) {
            if (refs.railEl && (refs.railEl.parentNode !== firstTd || firstTd.firstChild !== refs.railEl)) {
              firstTd.insertBefore(refs.railEl, firstTd.firstChild);
            }
            const afterRail = refs.railEl
              ? refs.railEl.nextSibling ?? firstTd.children[1] ?? null
              : firstTd.firstChild;
            if (refs.agentBadgeEl &&
              (refs.agentBadgeEl.parentNode !== firstTd || afterRail !== refs.agentBadgeEl)) {
              firstTd.insertBefore(refs.agentBadgeEl, afterRail);
            }
          }

          patchAttr(refs.agentBadgeEl, 'hidden', !showAgentBadge || !firstTd);
          if (showAgentBadge && firstTd) {
            const badgeCls = getAgentBadgeClass(st.agentIndex || 0, !st.isSubagent);
            const clickableCls = interactiveBadges && onSelectAgentScopes ? ' is-clickable' : '';
            patchAttr(refs.agentBadgeEl, 'class', `agent-badge${clickableCls} ${badgeCls}`);
            const badgeText = isEnglishLocale()
              ? formatAgentBadgeText({
                  isMain: !st.isSubagent,
                  isSideQuestion: Boolean(st.isSideQuestion),
                  sideIndex: st.sideIndex || 0,
                  index: st.agentIndex || 0,
                  badgeText: st.agentBadge,
                })
              : st.agentBadge || (st.isSideQuestion ? '旁' : st.isSubagent ? '子' : '主');
            patchText(refs.agentBadgeEl, badgeText);

            if (interactiveBadges && onSelectAgentScopes) {
              const targetScope = st.agentId || 'main';
              const isSoleTarget =
                effectiveScopes.length === 1 && effectiveScopes[0] === targetScope;
              const agentName = isEnglishLocale()
                ? formatAgentLabel({
                    isMain: !st.isSubagent,
                    index: st.agentIndex || 0,
                    role: st.agentRole || '',
                  })
                : st.agentLabel || t('steps.unitAgent');
              patchAttr(
                refs.agentBadgeEl,
                'title',
                isSoleTarget
                  ? t('steps.badgeBackAll')
                  : t('steps.badgeFilterAgent', { agent: agentName })
              );
              refs.agentBadgeEl.onclick = (e) => {
                if (e && (e.ctrlKey || e.metaKey || e.shiftKey) && effectiveScopes[0] !== 'all') {
                  const next = effectiveScopes.includes(targetScope)
                    ? effectiveScopes.filter((id) => id !== targetScope)
                    : [...effectiveScopes, targetScope];
                  onSelectAgentScopes(next.length > 0 ? next : ['all']);
                } else {
                  onSelectAgentScopes(isSoleTarget ? ['all'] : [targetScope]);
                }
              };
            } else {
              patchAttr(refs.agentBadgeEl, 'title', null);
              refs.agentBadgeEl.onclick = null;
            }
          } else if (refs.agentBadgeEl) {
            refs.agentBadgeEl.onclick = null;
          }

          patchAttr(refs.railEl, 'hidden', !showRowRail);
          if (showRowRail) {
            const marker = isStart ? ' is-origin' : !hasUp && hasDown ? ' is-cap' : '';
            patchAttr(refs.railEl, 'class', `turn-rail${isLatest ? ' is-latest' : ''}${hasUp ? ' has-up' : ''}${hasDown ? ' has-down' : ''}${marker}`);
          }

          const hoverTd = showRowRail && prompt ? firstTd : null;
          if (refs.hoverTd !== hoverTd) clearCellHover(refs.hoverTd);
          refs.hoverTd = hoverTd;
          if (hoverTd) {
            hoverRows.set(hoverTd, { badge: refs.agentBadgeEl, prompt });
            hoverTd.onmouseenter = firstColKey === 'step' ? enterStepCell : null;
            hoverTd.onmousemove = firstColKey === 'step' ? moveInStepCell : moveAlongTurnRail;
            hoverTd.onmouseleave = hideTurnTip;
          }
        },
      });
      lastRenderOptions = renderOptions;
      lastRenderedRows = tableSteps;
    }

    onCleanup(() => {
      stepsTablePane.removeEventListener('scroll', hideTurnTip);
      stepsTbody.removeEventListener('mouseleave', hideTurnTip);
    });

    return {
      el: standaloneHostEl || stepsTablePane,
      refs: {
        stepsTablePane,
        stepsTableEl,
        stepsTheadRow,
        stepsTbody,
        turnTipEl,
        syncTableHeaderColumns,
        renderStepTable,
        hideTurnTip,
        setBoundsElGetter,
      },
    };
  },
});

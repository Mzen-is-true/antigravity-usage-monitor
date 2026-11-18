/**
 * @fileoverview View 1: Decoupled `LiveOverviewView.js` (实时监控视图).
 * Acts as a lightweight host container delegating all telemetry cards
 * (`metrics`, `context`, `quotas`, `live_tasks`) to `widgetRegistry.js` (`a` calls `b`),
 * allowing users to freely reorder or remove any module down to 1 item.
 */

import { defineComponent } from '../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../core/domPatch.js';
import { isWindowOverlayMode } from '../core/httpClient.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { i18nStore, t } from '../i18n/index.js';
import { createDynamicWidgetHost } from '../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_OVERVIEW_MODULES,
  normalizeClientOverviewModules,
  normalizeClientWindowMountMode,
  telemetryStore,
  triggerHostCdpSetup,
} from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';

export { CTX_CHANNEL_DEFS } from '../components/widgets/ContextWindowWidget.js';
export {
  buildQuotaPoolItems,
  createPoolQuotaRow,
  formatQuotaSummaryFooter,
  quotaPoolRowSig,
  syncPoolQuotaRow,
} from '../components/widgets/QuotaPoolsWidget.js';
export {
  buildSessionUsedQuotaItems,
  syncUsedPoolQuotaRow,
  usedQuotaPoolRowSig,
} from '../components/widgets/SessionUsedQuotaWidget.js';

export const LiveOverviewView = defineComponent({
  name: 'LiveOverviewView',
  setup({ onCleanup }) {
    let bannerDismissed = false;
    let bannerApplying = false;

    const cdpBannerTextEl = h('span', {
      className: 'cdp-banner-text',
      text: t('overview.cdpBannerNeedApply'),
    });
    const cdpBannerApplyBtn = h('button', {
      type: 'button',
      className: 'cdp-banner-btn is-primary',
      text: t('overview.cdpBannerApplyBtn'),
      onClick: async () => {
        if (bannerApplying) return;
        bannerApplying = true;
        patchAttr(cdpBannerApplyBtn, 'disabled', true);
        patchText(cdpBannerApplyBtn, t('overview.cdpBannerApplying'));
        try {
          await triggerHostCdpSetup('apply');
        } catch {
          // 交由下次轮询或设置页详细提示反馈
        } finally {
          bannerApplying = false;
          patchAttr(cdpBannerApplyBtn, 'disabled', false);
          patchText(cdpBannerApplyBtn, t('overview.cdpBannerApplyBtn'));
        }
      },
    });
    const cdpBannerSettingsBtn = h('button', {
      type: 'button',
      className: 'cdp-banner-btn',
      text: t('overview.cdpBannerSettingsBtn'),
      onClick: () => {
        uiStore.setState({
          activeView: 'settings',
          settingsSubTab: 'structure',
          settingsStructureTab: 'mount',
        });
      },
    });
    const cdpBannerDismissBtn = h(
      'button',
      {
        type: 'button',
        className: 'cdp-banner-dismiss',
        'aria-label': t('overview.cdpBannerDismissAria'),
        title: t('overview.cdpBannerDismissAria'),
        onClick: () => {
          bannerDismissed = true;
          patchAttr(cdpBannerEl, 'hidden', true);
          viewScrollbar.refresh();
        },
      },
      [createSvgIcon('close', { size: 11 })]
    );
    const cdpBannerEl = h(
      'div',
      { className: 'cdp-inline-banner', hidden: true },
      [
        h('span', { className: 'cdp-banner-main' }, [
          createSvgIcon('dock', { size: 12 }),
          cdpBannerTextEl,
        ]),
        h('span', { className: 'cdp-banner-actions' }, [
          cdpBannerApplyBtn,
          cdpBannerSettingsBtn,
          cdpBannerDismissBtn,
        ]),
      ]
    );

    const overviewInner = h('div', {
      className: 'overview-modules-host',
    });

    const overviewStack = h('div', { className: 'overview-scroll-stack' }, [
      cdpBannerEl,
      overviewInner,
    ]);

    const widgetHost = createDynamicWidgetHost({
      containerEl: overviewInner,
      mode: 'overview',
      isVisibleFn: () => getVisibleMonitorView() === 'overview',
      initialModuleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
    });

    const viewScrollbar = CustomScrollbar({
      contentEl: overviewStack,
      className: 'view-pane',
    });

    let latestData = null;
    let isDirty = false;
    let countdownTickTimer = null;

    function stopCountdownTicker() {
      if (countdownTickTimer) {
        clearInterval(countdownTickTimer);
        countdownTickTimer = null;
      }
    }

    function ensureCountdownTicker() {
      if (getVisibleMonitorView() !== 'overview') {
        stopCountdownTicker();
        return;
      }
      if (!countdownTickTimer) {
        countdownTickTimer = setInterval(() => {
          if (getVisibleMonitorView() === 'overview' && latestData) {
            renderData(latestData);
          }
        }, 30_000);
      }
    }

    function syncCdpBanner(data) {
      const isStandalone =
        typeof document !== 'undefined' &&
        document?.documentElement?.dataset?.standalone === 'true';
      const mountMode = normalizeClientWindowMountMode(
        data?.settings?.windowMountMode,
        data?.settings?.enableWindowOverlay
      );
      const wb = data?.windowBridge;
      const shouldShow =
        !bannerDismissed &&
        !isWindowOverlayMode() &&
        !isStandalone &&
        mountMode !== 'sidebar' &&
        wb &&
        wb.state === 'no_devtools_port';
      patchAttr(cdpBannerEl, 'hidden', !shouldShow);
      if (!shouldShow) return;

      const readyRestart = Boolean(wb.cdpSetup?.shortcutsConfigured);
      patchClasses(cdpBannerEl, { 'is-ready': readyRestart });
      patchText(
        cdpBannerTextEl,
        readyRestart ? t('overview.cdpBannerNeedRestart') : t('overview.cdpBannerNeedApply')
      );
      const showQuickApply = !readyRestart && wb.cdpSetup?.supported !== false;
      patchAttr(cdpBannerApplyBtn, 'hidden', !showQuickApply);
      if (!bannerApplying) {
        patchText(cdpBannerApplyBtn, t('overview.cdpBannerApplyBtn'));
      }
      patchText(cdpBannerSettingsBtn, t('overview.cdpBannerSettingsBtn'));
      patchAttr(cdpBannerDismissBtn, 'aria-label', t('overview.cdpBannerDismissAria'));
      patchAttr(cdpBannerDismissBtn, 'title', t('overview.cdpBannerDismissAria'));
    }

    function renderData(data) {
      if (!data) return;
      syncCdpBanner(data);
      const moduleKeys = normalizeClientOverviewModules(data.settings?.overviewModules);
      const minuteTick = Math.floor(Date.now() / 30000);
      widgetHost.update({
        moduleKeys,
        data,
        minuteTick,
      });
      ensureCountdownTicker();
      viewScrollbar.refresh();
    }

    const unsubTelemetry = telemetryStore.subscribe(
      (st) => ({ telemetry: st.telemetry, minuteTick: st.minuteTick }),
      ({ telemetry: data }) => {
        latestData = data;
        if (getVisibleMonitorView() !== 'overview') {
          const stillRunning =
            (Array.isArray(data?.runningConversations) && data.runningConversations.length > 0) ||
            Boolean(
              data?.activeConversation?.isRunning ||
                data?.activeConversation?.aggregated?.isRunning
            );
          if (!stillRunning) {
            widgetHost.pauseTickers();
          }
          isDirty = true;
          return;
        }
        isDirty = false;
        renderData(data);
      }
    );

    let prevCtxTarget = uiStore.getState().ctxInspectorAgentId;

    const unsubView = uiStore.subscribe(
      (st) => ({
        activeView: getVisibleMonitorView(st),
        ctxInspectorAgentId: st.ctxInspectorAgentId,
      }),
      (slice) => {
        const scopeChanged = slice.ctxInspectorAgentId !== prevCtxTarget;
        prevCtxTarget = slice.ctxInspectorAgentId;

        if (slice.activeView !== 'overview') {
          widgetHost.pauseTickers();
          stopCountdownTicker();
          if (scopeChanged) isDirty = true;
          return;
        }
        ensureCountdownTicker();
        if ((isDirty || scopeChanged) && latestData) {
          isDirty = false;
          renderData(latestData);
        } else {
          widgetHost.resumeTickers();
        }
      }
    );

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        if (getVisibleMonitorView() !== 'overview') {
          isDirty = true;
          // Refresh initial skeleton labels even before telemetry arrives
          if (!latestData) {
            widgetHost.update({
              moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
              data: null,
            });
          }
          return;
        }
        if (latestData) {
          renderData(latestData);
        } else {
          widgetHost.update({
            moduleKeys: DEFAULT_CLIENT_OVERVIEW_MODULES,
            data: null,
          });
        }
      }
    );

    onCleanup(() => {
      stopCountdownTicker();
      unsubTelemetry();
      unsubView();
      unsubI18n();
      widgetHost.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { viewScrollbar, widgetHost },
    };
  },
});

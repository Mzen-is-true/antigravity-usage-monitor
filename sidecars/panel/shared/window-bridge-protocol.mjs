export const WINDOW_BRIDGE_KEY = '__AGUsageMonitorBridge';
export const WINDOW_BRIDGE_ROUTE_KEY = 'hostRouteCascadeId';
export const WINDOW_OVERLAY_KEY = '__AGUsageMonitorOverlay';

export const WINDOW_OVERLAY_METHODS = Object.freeze({
  ensureAlive: 'ensureAlive',
  getDockKind: 'getDockKind',
  getMountMode: 'getMountMode',
  updateBridge: 'updateBridge',
  applyMountMode: 'applyMountMode',
  syncHostRoute: 'syncHostRoute',
  deliverRpc: 'deliverRpc',
  dispose: 'dispose',
});

export function readInjectedWindowBridge() {
  return typeof window === 'undefined' ? undefined : window[WINDOW_BRIDGE_KEY];
}

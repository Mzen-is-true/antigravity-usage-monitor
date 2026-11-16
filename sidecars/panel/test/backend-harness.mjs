import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as metrics from '../speed-metrics.mjs';
import { stripModuleSyntax } from '../scripts/build-bundle.mjs';

const REAL_CATALOG_RAW = JSON.parse(
  fs.readFileSync(new URL('../../../pricing-catalog.json', import.meta.url), 'utf8')
);
const DEFAULT_BUNDLED_CATALOG = {
  schemaVersion: 1,
  pricing: REAL_CATALOG_RAW.pricing,
  placeholders: REAL_CATALOG_RAW.placeholders,
};

const BACKEND_MODULE_FILES = [
  '../backend/context-windows.mjs',
  '../backend/account-oauth.mjs',
  '../backend/account-switch.mjs',
  '../backend/settings-schema.mjs',
  '../backend/config.mjs',
  '../backend/cli-sqlite-reader.mjs',
  '../backend/cli-statusline-config.mjs',
  '../backend/ls-discovery.mjs',
  '../backend/pricing-catalog.mjs',
  '../backend/plugin-updater.mjs',
  '../backend/ls-rpc.mjs',
  '../backend/model-pricing.mjs',
  '../backend/quota-pools.mjs',
  '../backend/local-scanner.mjs',
  '../backend/usage-aggregator.mjs',
  '../backend/quota-ledger.mjs',
  '../backend/telemetry-builder.mjs',
  '../backend/window-bridge.mjs',
  '../backend/api-actions.mjs',
  '../main.mjs',
];

function loadCombinedBackendSource() {
  return BACKEND_MODULE_FILES.map((relPath) =>
    fs.readFileSync(new URL(relPath, import.meta.url), 'utf8')
  ).join('\n');
}

function stripEsmSyntax(rawSource, mainUrl) {
  return stripModuleSyntax(rawSource).replaceAll('import.meta.url', JSON.stringify(mainUrl));
}

export function backendHarness({
  cache={},
  deepStats=null,
  transcripts={},
  diskDirs={},
  settings={},
  trajectories={},
  summaries={},
  userStatus={},
  availableModels={},
  quotaSummary={groups:[]},
  localCatalog=DEFAULT_BUNDLED_CATALOG,
  remoteCatalog=null,
  sessionQuotaLedger=null,
  pluginManifest=null,
  hasGitDir=false,
  pluginRootPath=null,
  remoteFetch=null,
  execFileImpl=null,
  sourceText=null,
  clock=null,
  metricsImplementation=metrics,
}={}) {
  const mainUrl = pluginRootPath ? `file://${pluginRootPath}/sidecars/panel/main.mjs` : 'file:///test/sidecars/panel/main.mjs';
  const mainPath = pluginRootPath ? `${pluginRootPath}/sidecars/panel/main.mjs` : '/test/sidecars/panel/main.mjs';
  const source = stripEsmSyntax(sourceText ?? loadCombinedBackendSource(), mainUrl);
  const state={calls:[],errors:[],saves:[],settings,trajectories,summaries,transcripts,transcriptMtimeMs:1,userStatus,quotaSummary,localCatalog,remoteCatalog,sessionQuotaLedger,pluginManifest,hasGitDir,deepStats,deepStatsMtimeMs:1};
  const ctx={
    ...metricsImplementation, URL, AbortSignal, Buffer, isDeepStrictEqual, randomUUID,
    ...(clock ? { Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock()])); }
      static now() { return clock(); }
    } } : {}),
    process:{platform:'win32',env:{ANTIGRAVITY_EXECUTABLE_DATA_DIR:'/test-data',ANTIGRAVITY_LS_ADDRESS:'test.invalid',ANTIGRAVITY_CSRF_TOKEN:'test'}},
    console:{error:m=>state.errors.push(m)},
    cpSync:()=>{},
    rmSync:()=>{},
    renameSync:()=>{},
    unlinkSync:()=>{},
    execFile:execFileImpl || ((cmd,args,opts,cb)=>{
      const fn = typeof opts === 'function' ? opts : cb;
      fn(new Error('execFile not mocked'));
    }),
    existsSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('settings.json') || norm.endsWith('trajectory_usage_cache.json')) return true;
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return Boolean(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return Boolean(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return Boolean(state.remoteCatalog);
      if (norm.endsWith('session_quota_ledger.json')) return Boolean(state.sessionQuotaLedger);
      if (norm.endsWith('plugin.json')) return Boolean(state.pluginManifest);
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        return Boolean(m && state.transcripts?.[m[1]]);
      }
      if (norm.endsWith('/.git')) return Boolean(state.hasGitDir);
      if (diskDirs && Object.prototype.hasOwnProperty.call(diskDirs, norm)) return true;
      return false;
    },
    mkdirSync:()=>{},
    readdirSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (diskDirs && Array.isArray(diskDirs[norm])) return diskDirs[norm];
      return [];
    },
    statSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        if (lines) {
          const text = Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines);
          return {mtimeMs:state.transcriptMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
      }
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json') && state.deepStats) {
        return {mtimeMs:state.deepStatsMtimeMs,size:JSON.stringify(state.deepStats).length};
      }
      return {mtimeMs:0,size:0};
    },
    readFileSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        return Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines || '');
      }
      if (norm.endsWith('settings.json')) return JSON.stringify(state.settings);
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return JSON.stringify(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return JSON.stringify(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return JSON.stringify(state.remoteCatalog);
      if (norm.endsWith('session_quota_ledger.json')) return JSON.stringify(state.sessionQuotaLedger);
      if (norm.endsWith('plugin.json')) return JSON.stringify(state.pluginManifest);
      return JSON.stringify(cache);
    },
    writeFileSync:(p,s)=>{
      const norm = String(p).replace(/\\/g, '/');
      const parsed = typeof s === 'string' ? JSON.parse(s) : s;
      state.saves.push({path:p,data:parsed});
      if (norm.endsWith('settings.json')) {
        state.settings = parsed;
      }
      if (norm.endsWith('remote_pricing_cache.json')) {
        state.remoteCatalog = parsed;
      }
      if (norm.endsWith('session_quota_ledger.json')) {
        state.sessionQuotaLedger = parsed;
      }
    },
    writeTrajectoryCacheFile:(p,data)=>{
      state.saves.push({path:p,data:JSON.parse(JSON.stringify(data))});
    },
    homedir:()=>'/test-home',dirname:path.dirname,join:path.join,basename:path.basename,delimiter:path.delimiter,pathToFileURL,fileURLToPath:()=>mainPath,
    Response:class {constructor(body,options){this.body=body;this.options=options;}},
    SidecarApp:class {page(){} api(){} run(){}},
    fetch:async(url,options={})=>{
      if (/^https?:\/\/(?!test\.invalid)/i.test(String(url)) && remoteFetch) {
        return remoteFetch(url, options);
      }
      const method=url.split('/').pop(); const body=options.body ? JSON.parse(options.body) : {};state.calls.push({method,body});
      if(method==='GetCascadeTrajectory') {
        const data=state.trajectories[body.cascadeId];
        if(data instanceof Error) throw data;
        return {ok:true,json:async()=>data||{}};
      }
      if(method==='RetrieveUserQuotaSummary') {
        const qs=await state.quotaSummary;
        if(qs instanceof Error) throw qs;
        return {ok:true,json:async()=>({response:qs})};
      }
      const data={GetUserStatus:{userStatus:state.userStatus},GetAvailableModels:{response:{models:availableModels}},GetAllCascadeTrajectories:{trajectorySummaries:state.summaries}}[method];
      return {ok:true,json:async()=>data};
    },
  };
  vm.runInNewContext(source+'\n globalThis.api={buildTelemetryPayloadInternal,executeTelemetryAction,computeStepCost,resolveModelInfo,inferFamilyFromProviderOrKey,isArgonModelIdentifier,isCarbonModelIdentifier,getBaseModelLabel,formatUpstreamModelId,PLACEHOLDER_MAP,normalizeQuotaFraction,classifyOfficialBucketWindow,classifyQuotaPoolIdentity,buildOfficialQuotaPools,POOL_PRIORITY_ORDER,resolveStepQuotaPoolKey,collectAccountConversationEntries,updateLedgerAndBuildSessionUsedQuota,resetSessionQuotaLedgerCache,resolveTimeWindow,sanitizeCatalogPayload,rebuildActiveCatalog,syncCloudCatalog,getCloudStatus,isValidSemver,compareSemver,performPluginUpdate,resolveMigratedGitRemoteUrl,loadSettings,executeSettingsAction,executeModelContextWindowAction,executeResetSettingsAction,executeRebuildCacheAction,clearRuntimeCaches,normalizeTopbarCapsuleSlots,normalizeHoverModules,normalizeOverviewModules,normalizeOverviewMetrics,normalizeStepTableColumns,normalizeStepTokenComboFormat,parseStepTokenComboSegments,normalizeModelDisplayMode,normalizePopoverWidthMode,normalizePopoverWidth,normalizeStandalonePort,setStandalonePortListener,parseAnnotationPbtxtTitle,buildCliStatusSnapshot,buildCliStatusLineCommand,isManagedCliStatusLineCommand,applyCliStatusLineToSettingsObject,cliDisplayWidth,parseCliModelAndEffort,formatCliStatusLineCapsule};',ctx);
  return {...ctx.api,state};
}

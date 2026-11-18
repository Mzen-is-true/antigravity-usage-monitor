/**
 * @fileoverview 宿主本地调试通道（`--remote-debugging-port`）快捷方式巡检、一键写入与自动守护模块。
 *
 * 背景：
 * Antigravity 2.0 桌面端自 v2.33.0 起默认启动不再携带 `--remote-debugging-port=0`，且无 `argv.json` 机制，
 * 导致主窗口顶栏胶囊（WindowOverlay）因缺少 `DevToolsActivePort` 而退回仅右侧边栏模式；
 * 同时客户端自动升级（AutoUpdater）会重置快捷方式并无参拉起进程。
 *
 * 本模块在不触碰宿主 `app.asar` 或安装二进制的前提下，提供：
 * 1. Windows 用户目录（桌面 / 开始菜单 / 任务栏固定）`Antigravity.lnk` 快捷方式参数只读巡检与宿主启动方式诊断；
 * 2. 一键备份原始快捷方式参数并幂等写入 `--remote-debugging-port=0`（支持一键无损还原）；
 * 3. 供 `window-bridge.mjs` 在用户开启自动守护后，于客户端升级重置快捷方式时后台自动补回启动参数。
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import {
  CDP_SHORTCUT_BACKUP_FILE,
  loadJson,
  lsRuntimeEndpoint,
  saveJson,
} from './config.mjs';

const CDP_INSPECT_CACHE_TTL_MS = 15_000;

let cachedHostCdpSnapshot = null;
let cachedHostCdpAtMs = 0;
let inFlightHostCdpInspect = null;

/** 重置宿主 CDP 巡检内存缓存（仅供单元测试或写操作后立即刷新调用）。 */
export function resetHostCdpCache() {
  cachedHostCdpSnapshot = null;
  cachedHostCdpAtMs = 0;
  inFlightHostCdpInspect = null;
}

function buildPlatformManualLaunchCommand(platform = process.platform, port = 0) {
  const safePort =
    Number.isInteger(Number(port)) && Number(port) >= 0 && Number(port) <= 65535
      ? Number(port)
      : 0;
  if (platform === 'darwin') {
    return `open -a "Antigravity" --args --remote-debugging-port=${safePort}`;
  }
  if (platform === 'win32') {
    return `"%LOCALAPPDATA%\\Programs\\antigravity\\Antigravity.exe" --remote-debugging-port=${safePort}`;
  }
  return `antigravity --remote-debugging-port=${safePort}`;
}

function normalizeShortcutKey(rawPath) {
  return String(rawPath || '')
    .trim()
    .replace(/\//g, '\\')
    .toLowerCase();
}

function stripCdpFlagFromArgs(rawArgs) {
  return String(rawArgs || '')
    .replace(/(?:^|\s+)--remote-debugging-port(?:=|\s+)\d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WIN_POWERSHELL_CDP_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$mode = [string]$env:AG_CDP_CFG_MODE
$portRaw = [string]$env:AG_CDP_CFG_PORT
$port = 0
if ($portRaw -match '^\\d+$') { $port = [int]$portRaw }
$restoreMap = @{}
if ($env:AG_CDP_CFG_RESTORE_JSON) {
  try {
    $parsedRestore = $env:AG_CDP_CFG_RESTORE_JSON | ConvertFrom-Json
    if ($parsedRestore) {
      foreach ($prop in $parsedRestore.PSObject.Properties) {
        $restoreMap[$prop.Name.ToLowerInvariant()] = [string]$prop.Value
      }
    }
  } catch {}
}

$lnkCandidates = New-Object System.Collections.Generic.List[string]
$seenLnk = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

function Add-LnkCandidate([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return }
  if ((Test-Path -LiteralPath $p) -and $seenLnk.Add($p)) {
    [void]$lnkCandidates.Add($p)
  }
}

$desktopDir = [Environment]::GetFolderPath('Desktop')
if ($desktopDir -and (Test-Path -LiteralPath $desktopDir)) {
  Get-ChildItem -LiteralPath $desktopDir -Filter '*.lnk' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Add-LnkCandidate $_.FullName
  }
}

$startMenuDir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'
if ($startMenuDir -and (Test-Path -LiteralPath $startMenuDir)) {
  Get-ChildItem -LiteralPath $startMenuDir -Filter '*.lnk' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | ForEach-Object {
    Add-LnkCandidate $_.FullName
  }
}

$taskbarDir = Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'
if ($taskbarDir -and (Test-Path -LiteralPath $taskbarDir)) {
  Get-ChildItem -LiteralPath $taskbarDir -Filter '*.lnk' -File -ErrorAction SilentlyContinue | ForEach-Object {
    Add-LnkCandidate $_.FullName
  }
}

$shell = New-Object -ComObject WScript.Shell
$shortcutsOut = @()
$updatedCount = 0
$restoredCount = 0

foreach ($lnkPath in $lnkCandidates) {
  try {
    $sc = $shell.CreateShortcut($lnkPath)
    $target = [string]$sc.TargetPath
    if ([string]::IsNullOrWhiteSpace($target)) { continue }
    $leaf = [System.IO.Path]::GetFileName($target)
    if ($leaf -ine 'Antigravity.exe') { continue }

    $prevArgs = [string]$sc.Arguments
    $curArgs = $prevArgs

    if ($mode -eq 'apply') {
      $clean = ([regex]::Replace($prevArgs, '(?i)(?:^|\\s+)--remote-debugging-port(?:=|\\s+)\\d+', ' ')).Trim()
      $clean = ($clean -replace '\\s+', ' ').Trim()
      $desired = if ($clean.Length -gt 0) { "$clean --remote-debugging-port=$port" } else { "--remote-debugging-port=$port" }
      if ($prevArgs.Trim() -ne $desired) {
        $item = Get-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
        $wasReadOnly = $false
        if ($item -and $item.IsReadOnly) {
          $wasReadOnly = $true
          $item.IsReadOnly = $false
        }
        $sc.Arguments = $desired
        $sc.Save()
        if ($wasReadOnly -and $item) { $item.IsReadOnly = $true }
        $recheck = $shell.CreateShortcut($lnkPath)
        $curArgs = [string]$recheck.Arguments
        $updatedCount += 1
      }
    } elseif ($mode -eq 'restore') {
      $normKey = ($lnkPath -replace '/', '\\').ToLowerInvariant()
      $desired = if ($restoreMap.ContainsKey($normKey)) {
        [string]$restoreMap[$normKey]
      } else {
        (([regex]::Replace($prevArgs, '(?i)(?:^|\\s+)--remote-debugging-port(?:=|\\s+)\\d+', ' ')) -replace '\\s+', ' ').Trim()
      }
      if ($prevArgs.Trim() -ne $desired.Trim()) {
        $item = Get-Item -LiteralPath $lnkPath -Force -ErrorAction SilentlyContinue
        $wasReadOnly = $false
        if ($item -and $item.IsReadOnly) {
          $wasReadOnly = $true
          $item.IsReadOnly = $false
        }
        $sc.Arguments = $desired
        $sc.Save()
        if ($wasReadOnly -and $item) { $item.IsReadOnly = $true }
        $recheck = $shell.CreateShortcut($lnkPath)
        $curArgs = [string]$recheck.Arguments
        $restoredCount += 1
      }
    }

    $hasFlag = [bool]($curArgs -match '(?i)(?:^|\\s)--remote-debugging-port(?:=|\\s+)\\d+')
    $shortcutsOut += [pscustomobject]@{
      path = $lnkPath
      previousArgs = $prevArgs
      arguments = $curArgs
      hasCdpFlag = $hasFlag
    }
  } catch {}
}

$hostRunning = $false
$hostHasCdpFlag = $false
$launchedByUpdater = $false
$explicitCdpPort = 0

try {
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $cmdLine = [string]$p.CommandLine
    if ($cmdLine -match '--type=') { continue }
    $hostRunning = $true
    if ($cmdLine -match '(?i)--remote-debugging-port(?:=|\\s+)(\\d+)') {
      $hostHasCdpFlag = $true
      $parsedP = [int]$Matches[1]
      if ($parsedP -gt 0 -and $parsedP -le 65535) { $explicitCdpPort = $parsedP }
    }
    if ($cmdLine -match '(?i)--updated') {
      $launchedByUpdater = $true
    }
  }
} catch {}

[pscustomobject]@{
  ok = $true
  mode = $mode
  updatedCount = $updatedCount
  restoredCount = $restoredCount
  hostRunning = $hostRunning
  hostHasCdpFlag = $hostHasCdpFlag
  launchedByUpdater = $launchedByUpdater
  explicitCdpPort = $explicitCdpPort
  shortcuts = $shortcutsOut
} | ConvertTo-Json -Depth 5 -Compress
`;

function runWinPowerShellCdpTask({ mode = 'inspect', port = 0, restoreMap = null, env = process.env } = {}) {
  const encoded = Buffer.from(WIN_POWERSHELL_CDP_SCRIPT, 'utf16le').toString('base64');
  const childEnv = {
    ...env,
    AG_CDP_CFG_MODE: String(mode || 'inspect'),
    AG_CDP_CFG_PORT: String(port ?? 0),
    AG_CDP_CFG_RESTORE_JSON: restoreMap ? JSON.stringify(restoreMap) : '',
  };
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: childEnv, windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const text = String(stdout || '').trim();
        if (!text) {
          reject(new Error('Empty PowerShell CDP output'));
          return;
        }
        try {
          const lastLine = text.split(/\r?\n/).filter(Boolean).pop() || text;
          resolve(JSON.parse(lastLine));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

function formatHostCdpSnapshot(raw, platform) {
  const shortcuts = Array.isArray(raw?.shortcuts) ? raw.shortcuts : [];
  const totalShortcuts = shortcuts.length;
  const configuredShortcuts = shortcuts.filter((s) => Boolean(s?.hasCdpFlag)).length;
  const shortcutsConfigured = totalShortcuts > 0 && configuredShortcuts === totalShortcuts;
  const hostRunning = Boolean(raw?.hostRunning);
  const hostHasCdpFlag = Boolean(raw?.hostHasCdpFlag);
  const launchedByUpdater = Boolean(raw?.launchedByUpdater);
  const explicitCdpPort = Number(raw?.explicitCdpPort || 0);
  const backupData = loadJson(CDP_SHORTCUT_BACKUP_FILE, null);
  const hasBackup =
    Boolean(backupData?.entries) && Object.keys(backupData.entries).length > 0;

  return {
    ok: Boolean(raw?.ok !== false),
    supported: platform === 'win32',
    platform,
    totalShortcuts,
    configuredShortcuts,
    shortcutsConfigured,
    hasBackup,
    hostRunning,
    hostHasCdpFlag,
    launchedByUpdater,
    explicitCdpPort: explicitCdpPort > 0 && explicitCdpPort <= 65535 ? explicitCdpPort : 0,
    needsColdRestart: shortcutsConfigured && hostRunning && !hostHasCdpFlag,
    manualLaunchCommand: buildPlatformManualLaunchCommand(platform, 0),
    checkedAtMs: Date.now(),
  };
}

/**
 * 巡检宿主快捷方式 `--remote-debugging-port` 配置状态与当前运行进程诊断（默认带 15s 内存缓存）。
 *
 * @param {{ force?: boolean, platform?: string, env?: Record<string, string|undefined>, homeDir?: string }} [options]
 */
export async function inspectHostCdpSetup({
  force = false,
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    return {
      ok: true,
      supported: false,
      platform,
      totalShortcuts: 0,
      configuredShortcuts: 0,
      shortcutsConfigured: false,
      hasBackup: false,
      hostRunning: false,
      hostHasCdpFlag: false,
      launchedByUpdater: false,
      explicitCdpPort: 0,
      needsColdRestart: false,
      manualLaunchCommand: buildPlatformManualLaunchCommand(platform, 0),
      checkedAtMs: Date.now(),
    };
  }

  const now = Date.now();
  if (!force && cachedHostCdpSnapshot && now - cachedHostCdpAtMs < CDP_INSPECT_CACHE_TTL_MS) {
    return cachedHostCdpSnapshot;
  }
  if (!force && inFlightHostCdpInspect) {
    return inFlightHostCdpInspect;
  }

  const runPromise = (async () => {
    try {
      const raw = await runWinPowerShellCdpTask({ mode: 'inspect', port: 0, env });
      const snap = formatHostCdpSnapshot(raw, platform);
      cachedHostCdpSnapshot = snap;
      cachedHostCdpAtMs = Date.now();
      return snap;
    } catch (err) {
      const fallback = {
        ok: lsRuntimeEndpoint.addr === 'test.invalid',
        supported: true,
        platform,
        totalShortcuts: 0,
        configuredShortcuts: 0,
        shortcutsConfigured: false,
        hasBackup: false,
        hostRunning: false,
        hostHasCdpFlag: false,
        launchedByUpdater: false,
        explicitCdpPort: 0,
        needsColdRestart: false,
        manualLaunchCommand: buildPlatformManualLaunchCommand(platform, 0),
        error: lsRuntimeEndpoint.addr === 'test.invalid' ? undefined : err?.message || 'inspect_failed',
        checkedAtMs: Date.now(),
      };
      cachedHostCdpSnapshot = fallback;
      cachedHostCdpAtMs = Date.now();
      return fallback;
    } finally {
      if (inFlightHostCdpInspect === runPromise) {
        inFlightHostCdpInspect = null;
      }
    }
  })();

  inFlightHostCdpInspect = runPromise;
  return runPromise;
}

/**
 * 为本机桌面、开始菜单与任务栏固定的 `Antigravity.lnk` 备份原始参数并幂等写入 `--remote-debugging-port`。
 *
 * @param {{ port?: number, platform?: string, env?: Record<string, string|undefined>, homeDir?: string }} [options]
 */
export async function applyHostCdpSetup({
  port = 0,
  platform = process.platform,
  env = process.env,
} = {}) {
  const safePort =
    Number.isInteger(Number(port)) &&
    (Number(port) === 0 || (Number(port) >= 1024 && Number(port) <= 65535))
      ? Number(port)
      : 0;

  if (platform !== 'win32') {
    return {
      ok: false,
      supported: false,
      platform,
      manualLaunchCommand: buildPlatformManualLaunchCommand(platform, safePort),
      error: 'Automatic shortcut configuration is only supported on Windows.',
    };
  }

  try {
    const existingBackup = loadJson(CDP_SHORTCUT_BACKUP_FILE, null);
    const entries =
      existingBackup && typeof existingBackup.entries === 'object' && existingBackup.entries
        ? { ...existingBackup.entries }
        : {};

    const raw = await runWinPowerShellCdpTask({ mode: 'apply', port: safePort, env });
    const shortcuts = Array.isArray(raw?.shortcuts) ? raw.shortcuts : [];
    for (const item of shortcuts) {
      const key = normalizeShortcutKey(item?.path);
      if (!key) continue;
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        entries[key] = stripCdpFlagFromArgs(item?.previousArgs || '');
      }
    }
    if (shortcuts.length > 0) {
      saveJson(CDP_SHORTCUT_BACKUP_FILE, {
        version: 1,
        updatedAtMs: Date.now(),
        entries,
      });
    }

    const snap = formatHostCdpSnapshot(raw, platform);
    cachedHostCdpSnapshot = snap;
    cachedHostCdpAtMs = Date.now();
    return {
      ...snap,
      ok: shortcuts.length > 0,
      updatedShortcuts: Number(raw?.updatedCount || 0),
      port: safePort,
      error: shortcuts.length === 0 ? '未检测到 Antigravity 快捷方式' : undefined,
    };
  } catch (err) {
    resetHostCdpCache();
    return {
      ok: false,
      supported: true,
      platform,
      totalShortcuts: 0,
      configuredShortcuts: 0,
      shortcutsConfigured: false,
      manualLaunchCommand: buildPlatformManualLaunchCommand(platform, safePort),
      error: err?.message || '快捷方式写入失败',
    };
  }
}

/**
 * 还原所有被修改过的 `Antigravity.lnk` 快捷方式至原始参数，并清空备份记录。
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined>, homeDir?: string }} [options]
 */
export async function restoreHostCdpSetup({
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    return {
      ok: false,
      supported: false,
      platform,
      manualLaunchCommand: buildPlatformManualLaunchCommand(platform, 0),
      error: 'Shortcut restore is only supported on Windows.',
    };
  }

  try {
    const existingBackup = loadJson(CDP_SHORTCUT_BACKUP_FILE, null);
    const restoreMap =
      existingBackup && typeof existingBackup.entries === 'object' && existingBackup.entries
        ? existingBackup.entries
        : {};
    const raw = await runWinPowerShellCdpTask({ mode: 'restore', port: 0, restoreMap, env });
    saveJson(CDP_SHORTCUT_BACKUP_FILE, { version: 1, updatedAtMs: Date.now(), entries: {} });
    const snap = formatHostCdpSnapshot(raw, platform);
    cachedHostCdpSnapshot = snap;
    cachedHostCdpAtMs = Date.now();
    return {
      ...snap,
      ok: true,
      restoredShortcuts: Number(raw?.restoredCount || 0),
    };
  } catch (err) {
    resetHostCdpCache();
    return {
      ok: false,
      supported: true,
      platform,
      error: err?.message || '快捷方式还原失败',
    };
  }
}

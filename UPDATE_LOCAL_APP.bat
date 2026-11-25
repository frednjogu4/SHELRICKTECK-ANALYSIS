@echo off
setlocal
title Fredrick TRADING - One-Click Update for http://127.0.0.1:8788/app
set "AURUM_UPDATER_BAT=%~f0"
set "AURUM_UPDATER_DIR=%~dp0"
set "AURUM_UPDATER_ARGS=%*"

echo ============================================================
echo  Fredrick TRADING - One-Click Local App Updater
echo  Target URL: http://127.0.0.1:8788/app
echo  Backed-up update from GitHub (main) with automatic rollback,
echo  strict AURUM-only process checks, and live Build ID check.
echo  Options: --dry-run   --no-restart   --no-pause
echo ============================================================
echo.

(
  if exist "%~dp0bridge\UPDATE_LOCAL_APP.ps1" (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge\UPDATE_LOCAL_APP.ps1"
  ) else (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$raw=[System.IO.File]::ReadAllText($env:AURUM_UPDATER_BAT,[System.Text.Encoding]::UTF8); $m='#'+' === AURUM_PS_UPDATER_PAYLOAD ==='; $i=$raw.IndexOf($m); if($i -lt 0){Write-Error 'Updater payload missing'; exit 1}; & ([ScriptBlock]::Create($raw.Substring($i)))"
  )
  if errorlevel 1 (
    echo.
    echo [X] Update stopped with an error (any partial changes were rolled back).
    echo     Running MT5 and local tokens/data were NOT modified.
    if /I not "%~1"=="--no-pause" if /I not "%~2"=="--no-pause" pause
    exit /b 1
  ) else (
    echo.
    if /I not "%~1"=="--no-pause" if /I not "%~2"=="--no-pause" pause
    exit /b 0
  )
)

# === AURUM_PS_UPDATER_PAYLOAD ===
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$rawArgs = if ($env:AURUM_UPDATER_ARGS) { $env:AURUM_UPDATER_ARGS.Trim() } elseif ($args -and $args.Count -gt 0) { ($args -join ' ').Trim() } else { '' }
$explicitTarget = ''
if ($rawArgs -match '--target\s+"([^"]+)"') {
  $explicitTarget = $Matches[1]
} elseif ($rawArgs -match '--target\s+(\S+)') {
  $explicitTarget = $Matches[1]
}
$dryRun = [bool]($rawArgs -match '(^|\s)--dry-run(\s|$)')
$skipRestart = [bool](($rawArgs -match '(^|\s)--no-restart(\s|$)') -or $dryRun)

$zipUrl = if ($env:AURUM_UPDATE_ZIP_URL) {
  $env:AURUM_UPDATE_ZIP_URL
} else {
  'https://codeload.github.com/frednjogu4/SHELRICKTECK-ANALYSIS/zip/refs/heads/main'
}

$packageTrees = @('bridge', 'server', 'src', 'scripts', 'public', 'cloudflare')
$packageRootFiles = @(
  'index.html',
  'vite.config.js',
  'wrangler.jsonc',
  'START_LOCAL_MARKET_COMMAND_CENTRE.bat',
  'START_ALL_LOCAL.bat',
  'SETUP_AND_RUN_LOCAL.bat',
  'RUN_LOCAL_API.bat',
  'START_LOCAL_API.bat',
  'UPDATE_LOCAL_APP.bat',
  'LOCAL_HOSTING_README.md',
  'LOCAL_HOST_ONLY.txt',
  'LOCAL_UPDATE_NOTES.txt',
  'START_HERE_LOCAL_PACKAGE.txt',
  'package.json',
  'package-lock.json'
)
$preservedRelPaths = @(
  'bridge/bridge_token.txt',
  'bridge/terminal_path.txt',
  'bridge/python_runtime.txt',
  'bridge/.dev-watch.json',
  '.env',
  '.env.local'
)
$preservedDirPrefixes = @(
  'server/data/',
  'logs/',
  'node_modules/',
  'backups/'
)

function Normalize-Dir([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  try {
    return [System.IO.Path]::GetFullPath($p.Trim().TrimEnd('\', '/'))
  } catch {
    return ''
  }
}

function Test-AurumRoot([string]$dir) {
  $d = Normalize-Dir $dir
  if (-not $d -or -not (Test-Path -LiteralPath $d -PathType Container)) { return $false }
  $hasPkg = Test-Path -LiteralPath (Join-Path $d 'package.json') -PathType Leaf
  $hasBridge = Test-Path -LiteralPath (Join-Path $d 'bridge\mt5_bridge.py') -PathType Leaf
  $hasLauncher = (Test-Path -LiteralPath (Join-Path $d 'START_ALL_LOCAL.bat') -PathType Leaf) -or
                 (Test-Path -LiteralPath (Join-Path $d 'START_LOCAL_MARKET_COMMAND_CENTRE.bat') -PathType Leaf)
  return ($hasPkg -and $hasBridge -and $hasLauncher)
}

function Test-IsPreservedRel([string]$relPosix) {
  if ($preservedRelPaths -contains $relPosix) { return $true }
  foreach ($pref in $preservedDirPrefixes) {
    if ($relPosix.StartsWith($pref, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Get-ListeningPids([int]$port) {
  $pids = New-Object System.Collections.Generic.List[int]
  try {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
      foreach ($pidVal in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        if ($pidVal -gt 0 -and -not $pids.Contains([int]$pidVal)) {
          $pids.Add([int]$pidVal)
        }
      }
      return $pids
    }
  } catch {}
  try {
    $lines = netstat -ano | Select-String -Pattern (":$port\s+.*LISTENING\s+(\d+)\s*$")
    foreach ($m in $lines) {
      $val = [int]$m.Matches[0].Groups[1].Value
      if ($val -gt 0 -and -not $pids.Contains($val)) { $pids.Add($val) }
    }
  } catch {}
  return $pids
}

function Get-ProcInfo([int]$procId) {
  try {
    $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    $gp = Get-Process -Id $procId -ErrorAction SilentlyContinue
    return [PSCustomObject]@{
      ProcessId   = $procId
      Name        = if ($gp) { [string]$gp.ProcessName } elseif ($cim) { [string]$cim.Name } else { '' }
      CommandLine = if ($cim -and $cim.CommandLine) { [string]$cim.CommandLine } else { '' }
      ExePath     = if ($cim -and $cim.ExecutablePath) { [string]$cim.ExecutablePath } else { '' }
      ParentPid   = if ($cim -and $cim.ParentProcessId) { [int]$cim.ParentProcessId } else { 0 }
      WindowTitle = if ($gp -and $gp.MainWindowTitle) { [string]$gp.MainWindowTitle } else { '' }
    }
  } catch {
    return $null
  }
}

function Resolve-RootFromCommandLine([string]$cmd, [string]$markerRegex, [int]$upLevels) {
  if ([string]::IsNullOrWhiteSpace($cmd)) { return '' }
  $matchesList = [regex]::Matches($cmd, '"([^"]+)"|(\S+)')
  foreach ($m in $matchesList) {
    $tok = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
    if ($tok -match $markerRegex -and (Test-Path -LiteralPath $tok)) {
      $cur = Split-Path -Parent ([System.IO.Path]::GetFullPath($tok))
      for ($i = 0; $i -lt $upLevels; $i++) {
        if ($cur) { $cur = Split-Path -Parent $cur }
      }
      if (Test-AurumRoot $cur) { return (Normalize-Dir $cur) }
    }
  }
  return ''
}

function Find-TargetAurumRoot {
  if ($explicitTarget) {
    $norm = Normalize-Dir $explicitTarget
    if (-not (Test-AurumRoot $norm)) {
      throw "The --target folder '$explicitTarget' is not an AURUM local package folder (missing package.json, bridge\mt5_bridge.py, or START_ALL_LOCAL.bat)."
    }
    return $norm
  }

  # 1. Check live process on port 8788 first so we always update the exact folder serving http://127.0.0.1:8788/app
  foreach ($p in (Get-ListeningPids 8788)) {
    $info = Get-ProcInfo $p
    if ($info) {
      $r = Resolve-RootFromCommandLine $info.CommandLine 'mt5_bridge\.py$' 1
      if ($r) { return $r }
      $r = Resolve-RootFromCommandLine $info.CommandLine 'wrangler\.jsonc$' 0
      if ($r) { return $r }
    }
  }

  # 2. Check the folder containing UPDATE_LOCAL_APP.bat (or parent of bridge\UPDATE_LOCAL_APP.ps1)
  $selfDir = Normalize-Dir $env:AURUM_UPDATER_DIR
  if (Test-AurumRoot $selfDir) { return $selfDir }
  if ($PSScriptRoot) {
    $psParent = Normalize-Dir (Split-Path -Parent $PSScriptRoot)
    if (Test-AurumRoot $psParent) { return $psParent }
  }

  # 3. Check live process on port 4100 (local Express API or its parent RUN_LOCAL_API.bat window)
  foreach ($p in (Get-ListeningPids 4100)) {
    $info = Get-ProcInfo $p
    if ($info) {
      $r = Resolve-RootFromCommandLine $info.CommandLine 'server[\\/]server\.js$' 1
      if ($r) { return $r }
      if ($info.ParentPid -gt 0) {
        $pInfo = Get-ProcInfo $info.ParentPid
        if ($pInfo) {
          $r = Resolve-RootFromCommandLine $pInfo.CommandLine 'RUN_LOCAL_API\.bat$' 0
          if ($r) { return $r }
        }
      }
    }
  }

  # 4. Check Desktop & Startup shortcuts created by SETUP_AND_RUN.bat
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $deskLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fredrick TRADING (local app).lnk'
    if (Test-Path -LiteralPath $deskLnk) {
      $wd = Normalize-Dir ($wsh.CreateShortcut($deskLnk).WorkingDirectory)
      if (Test-AurumRoot $wd) { return $wd }
    }
    $autoLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Fredrick TRADING AutoStart.lnk'
    if (Test-Path -LiteralPath $autoLnk) {
      $wd = Normalize-Dir ($wsh.CreateShortcut($autoLnk).WorkingDirectory)
      if ($wd) {
        $parentWd = Normalize-Dir (Split-Path -Parent $wd)
        if (Test-AurumRoot $parentWd) { return $parentWd }
      }
    }
  } catch {}

  # 5. Scan Downloads and Desktop (up to 2 levels) preferring any folder that already has bridge\bridge_token.txt
  $userHome = [Environment]::GetFolderPath('UserProfile')
  $discovered = New-Object System.Collections.Generic.List[string]
  foreach ($base in @((Join-Path $userHome 'Downloads'), (Join-Path $userHome 'Desktop'))) {
    if (-not (Test-Path -LiteralPath $base -PathType Container)) { continue }
    foreach ($d1 in (Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue)) {
      if (Test-AurumRoot $d1.FullName) { $discovered.Add((Normalize-Dir $d1.FullName)) }
      foreach ($d2 in (Get-ChildItem -LiteralPath $d1.FullName -Directory -ErrorAction SilentlyContinue)) {
        if (Test-AurumRoot $d2.FullName) { $discovered.Add((Normalize-Dir $d2.FullName)) }
      }
    }
  }
  if ($discovered.Count -gt 0) {
    foreach ($cand in $discovered) {
      if (Test-Path -LiteralPath (Join-Path $cand 'bridge\bridge_token.txt') -PathType Leaf) {
        return $cand
      }
    }
    return $discovered[0]
  }

  throw "Could not automatically locate your existing AURUM local package folder. Move UPDATE_LOCAL_APP.bat into the folder that holds START_ALL_LOCAL.bat and double-click it again."
}

function Get-FileSha256([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return '' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-AurumApiHealth {
  try {
    $j = Invoke-RestMethod -Uri 'http://127.0.0.1:4100/api/health' -TimeoutSec 2
    return [bool]($j -and $j.ok -eq $true -and $j.live_feed -eq 'deriv-public')
  } catch {
    return $false
  }
}

function Start-AurumServices([string]$rootDir, [string]$mode) {
  $hasStartAll = Test-Path -LiteralPath (Join-Path $rootDir 'START_ALL_LOCAL.bat') -PathType Leaf
  $hasCmdCentre = Test-Path -LiteralPath (Join-Path $rootDir 'START_LOCAL_MARKET_COMMAND_CENTRE.bat') -PathType Leaf
  $tokenPath = Join-Path $rootDir 'bridge\bridge_token.txt'
  $pyRuntimePath = Join-Path $rootDir 'bridge\python_runtime.txt'
  $autoStartBat = Join-Path $rootDir 'bridge\AUTO_START.bat'

  if ($mode -eq 'wrangler' -or (-not $hasStartAll -and $hasCmdCentre)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $rootDir 'START_LOCAL_MARKET_COMMAND_CENTRE.bat') + '"') -WorkingDirectory $rootDir | Out-Null
  } else {
    $canAutoStart = $false
    if ((Test-Path -LiteralPath $tokenPath -PathType Leaf) -and (Test-Path -LiteralPath $pyRuntimePath -PathType Leaf) -and (Test-Path -LiteralPath $autoStartBat -PathType Leaf)) {
      $savedPy = (Get-Content -LiteralPath $pyRuntimePath -TotalCount 1 -ErrorAction SilentlyContinue)
      if ($savedPy -and (Test-Path -LiteralPath $savedPy.Trim() -PathType Leaf)) {
        $canAutoStart = $true
      }
    }
    if ($canAutoStart) {
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $autoStartBat + '"') -WorkingDirectory (Join-Path $rootDir 'bridge') -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -ne 0) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $rootDir 'START_ALL_LOCAL.bat') + '"') -WorkingDirectory $rootDir | Out-Null
      }
    } else {
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $rootDir 'START_ALL_LOCAL.bat') + '"') -WorkingDirectory $rootDir | Out-Null
    }
  }
}

function Restore-AurumBackup([string]$rootDir, [string]$backupDir) {
  $manifestPath = Join-Path $backupDir 'backup-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Rollback failed: backup-manifest.json missing in $backupDir"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $filesDir = Join-Path $backupDir 'files'
  foreach ($prop in $manifest.sha256ByRelPath.PSObject.Properties) {
    $rel = [string]$prop.Name
    $expectedSha = [string]$prop.Value
    if (Test-IsPreservedRel $rel) { continue }
    $src = Join-Path $filesDir ($rel -replace '/', '\')
    $dst = Join-Path $rootDir ($rel -replace '/', '\')
    $dstParent = Split-Path -Parent $dst
    if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
      New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
    }
    [System.IO.File]::Copy($src, $dst, $true)
    if ((Get-FileSha256 $dst) -ne $expectedSha) {
      throw "Rollback checksum mismatch on $rel"
    }
  }
  foreach ($addedRel in $manifest.addedIfApplied) {
    $r = [string]$addedRel
    if (Test-IsPreservedRel $r) { continue }
    $dst = Join-Path $rootDir ($r -replace '/', '\')
    if (Test-Path -LiteralPath $dst -PathType Leaf) {
      Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
    }
  }
  return [string]$manifest.previousBuildId
}

$targetRoot = Find-TargetAurumRoot
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$logsDir = Join-Path $targetRoot 'logs'
if (-not (Test-Path -LiteralPath $logsDir -PathType Container)) {
  New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
}
$logFile = Join-Path $logsDir ("local-update-" + $stamp + ".log")
$logLines = New-Object System.Collections.Generic.List[string]

function Write-UpdateLog([string]$msg) {
  $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $entry = "[$ts] $msg"
  $logLines.Add($entry)
  [System.IO.File]::WriteAllLines($logFile, $logLines, [System.Text.Encoding]::UTF8)
  Write-Host $msg
}

$oldBuildJsonPath = Join-Path $targetRoot 'bridge\pwa\build.json'
$oldBuildId = 'none (pre-repair package)'
if (Test-Path -LiteralPath $oldBuildJsonPath -PathType Leaf) {
  try {
    $parsedOld = Get-Content -LiteralPath $oldBuildJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($parsedOld -and $parsedOld.id) { $oldBuildId = [string]$parsedOld.id }
  } catch {}
}

Write-UpdateLog "[1/7] Located local package folder: $targetRoot"
Write-UpdateLog "      Current installed Build ID: $oldBuildId"
Write-UpdateLog "      Update log: $logFile"
if ($dryRun) { Write-UpdateLog "      Mode: DRY-RUN (read-only verification; zero files or processes will be modified)" }

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aurum-local-update-' + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  $zipFile = Join-Path $tempDir 'aurum-main.zip'
  $extractDir = Join-Path $tempDir 'extracted'
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

  Write-UpdateLog "[2/7] Downloading & verifying latest approved release..."
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  if ($zipUrl -match '^https?://') {
    Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipFile -TimeoutSec 120
  } elseif (Test-Path -LiteralPath $zipUrl -PathType Leaf) {
    Copy-Item -LiteralPath $zipUrl -Destination $zipFile -Force
  } else {
    throw "Download source not reachable: $zipUrl"
  }

  if (-not (Test-Path -LiteralPath $zipFile -PathType Leaf) -or ((Get-Item -LiteralPath $zipFile).Length -lt 50000)) {
    throw "Downloaded archive is missing or unexpectedly small. Aborting without changing local files."
  }

  Expand-Archive -LiteralPath $zipFile -DestinationPath $extractDir -Force
  $subDirs = @(Get-ChildItem -LiteralPath $extractDir -Directory)
  $srcRoot = if ($subDirs.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $subDirs[0].FullName 'bridge\app.html'))) {
    $subDirs[0].FullName
  } elseif (Test-Path -LiteralPath (Join-Path $extractDir 'bridge\app.html')) {
    $extractDir
  } else {
    throw "Extracted archive did not contain bridge\app.html in an expected root folder."
  }

  $requiredFiles = @(
    'bridge\app.html',
    'bridge\pwa\build.json',
    'bridge\pwa\sw.js',
    'bridge\mt5_bridge.py',
    'server\server.js',
    'server\lib\strength.js',
    'package.json'
  )
  foreach ($req in $requiredFiles) {
    $fullReq = Join-Path $srcRoot $req
    if (-not (Test-Path -LiteralPath $fullReq -PathType Leaf) -or ((Get-Item -LiteralPath $fullReq).Length -eq 0)) {
      throw "Downloaded release failed verification: missing or empty $req"
    }
  }

  $newBuildObj = Get-Content -LiteralPath (Join-Path $srcRoot 'bridge\pwa\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $newBuildId = [string]$newBuildObj.id
  $newGitSha = if ($newBuildObj.git) { [string]$newBuildObj.git } else { 'n/a' }
  if ([string]::IsNullOrWhiteSpace($newBuildId)) {
    throw "Downloaded bridge\pwa\build.json has no valid Build ID."
  }
  $newAppHtml = [System.IO.File]::ReadAllText((Join-Path $srcRoot 'bridge\app.html'), [System.Text.Encoding]::UTF8)
  $newSwJs = [System.IO.File]::ReadAllText((Join-Path $srcRoot 'bridge\pwa\sw.js'), [System.Text.Encoding]::UTF8)
  if ($newAppHtml -notmatch [regex]::Escape($newBuildId) -or $newSwJs -notmatch [regex]::Escape($newBuildId)) {
    throw "Release consistency check failed: bridge\app.html and bridge\pwa\sw.js do not match Build ID $newBuildId."
  }
  Write-UpdateLog "      Verified incoming release Build ID: $newBuildId (git: $newGitSha)"

  # Collect candidate canonical entries (relPosix -> fullSrcPath)
  $candidateList = New-Object System.Collections.Generic.List[PSCustomObject]
  foreach ($rootFile in $packageRootFiles) {
    $srcPath = Join-Path $srcRoot $rootFile
    if (Test-Path -LiteralPath $srcPath -PathType Leaf) {
      $candidateList.Add([PSCustomObject]@{ Rel = $rootFile; Src = $srcPath })
    }
  }
  foreach ($tree in $packageTrees) {
    $srcTree = Join-Path $srcRoot $tree
    if (-not (Test-Path -LiteralPath $srcTree -PathType Container)) { continue }
    foreach ($f in (Get-ChildItem -LiteralPath $srcTree -Recurse -File)) {
      if ($f.Extension -eq '.pyc' -or $f.Name -eq '.DS_Store' -or $f.FullName -match '[\\/]__pycache__[\\/]') { continue }
      $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\', '/') -replace '\\', '/'
      if (Test-IsPreservedRel $rel) { continue }
      $candidateList.Add([PSCustomObject]@{ Rel = $rel; Src = $f.FullName })
    }
  }

  $changedCount = 0
  foreach ($entry in $candidateList) {
    $dstCheck = Join-Path $targetRoot ($entry.Rel -replace '/', '\')
    if ((Get-FileSha256 $dstCheck) -ne (Get-FileSha256 $entry.Src)) { $changedCount++ }
  }

  if ($dryRun) {
    Write-UpdateLog "[DRY-RUN OK] $changedCount of $($candidateList.Count) canonical file(s) would update ($oldBuildId -> $newBuildId, git $newGitSha)."
    Write-UpdateLog "             Zero files were modified and zero processes were stopped."
    exit 0
  }

  # Snapshot hashes of local-only files + server\data\* so we prove nothing secret/local was touched
  $preservedBefore = @{}
  foreach ($rel in $preservedRelPaths) {
    $pFull = Join-Path $targetRoot ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $pFull -PathType Leaf) {
      $preservedBefore[$rel] = Get-FileSha256 $pFull
    }
  }
  $serverDataDir = Join-Path $targetRoot 'server\data'
  if (Test-Path -LiteralPath $serverDataDir -PathType Container) {
    foreach ($df in (Get-ChildItem -LiteralPath $serverDataDir -Recurse -File -ErrorAction SilentlyContinue)) {
      $dRel = $df.FullName.Substring($targetRoot.Length).TrimStart('\', '/') -replace '\\', '/'
      $preservedBefore[$dRel] = Get-FileSha256 $df.FullName
    }
  }

  # Verify port ownership BEFORE stopping anything or touching any files
  $launchMode = 'bridge'
  $aurumProcsToStop = New-Object System.Collections.Generic.List[int]
  if (-not $skipRestart) {
    Write-UpdateLog "[3/7] Verifying running processes on ports 8788, 8787, and 4100 (MT5 & unrelated apps are NEVER stopped)..."
    foreach ($port in @(8788, 8787)) {
      foreach ($procId in (Get-ListeningPids $port)) {
        $info = Get-ProcInfo $procId
        if (-not $info) { continue }
        if ($info.Name -match '^(?i)terminal(64)?(\.exe)?$') { continue }
        if ($info.CommandLine -match 'mt5_bridge\.py' -or $info.WindowTitle -match 'Exness MT5 Bridge') {
          $launchMode = 'bridge'
          if (-not $aurumProcsToStop.Contains($procId)) { $aurumProcsToStop.Add($procId) }
        } elseif (($info.CommandLine -match 'wrangler' -and $info.CommandLine -match 'wrangler\.jsonc') -or $info.WindowTitle -match 'Shelricktech Local Dashboard') {
          $launchMode = 'wrangler'
          if (-not $aurumProcsToStop.Contains($procId)) { $aurumProcsToStop.Add($procId) }
        } else {
          throw "Port $port is occupied by unrelated process PID $procId ($($info.Name)). Refusing to terminate unrelated process; aborting safely."
        }
      }
    }

    foreach ($procId in (Get-ListeningPids 4100)) {
      $info = Get-ProcInfo $procId
      if (-not $info) { continue }
      if ($info.Name -match '^(?i)terminal(64)?(\.exe)?$') { continue }
      $parentInfo = if ($info.ParentPid -gt 0) { Get-ProcInfo $info.ParentPid } else { $null }
      $isVerifiedAurumApi = ($info.CommandLine -match 'server[\\/]server\.js') -or
                            ($info.WindowTitle -match 'Fredrick AURUM Local API') -or
                            ($parentInfo -and ($parentInfo.CommandLine -match 'RUN_LOCAL_API\.bat' -or $parentInfo.WindowTitle -match 'Fredrick AURUM Local API'))
      if ($isVerifiedAurumApi) {
        if (-not $aurumProcsToStop.Contains($procId)) { $aurumProcsToStop.Add($procId) }
        if ($parentInfo -and ($parentInfo.CommandLine -match 'RUN_LOCAL_API\.bat' -or $parentInfo.WindowTitle -match 'Fredrick AURUM Local API')) {
          if (-not $aurumProcsToStop.Contains($info.ParentPid)) { $aurumProcsToStop.Add($info.ParentPid) }
        }
      } else {
        throw "Port 4100 is occupied by unrelated process PID $procId ($($info.Name)). Refusing to terminate unrelated process; aborting safely."
      }
    }
  } else {
    Write-UpdateLog "[3/7] Skipping process inspection (--no-restart)."
  }

  # Create timestamped backup BEFORE stopping services or replacing files
  $backupsRoot = Join-Path $targetRoot 'backups'
  New-Item -ItemType Directory -Force -Path $backupsRoot | Out-Null
  $backupDir = Join-Path $backupsRoot ("backup-" + $stamp)
  $backupFilesDir = Join-Path $backupDir 'files'
  New-Item -ItemType Directory -Force -Path $backupFilesDir | Out-Null

  $backupHashes = [ordered]@{}
  $addedIfApplied = New-Object System.Collections.Generic.List[string]
  foreach ($entry in $candidateList) {
    $existingPath = Join-Path $targetRoot ($entry.Rel -replace '/', '\')
    if (Test-Path -LiteralPath $existingPath -PathType Leaf) {
      $bDst = Join-Path $backupFilesDir ($entry.Rel -replace '/', '\')
      $bParent = Split-Path -Parent $bDst
      if (-not (Test-Path -LiteralPath $bParent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $bParent | Out-Null
      }
      [System.IO.File]::Copy($existingPath, $bDst, $true)
      $backupHashes[$entry.Rel] = Get-FileSha256 $bDst
    } else {
      $addedIfApplied.Add($entry.Rel)
    }
  }
  $backupManifestObj = [ordered]@{
    createdAt       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    previousBuildId = $oldBuildId
    backedUpCount   = $backupHashes.Count
    sha256ByRelPath = $backupHashes
    addedIfApplied  = $addedIfApplied
  }
  [System.IO.File]::WriteAllText((Join-Path $backupDir 'backup-manifest.json'), ($backupManifestObj | ConvertTo-Json -Depth 6), [System.Text.Encoding]::UTF8)

  # Keep the 5 most recent backups tidy
  $existingBackups = @(Get-ChildItem -LiteralPath $backupsRoot -Directory -Filter 'backup-*' | Sort-Object Name)
  while ($existingBackups.Count -gt 5) {
    Remove-Item -LiteralPath $existingBackups[0].FullName -Recurse -Force -ErrorAction SilentlyContinue
    $existingBackups = $existingBackups[1..($existingBackups.Count - 1)]
  }
  Write-UpdateLog "[4/7] Created timestamped backup ($($backupHashes.Count) files): $backupDir"

  try {
    if (-not $skipRestart -and $aurumProcsToStop.Count -gt 0) {
      Write-UpdateLog "      Stopping $($aurumProcsToStop.Count) verified AURUM process(es)..."
      foreach ($pidToStop in $aurumProcsToStop) {
        Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue
      }
      $waitUntil = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $waitUntil) {
        if ((Get-ListeningPids 8788).Count -eq 0 -and (Get-ListeningPids 4100).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
      }
    }

    Write-UpdateLog "[5/7] Replacing approved canonical files ($changedCount changed of $($candidateList.Count))..."
    $selfFull = if ($env:AURUM_UPDATER_BAT) { [System.IO.Path]::GetFullPath($env:AURUM_UPDATER_BAT) } else { '' }
    foreach ($entry in $candidateList) {
      if (Test-IsPreservedRel $entry.Rel) { continue }
      $dstFile = Join-Path $targetRoot ($entry.Rel -replace '/', '\')
      if ($selfFull -and ([System.IO.Path]::GetFullPath($dstFile) -ieq $selfFull) -and ((Get-FileSha256 $entry.Src) -eq (Get-FileSha256 $dstFile))) {
        continue
      }
      $dstParent = Split-Path -Parent $dstFile
      if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
      }
      [System.IO.File]::Copy($entry.Src, $dstFile, $true)
    }

    # Verify local-only files + server\data were preserved byte-for-byte
    foreach ($kv in $preservedBefore.GetEnumerator()) {
      $pFull = Join-Path $targetRoot ($kv.Key -replace '/', '\')
      if ((Get-FileSha256 $pFull) -ne $kv.Value) {
        throw "Safety check failed: preserved local file $($kv.Key) changed unexpectedly."
      }
    }

    $installedUpdater = Join-Path $targetRoot 'UPDATE_LOCAL_APP.bat'
    if (-not (Test-Path -LiteralPath $installedUpdater -PathType Leaf) -and $selfFull -and (Test-Path -LiteralPath $selfFull -PathType Leaf)) {
      [System.IO.File]::Copy($selfFull, $installedUpdater, $true)
    }

    try {
      $desk = [Environment]::GetFolderPath('Desktop')
      if ($desk -and (Test-Path -LiteralPath $desk -PathType Container)) {
        $wsh = New-Object -ComObject WScript.Shell
        $lnk = $wsh.CreateShortcut((Join-Path $desk 'Fredrick TRADING - Update Local App.lnk'))
        $lnk.TargetPath = $installedUpdater
        $lnk.WorkingDirectory = $targetRoot
        $lnk.Save()
      }
    } catch {}

    if (-not $skipRestart) {
      Write-UpdateLog "[6/7] Restarting local service ($launchMode) for http://127.0.0.1:8788/app..."
      Start-AurumServices $targetRoot $launchMode

      Write-UpdateLog "[7/7] Verifying live http://127.0.0.1:8788/build.json matches Build ID $newBuildId..."
      $liveId = ''
      $liveGit = ''
      $deadline = (Get-Date).AddSeconds(60)
      while ((Get-Date) -lt $deadline) {
        try {
          $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/build.json' -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 3
          if ($resp.StatusCode -eq 200 -and $resp.Content) {
            $b = $resp.Content | ConvertFrom-Json
            if ($b -and $b.id) {
              $liveId = [string]$b.id
              $liveGit = if ($b.git) { [string]$b.git } else { '' }
              if ($liveId -eq $newBuildId) { break }
            }
          }
        } catch {}
        Start-Sleep -Seconds 1
      }

      if ($liveId -ne $newBuildId) {
        throw "Live verification failed: http://127.0.0.1:8788/build.json reported '$liveId' instead of '$newBuildId'."
      }

      $apiStatus = if ($launchMode -eq 'bridge') {
        if (Test-AurumApiHealth) { 'HTTP 200 (ok)' } else { 'starting' }
      } else {
        'not applicable (Wrangler dashboard mode)'
      }

      Write-UpdateLog ""
      Write-UpdateLog "============================================================"
      Write-UpdateLog " [OK] http://127.0.0.1:8788/app IS NOW UP TO DATE"
      Write-UpdateLog " Folder updated:    $targetRoot"
      Write-UpdateLog " Previous Build ID: $oldBuildId"
      Write-UpdateLog " Live Build ID:     $liveId (git: $liveGit)"
      Write-UpdateLog " Local API (4100):  $apiStatus"
      Write-UpdateLog " Backup saved at:   $backupDir"
      Write-UpdateLog " Update log:        $logFile"
      Write-UpdateLog " Preserved intact:  bridge_token.txt, terminal_path.txt, server\data, MT5"
      Write-UpdateLog "============================================================"
    } else {
      Write-UpdateLog "[6/7] Skipped service restart (--no-restart)."
      Write-UpdateLog "[7/7] Verified on-disk Build ID $newBuildId (backup at $backupDir)."
    }
  } catch {
    $errMsg = $_.Exception.Message
    Write-UpdateLog "[ERROR] Update failed: $errMsg"
    Write-UpdateLog "[ROLLBACK] Automatically restoring previous version ($oldBuildId) from $backupDir..."
    $restoredId = Restore-AurumBackup $targetRoot $backupDir
    foreach ($kv in $preservedBefore.GetEnumerator()) {
      $pFull = Join-Path $targetRoot ($kv.Key -replace '/', '\')
      if ((Get-FileSha256 $pFull) -ne $kv.Value) {
        throw "Rollback safety check failed on preserved file $($kv.Key)"
      }
    }
    if (-not $skipRestart) {
      Write-UpdateLog "[ROLLBACK] Restarting restored local service ($restoredId)..."
      try { Start-AurumServices $targetRoot $launchMode } catch {}
    }
    Write-UpdateLog "[ROLLBACK COMPLETE] Restored previous Build ID: $restoredId. Preserved files verified intact."
    throw "Update failed and was automatically rolled back to $restoredId ($errMsg)"
  }
} finally {
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

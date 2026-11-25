@echo off
setlocal
title Fredrick TRADING - One-Click Update for http://127.0.0.1:8788/app
set "AURUM_UPDATER_BAT=%~f0"
set "AURUM_UPDATER_DIR=%~dp0"
set "AURUM_UPDATER_ARGS=%*"

echo ============================================================
echo  Fredrick TRADING - One-Click Local App Updater
echo  Target URL: http://127.0.0.1:8788/app
echo  Downloads latest verified release from GitHub (main),
echo  backs up current files, preserves local tokens/MT5/data,
echo  restarts API + bridge, verifies the live Build ID on port 8788,
echo  and restores the previous version automatically on failure.
echo  Usage: UPDATE_LOCAL_APP.bat [--dry-run] [--no-restart] [--target "C:\path"]
echo ============================================================
echo.

(
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$raw=[System.IO.File]::ReadAllText($env:AURUM_UPDATER_BAT,[System.Text.Encoding]::UTF8); $m='#'+' === AURUM_PS_UPDATER_PAYLOAD ==='; $i=$raw.IndexOf($m); if($i -lt 0){Write-Error 'Updater payload missing'; exit 1}; & ([ScriptBlock]::Create($raw.Substring($i)))"
  if errorlevel 1 (
    echo.
    echo [X] Update stopped with an error. Running MT5 and local tokens/data were NOT modified.
    if /I not "%~1"=="--no-pause" pause
    exit /b 1
  ) else (
    echo.
    if /I not "%~1"=="--no-pause" pause
    exit /b 0
  )
)

# === AURUM_PS_UPDATER_PAYLOAD ===
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$rawArgs = if ($env:AURUM_UPDATER_ARGS) { $env:AURUM_UPDATER_ARGS.Trim() } else { '' }
$explicitTarget = ''
if ($rawArgs -match '--target\s+"([^"]+)"') {
  $explicitTarget = $Matches[1]
} elseif ($rawArgs -match '--target\s+(\S+)') {
  $explicitTarget = $Matches[1]
}
$skipRestart = $rawArgs -match '(^|\s)--no-restart(\s|$)'
$dryRun = $rawArgs -match '(^|\s)--dry-run(\s|$)'

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
  'node_modules/'
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

  # 2. Check the folder containing UPDATE_LOCAL_APP.bat itself
  $selfDir = Normalize-Dir $env:AURUM_UPDATER_DIR
  if (Test-AurumRoot $selfDir) { return $selfDir }

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

function Restart-AndVerifyServices([string]$root, [string]$mode, [string]$expectedId) {
  Write-Host "[5/6] Restarting local services for http://127.0.0.1:8788/app..."
  $hasStartAll = Test-Path -LiteralPath (Join-Path $root 'START_ALL_LOCAL.bat') -PathType Leaf
  $hasCmdCentre = Test-Path -LiteralPath (Join-Path $root 'START_LOCAL_MARKET_COMMAND_CENTRE.bat') -PathType Leaf
  $tokenPath = Join-Path $root 'bridge\bridge_token.txt'
  $pyRuntimePath = Join-Path $root 'bridge\python_runtime.txt'
  $autoStartBat = Join-Path $root 'bridge\AUTO_START.bat'

  if ($mode -eq 'wrangler' -or (-not $hasStartAll -and $hasCmdCentre)) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $root 'START_LOCAL_MARKET_COMMAND_CENTRE.bat') + '"') -WorkingDirectory $root
  } else {
    $canAutoStart = $false
    if ((Test-Path -LiteralPath $tokenPath -PathType Leaf) -and (Test-Path -LiteralPath $pyRuntimePath -PathType Leaf) -and (Test-Path -LiteralPath $autoStartBat -PathType Leaf)) {
      $savedPy = (Get-Content -LiteralPath $pyRuntimePath -TotalCount 1 -ErrorAction SilentlyContinue)
      if ($savedPy -and (Test-Path -LiteralPath $savedPy.Trim() -PathType Leaf)) {
        $canAutoStart = $true
      }
    }
    if ($canAutoStart) {
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $autoStartBat + '"') -WorkingDirectory (Join-Path $root 'bridge') -Wait -PassThru -WindowStyle Hidden
      if ($p.ExitCode -ne 0) {
        Write-Host "      Background auto-start returned $($p.ExitCode); running full START_ALL_LOCAL.bat..."
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $root 'START_ALL_LOCAL.bat') + '"') -WorkingDirectory $root
      }
    } else {
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + (Join-Path $root 'START_ALL_LOCAL.bat') + '"') -WorkingDirectory $root
    }
  }

  Write-Host "[6/6] Verifying live http://127.0.0.1:8788/build.json matches Build ID $expectedId..."
  $liveId = ''
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/build.json' -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 3
      if ($resp.StatusCode -eq 200 -and $resp.Content) {
        $b = $resp.Content | ConvertFrom-Json
        if ($b -and $b.id) {
          $liveId = [string]$b.id
          if ($liveId -eq $expectedId) { break }
        }
      }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $liveId
}


$targetRoot = Find-TargetAurumRoot
$oldBuildJsonPath = Join-Path $targetRoot 'bridge\pwa\build.json'
$oldBuildId = 'none (pre-repair package)'
if (Test-Path -LiteralPath $oldBuildJsonPath -PathType Leaf) {
  try {
    $parsedOld = Get-Content -LiteralPath $oldBuildJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($parsedOld -and $parsedOld.id) { $oldBuildId = [string]$parsedOld.id }
  } catch {}
}

Write-Host "[1/6] Located local package folder:"
Write-Host "      $targetRoot"
Write-Host "      Current installed Build ID: $oldBuildId"

$transcriptOn = $false
try {
  $logDir = Join-Path $targetRoot 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logFile = Join-Path $logDir ('aurum-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
  Start-Transcript -Path $logFile -Force | Out-Null
  $transcriptOn = $true
  Write-Host "Update log: $logFile"
} catch {}


$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aurum-local-update-' + [guid]::NewGuid().ToString('N').Substring(0, 10))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  $zipFile = Join-Path $tempDir 'aurum-main.zip'
  $extractDir = Join-Path $tempDir 'extracted'
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

  Write-Host "[2/6] Downloading latest release from GitHub (main)..."
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
  Write-Host ("      Downloaded archive SHA-256: " + (Get-FileSha256 $zipFile))

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
  if ([string]::IsNullOrWhiteSpace($newBuildId)) {
    throw "Downloaded bridge\pwa\build.json has no valid Build ID."
  }
  $newAppHtml = [System.IO.File]::ReadAllText((Join-Path $srcRoot 'bridge\app.html'), [System.Text.Encoding]::UTF8)
  $newSwJs = [System.IO.File]::ReadAllText((Join-Path $srcRoot 'bridge\pwa\sw.js'), [System.Text.Encoding]::UTF8)
  if ($newAppHtml -notmatch [regex]::Escape($newBuildId) -or $newSwJs -notmatch [regex]::Escape($newBuildId)) {
    throw "Release consistency check failed: bridge\app.html and bridge\pwa\sw.js do not match Build ID $newBuildId."
  }
  Write-Host "      Verified incoming release Build ID: $newBuildId"
  try {
    $newPkg = Get-Content -LiteralPath (Join-Path $srcRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($newPkg -and $newPkg.version -and $newBuildObj.version -and ([string]$newPkg.version -ne [string]$newBuildObj.version)) {
      throw "Downloaded release failed verification: package.json version $($newPkg.version) does not match build.json version $($newBuildObj.version)."
    }
  } catch {
    if ($_.Exception.Message -match 'failed verification') { throw }
  }


  # Snapshot hashes of local-only files so we prove nothing secret/local was touched
  $preservedBefore = @{}
  foreach ($rel in $preservedRelPaths) {
    $pFull = Join-Path $targetRoot ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $pFull -PathType Leaf) {
      $preservedBefore[$rel] = Get-FileSha256 $pFull
    }
  }

  # Build the copy plan first (the same approved file lists as before) so a
  # timestamped backup exists BEFORE anything is overwritten, and so a dry
  # run can report exactly what would change without touching the install.
  $selfFull = if ($env:AURUM_UPDATER_BAT) { [System.IO.Path]::GetFullPath($env:AURUM_UPDATER_BAT) } else { '' }
  $copyPlan = New-Object System.Collections.Generic.List[object]
  foreach ($rootFile in $packageRootFiles) {
    $srcPath = Join-Path $srcRoot $rootFile
    if (Test-Path -LiteralPath $srcPath -PathType Leaf) {
      $dstPath = Join-Path $targetRoot $rootFile
      if ($selfFull -and ([System.IO.Path]::GetFullPath($dstPath) -ieq $selfFull) -and ((Get-FileSha256 $srcPath) -eq (Get-FileSha256 $dstPath))) {
        continue
      }
      $copyPlan.Add([PSCustomObject]@{ Src = $srcPath; Dst = $dstPath; Rel = $rootFile })
    }
  }
  foreach ($tree in $packageTrees) {
    $srcTree = Join-Path $srcRoot $tree
    if (-not (Test-Path -LiteralPath $srcTree -PathType Container)) { continue }
    $files = Get-ChildItem -LiteralPath $srcTree -Recurse -File
    foreach ($f in $files) {
      if ($f.Extension -eq '.pyc' -or $f.Name -eq '.DS_Store' -or $f.FullName -match '[\\/]__pycache__[\\/]') { continue }
      $rel = $f.FullName.Substring($srcRoot.Length).TrimStart('\', '/') -replace '\\', '/'
      if ($preservedRelPaths -contains $rel) { continue }
      $skipDir = $false
      foreach ($pref in $preservedDirPrefixes) {
        if ($rel.StartsWith($pref, [System.StringComparison]::OrdinalIgnoreCase)) { $skipDir = $true; break }
      }
      if ($skipDir) { continue }
      $dstFile = Join-Path $targetRoot ($rel -replace '/', '\')
      $copyPlan.Add([PSCustomObject]@{ Src = $f.FullName; Dst = $dstFile; Rel = $rel })
    }
  }

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backupDir = Join-Path $targetRoot ('backups\aurum-backup-' + $stamp)
  $createdRels = New-Object System.Collections.Generic.List[string]
  $servicesStopped = $false

  if ($dryRun) {
    Write-Host "[DRY RUN] No files will be changed and no service will be stopped."
    Write-Host "      Target folder:    $targetRoot"
    Write-Host "      Current Build ID: $oldBuildId"
    Write-Host "      Incoming Build ID: $newBuildId"
    Write-Host "      Files that would be copied: $($copyPlan.Count)"
    Write-Host "      Backup that would be created: $backupDir"
    Write-Host "      Preserved untouched: bridge_token.txt, terminal_path.txt, python_runtime.txt, server\data, logs, node_modules, .env"
    Write-Host "      Services that would restart: local API (4100) and bridge (8788). MT5 is never stopped."
    Write-Host "[DRY RUN] Done. Run UPDATE_LOCAL_APP.bat without --dry-run to apply."
    return
  }

  $launchMode = 'bridge'
  try {
    if (-not $skipRestart) {
      Write-Host "[3/6] Stopping old local AURUM server/bridge processes (MT5 is NEVER stopped)..."
      foreach ($port in @(8788, 8787)) {
        foreach ($procId in (Get-ListeningPids $port)) {
          $info = Get-ProcInfo $procId
          if (-not $info) { continue }
          if ($info.Name -match '^(?i)terminal(64)?(\.exe)?$') { continue }
          if ($info.CommandLine -match 'mt5_bridge\.py' -or $info.WindowTitle -match 'Exness MT5 Bridge') {
            $launchMode = 'bridge'
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
          } elseif ($info.CommandLine -match 'wrangler' -or $info.Name -match '^(?i)workerd') {
            $launchMode = 'wrangler'
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
          } else {
            throw "Port $port is occupied by non-AURUM process PID $procId ($($info.Name)). Close it manually before updating."
          }
        }
      }

      $port4100IsAurum = Test-AurumApiHealth
      foreach ($procId in (Get-ListeningPids 4100)) {
        $info = Get-ProcInfo $procId
        if (-not $info) { continue }
        if ($info.Name -match '^(?i)terminal(64)?(\.exe)?$') { continue }
        $isAurumNode = ($info.CommandLine -match 'server[\\/]server\.js') -or
                       ($info.WindowTitle -match 'Fredrick AURUM Local API') -or
                       ($port4100IsAurum -and $info.Name -match '^(?i)node(\.exe)?$')
        if ($isAurumNode) {
          $parentId = $info.ParentPid
          Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
          if ($parentId -gt 0) {
            $pInfo = Get-ProcInfo $parentId
            if ($pInfo -and ($pInfo.CommandLine -match 'RUN_LOCAL_API\.bat' -or $pInfo.WindowTitle -match 'Fredrick AURUM Local API')) {
              Stop-Process -Id $parentId -Force -ErrorAction SilentlyContinue
            }
          }
        }
      }

      $waitUntil = (Get-Date).AddSeconds(10)
      while ((Get-Date) -lt $waitUntil) {
        if ((Get-ListeningPids 8788).Count -eq 0 -and (Get-ListeningPids 4100).Count -eq 0) { break }
        Start-Sleep -Milliseconds 300
      }
      $servicesStopped = $true
    } else {
      Write-Host "[3/6] Skipping service stop (--no-restart)."
    }

    Write-Host "[4/6] Backing up current files, then updating application, bridge, PWA, and local API files..."
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    $backedUpCount = 0
    foreach ($entry in $copyPlan) {
      if (Test-Path -LiteralPath $entry.Dst -PathType Leaf) {
        $backupFile = Join-Path $backupDir ($entry.Rel -replace '/', '\')
        $backupParent = Split-Path -Parent $backupFile
        if (-not (Test-Path -LiteralPath $backupParent -PathType Container)) {
          New-Item -ItemType Directory -Force -Path $backupParent | Out-Null
        }
        [System.IO.File]::Copy($entry.Dst, $backupFile, $true)
        $backedUpCount++
      } else {
        $createdRels.Add($entry.Rel)
      }
    }
    $manifestLines = @(
      'AURUM local update backup',
      ('Created: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
      ('Target: ' + $targetRoot),
      ('Previous Build ID: ' + $oldBuildId),
      ('Incoming Build ID: ' + $newBuildId),
      ('Files backed up: ' + $backedUpCount),
      ('Files newly created by the update: ' + $createdRels.Count)
    )
    [System.IO.File]::WriteAllLines((Join-Path $backupDir 'manifest.txt'), $manifestLines)
    Write-Host "      Backup written to $backupDir ($backedUpCount files)"

    $copiedCount = 0
    foreach ($entry in $copyPlan) {
      $dstParent = Split-Path -Parent $entry.Dst
      if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
      }
      [System.IO.File]::Copy($entry.Src, $entry.Dst, $true)
      $copiedCount++
    }

    # Ensure UPDATE_LOCAL_APP.bat itself is always installed inside the target package folder
    $installedUpdater = Join-Path $targetRoot 'UPDATE_LOCAL_APP.bat'
    if (-not (Test-Path -LiteralPath $installedUpdater -PathType Leaf) -and $selfFull -and (Test-Path -LiteralPath $selfFull -PathType Leaf)) {
      [System.IO.File]::Copy($selfFull, $installedUpdater, $true)
    }

    # Verify local-only files were preserved byte-for-byte
    foreach ($kv in $preservedBefore.GetEnumerator()) {
      $pFull = Join-Path $targetRoot ($kv.Key -replace '/', '\')
      $afterHash = Get-FileSha256 $pFull
      if ($afterHash -ne $kv.Value) {
        throw "Safety check failed: local file $($kv.Key) changed unexpectedly."
      }
    }

    # Create Desktop one-click updater shortcut for future releases
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

    Write-Host "      Synchronized $copiedCount canonical files into $targetRoot"

    if (-not $skipRestart) {
      $liveId = Restart-AndVerifyServices $targetRoot $launchMode $newBuildId
      if ($liveId -ne $newBuildId) {
        throw "Port 8788 did not report Build ID $newBuildId within 60 seconds (got: '$liveId'). Check the bridge/API console window."
      }

      $apiStatus = 'not checked (Wrangler dashboard mode)'
      if ($launchMode -eq 'bridge') {
        $apiStatus = if (Test-AurumApiHealth) { 'HTTP 200 (ok)' } else { 'starting' }
      }

      Write-Host ""
      Write-Host "============================================================"
      Write-Host " [OK] http://127.0.0.1:8788/app IS NOW UP TO DATE"
      Write-Host " Folder updated:    $targetRoot"
      Write-Host " Previous Build ID: $oldBuildId"
      Write-Host " Live Build ID:     $liveId (matches GitHub main & staging)"
      Write-Host " Backup:            $backupDir"
      Write-Host " Local API (4100):  $apiStatus"
      Write-Host " Preserved intact:  bridge_token.txt, terminal_path.txt, server\data, MT5"
      Write-Host " Desktop shortcut:  Fredrick TRADING - Update Local App"
      Write-Host "============================================================"
    } else {
      Write-Host "[5/6] Skipped service restart (--no-restart)."
      Write-Host "[6/6] Offline file update verified: $targetRoot is at Build ID $newBuildId."
    }
  } catch {
    $updateError = $_
    Write-Host "[X] Update failed: $($updateError.Exception.Message)"
    if (Test-Path -LiteralPath $backupDir -PathType Container) {
      Write-Host "[ROLLBACK] Restoring previous files from $backupDir..."
      try {
        foreach ($entry in $copyPlan) {
          $backupFile = Join-Path $backupDir ($entry.Rel -replace '/', '\')
          if (Test-Path -LiteralPath $backupFile -PathType Leaf) {
            $dstParent = Split-Path -Parent $entry.Dst
            if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
              New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
            }
            [System.IO.File]::Copy($backupFile, $entry.Dst, $true)
          } elseif ($createdRels.Contains($entry.Rel)) {
            if (Test-Path -LiteralPath $entry.Dst -PathType Leaf) {
              Remove-Item -LiteralPath $entry.Dst -Force -ErrorAction SilentlyContinue
            }
          }
        }
        Write-Host "[ROLLBACK] Previous files restored."
        if (-not $skipRestart) {
          $restoredId = $oldBuildId
          try {
            $rb = Get-Content -LiteralPath (Join-Path $targetRoot 'bridge\pwa\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($rb -and $rb.id) { $restoredId = [string]$rb.id }
          } catch {}
          Write-Host "[ROLLBACK] Restarting previous version and verifying Build ID $restoredId..."
          try {
            $rolledId = Restart-AndVerifyServices $targetRoot $launchMode $restoredId
            if ($rolledId -eq $restoredId) {
              Write-Host "[ROLLBACK] Previous version is live again (Build ID $rolledId)."
            } else {
              Write-Host "[ROLLBACK] Files restored, but the previous version did not confirm live within 60 seconds (got: '$rolledId'). Run START_ALL_LOCAL.bat manually."
            }
          } catch {
            Write-Host "[ROLLBACK] Restart attempt failed: $($_.Exception.Message). Run START_ALL_LOCAL.bat manually."
          }
        }
      } catch {
        Write-Host "[ROLLBACK] Restore failed: $($_.Exception.Message). Your backup is kept at $backupDir - restore it manually, then run START_ALL_LOCAL.bat."
      }
    } elseif ($servicesStopped -and (-not $skipRestart)) {
      Write-Host "[ROLLBACK] No files were changed, but services were stopped. Restarting the current version..."
      try {
        $currentId = $oldBuildId
        try {
          $cb = Get-Content -LiteralPath (Join-Path $targetRoot 'bridge\pwa\build.json') -Raw -Encoding UTF8 | ConvertFrom-Json
          if ($cb -and $cb.id) { $currentId = [string]$cb.id }
        } catch {}
        $backId = Restart-AndVerifyServices $targetRoot $launchMode $currentId
        if ($backId -eq $currentId) {
          Write-Host "[ROLLBACK] Current version is live again (Build ID $backId)."
        } else {
          Write-Host "[ROLLBACK] Restart did not confirm live within 60 seconds (got: '$backId'). Run START_ALL_LOCAL.bat manually."
        }
      } catch {
        Write-Host "[ROLLBACK] Restart attempt failed: $($_.Exception.Message). Run START_ALL_LOCAL.bat manually."
      }
    } else {
      Write-Host "[ROLLBACK] No backup was created and no files were changed by this run."
    }
    throw $updateError
  }

} finally {
  if ($transcriptOn) { try { Stop-Transcript | Out-Null } catch {} }
  if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

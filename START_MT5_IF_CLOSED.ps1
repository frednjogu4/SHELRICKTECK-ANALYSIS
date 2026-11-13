param([string]$PathFile = (Join-Path $PSScriptRoot 'terminal_path.txt'), [switch]$NoPrompt)
$ErrorActionPreference = 'Stop'

function Save-TerminalPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    Remove-Item -LiteralPath $PathFile -ErrorAction SilentlyContinue
    return
  }
  $parent = Split-Path -Parent $PathFile
  if ($parent -and !(Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [System.IO.File]::WriteAllText($PathFile, $Path, [System.Text.Encoding]::Default)
}

function Add-TerminalCandidate([string]$Value, [string]$Source, [int]$Priority) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  $candidate = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
  if (Test-Path -LiteralPath $candidate -PathType Container) {
    $candidate = Join-Path $candidate 'terminal64.exe'
  }
  if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { return }
  $full = [System.IO.Path]::GetFullPath($candidate)
  if (!($script:Candidates | Where-Object { $_.Path -ieq $full })) {
    $script:Candidates += [pscustomobject]@{ Path = $full; Source = $Source; Priority = $Priority }
  }
}

# Never kill or restart a terminal. If one is already open, leave it alone.
$running = @(Get-Process -Name 'terminal64', 'terminal' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host 'MT5 is already running; leaving the existing terminal untouched.' -ForegroundColor Green
  if ($running.Count -eq 1) {
    try { if ($running[0].Path) { Save-TerminalPath $running[0].Path } } catch { }
  }
  exit 0
}

$script:Candidates = @()
if ($env:AURUM_MT5_PATH) { Add-TerminalCandidate $env:AURUM_MT5_PATH 'AURUM_MT5_PATH setting' 0 }
$storedPath = Join-Path $PSScriptRoot 'terminal_path.txt'
if (Test-Path -LiteralPath $storedPath) {
  try { Add-TerminalCandidate (Get-Content -LiteralPath $storedPath -Raw) 'previously selected Exness terminal' 1 } catch { }
}

# Look up registered MetaTrader/Exness terminal installations.
$registryRoots = @(
  'Registry::HKEY_CURRENT_USER\Software\MetaQuotes\Terminal',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\MetaQuotes\Terminal',
  'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\MetaQuotes\Terminal'
)
foreach ($root in $registryRoots) {
  if (!(Test-Path -LiteralPath $root)) { continue }
  $keys = @()
  try { $keys += Get-Item -LiteralPath $root } catch { }
  try { $keys += Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue } catch { }
  foreach ($key in $keys) {
    try {
      $props = Get-ItemProperty -LiteralPath $key.PSPath
      $source = 'MetaTrader registry'
      if ($key.Name -match '(?i)exness') { $source = 'Exness registry' }
      foreach ($name in @('InstallPath', 'Path', 'TerminalPath')) {
        $property = $props.PSObject.Properties[$name]
        if ($property -and $property.Value) { Add-TerminalCandidate ([string]$property.Value) $source 2 }
      }
    } catch { }
  }
}

# Search named Start Menu shortcuts, preferring an Exness-labelled shortcut.
try {
  $shell = New-Object -ComObject WScript.Shell
  $startMenus = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
  )
  foreach ($folder in $startMenus) {
    if (!(Test-Path -LiteralPath $folder)) { continue }
    Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.BaseName -match '(?i)Exness|MetaTrader|MT5' } |
      ForEach-Object {
        try {
          $target = $shell.CreateShortcut($_.FullName).TargetPath
          $source = if ($_.BaseName -match '(?i)Exness') { 'Exness Start Menu shortcut' } else { 'MetaTrader Start Menu shortcut' }
          $priority = if ($source -like 'Exness*') { 2 } else { 3 }
          Add-TerminalCandidate $target $source $priority
        } catch { }
      }
  }
} catch { }

# Common install locations are a final fallback; no broad disk scan is done.
$programRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
foreach ($base in ($programRoots | Where-Object { $_ } | Select-Object -Unique)) {
  foreach ($folder in @('MetaTrader 5', 'MetaTrader5', 'Exness MT5', 'Exness')) {
    Add-TerminalCandidate (Join-Path (Join-Path $base $folder) 'terminal64.exe') 'common installation folder' 4
  }
}

# Use an explicitly configured or previously selected path first. Otherwise
# prefer an Exness-labelled install, then a single unambiguous MT5 install.
$preferred = @($script:Candidates | Where-Object { $_.Priority -le 1 } | Sort-Object Priority)
$exness = @($script:Candidates | Where-Object { $_.Source -match '(?i)Exness' -or $_.Path -match '(?i)Exness' } | Sort-Object Priority)
$pool = if ($preferred.Count -gt 0) { $preferred } elseif ($exness.Count -gt 0) { $exness } else { @($script:Candidates | Sort-Object Priority) }
$selected = $null
if ($pool.Count -gt 0) {
  $bestPriority = ($pool | Measure-Object -Property Priority -Minimum).Minimum
  $best = @($pool | Where-Object { $_.Priority -eq $bestPriority } | Select-Object -ExpandProperty Path -Unique)
  if ($best.Count -eq 1) { $selected = $best[0] }
}

if (!$selected -and $pool.Count -gt 1 -and !$NoPrompt) {
  $choices = @($pool | Sort-Object Priority | Select-Object -ExpandProperty Path -Unique)
  Write-Host '[!] Several MT5 installations were found. Choose the Exness terminal path; nothing will be closed.' -ForegroundColor Yellow
  for ($i = 0; $i -lt $choices.Count; $i++) { Write-Host (('  {0}. {1}' -f ($i + 1), $choices[$i])) }
  try {
    $answer = Read-Host 'Enter the number to start, or press Enter to skip'
    $number = 0
    if ([int]::TryParse($answer, [ref]$number) -and $number -ge 1 -and $number -le $choices.Count) { $selected = $choices[$number - 1] }
  } catch { }
}

if (!$selected) {
  Save-TerminalPath ''
  if ($script:Candidates.Count -gt 1) {
    Write-Host '[!] MT5 selection skipped or ambiguous; not guessing or opening the wrong terminal.' -ForegroundColor Yellow
  } else {
    Write-Host '[!] Could not locate Exness MT5 automatically.' -ForegroundColor Yellow
  }
  Write-Host '    The local app and bridge will still start. To enable auto-start, set AURUM_MT5_PATH in bridge\SETUP_AND_RUN.bat to the correct terminal64.exe.' -ForegroundColor Yellow
  Write-Host '    If MT5 is installed but not found, open it manually; this launcher will not close any existing terminal.' -ForegroundColor Yellow
  exit 0
}

Write-Host ('MT5 is closed; starting: ' + $selected) -ForegroundColor Cyan
try {
  $process = Start-Process -FilePath $selected -PassThru
  Save-TerminalPath $selected
  # Give the GUI time to initialize before the bridge attaches. We do not
  # enter or store any account credentials; sign in to MT5 yourself if needed.
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
      $process.Refresh()
      if ($process.HasExited) { throw 'The MT5 process exited during startup.' }
      if ($process.MainWindowHandle -ne 0) { break }
    } catch { throw }
  }
  Write-Host 'MT5 launch requested. Existing MT5 instances are never closed or restarted.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host ('[!] MT5 could not be started: ' + $_.Exception.Message) -ForegroundColor Yellow
  Write-Host '    The local app and bridge will continue; open Exness MT5 manually if needed.' -ForegroundColor Yellow
  exit 0
}

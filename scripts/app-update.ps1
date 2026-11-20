param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [string]$WorkDir,
  [string]$Version,
  [string]$PreviousVersion,
  [string]$ExpectedHash,
  [int]$GuiPid,
  [switch]$Recover,
  [switch]$NoReopen
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$data = Join-Path $root 'data'
$updates = Join-Path $data 'updates'
$statusFile = Join-Path $data 'program-update.json'
$lock = $null
$journal = $null
$keepWork = $false
$reopen = $false
$exitCode = 0

function Write-Json($file, $value) {
  $pending = $file + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllText($pending, ($value | ConvertTo-Json -Depth 12 -Compress))
  if ([IO.File]::Exists($file)) { [IO.File]::Replace($pending, $file, [NullString]::Value) }
  else { [IO.File]::Move($pending, $file) }
}
function Read-Json($file) { [IO.File]::ReadAllText($file) | ConvertFrom-Json }
function Write-State($phase, $message = '') {
  Write-Json $statusFile @{ phase=$phase; version=$Version; pid=$PID; job=(Split-Path $WorkDir -Leaf); message=$message }
}
function Get-Hash($file) {
  $hash = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($file)
  try { [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $hash.Dispose() }
}
function Get-SafeFile($base, $relative) {
  $parts = $relative -split '[\\/]'
  if (!$relative -or ($parts | Where-Object { !$_ -or $_ -in '.', '..' -or $_ -match '[:*?"<>|\x00-\x1f]|[ .]$|^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)' })) { throw 'Invalid program file path.' }
  $target = $base
  foreach ($part in $parts) {
    $target = Join-Path $target $part
    $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
    if ($existing -and ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Program file path contains a link.' }
  }
  return $target
}
function Test-ProgramPath($relative) {
  $part = ($relative -split '[\\/]')[0]
  if ($part -in @('dist','ui','native','runtime','scripts','licenses')) { return $true }
  return $relative -eq $part -and ($part -match '\.(md|html|vbs|cmd)$' -or $part -in @('release-manifest.json','config.example.json','toolchain.lock.json'))
}
function Replace-ProgramFile($origin, $destination) {
  $parent = Split-Path -Parent $destination
  [IO.Directory]::CreateDirectory($parent) | Out-Null
  $temporary = Join-Path $parent ('.anibt-update-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [IO.File]::Copy($origin, $temporary)
    if ([IO.File]::Exists($destination)) { [IO.File]::Replace($temporary, $destination, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $destination) }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}
function Restore-Program($journal) {
  foreach ($file in $journal.files) {
    if (!(Test-ProgramPath $file.path)) { throw 'Invalid recovery journal.' }
    $dest = Get-SafeFile $root $file.path
    if ($file.hadFile) {
      $old = Get-SafeFile (Join-Path $WorkDir 'backup') $file.path
      if (![IO.File]::Exists($dest) -or (Get-Hash $dest) -ne (Get-Hash $old)) { Replace-ProgramFile $old $dest }
    } elseif ([IO.File]::Exists($dest) -and (Get-Hash $dest) -eq $file.sha256) { [IO.File]::Delete($dest) }
  }
}
function Start-WatchIfNeeded($journal) {
  if ($journal -and $journal.background) { & (Join-Path $root 'scripts\background.ps1') start | Out-Null }
}

try {
  if (!(Test-Path -LiteralPath (Join-Path $root 'release-manifest.json') -PathType Leaf)) { throw 'Official portable installation required.' }
  $null = Get-SafeFile $root 'data/updates'
  if ($Recover) {
    $last = Read-Json $statusFile
    if ($last.phase -ne 'applying' -or $last.job -notmatch '^job-[a-zA-Z0-9]{6}$') { throw 'No interrupted update was found.' }
    $WorkDir = Join-Path $updates $last.job
    $Version = $last.version
  }
  $WorkDir = [IO.Path]::GetFullPath($WorkDir)
  if ((Split-Path $WorkDir -Parent) -ne $updates -or (Split-Path $WorkDir -Leaf) -notmatch '^job-[a-zA-Z0-9]{6}$') { throw 'Invalid update staging directory.' }
  $null = Get-SafeFile $root ('data/updates/' + (Split-Path $WorkDir -Leaf))
  $lock = [IO.File]::Open((Join-Path $updates 'install.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  $journalFile = Join-Path $WorkDir 'changes.json'
  if ($Recover) {
    $keepWork = $true
    $journal = Read-Json $journalFile
    Restore-Program $journal
    Start-WatchIfNeeded $journal
    Write-State 'failed' 'Previous update was interrupted. The original program was restored.'
    $keepWork = $false
  } else {
    if ($Version -notmatch '^\d{1,8}\.\d{1,8}\.\d{1,8}$' -or $PreviousVersion -notmatch '^\d{1,8}\.\d{1,8}\.\d{1,8}$' -or [version]$Version -le [version]$PreviousVersion -or $ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid update version or checksum.' }
    Write-State 'waiting'
    if ($GuiPid -gt 0) {
      $gui = Get-Process -Id $GuiPid -ErrorAction SilentlyContinue
      if ($gui -and !$gui.WaitForExit(900000)) { throw 'Close all AniBT windows before installing the update.' }
    }
    $oldManifest = Read-Json (Join-Path $root 'release-manifest.json')
    if ($oldManifest.version -ne $PreviousVersion -or $oldManifest.platform -ne 'win32-x64') { throw 'The installed version changed during the update.' }
    $archive = Join-Path $WorkDir 'update.zip'
    if ((Get-Hash $archive) -ne $ExpectedHash) { throw 'The update archive checksum does not match.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extracted = Join-Path $WorkDir 'unpacked'
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
      $seen = @{}
      $total = 0L
      foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\','/').TrimEnd('/')
        $null = Get-SafeFile $extracted $name
        if ($name -ne 'AniBT-qB' -and !$name.StartsWith('AniBT-qB/', [StringComparison]::Ordinal)) { throw 'Unexpected package layout.' }
        if ($seen.ContainsKey($name) -or (($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000)) { throw 'Duplicate path or link in the archive.' }
        $seen[$name] = $true
        $total += $entry.Length
        if ($total -gt 335544320 -or $seen.Count -gt 2000) { throw 'The extracted package exceeds the limit.' }
      }
      [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)
    } finally { $zip.Dispose() }
    $source = Join-Path $extracted 'AniBT-qB'
    $newManifestPath = Join-Path $source 'release-manifest.json'
    $newManifest = Read-Json $newManifestPath
    if ($newManifest.version -ne $Version -or $newManifest.platform -ne 'win32-x64') { throw 'The update package does not match the requested version.' }
    $listed = @{}
    $plan = @(foreach ($file in @($newManifest.files) + @(@{path='release-manifest.json';sha256=(Get-Hash $newManifestPath)})) {
      if ($listed.ContainsKey($file.path) -or !(Test-ProgramPath $file.path) -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid program file manifest.' }
      $listed[$file.path] = $true
      $from = Get-SafeFile $source $file.path
      $to = Get-SafeFile $root $file.path
      if ((Get-Hash $from) -ne $file.sha256) { throw 'A program file failed verification.' }
      $hadFile = [IO.File]::Exists($to)
      if ($hadFile -and (Get-Hash $to) -eq $file.sha256) { continue }
      if ($hadFile) {
        $old = Get-SafeFile (Join-Path $WorkDir 'backup') $file.path
        [IO.Directory]::CreateDirectory((Split-Path -Parent $old)) | Out-Null
        [IO.File]::Copy($to, $old)
      }
      @{ path=$file.path; sha256=$file.sha256; hadFile=$hadFile }
    })
    foreach ($required in @('dist/gui.mjs','ui/index.html','native/AniBT.exe','runtime/node.exe')) {
      if (!$listed.ContainsKey($required)) { throw 'A required program file is missing.' }
    }
    $background = Join-Path $root 'scripts\background.ps1'
    $watching = [bool](((& $background status) -join "`n") -match '(?m)^(?:Watcher running|Health supervisor running): True$')
    $planState = @{files=$plan; background=$watching}
    Write-Json $journalFile $planState
    Write-State 'applying'
    $journal = $planState
    if ($watching) { & $background stop | Out-Null }
    foreach ($file in $plan) { Replace-ProgramFile (Get-SafeFile $source $file.path) (Get-SafeFile $root $file.path) }
    Start-WatchIfNeeded $journal
    Write-State 'complete'
    $reopen = !$NoReopen
  }
} catch {
  $exitCode = 1
  $message = $_.Exception.Message
  if ($journal -and !$Recover) {
    try {
      Restore-Program $journal
      Start-WatchIfNeeded $journal
    } catch { $keepWork = $true }
  }
  if ($lock -and !$keepWork) { Write-State 'failed' $message }
  [Console]::Error.WriteLine($message)
} finally {
  if ($lock) {
    if (!$keepWork -and (Split-Path $WorkDir -Parent) -eq $updates -and (Split-Path $WorkDir -Leaf) -match '^job-[a-zA-Z0-9]{6}$' -and [IO.Directory]::Exists($WorkDir)) {
      Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $lock.Dispose()
  }
}
if ($reopen) {
  Start-Process -FilePath (Join-Path $root 'runtime\node.exe') -ArgumentList @('"' + (Join-Path $root 'dist\gui.mjs') + '"', '--desktop') -WorkingDirectory $root -WindowStyle Hidden
}
exit $exitCode

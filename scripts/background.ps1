param([ValidateSet('start','stop','status','install','uninstall')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $taskRoot 'dist\anibt-qb.mjs'
$config = Join-Path $taskRoot 'config.json'
$dataDir = Join-Path $taskRoot 'data'
$pidFile = Join-Path $dataDir 'background.json'
$supervisorEntry = Join-Path $taskRoot 'dist\supervisor.mjs'
$supervisorFile = Join-Path $dataDir 'supervisor.json'
$controlFile = Join-Path $dataDir 'watch-control.json'
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'AniBT-qB.lnk'
function Get-ManagedProcess($metadataFile, $expectedEntry) {
    if (!(Test-Path -LiteralPath $metadataFile)) { return $null }
    $meta = Get-Content -Raw -LiteralPath $metadataFile | ConvertFrom-Json
    $managed = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$meta.pid)" -ErrorAction SilentlyContinue
    if ($managed -and $managed.CommandLine -and
        $managed.CommandLine.IndexOf($expectedEntry, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $managed.CommandLine.IndexOf($config, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $managed }
    return $null
}
function Set-WatchControl([bool]$enabled) {
    $temporary = Join-Path $dataDir ('watch-control-' + [guid]::NewGuid().ToString('N') + '.tmp')
    @{enabled=$enabled;runId=[guid]::NewGuid().ToString('N')} | ConvertTo-Json | Set-Content -LiteralPath $temporary -Encoding UTF8
    if (Test-Path -LiteralPath $controlFile) {
        [IO.File]::Replace($temporary, $controlFile, [NullString]::Value)
    } else { [IO.File]::Move($temporary, $controlFile) }
}
function Stop-ManagedWatch {
    Set-WatchControl $false
    $guardian = Get-ManagedProcess $supervisorFile $supervisorEntry
    if ($guardian) {
        # Give the guardian time to observe the pause and stop its own child.
        for ($attempt=0; $attempt -lt 40; $attempt++) {
            if (!(Get-Process -Id $guardian.ProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $guardian.ProcessId -ErrorAction SilentlyContinue) {
            $verified = Get-ManagedProcess $supervisorFile $supervisorEntry
            if ($verified) { Stop-Process -Id $verified.ProcessId -ErrorAction SilentlyContinue }
        }
    }
    $worker = Get-ManagedProcess $pidFile $entry
    if ($worker) { Stop-Process -Id $worker.ProcessId -ErrorAction SilentlyContinue }
}
function Find-AniNode {
    $localNode = Join-Path $taskRoot 'runtime\node.exe'
    if (Test-Path -LiteralPath $localNode) { return $localNode }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { return $nodeCommand.Source }
    $codexNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $codexNode) { return $codexNode }
    throw 'Node.js 22+ is required.'
}
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$operationFile = Join-Path $dataDir 'background-operation.lock'
$operationHandle = $null
for ($attempt=0; $attempt -lt 100; $attempt++) {
    try { $operationHandle = [IO.File]::Open($operationFile, 'OpenOrCreate', 'ReadWrite', 'None'); break }
    catch [IO.IOException] { Start-Sleep -Milliseconds 100 }
}
if (!$operationHandle) { throw 'Another background operation is still running.' }
try {
switch ($Action) {
    'start' {
        if (!(Test-Path -LiteralPath $config)) { throw 'Run anibt-qb init first.' }
        if (!(Test-Path -LiteralPath $supervisorEntry)) { throw 'Supervisor component is missing. Extract the complete package.' }
        $guardian = Get-ManagedProcess $supervisorFile $supervisorEntry
        $control = $null
        if (Test-Path -LiteralPath $controlFile) { $control = Get-Content -Raw -LiteralPath $controlFile | ConvertFrom-Json }
        if ($guardian -and $control.enabled) { Write-Output 'Already running with health supervision.'; break }
        Stop-ManagedWatch
        Set-WatchControl $true
        $nodeExe = Find-AniNode
        $started = Start-Process -FilePath $nodeExe -ArgumentList @("`"$supervisorEntry`"", '--config', "`"$config`"") -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 2
        $started.Refresh()
        if ($started.HasExited) { throw 'Supervisor did not start. Check the local configuration.' }
        Write-Output 'Started with background health supervision.'
    }
    'status' {
        $worker = Get-ManagedProcess $pidFile $entry
        $guardian = Get-ManagedProcess $supervisorFile $supervisorEntry
        Write-Output "Watcher running: $([bool]$worker)"
        Write-Output "Health supervisor running: $([bool]$guardian)"
        Write-Output "Login auto-start: $(Test-Path -LiteralPath $shortcutPath)"
    }
    'stop' {
        Stop-ManagedWatch
        Write-Output 'Paused. Health supervisor will not restart the watcher.'
    }
    'install' {
        $shell = New-Object -ComObject WScript.Shell
        if (Test-Path -LiteralPath $shortcutPath) {
            $old = $shell.CreateShortcut($shortcutPath)
            if (!$old.Arguments.Contains($PSCommandPath)) { throw 'Another AniBT-qB startup entry already exists.' }
        }
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = (Get-Command powershell.exe).Source
        $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" start"
        $shortcut.WorkingDirectory = $taskRoot
        $shortcut.WindowStyle = 7
        $shortcut.Description = 'AniBT subscriptions to qBittorrent'
        $shortcut.Save()
        Write-Output 'Installed login auto-start. Run start to begin now.'
    }
    'uninstall' {
        if (Test-Path -LiteralPath $shortcutPath) {
            $shell = New-Object -ComObject WScript.Shell
            if (!$shell.CreateShortcut($shortcutPath).Arguments.Contains($PSCommandPath)) { throw 'Startup entry belongs to another folder.' }
            Remove-Item -LiteralPath $shortcutPath
        }
        Write-Output 'Login auto-start removed. Use stop to stop the current watcher.'
    }
}

} finally { $operationHandle.Dispose() }

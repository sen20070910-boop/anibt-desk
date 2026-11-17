param([switch]$ReplaceExisting)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $taskRoot '打开图形界面.vbs'
if (!(Test-Path -LiteralPath $launcher)) { throw 'GUI launcher not found.' }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutFile = Join-Path $desktop 'AniBT 自动追番.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutFile) {
    $old = $shell.CreateShortcut($shortcutFile)
    if (!$old.Arguments.Contains($launcher) -and !$ReplaceExisting) { throw 'A shortcut from another folder already uses this name.' }
}
$shortcut = $shell.CreateShortcut($shortcutFile)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shortcut.Arguments = "`"$launcher`""
$shortcut.WorkingDirectory = $taskRoot
$shortcut.IconLocation = Join-Path $taskRoot 'ui\anibt.ico'
$shortcut.Description = 'AniBT subscriptions and automatic downloads'
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Output $shortcutFile

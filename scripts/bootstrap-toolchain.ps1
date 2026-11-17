param([string]$CacheRoot='', [ValidateSet('All','Node','WebView2')][string]$Component='All')
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$cache=if($CacheRoot){[IO.Path]::GetFullPath($CacheRoot)}else{Join-Path $taskRoot '.tools'}
if(!$cache.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Tool cache must stay inside the workspace.'}
if((Test-Path -LiteralPath $cache) -and ((Get-Item -LiteralPath $cache).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Tool cache cannot be a link.'}
$lock=Get-Content -LiteralPath (Join-Path $taskRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
if(![Environment]::Is64BitOperatingSystem){throw 'The native build requires Windows x64.'}
function Hash([string]$File){(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()}
function Archive($Spec,[string]$Name){
  $folder=Join-Path $cache 'downloads';New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $file=Join-Path $folder $Name
  if(!(Test-Path -LiteralPath $file)){
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri $Spec.url -OutFile $file
  }
  if((Hash $file) -ne $Spec.sha256){throw "Pinned archive checksum mismatch: $Name"}
  return $file
}
if($Component -in @('All','Node')){
  $destination=Join-Path $cache ('node\'+$lock.node.version)
  $node=Join-Path $destination ('node-v'+$lock.node.version+'-win-x64\node.exe')
  if(!(Test-Path -LiteralPath $node)){
    $archive=Archive $lock.node ('node-'+$lock.node.version+'.zip')
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
  }
  if((Hash $node) -ne $lock.node.executableSha256){throw 'Pinned Node executable checksum mismatch.'}
  if((& $node -p "process.platform+'-'+process.arch+'@'+process.versions.node") -ne ('win32-x64@'+$lock.node.version)){throw 'Pinned runtime platform/version mismatch.'}
  Write-Output ('Node: '+$node)
}
if($Component -in @('All','WebView2')){
  $destination=Join-Path $cache ('webview2\'+$lock.webview2.version)
  if(!(Test-Path -LiteralPath (Join-Path $destination 'Microsoft.Web.WebView2.nuspec'))){
    $archive=Archive $lock.webview2 ('webview2-'+$lock.webview2.version+'.zip')
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
  }
  foreach($entry in $lock.webview2.files.PSObject.Properties){if((Hash (Join-Path $destination $entry.Name)) -ne $entry.Value){throw ('SDK file checksum mismatch: '+$entry.Name)}}
  Write-Output ('WebView2 SDK: '+$destination)
}

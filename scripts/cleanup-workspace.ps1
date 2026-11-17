param([switch]$Execute,[ValidateRange(2,10)][int]$KeepVersions=3,[string[]]$PinnedVersions=@('2.21.0'))
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$releaseRoot=Join-Path $taskRoot 'release'
$build=Get-Content -LiteralPath (Join-Path $releaseRoot 'latest-build.json') -Raw | ConvertFrom-Json
$keepStage=[IO.Path]::GetFullPath((Split-Path -Parent $build.staging))
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Verify-Package([string]$File){
  $expected=((Get-Content -LiteralPath ($File+'.sha256') -Raw).Trim() -split '\s+')[0]
  if((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -ne $expected){throw ('Package checksum mismatch: '+$File)}
  $zip=[IO.Compression.ZipFile]::OpenRead($File)
  try{
    $entry=$zip.GetEntry('AniBT-qB/release-manifest.json');if(!$entry){throw 'Release manifest is missing.'}
    $reader=[IO.StreamReader]::new($entry.Open());try{$manifest=$reader.ReadToEnd() | ConvertFrom-Json}finally{$reader.Dispose()}
    foreach($row in $manifest.files){
      $item=$zip.GetEntry('AniBT-qB/'+$row.path);if(!$item){throw ('Missing packaged file: '+$row.path)}
      $stream=$item.Open();$sha=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
      if($actual -ne $row.sha256){throw ('File hash mismatch: '+$row.path)}
    }
  }finally{$zip.Dispose()}
}
$packages=@(Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object {$_.Name -match '^AniBT-qB-v(\d+\.\d+\.\d+)-Windows-x64\.zip$'} | Sort-Object {[version]($_.Name -replace '^AniBT-qB-v|\-Windows-x64.zip$','')} -Descending)
$keep=@($packages | Select-Object -First $KeepVersions | ForEach-Object {$_.FullName})
foreach($v in $PinnedVersions){$file=Join-Path $releaseRoot ('AniBT-qB-v'+$v+'-Windows-x64.zip');if(!(Test-Path -LiteralPath $file)){throw ('Pinned rollback package missing: '+$v)};$keep+=$file}
$keep=@($keep | Sort-Object -Unique)
if($keep -notcontains $build.zip){throw 'Latest package is not in the retention set.'}
foreach($file in $keep){Verify-Package $file;Write-Output ('Retain verified: '+$file)}
if((Get-FileHash -LiteralPath $build.zip -Algorithm SHA256).Hash -ne $build.sha256){throw 'Current package differs from latest-build.json.'}
$targets=@(Get-ChildItem -LiteralPath $releaseRoot -Force | Where-Object {
  ($_.PSIsContainer -and $_.FullName -ne $keepStage -and ($_.Name -match '^\.stage-v\d+\.' -or $_.Name -in @('AniBT-qB','AniBT-qB-v1.2'))) -or
  (!$_.PSIsContainer -and $_.Name -match '^AniBT-qB-v\d+\.\d+\.\d+-Windows-x64\.zip(\.sha256)?$' -and $keep -notcontains ($_.FullName -replace '\.sha256$',''))
})
$freed=0
foreach($target in $targets){
  $resolved=[IO.Path]::GetFullPath($target.FullName)
  if(!$resolved.StartsWith($releaseRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $resolved -eq $keepStage){throw 'Cleanup target is outside the permitted release paths.'}
  $children=@();if($target.PSIsContainer){$children=@(Get-ChildItem -LiteralPath $resolved -Recurse -Force)}
  if(($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @($children | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'Filesystem links are not allowed in cleanup targets.'}
  $bytes=if($target.PSIsContainer){($children | Where-Object {!$_.PSIsContainer} | Measure-Object Length -Sum).Sum}else{$target.Length}
  [PSCustomObject]@{Action=if($Execute){'Delete'}else{'Preview'};Path=$resolved;MiB=[Math]::Round($bytes/1MB,1)}
  if($Execute){Remove-Item -LiteralPath $resolved -Recurse -Force}
  $freed+=$bytes
}
Write-Output ('Total MiB: '+[Math]::Round($freed/1MB,1)+'. Source, data, browser profiles, downloads, toolchain and pinned rollback packages are retained.')
if(!$Execute){Write-Output 'Preview only. Use -Execute to apply this retention policy.'}

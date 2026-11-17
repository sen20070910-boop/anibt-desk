param([switch]$UseVerifiedCache)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$probe=Join-Path $taskRoot ('.research\clean-build-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $probe -Force | Out-Null
foreach($name in @('src','ui','test','scripts','native-src','licenses')){Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $probe -Recurse}
foreach($name in @('package.json','package-lock.json','toolchain.lock.json','config.example.json','README.md','ENGINEERING.md','使用说明.md','开始使用.md','发布说明.md','打开图形界面.vbs','创建桌面快捷方式.vbs','anibt-qb.cmd')){Copy-Item -LiteralPath (Join-Path $taskRoot $name) -Destination $probe}
if($UseVerifiedCache){
  $cache=Join-Path $probe '.tools\downloads';New-Item -ItemType Directory -Path $cache -Force | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tools\downloads') -File | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination $cache}
}
Push-Location -LiteralPath $probe
try{
  & '.\scripts\bootstrap-toolchain.ps1' | Out-Host
  $lock=Get-Content -LiteralPath '.\toolchain.lock.json' -Raw | ConvertFrom-Json
  $runtime=Join-Path $probe ('.tools\node\'+$lock.node.version+'\node-v'+$lock.node.version+'-win-x64')
  $node=Join-Path $runtime 'node.exe'
  & $node (Join-Path $runtime 'node_modules\npm\bin\npm-cli.js') ci --ignore-scripts --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'Clean npm ci failed.'}
  & $node scripts/sync-version.mjs --check
  if($LASTEXITCODE -ne 0){throw 'Version check failed.'}
  & $node --test 'test/*.test.js' *> (Join-Path $probe 'test-results.txt')
  if($LASTEXITCODE -ne 0){throw ('Clean tests failed; see '+$probe+'\test-results.txt')}
  & $node scripts/build.mjs
  if($LASTEXITCODE -ne 0){throw 'Clean JavaScript build failed.'}
  & '.\scripts\build-native.ps1' -SkipRegistration
  & $node scripts/package-release.mjs
  if($LASTEXITCODE -ne 0){throw 'Clean portable packaging failed.'}
  & $node scripts/verify-release.mjs
  if($LASTEXITCODE -ne 0){throw 'Clean extracted package verification failed.'}
  Write-Output ('Clean build passed: '+$probe)
}finally{Pop-Location}

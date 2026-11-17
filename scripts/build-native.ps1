param([string]$OutputDirectory='', [switch]$SkipRegistration)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'bootstrap-toolchain.ps1') -Component WebView2 | Out-Null
$toolchain=Get-Content -LiteralPath (Join-Path $taskRoot 'toolchain.lock.json') -Raw | ConvertFrom-Json
$sdk=Join-Path $taskRoot ('.tools\webview2\'+$toolchain.webview2.version)
$native=if($OutputDirectory){[IO.Path]::GetFullPath($OutputDirectory)}else{Join-Path $taskRoot 'native'}
New-Item -ItemType Directory -Path $native -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'),(Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Wpf.dll'),(Join-Path $sdk 'build\native\x64\WebView2Loader.dll') -Destination $native -Force
Copy-Item -LiteralPath (Join-Path $sdk 'LICENSE.txt') -Destination (Join-Path $taskRoot 'licenses\Microsoft-WebView2-LICENSE.txt') -Force
$framework=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319'
$references=@('System.dll','System.Core.dll','System.Drawing.dll','System.Web.Extensions.dll','System.Xaml.dll','WindowsBase.dll','PresentationCore.dll','PresentationFramework.dll') | ForEach-Object { $dll=Join-Path $framework $_; if(!(Test-Path -LiteralPath $dll)){$dll=Join-Path $framework ('WPF\'+$_)}; '/reference:'+$dll }
$references+=@('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.Wpf.dll') | ForEach-Object { '/reference:'+(Join-Path $native $_) }
& (Join-Path $framework 'csc.exe') /nologo /target:winexe /platform:x64 /optimize+ ('/win32icon:'+(Join-Path $taskRoot 'ui\anibt.ico')) ('/out:'+(Join-Path $native 'AniBT.exe')) $references (Join-Path $taskRoot 'native-src\AniBT.cs') (Join-Path $taskRoot 'native-src\AniBTAccount.cs') (Join-Path $taskRoot 'native-src\FolderWindow.cs')
if($LASTEXITCODE -ne 0){throw 'Native application build failed.'}
if(!$SkipRegistration){ & (Join-Path $native 'AniBT.exe') --register }
Write-Output 'Native window and notification identity are ready.'

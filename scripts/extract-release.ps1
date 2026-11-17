param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$target=[IO.Path]::GetFullPath($Destination)
if(Test-Path -LiteralPath $target){throw 'Extraction destination must be new.'}
$zip=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $seen=@{}
  foreach($entry in $zip.Entries){
    $file=[IO.Path]::GetFullPath((Join-Path $target $entry.FullName))
    if(!$file.StartsWith($target+'\',[StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($file)){throw 'Unsafe or duplicate archive path.'}
    if(($entry.ExternalAttributes -shr 16 -band 0xF000) -eq 0xA000){throw 'Archive contains a filesystem link.'}
    $seen[$file]=$true
  }
  [IO.Compression.ZipFile]::ExtractToDirectory([IO.Path]::GetFullPath($Archive),$target)
}finally{$zip.Dispose()}

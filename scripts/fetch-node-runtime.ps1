param(
  [string]$ConfigPath = "build/node-runtime.json",
  [string]$TargetPlatform = "win-x64",
  [string]$OutputDir = "src-tauri/bin/node"
)

$ErrorActionPreference = "Stop"

function Get-Sha256Hex([string]$Path) {
  $hash = Get-FileHash -Path $Path -Algorithm SHA256
  return $hash.Hash.ToLowerInvariant()
}

if (!(Test-Path -Path $ConfigPath -PathType Leaf)) {
  throw "Node runtime config not found: $ConfigPath"
}

$config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
$version = [string]$config.version
$platformConfig = $config.platforms.$TargetPlatform

if ($null -eq $platformConfig) {
  throw "No node runtime config found for platform '$TargetPlatform'"
}

$archiveUrl = [string]$platformConfig.archive
$expectedArchiveSha = [string]$platformConfig.archiveSha256
$expectedNodeExeSha = [string]$platformConfig.nodeExeSha256

if ([string]::IsNullOrWhiteSpace($archiveUrl) -or [string]::IsNullOrWhiteSpace($expectedArchiveSha) -or [string]::IsNullOrWhiteSpace($expectedNodeExeSha)) {
  throw "Invalid runtime config for platform '$TargetPlatform'"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$tempRoot = Join-Path $env:TEMP "floorpov-node-runtime"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$archiveName = Split-Path -Path $archiveUrl -Leaf
$archivePath = Join-Path $tempRoot $archiveName

if (!(Test-Path -Path $archivePath -PathType Leaf)) {
  Write-Host "Downloading Node runtime $version ($TargetPlatform)..."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
}

$actualArchiveSha = Get-Sha256Hex -Path $archivePath
if ($actualArchiveSha -ne $expectedArchiveSha.ToLowerInvariant()) {
  throw "Archive checksum mismatch for $archiveName. Expected $expectedArchiveSha, got $actualArchiveSha"
}

$extractRoot = Join-Path $tempRoot "extract-$TargetPlatform"
if (Test-Path -Path $extractRoot) {
  Remove-Item -Recurse -Force $extractRoot
}
New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
Expand-Archive -Path $archivePath -DestinationPath $extractRoot -Force

$entryDir = Get-ChildItem -Path $extractRoot -Directory | Select-Object -First 1
if ($null -eq $entryDir) {
  throw "Could not find extracted Node directory in $extractRoot"
}

$sourceNodeExe = Join-Path $entryDir.FullName "node.exe"
if (!(Test-Path -Path $sourceNodeExe -PathType Leaf)) {
  throw "Extracted node.exe not found at $sourceNodeExe"
}

$actualNodeExeSha = Get-Sha256Hex -Path $sourceNodeExe
if ($actualNodeExeSha -ne $expectedNodeExeSha.ToLowerInvariant()) {
  throw "node.exe checksum mismatch. Expected $expectedNodeExeSha, got $actualNodeExeSha"
}

$targetPlatformDir = Join-Path $OutputDir $TargetPlatform
New-Item -ItemType Directory -Force -Path $targetPlatformDir | Out-Null

$targetNodeExe = Join-Path $targetPlatformDir "node.exe"
Copy-Item -Path $sourceNodeExe -Destination $targetNodeExe -Force

Write-Host "Bundled runtime ready: $targetNodeExe"

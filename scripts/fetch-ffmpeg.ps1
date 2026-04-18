param(
  [string]$ConfigPath = "build/ffmpeg.json",
  [string]$TargetPlatform = "win-x64",
  [string]$OutputPath = "src-tauri/bin/ffmpeg.exe"
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable -and $PSVersionTable.PSVersion) {
  Write-Host "PowerShell version: $($PSVersionTable.PSVersion)"
}

function Get-Sha256Hex([string]$Path) {
  $getFileHashCommand = Get-Command -Name "Get-FileHash" -ErrorAction SilentlyContinue
  if ($null -ne $getFileHashCommand) {
    $hash = Get-FileHash -Path $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
  }

  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    }
    finally {
      $stream.Dispose()
    }
  }
  finally {
    $sha256.Dispose()
  }

  return ([System.BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
}

if (!(Test-Path -Path $ConfigPath -PathType Leaf)) {
  throw "FFmpeg config not found: $ConfigPath"
}

$config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
$version = [string]$config.version
$platformConfig = $config.platforms.$TargetPlatform

if ($null -eq $platformConfig) {
  throw "No FFmpeg config found for platform '$TargetPlatform'"
}

$archiveUrl = [string]$platformConfig.archive
$expectedArchiveSha = [string]$platformConfig.archiveSha256
$binaryPathSuffix = [string]$platformConfig.binaryPathSuffix
$expectedBinarySha = [string]$platformConfig.binarySha256

if ([string]::IsNullOrWhiteSpace($archiveUrl) -or [string]::IsNullOrWhiteSpace($expectedArchiveSha) -or [string]::IsNullOrWhiteSpace($binaryPathSuffix)) {
  throw "Invalid FFmpeg config for platform '$TargetPlatform'"
}

$outputDirectory = Split-Path -Path $OutputPath -Parent
if (![string]::IsNullOrWhiteSpace($outputDirectory)) {
  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}

$tempRoot = Join-Path $env:TEMP "floorpov-ffmpeg"
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$archiveName = Split-Path -Path $archiveUrl -Leaf
$archivePath = Join-Path $tempRoot $archiveName

if (!(Test-Path -Path $archivePath -PathType Leaf)) {
  Write-Host "Downloading FFmpeg $version ($TargetPlatform)..."
  Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
}

$actualArchiveSha = Get-Sha256Hex -Path $archivePath
if ($actualArchiveSha -ne $expectedArchiveSha.ToLowerInvariant()) {
  throw "Archive checksum mismatch for $archiveName. Expected $expectedArchiveSha, got $actualArchiveSha"
}

$normalizedSuffix = $binaryPathSuffix.Replace("\\", "/").TrimStart("/")

Add-Type -AssemblyName "System.IO.Compression.FileSystem"
$zipArchive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entry = $zipArchive.Entries | Where-Object {
    $_.FullName.Replace("\\", "/").TrimStart("/").ToLowerInvariant().EndsWith($normalizedSuffix.ToLowerInvariant())
  } | Select-Object -First 1

  if ($null -eq $entry) {
    throw "Could not find '$binaryPathSuffix' inside $archiveName"
  }

  $extractedBinaryPath = Join-Path $tempRoot "ffmpeg-$TargetPlatform.exe"
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $extractedBinaryPath, $true)

  if (![string]::IsNullOrWhiteSpace($expectedBinarySha)) {
    $actualBinarySha = Get-Sha256Hex -Path $extractedBinaryPath
    if ($actualBinarySha -ne $expectedBinarySha.ToLowerInvariant()) {
      throw "FFmpeg binary checksum mismatch. Expected $expectedBinarySha, got $actualBinarySha"
    }
  }

  Copy-Item -Path $extractedBinaryPath -Destination $OutputPath -Force
}
finally {
  $zipArchive.Dispose()
}

Write-Host "Bundled FFmpeg ready: $OutputPath"

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$appRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$manifest = Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') {
    throw "package.json must contain a valid semantic version."
}
& node (Join-Path $appRoot "scripts\version.mjs") check
if ($LASTEXITCODE -ne 0) { throw "Version check failed. Run npm run release:check before packaging." }

$electronDist = Join-Path $appRoot "node_modules\electron\dist"
$electronExe = Join-Path $electronDist "electron.exe"
if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) {
    throw "Electron runtime is missing. Run npm ci in the project directory first."
}

# Read the runtime's PE machine type, not the shell's architecture.
$reader = [System.IO.BinaryReader]::new([System.IO.File]::OpenRead($electronExe))
try {
    if ($reader.ReadUInt16() -ne 0x5a4d) { throw "Invalid Electron executable (DOS header)." }
    $reader.BaseStream.Position = 0x3c
    $peOffset = $reader.ReadInt32()
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid Electron executable (PE header)." }
    $architecture = switch ($reader.ReadUInt16()) {
        0x8664 { "x64" }
        0xaa64 { "arm64" }
        0x014c { "ia32" }
        default { throw "Unsupported Electron executable architecture." }
    }
} finally {
    $reader.Dispose()
}

$distRoot = Join-Path $appRoot "dist"
$versionRoot = Join-Path $distRoot "v$version"
$artifactName = "Moonshadow-Reslib-$version-win32-$architecture"
$output = Join-Path $versionRoot $artifactName
if (Test-Path -LiteralPath $output) {
    throw "Portable build already exists; no files were changed: $output. Bump the version or move the existing artifact before rebuilding."
}

function Assert-NoLinks([string]$Source) {
    $entry = Get-Item -LiteralPath $Source -Force
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to package a symbolic link or junction: $Source"
    }
}

function Copy-ArtifactTree([string]$Source, [string]$Destination) {
    Assert-NoLinks $Source
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        # Only the Electron distribution uses recursive copying. Exclude
        # accidental local state at every depth; app inputs use a whitelist.
        if ($entry.Name -in @("node_modules", "logs", "log", "cache", "__pycache__") -or $entry.Name.StartsWith(".")) { continue }
        Assert-NoLinks $entry.FullName
        $target = Join-Path $Destination $entry.Name
        if ($entry.PSIsContainer) {
            Copy-ArtifactTree $entry.FullName $target
        } elseif ($entry.Extension -notin @(".log", ".pyc", ".pyo")) {
            Copy-Item -LiteralPath $entry.FullName -Destination $target
        }
    }
}

$sourceFiles = @(
    "desktop/main.js",
    "desktop/preload.js",
    "desktop/reader-shortcuts.js",
    "backend/display/server.py",
    "backend/display/compat.py",
    "backend/subscription/server.py",
    "frontend/display/dist/index.html",
    "frontend/display/dist/config.js",
    "frontend/display/dist/version.json",
    "frontend/subscription/dist/index.html",
    "frontend/subscription/dist/config.js",
    "frontend/subscription/dist/version.json"
)
# Validate all inputs before creating an output directory.
foreach ($relative in $sourceFiles) {
    $source = Join-Path $appRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required input is missing: $relative. Run npm run build first."
    }
    for ($candidate = $source; $candidate -ne $appRoot; $candidate = Split-Path -Parent $candidate) {
        Assert-NoLinks $candidate
    }
}

# Build in a unique staging directory. Never delete dist or overwrite an old
# release. A failed build remains clearly marked for inspection.
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-NoLinks $distRoot
$staging = Join-Path $distRoot (".packaging-$version-" + [guid]::NewGuid().ToString("N"))
$resourceApp = Join-Path $staging "resources\app"
try {
    Copy-ArtifactTree $electronDist $staging
    New-Item -ItemType Directory -Path $resourceApp -Force | Out-Null
    foreach ($relative in $sourceFiles) {
        $target = Join-Path $resourceApp $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $appRoot $relative) -Destination $target
    }
    $packagedManifest = [ordered]@{
        name = $manifest.name
        version = $version
        description = $manifest.description
        main = "desktop/main.js"
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $resourceApp "package.json"), ($packagedManifest | ConvertTo-Json) + "`n", $utf8)
    $buildInfo = [ordered]@{
        name = $manifest.name
        version = $version
        platform = "win32"
        architecture = $architecture
        electronVersion = (Get-Content -LiteralPath (Join-Path $electronDist "version") -Raw).Trim()
    }
    [System.IO.File]::WriteAllText((Join-Path $staging "build-info.json"), ($buildInfo | ConvertTo-Json) + "`n", $utf8)
    Rename-Item -LiteralPath (Join-Path $staging "electron.exe") -NewName "Moonshadow-Reslib.exe"

    New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
    Assert-NoLinks $versionRoot
    # Move only this build's staging directory, confined to the project's dist.
    $resolvedDist = (Resolve-Path -LiteralPath $distRoot).Path.TrimEnd('\') + '\'
    $resolvedStaging = (Resolve-Path -LiteralPath $staging).Path
    $resolvedOutput = [System.IO.Path]::GetFullPath($output)
    if (-not $resolvedStaging.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $resolvedOutput.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to move a build outside the project dist directory."
    }
    if (Test-Path -LiteralPath $output) { throw "Another build already created $output; staging was preserved." }
    # Directory.Move fails atomically if another build wins the destination;
    # Move-Item could instead nest staging inside that newly created directory.
    [System.IO.Directory]::Move($resolvedStaging, $resolvedOutput)
} catch {
    Write-Warning "Packaging failed. Any partial output is preserved at: $staging"
    throw
}

Write-Output "Portable build created: $output\Moonshadow-Reslib.exe"

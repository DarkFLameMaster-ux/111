param(
    [ValidateSet("all", "display", "management")][string]$Role = "all",
    [string]$BackupRoot = $env:RESLIB_BACKUP_DIR
)

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
$currentRoot = Join-Path $distRoot "current"
$roles = if ($Role -eq "all") { @("display", "management") } else { @($Role) }
if (-not $BackupRoot) {
    $BackupRoot = Join-Path ([System.IO.Path]::GetPathRoot($appRoot)) "Reslib-backups"
}
$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$appPrefix = $appRoot.TrimEnd('\') + '\'
if ($BackupRoot.Equals($appRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $BackupRoot.StartsWith($appPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Backups must be outside the source project. Set RESLIB_BACKUP_DIR or -BackupRoot."
}
$electronVersion = (Get-Content -LiteralPath (Join-Path $electronDist "version") -Raw).Trim()

function Assert-NoLinks([string]$Source) {
    $entry = Get-Item -LiteralPath $Source -Force
    if ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to package a symbolic link or junction: $Source"
    }
}

function Assert-PathAncestors([string]$Target) {
    for ($candidate = $Target; $candidate; $candidate = Split-Path -Parent $candidate) {
        if (Test-Path -LiteralPath $candidate) { Assert-NoLinks $candidate }
    }
}

function Assert-TreeNoLinks([string]$Source) {
    Assert-NoLinks $Source
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force -Recurse) {
        Assert-NoLinks $entry.FullName
    }
}

function Assert-Confined([string]$Target, [string]$Root) {
    $absolute = [System.IO.Path]::GetFullPath($Target)
    $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing a build move outside its intended directory: $Target"
    }
    Assert-PathAncestors $absolute
}

function Read-CurrentBuild([string]$Output, [string]$SelectedRole) {
    if (-not (Test-Path -LiteralPath $Output)) { return $null }
    Assert-TreeNoLinks $Output
    $infoPath = Join-Path $Output "build-info.json"
    $appManifest = Join-Path $Output "resources\app\package.json"
    if (-not (Test-Path -LiteralPath $infoPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $appManifest -PathType Leaf)) {
        throw "Current directory is not a recognized portable build: $Output"
    }
    $info = Get-Content -LiteralPath $infoPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldManifest = Get-Content -LiteralPath $appManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($info.role -ne $SelectedRole -or $info.platform -ne "win32" -or
        $oldManifest.reslibRole -ne $SelectedRole -or $info.version -ne $oldManifest.version) {
        throw "Current portable build identity is invalid: $Output"
    }
    return $info
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

# Validate both roles before staging or changing either current program.
$inputs = @{}
foreach ($selectedRole in $roles) {
    $frontend = if ($selectedRole -eq "display") { "display" } else { "subscription" }
    $inputs[$selectedRole] = @(
    "desktop/main.js",
    "desktop/preload.js",
    "desktop/reader-shortcuts.js",
    "backend/runtime.py",
    "backend/catalog.py",
    "backend/display/compat.py",
    "backend/$frontend/server.py",
    "frontend/$frontend/dist/index.html",
    "frontend/$frontend/dist/config.js",
    "frontend/$frontend/dist/version.json"
    )
# Validate all inputs before creating an output directory.
foreach ($relative in $inputs[$selectedRole]) {
    $source = Join-Path $appRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Required input is missing: $relative. Run npm run build first."
    }
    for ($candidate = $source; $candidate -ne $appRoot; $candidate = Split-Path -Parent $candidate) {
        Assert-NoLinks $candidate
    }
}
}

# The fixed paths keep shortcuts current. Serialize builds and reject updates
# while an executable from a selected current directory is still running.
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
Assert-PathAncestors $distRoot
Assert-PathAncestors $currentRoot
Assert-PathAncestors $BackupRoot
$lock = [System.IO.File]::Open((Join-Path $distRoot ".portable-build.lock"), "OpenOrCreate", "ReadWrite", "None")
try {
$buildProcesses = @(Get-CimInstance Win32_Process)
foreach ($selectedRole in $roles) {
    $output = Join-Path $currentRoot $selectedRole
    Assert-Confined $output $distRoot
    $null = Read-CurrentBuild $output $selectedRole
    $outputPrefix = $output.TrimEnd('\') + '\'
    foreach ($buildProcess in $buildProcesses) {
        if (-not $buildProcess.ExecutablePath) { continue }
        # CIM can return an 8.3 path (e.g. DARKFL~1). Expand it before comparing
        # with the long project path so aliases cannot bypass the running guard.
        $runningExe = Get-Item -LiteralPath $buildProcess.ExecutablePath -ErrorAction SilentlyContinue
        if ($runningExe -and $runningExe.FullName.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Close the running $selectedRole program before updating: $output"
        }
    }
}
foreach ($selectedRole in $roles) {
$output = Join-Path $currentRoot $selectedRole
$oldInfo = Read-CurrentBuild $output $selectedRole
$reuseRuntime = $null -ne $oldInfo -and $oldInfo.architecture -eq $architecture -and $oldInfo.electronVersion -eq $electronVersion -and
    (Test-Path -LiteralPath (Join-Path $output "Moonshadow-$selectedRole.exe") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $output "version") -PathType Leaf)
if ($reuseRuntime) {
    $reuseRuntime = (Get-Content -LiteralPath (Join-Path $output "version") -Raw).Trim() -eq $electronVersion
}
$staging = Join-Path $distRoot (".packaging-$selectedRole-" + [guid]::NewGuid().ToString("N"))
$resourceApp = Join-Path $staging "resources\app"
$backup = $null
$oldMoved = $false
$newMoved = $false
try {
    if (-not $reuseRuntime) { Copy-ArtifactTree $electronDist $staging }
    New-Item -ItemType Directory -Path $resourceApp -Force | Out-Null
    foreach ($relative in $inputs[$selectedRole]) {
        $target = Join-Path $resourceApp $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $appRoot $relative) -Destination $target
    }
    $packagedManifest = [ordered]@{
        name = "$($manifest.name)-$selectedRole"
        version = $version
        description = $manifest.description
        main = "desktop/main.js"
        reslibRole = $selectedRole
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $resourceApp "package.json"), ($packagedManifest | ConvertTo-Json) + "`n", $utf8)
    $buildInfo = [ordered]@{
        name = "$($manifest.name)-$selectedRole"
        version = $version
        role = $selectedRole
        platform = "win32"
        architecture = $architecture
        electronVersion = $electronVersion
    }
    [System.IO.File]::WriteAllText((Join-Path $staging "build-info.json"), ($buildInfo | ConvertTo-Json) + "`n", $utf8)
    if (-not $reuseRuntime) {
        Rename-Item -LiteralPath (Join-Path $staging "electron.exe") -NewName "Moonshadow-$selectedRole.exe"
    }

    New-Item -ItemType Directory -Path $currentRoot -Force | Out-Null
    Assert-Confined $staging $distRoot
    Assert-Confined $output $distRoot
    if ($null -ne $oldInfo) {
        $backup = Join-Path $BackupRoot ("portable\" + (Get-Date -Format "yyyyMMdd-HHmmssfff") + "-" + [guid]::NewGuid().ToString("N") + "\$selectedRole")
        Assert-Confined $backup $BackupRoot
        New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
    }
    if ($reuseRuntime) {
        # Preserve only the replaced app and its metadata, not another Electron
        # runtime. Source history is maintained by local Git commits and tags.
        New-Item -ItemType Directory -Path (Join-Path $backup "resources") -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $output "build-info.json") -Destination (Join-Path $backup "build-info.json")
        [System.IO.Directory]::Move((Join-Path $output "resources\app"), (Join-Path $backup "resources\app"))
        $oldMoved = $true
        [System.IO.Directory]::Move($resourceApp, (Join-Path $output "resources\app"))
        $newMoved = $true
        [System.IO.File]::Replace((Join-Path $staging "build-info.json"), (Join-Path $output "build-info.json"), (Join-Path $backup "build-info.json"))
    } else {
        # First install or runtime upgrade. Keep the previous complete runtime
        # outside the project so a failed upgrade can be rolled back.
        if ($null -ne $oldInfo) {
            [System.IO.Directory]::Move($output, $backup)
            $oldMoved = $true
        }
        [System.IO.Directory]::Move($staging, $output)
        $newMoved = $true
    }
} catch {
    if ($oldMoved) {
        if ($reuseRuntime) {
            if ($newMoved) { [System.IO.Directory]::Move((Join-Path $output "resources\app"), $resourceApp) }
            [System.IO.Directory]::Move((Join-Path $backup "resources\app"), (Join-Path $output "resources\app"))
            Copy-Item -LiteralPath (Join-Path $backup "build-info.json") -Destination (Join-Path $output "build-info.json") -Force
        } else {
            if ($newMoved) { [System.IO.Directory]::Move($output, $staging) }
            [System.IO.Directory]::Move($backup, $output)
        }
    }
    Write-Warning "Packaging failed. Any partial output is preserved at: $staging"
    throw
}

if ($reuseRuntime) {
    try {
        [System.IO.Directory]::Delete((Join-Path $staging "resources"))
        [System.IO.Directory]::Delete($staging)
    } catch { Write-Warning "Update succeeded; empty staging directory could not be removed: $staging" }
}
Write-Output "Current portable build: $output\Moonshadow-$selectedRole.exe"
if ($backup) { Write-Output "Previous app backed up outside the project: $backup" }
}
} finally {
    $lock.Dispose()
}

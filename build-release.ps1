$ErrorActionPreference = "Continue"

$version = (Get-Content (Join-Path $PSScriptRoot "package.json") | ConvertFrom-Json).version

Write-Host "=== WTD Pack Picker Release Builder v$version ==="

# Build C# handler
Write-Host "Building C# save handler..."
& (Join-Path $PSScriptRoot "save-handler\build.ps1")
if ($LASTEXITCODE -ne 0) { throw "C# build failed with exit code $LASTEXITCODE" }

# Build C# window embed helper
Write-Host "Building C# window embed helper..."
& (Join-Path $PSScriptRoot "window-embed\build.ps1")
if ($LASTEXITCODE -ne 0) { throw "Window embed build failed with exit code $LASTEXITCODE" }

# Build Python audio handler
Write-Host "Building Python audio handler..."
& (Join-Path $PSScriptRoot "audio-handler\build.ps1")
if ($LASTEXITCODE -ne 0) { throw "Python build failed with exit code $LASTEXITCODE" }

# Install deps
Write-Host "Installing dependencies..."
Push-Location $PSScriptRoot
try {
    npm ci --include=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$electronDir = Join-Path $PSScriptRoot "node_modules\electron"
$electronExe = Join-Path $electronDir "dist\electron.exe"
$electronPath = Join-Path $electronDir "path.txt"
if (-not (Test-Path $electronExe) -or -not (Test-Path $electronPath)) {
    Write-Host "Electron binary missing; extracting from local cache..."
    $electronVersion = (Get-Content (Join-Path $electronDir "package.json") | ConvertFrom-Json).version
    $cacheRoot = Join-Path $env:LOCALAPPDATA "electron\Cache"
    $zip = Get-ChildItem $cacheRoot -Recurse -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $zip) {
        throw "Electron install is incomplete and no cached Electron zip was found. Remove node_modules and rerun."
    }

    $dist = Join-Path $electronDir "dist"
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Path $dist | Out-Null
    Expand-Archive -LiteralPath $zip.FullName -DestinationPath $dist -Force -ErrorAction Stop
    [System.IO.File]::WriteAllText($electronPath, "electron.exe")
}

if (-not (Test-Path $electronExe) -or -not (Test-Path $electronPath)) {
    throw "Electron install is incomplete (missing electron.exe or path.txt)."
}

# Run electron-builder
Write-Host "Building NSIS installer..."
Push-Location $PSScriptRoot
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "0"
npx electron-builder --win *>&1 | ForEach-Object { if ($_ -isnot [System.Management.Automation.ErrorRecord]) { $_ } }
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
Pop-Location

$setup = Get-ChildItem (Join-Path $PSScriptRoot "release") -Filter "WTD Pack Picker Setup*.exe" | Select-Object -First 1
if ($setup) {
    $sizeMB = [math]::Round($setup.Length / 1MB, 1)
    Write-Host "Done: $($setup.FullName) ($sizeMB MB)"
} else {
    Write-Host "Build completed. Check release/ folder for output."
}

$ErrorActionPreference = "Continue"

$version = (Get-Content (Join-Path $PSScriptRoot "package.json") | ConvertFrom-Json).version

Write-Host "=== WTD Pack Picker Release Builder v$version ==="

# Build C# handler
Write-Host "Building C# save handler..."
& (Join-Path $PSScriptRoot "save-handler\build.ps1")
if ($LASTEXITCODE -ne 0) { throw "C# build failed with exit code $LASTEXITCODE" }

# Install deps
Write-Host "Installing dependencies..."
Push-Location $PSScriptRoot
$prev = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
cmd /c "npm install --omit=dev --no-audit --no-fund --loglevel=error 2>&1"
cmd /c "npm install electron electron-builder --save-dev --no-audit --no-fund --loglevel=error 2>&1"
$ErrorActionPreference = $prev
Pop-Location

# Run electron-builder
Write-Host "Building Electron package..."
Push-Location $PSScriptRoot
$env:ELECTRON_SKIP_BINARY_DOWNLOAD = "0"
npx electron-builder --win portable *>&1 | ForEach-Object { if ($_ -isnot [System.Management.Automation.ErrorRecord]) { $_ } }
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
Pop-Location

$exe = Join-Path $PSScriptRoot "release\WTD Pack Picker.exe"
if (Test-Path $exe) {
    $sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "Done: $exe ($sizeMB MB)"
} else {
    Write-Host "Build completed. Check release/ folder for output."
}

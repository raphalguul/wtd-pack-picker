$ErrorActionPreference = "Stop"

$version = (Get-Content (Join-Path $PSScriptRoot "package.json") | ConvertFrom-Json).version

Write-Host "=== WTD Pack Picker Release Builder v$version ==="

# Build C# handler
Write-Host "Building C# save handler..."
& (Join-Path $PSScriptRoot "save-handler\build.ps1")

# Install deps
Write-Host "Installing dependencies..."
Push-Location $PSScriptRoot
npm install --omit=dev 2>&1 | Out-Null
npm install electron electron-builder --save-dev 2>&1 | Out-Null
Pop-Location

# Run electron-builder
Write-Host "Building Electron package..."
Push-Location $PSScriptRoot
npx electron-builder --win portable 2>&1
Pop-Location

$exe = Join-Path $PSScriptRoot "release\WTD Pack Picker.exe"
if (Test-Path $exe) {
    $sizeMB = [math]::Round((Get-Item $exe).Length / 1MB, 1)
    Write-Host "Done: $exe ($sizeMB MB)"
} else {
    Write-Host "Build completed. Check release/ folder for output."
}

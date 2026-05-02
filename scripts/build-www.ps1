$src = Split-Path -Parent $PSScriptRoot
$www = Join-Path $src "www"

if (Test-Path $www) {
    Remove-Item -Recurse -Force $www
}

New-Item -ItemType Directory -Path $www -Force | Out-Null

Get-ChildItem -Path $src -Filter "*.html" | Copy-Item -Destination $www
Get-ChildItem -Path $src -Filter "*.js" | Copy-Item -Destination $www
Get-ChildItem -Path $src -Filter "*.css" | Copy-Item -Destination $www
Get-ChildItem -Path $src -Filter "*.json" | Copy-Item -Destination $www
Get-ChildItem -Path $src -Filter "*.ico" | Copy-Item -Destination $www
Get-ChildItem -Path $src -Filter "favicon.ico" | Copy-Item -Destination $www

Copy-Item -Path (Join-Path $src "icons") -Destination $www -Recurse
Copy-Item -Path (Join-Path $src "api") -Destination $www -Recurse
Copy-Item -Path (Join-Path $src "config.js") -Destination $www

Write-Host "www built"

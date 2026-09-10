# hodor installer for Windows PowerShell.
#   irm https://github.com/dylnhdsn/hodor/releases/download/latest/install.ps1 | iex
# Requires Node.js >= 22.
$ErrorActionPreference = "Stop"

$Repo = "dylnhdsn/hodor"
$Tag = "latest"
$HodorHome = if ($env:HODOR_HOME) { $env:HODOR_HOME } else { Join-Path $env:USERPROFILE ".hodor" }
$BinDir = Join-Path $HodorHome "bin"
$BaseUrl = "https://github.com/$Repo/releases/download/$Tag"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "hodor: Node.js >= 22 is required (https://nodejs.org)"
}
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
    throw "hodor: Node.js >= 22 is required (found $(node -v))"
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Bundle = Join-Path $BinDir "hodor.mjs"

try {
    Invoke-WebRequest -Uri "$BaseUrl/hodor.mjs" -OutFile "$Bundle.new" -UseBasicParsing
    Move-Item -Force "$Bundle.new" $Bundle
}
catch {
    if (Get-Command gh -ErrorAction SilentlyContinue) {
        gh release download $Tag -R $Repo --pattern hodor.mjs --output $Bundle --clobber
        if ($LASTEXITCODE -ne 0) { throw "hodor: gh download failed" }
    }
    else {
        throw "hodor: failed to download $BaseUrl/hodor.mjs : $_"
    }
}

# cmd shim so `hodor` resolves from PowerShell and cmd alike
Set-Content -Path (Join-Path $BinDir "hodor.cmd") -Value "@echo off`r`nnode `"%~dp0hodor.mjs`" %*" -Encoding ascii

# Persist the bin dir on the user PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $BinDir) {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$BinDir", "User")
    Write-Host "hodor: added $BinDir to your user PATH (new terminals will pick it up)"
}
# ...and the current session's
if (($env:Path -split ";") -notcontains $BinDir) {
    $env:Path = "$env:Path;$BinDir"
}

$Version = node $Bundle --version
Write-Host "hodor $Version installed to $BinDir"
Write-Host "hodor: update later with: hodor update"

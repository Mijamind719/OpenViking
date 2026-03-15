param(
  [ValidateSet("local", "remote")]
  [string]$Mode = "local",
  [string]$BaseUrl = "http://127.0.0.1:1933",
  [string]$ConfigPath = "$HOME/.openviking/ov.conf",
  [int]$Port = 1933,
  [switch]$Copy,
  [switch]$NoDev
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$openclawArgs = @()

if (-not $NoDev) {
  $openclawArgs += "--dev"
}

$installArgs = @()
if (-not $Copy) {
  $installArgs += "--link"
}

Write-Host "[context-openviking] installing plugin from $scriptDir"
& openclaw @openclawArgs plugins install @installArgs $scriptDir
& openclaw @openclawArgs config set plugins.enabled true --json
& openclaw @openclawArgs config set plugins.slots.contextEngine context-openviking
& openclaw @openclawArgs config set plugins.entries.context-openviking.config.mode $Mode

if ($Mode -eq "remote") {
  & openclaw @openclawArgs config set plugins.entries.context-openviking.config.baseUrl $BaseUrl
} else {
  & openclaw @openclawArgs config set plugins.entries.context-openviking.config.configPath $ConfigPath
  & openclaw @openclawArgs config set plugins.entries.context-openviking.config.port $Port --json
}

Write-Host "[context-openviking] installed"
Write-Host "[context-openviking] verify with: openclaw $($openclawArgs -join ' ') plugins info context-openviking"

# Local dev helper (Windows). Infra comes from docker; the apps run on the host with Bun.
#   .\dev.ps1 start [-Workers 2] [-SinkLimit 0] [-SinkLatency 0]
#   .\dev.ps1 stop
#   .\dev.ps1 status
param(
  [ValidateSet("start", "stop", "status")] [string]$Cmd = "start",
  [int]$Workers = 1,
  [int]$SinkLimit = 0,
  [int]$SinkLatency = 0
)
$root = $PSScriptRoot
$run = Join-Path $root ".run"
New-Item -ItemType Directory -Force $run | Out-Null
$pattern = 'src[/\\](api[/\\]server|workers[/\\](outbox-relay|send-worker|reaper)|loadtest[/\\]smtp-sink)'

function Stop-All {
  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-Svc($name, $script, $envs = @{}) {
  foreach ($k in $envs.Keys) { Set-Item "env:$k" $envs[$k] }
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "bun run $script") -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $run "$name.log") -RedirectStandardError (Join-Path $run "$name.err.log")
}

switch ($Cmd) {
  "stop" { Stop-All; "stopped" }
  "status" {
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $pattern } |
      ForEach-Object { "{0}  {1}" -f $_.ProcessId, ($_.CommandLine -replace '.*bun(\.exe)?"?\s+', '') }
  }
  "start" {
    Stop-All
    docker compose up -d mongo redis | Out-Null
    Start-Svc "sink" "src/loadtest/smtp-sink.ts" @{ SINK_LIMIT_PER_SEC = "$SinkLimit"; SINK_LATENCY_MS = "$SinkLatency" }
    Start-Svc "api" "src/api/server.ts"
    Start-Svc "relay" "src/workers/outbox-relay.ts"
    for ($i = 1; $i -le $Workers; $i++) { Start-Svc "worker$i" "src/workers/send-worker.ts" }
    Start-Svc "reaper" "src/workers/reaper.ts"
    "started: sink, api (http://localhost:3100), relay, $Workers worker(s), reaper. Logs in .run\"
  }
}

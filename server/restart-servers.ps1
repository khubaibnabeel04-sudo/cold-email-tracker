<#
  Used by start-app.bat: stops anything already listening on 3005/3006,
  waits for the ports to actually free up, then (after the caller starts
  fresh backend/frontend windows) waits for both ports to come back up.
  Split into two modes so start-app.bat can call it before AND after
  launching the new processes.

  Uses `netstat -ano` directly rather than Get-NetTCPConnection /
  Get-CimInstance — both go through WMI, which can hang for a long time on
  some machines. netstat is a plain console tool and returns immediately.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('stop', 'wait-up')][string]$Mode
)

$ports = 3005, 3006

function Get-ListeningPids([int[]]$Ports) {
  $result = @{}
  foreach ($p in $Ports) { $result[$p] = @() }
  netstat -ano | ForEach-Object {
    if ($_ -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$') {
      $port = [int]$matches[1]
      $procId = [int]$matches[2]
      if ($Ports -contains $port) { $result[$port] += $procId }
    }
  }
  return $result
}

if ($Mode -eq 'stop') {
  $pidsByPort = Get-ListeningPids -Ports $ports
  foreach ($p in $ports) {
    foreach ($procId in ($pidsByPort[$p] | Select-Object -Unique)) {
      Write-Host "  Stopping PID $procId on port $p..."
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }

  $deadline = (Get-Date).AddSeconds(15)
  $busy = $true
  while ((Get-Date) -lt $deadline) {
    $pidsByPort = Get-ListeningPids -Ports $ports
    $busy = ($pidsByPort[3005].Count -gt 0) -or ($pidsByPort[3006].Count -gt 0)
    if (-not $busy) { break }
    Start-Sleep -Milliseconds 500
  }
  if ($busy) {
    Write-Host "  Warning: a port is still in use after waiting - starting anyway."
  } else {
    Write-Host "  Ports 3005/3006 are free."
  }
  exit 0
}

if ($Mode -eq 'wait-up') {
  $deadline = (Get-Date).AddSeconds(60)
  $ok = @{ 3005 = $false; 3006 = $false }
  while ((Get-Date) -lt $deadline -and (-not $ok[3005] -or -not $ok[3006])) {
    $pidsByPort = Get-ListeningPids -Ports $ports
    foreach ($p in $ports) {
      if (-not $ok[$p] -and $pidsByPort[$p].Count -gt 0) {
        Write-Host "  Port $p is up."
        $ok[$p] = $true
      }
    }
    if (-not $ok[3005] -or -not $ok[3006]) { Start-Sleep -Milliseconds 500 }
  }
  if (-not $ok[3006]) { Write-Host "  Warning: backend (3006) did not come up within 60s - check its window for errors." }
  if (-not $ok[3005]) { Write-Host "  Warning: frontend (3005) did not come up within 60s - it can take a while to compile, check its window." }
  exit 0
}

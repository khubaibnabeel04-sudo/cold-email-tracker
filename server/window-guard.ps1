<#
  Keeps the auto-scheduler's Chrome windows composited by Windows.

  WHY THIS EXISTS
  ---------------
  When a Chrome window is minimized, Windows stops producing frames for it.
  Chrome then throttles requestAnimationFrame from ~60 Hz to ~6 Hz, and every
  Playwright click (which waits for a stable bounding box across rAF frames)
  goes from ~100 ms to ~1900 ms. Measured with 8 parallel instances:

      visible/off-screen : rAF 59.9 Hz, click median   99 ms
      minimized          : rAF  6.3 Hz, click median 1824 ms

  No Chrome command-line flag fixes this — it is the window manager, not
  Chrome. The only fix is to never let the window be minimized. So we park the
  windows far off-screen (invisible to the user, but still composited) and this
  guard un-minimizes any that get minimized, e.g. by Win+D / "Show desktop" or
  a stray taskbar click.

  Windows are identified by PID, resolved from the exact --user-data-dir values
  this run launched with, so the user's own Chrome is never touched.

  Restores use SW_SHOWNOACTIVATE so focus is never stolen from the user.
  Runs until -Sentinel disappears.
#>
param(
  [Parameter(Mandatory = $true)][string]$Sentinel,
  # Newline-delimited file of --user-data-dir values. A file rather than a
  # parameter list because an array passed through spawn() arrives as one
  # already-quoted string and silently binds as a single element.
  [Parameter(Mandatory = $true)][string]$ProfileList,
  [int]$IntervalMs = 1000,
  [int]$OffX = -32000,
  [int]$OffY = -32000
)

$ErrorActionPreference = 'Continue'

$ProfileDirs = @(Get-Content -LiteralPath $ProfileList -ErrorAction SilentlyContinue |
  ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($ProfileDirs.Count -eq 0) {
  Write-Output "guard: no profile dirs supplied — nothing to protect"
  return
}
Write-Output "guard watching $($ProfileDirs.Count) profile dir(s)"

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class WinGuard {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

  const int SW_SHOWNOACTIVATE = 4;
  // NOSIZE | NOZORDER | NOACTIVATE — move only, never raise or focus.
  const uint SWP = 0x0001 | 0x0004 | 0x0010;

  // Returns how many windows had to be rescued from a minimized state.
  public static int Sweep(HashSet<uint> pids, int x, int y) {
    int rescued = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      // Only top-level windows with a caption — skips Chrome's hidden helpers.
      if (GetWindowTextLength(h) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      if (IsIconic(h)) { ShowWindow(h, SW_SHOWNOACTIVATE); rescued++; }
      SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP);
      return true;
    }, IntPtr.Zero);
    return rescued;
  }
}
"@

function Get-OurChromePids {
  $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction Stop
  } catch { return $set }
  foreach ($p in $procs) {
    $cl = $p.CommandLine
    if (-not $cl) { continue }
    foreach ($d in $ProfileDirs) {
      if ($cl.IndexOf($d, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        [void]$set.Add([uint32]$p.ProcessId)
        break
      }
    }
  }
  return $set
}

$pids = Get-OurChromePids
$lastPidRefresh = Get-Date
$totalRescued = 0
$announced = $false

while (Test-Path -LiteralPath $Sentinel) {
  # Chrome spawns/retires processes as it runs, so re-resolve periodically.
  if (((Get-Date) - $lastPidRefresh).TotalSeconds -ge 5) {
    $pids = Get-OurChromePids
    $lastPidRefresh = Get-Date
  }
  # Surface the match count once — a silent 0 here would mean the guard is
  # running but protecting nothing.
  if (-not $announced -and $pids.Count -gt 0) {
    Write-Output "guard tracking $($pids.Count) Chrome process(es)"
    $announced = $true
  }
  if ($pids.Count -gt 0) {
    $n = [WinGuard]::Sweep($pids, $OffX, $OffY)
    if ($n -gt 0) {
      $totalRescued += $n
      Write-Output "un-minimized $n window(s)"
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}

Write-Output "guard stopped (total rescues: $totalRescued)"

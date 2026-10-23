# send-mc-command.ps1 -- type a slash command into the Minecraft chat box.
#
# ASCII-only on purpose (PS 5.1 + UTF-8 source = mojibake; see capture-win.ps1).
#
# ============================ 2026-10-23 REWRITE ============================
# History that still matters:
#   * 2026-10-04: OpenClaw's keyDown/keyUp cannot open chat (the mod maps only
#     W A S D SPACE LEFTSHIFT LEFTCONTROL; everything else replies success:true
#     and does nothing).
#   * 2026-10-04: "OS-level keystrokes reach MC" was believed true via SendKeys.
#   * 2026-10-23: **that belief is false on this machine today.**
#       - SendKeys('t') never opened the chat box (screenshot evidence);
#       - SendInput returned 0 for every event (last_error=203) -> nothing was
#         ever queued;
#       - same session (1), same owner, shell is High integrity, so UIPI is not
#         the obvious culprit.
#   * 2026-10-23: **PostMessage works.** WM_KEYDOWN/WM_KEYUP for T opens the chat
#     screen, WM_CHAR for each character fills the line, VK_RETURN sends it.
#     Verified visually: `/help` printed the command list on screen.
#     Delivery path = PostMessage straight to the GLFW window handle.
#
# WHY VERIFICATION EXISTS: "posted" only means the message was queued. The old
# script printed SENT while nothing happened. With -Verify the script captures
# the bottom strip before/after opening the chat and requires the input bar to
# actually appear (a real state change, not a receipt).
#
# USAGE:
#   powershell -File send-mc-command.ps1 -Text "/cam status"
#   powershell -File send-mc-command.ps1 -Text "/cam list" -NoEnter   # type only
#   powershell -File send-mc-command.ps1 -Text "/help" -Verify        # check first
#
# EXIT CODES: 0 sent / 2 no window / 3 bad argument / 4 verification failed
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$WindowKeyword = 'Minecraft',
  [int]$OpenDelayMs = 350,
  [int]$TypeDelayMs = 60,
  [switch]$NoEnter,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$RddRoot = if ($env:RDD_ROOT) { $env:RDD_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class McPost {
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  public const uint WM_KEYDOWN = 0x0100;
  public const uint WM_KEYUP = 0x0101;
  public const uint WM_CHAR = 0x0102;
  public static bool Key(IntPtr h, int vk) {
    bool a = PostMessage(h, WM_KEYDOWN, (IntPtr)vk, (IntPtr)0);
    bool b = PostMessage(h, WM_KEYUP, (IntPtr)vk, (IntPtr)0);
    return a && b;
  }
  public static bool Chars(IntPtr h, string s) {
    foreach (char c in s) {
      if (!PostMessage(h, WM_CHAR, (IntPtr)c, (IntPtr)0)) return false;
    }
    return true;
  }
}
'@

$proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$WindowKeyword*" } | Select-Object -First 1
if (-not $proc) { Write-Output 'NO_WINDOW'; exit 2 }
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_HWND'; exit 2 }

$VK_ESCAPE = 0x1B
$VK_T = 0x54
$VK_RETURN = 0x0D

# ---- optional verification: chat input bar must appear ---------------------
function Get-CaptureScript {
  Join-Path $RddRoot 'workspace\mc-openclaw-controller\scripts\capture-win.ps1'
}

function Invoke-Capture([string]$Path) {
  $cap = Get-CaptureScript
  if (-not (Test-Path -LiteralPath $cap)) { return $false }
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $cap -TitleMatch 'Minecraft' -Out $Path 2>$null | Out-Null
  } catch {
    # caller decides based on file existence
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return (Test-Path -LiteralPath $Path)
}

# Mean brightness of the chat input strip (bottom centre). The open line draws a
# dark translucent bar there, so "bar present" == mean brightness drops a lot.
function Get-InputStripLuma([string]$Path) {
  Add-Type -AssemblyName System.Drawing
  $bmp = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    $w = $bmp.Width
    $h2 = $bmp.Height
    if ($w -lt 100 -or $h2 -lt 100) { return -1.0 }
    $x0 = [int]($w * 0.28)
    $x1 = [int]($w * 0.72)
    $y0 = [int]($h2 * 0.92)
    $y1 = [int]($h2 * 0.965)
    $sum = 0.0
    $n = 0
    for ($y = $y0; $y -lt $y1; $y += 3) {
      for ($x = $x0; $x -lt $x1; $x += 3) {
        $p = $bmp.GetPixel($x, $y)
        $sum += (0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
        $n++
      }
    }
    if ($n -eq 0) { return -1.0 }
    return ($sum / $n)
  } finally {
    $bmp.Dispose()
  }
}

$tmpDir = Join-Path $env:TEMP 'rdd-send-mc'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$beforePng = Join-Path $tmpDir "before-$stamp.png"
$afterPng = Join-Path $tmpDir "after-$stamp.png"

$doVerify = [bool]$Verify
if ($doVerify) {
  if (-not (Invoke-Capture $beforePng)) {
    Write-Output 'VERIFY_SKIPPED no-capture-script'
    $doVerify = $false
  }
}

# 1) start from a closed chat screen
[void][McPost]::Key($h, $VK_ESCAPE)
Start-Sleep -Milliseconds 200

# 2) open the chat screen with a real keydown/keyup pair
$opened = [McPost]::Key($h, $VK_T)
Start-Sleep -Milliseconds $OpenDelayMs

if ($doVerify) {
  if (-not (Invoke-Capture $afterPng)) {
    Write-Output 'SENT_UNVERIFIED capture-after-failed'
    exit 4
  }
  $lumaBefore = Get-InputStripLuma $beforePng
  $lumaAfter = Get-InputStripLuma $afterPng
  if ($lumaBefore -lt 0 -or $lumaAfter -lt 0) {
    Write-Output 'SENT_UNVERIFIED image-read-failed'
    exit 4
  }
  $drop = $lumaBefore - $lumaAfter
  if ($drop -lt 10) {
    Write-Output ("SENT_UNVERIFIED chat-input-bar not detected (luma {0:N1} -> {1:N1}, drop {2:N1})" -f $lumaBefore, $lumaAfter, $drop)
    exit 4
  }
  Write-Output ("VERIFIED chat input bar appeared (luma {0:N1} -> {1:N1})" -f $lumaBefore, $lumaAfter)
}

# 3) fill the line char by char, 4) send it
$typed = [McPost]::Chars($h, $Text)
$waitMs = [Math]::Max(60, $TypeDelayMs * [Math]::Min(20, $Text.Length))
Start-Sleep -Milliseconds $waitMs

if (-not $NoEnter) {
  [void][McPost]::Key($h, $VK_RETURN)
  Start-Sleep -Milliseconds 250
  Write-Output "SENT [$Text] hwnd=$h post_ok=$opened typed=$typed"
} else {
  Write-Output "TYPED [$Text] hwnd=$h post_ok=$opened typed=$typed (no Enter)"
}
exit 0

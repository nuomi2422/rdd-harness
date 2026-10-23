# send-mc-command.ps1 -- type a slash command into the Minecraft chat box.
#
# ASCII-only on purpose (PS 5.1 + UTF-8 source = mojibake; see capture-win.ps1).
#
# WHY THIS EXISTS (2026-10-04, measured):
#   The obvious route -- OpenClaw's keyDown/keyUp actions -- CANNOT open or type
#   into the chat screen. neoforge-mod InputHandler.java has exactly 7 branches:
#   W A S D SPACE LEFTSHIFT LEFT_CONTROL. CommandHandler's name->keycode table
#   maps 20+ names (t, escape, enter, ctrl+a, delete, 1-9 ...) but the ones with
#   no branch silently do nothing while still replying {"success":true}.
#   So `--chat` (t -> ctrl+a -> delete -> typeText) cannot work by design.
#
#   mc-focus.ps1 proved the other half: once the MC window really has focus,
#   real OS-level keystrokes DO reach Minecraft. So: steal focus, put the text
#   on the clipboard, paste it.
#
# WHY VERIFICATION EXISTS (2026-10-23, repo TODO P1):
#   "success:true" from a keystroke helper only means "the call did not throw".
#   Receipt is not product (AGENTS 4.3). This script now captures the window
#   before and ~1s after the command and measures how much the lower-left area
#   changed. Chat lines live there, so a real delivery changes pixels; a missed
#   delivery leaves the frame identical.
#     exit 0  = SENT_VERIFIED
#     exit 4  = SENT_UNVERIFIED (typed/entered, but the frame did not change)
#
# USAGE:
#   powershell -File send-mc-command.ps1 -Text "/cam status"
#   powershell -File send-mc-command.ps1 -Text "/cam bind ACX" -Enter
#   powershell -File send-mc-command.ps1 -Text "/cam list" -NoEnter   # type only
#   powershell -File send-mc-command.ps1 -Text "/cam list" -Verify    # opt-in delivery check
#
# NOTES:
#   * -Text must not contain SendKeys metacharacters:  ^ % + ~ ( ) { } [ ]
#     (they would be interpreted, not typed). "/cam ..." never does.
#   * Returns FOCUS_OK / TYPED / SENT_VERIFIED / SENT_UNVERIFIED lines.
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$WindowKeyword = 'minecraft',
  [int]$PreDelayMs = 400,
  [int]$PostDelayMs = 500,
  [int]$VerifyDelayMs = 900,
  [double]$ChangeThreshold = 0.0015,
  [switch]$NoEnter,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'
# 2026-10-19: no hard-coded D:\rdd. Layout: <RDD root>\harness\rdd-harness\bin\ (this file)
#   -> three levels up = RDD root; RDD_ROOT env var overrides (other machine / temp copy).
$RddRoot = if ($env:RDD_ROOT) { $env:RDD_ROOT } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
$focus = Join-Path $RddRoot 'workspace\rdd-selfcompile\scripts\mc-focus.ps1'
if (-not (Test-Path -LiteralPath $focus)) { Write-Output "NO_FOCUS_HELPER $focus"; exit 3 }

foreach ($c in @('^', '%', '+', '~', '(', ')', '{', '}', '[', ']')) {
  if ($Text.Contains($c)) { Write-Output "BAD_CHAR $c -- SendKeys would eat it"; exit 3 }
}

# ---- delivery verification helpers -----------------------------------------
function Get-CaptureScript {
  Join-Path $RddRoot 'workspace\mc-openclaw-controller\scripts\capture-win.ps1'
}

function Invoke-Capture([string]$Path) {
  $cap = Get-CaptureScript
  if (-not (Test-Path -LiteralPath $cap)) { return $false }
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  # capture-win.ps1 writes its notes to stderr; with ErrorActionPreference=Stop
  # a native stderr line becomes a terminating NativeCommandError. Relax locally.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $cap -TitleMatch 'Minecraft' -Out $Path 2>$null | Out-Null
  } catch {
    # ignore: caller decides based on whether the file exists
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return (Test-Path -LiteralPath $Path)
}

# Village of chat text: lower-left band. Sampled every 4 px so this stays cheap.
function Measure-LowerLeftChange([string]$Before, [string]$After) {
  Add-Type -AssemblyName System.Drawing
  $ia = [System.Drawing.Bitmap]::FromFile($Before)
  $ib = [System.Drawing.Bitmap]::FromFile($After)
  try {
    $w = [Math]::Min($ia.Width, $ib.Width)
    $h = [Math]::Min($ia.Height, $ib.Height)
    if ($w -lt 50 -or $h -lt 50) { return -1.0 }
    $x0 = 0
    $x1 = [int]($w * 0.60)
    $y0 = [int]($h * 0.55)
    $y1 = $h
    $changed = 0
    $total = 0
    for ($y = $y0; $y -lt $y1; $y += 4) {
      for ($x = $x0; $x -lt $x1; $x += 4) {
        $pa = $ia.GetPixel($x, $y)
        $pb = $ib.GetPixel($x, $y)
        $d = [Math]::Abs($pa.R - $pb.R) + [Math]::Abs($pa.G - $pb.G) + [Math]::Abs($pa.B - $pb.B)
        if ($d -gt 30) { $changed++ }
        $total++
      }
    }
    if ($total -eq 0) { return -1.0 }
    return ($changed / $total)
  } finally {
    $ia.Dispose()
    $ib.Dispose()
  }
}

$tmpDir = Join-Path $env:TEMP 'rdd-send-mc'
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
$stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$beforePng = Join-Path $tmpDir "before-$stamp.png"
$afterPng = Join-Path $tmpDir "after-$stamp.png"

$doVerify = $Verify -and (-not $NoEnter)
if ($doVerify) {
  if (-not (Invoke-Capture $beforePng)) {
    $doVerify = $false
    Write-Output "VERIFY_SKIPPED no-capture-script-or-failed"
  }
}

. $focus
# mc-focus.ps1 also echoes status lines through the pipeline; the real title is
# the last object. Keep it a scalar so the SENT_VERIFIED line stays readable.
$titleRaw = Focus-MinecraftWindow -Keyword $WindowKeyword
$title = @($titleRaw)[-1]
if ([string]::IsNullOrEmpty($title)) { Write-Output 'NO_WINDOW'; exit 2 }
Start-Sleep -Milliseconds $PreDelayMs

Add-Type -AssemblyName System.Windows.Forms
Set-Clipboard -Value $Text

# 't' opens the vanilla chat screen (T is unbound in Numen: G/R/Y/V/M are taken,
# T is not). Clipboard paste avoids both SendKeys escaping and GLFW key mapping.
[System.Windows.Forms.SendKeys]::SendWait('t')
Start-Sleep -Milliseconds 450
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds $PostDelayMs

# ---- verify that the text actually reached the game ------------------------
# Capture AFTER typing but BEFORE Enter. Rationale (measured 2026-10-23): the same
# command twice produces the same chat lines, so an after-Enter frame can be
# identical to the before frame and look like a miss. The open chat input box,
# however, is a state change that only happens if the keystrokes really landed.
$verifyRatio = -1.0
if ($doVerify) {
  if (-not (Invoke-Capture $afterPng)) {
    Write-Output "VERIFY_SKIPPED capture-typed-failed"
  } else {
    $verifyRatio = Measure-LowerLeftChange $beforePng $afterPng
  }
}

if (-not $NoEnter) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 400
  if (-not $doVerify -or $verifyRatio -lt 0) {
    Write-Output "SENT [$Text] to '$title' (unverified)"
    exit 0
  }
  $pct = [Math]::Round($verifyRatio * 100, 3)
  if ($verifyRatio -ge $ChangeThreshold) {
    Write-Output "SENT_VERIFIED [$Text] to '$title' (typing changed lower-left by $pct%)"
    exit 0
  }
  Write-Output "SENT_UNVERIFIED [$Text] to '$title' (typing changed lower-left only $pct%, threshold $([Math]::Round($ChangeThreshold * 100, 3))%)"
  exit 4
} else {
  Write-Output "TYPED [$Text] into '$title' (no Enter)"
}
exit 0

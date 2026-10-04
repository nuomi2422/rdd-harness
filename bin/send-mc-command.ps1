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
# USAGE:
#   powershell -File send-mc-command.ps1 -Text "/cam status"
#   powershell -File send-mc-command.ps1 -Text "/cam bind ACX" -Enter
#   powershell -File send-mc-command.ps1 -Text "/cam list" -NoEnter   # type only
#
# NOTES:
#   * -Text must not contain SendKeys metacharacters:  ^ % + ~ ( ) { } [ ]
#     (they would be interpreted, not typed). "/cam ..." never does.
#   * Returns FOCUS_OK / TYPED / TIMEOUT-style lines; exit 0 on success.
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [string]$WindowKeyword = 'minecraft',
  [int]$PreDelayMs = 400,
  [int]$PostDelayMs = 500,
  [switch]$NoEnter
)

$ErrorActionPreference = 'Stop'
$focus = 'E:\restart developing doer\rdd-selfcompile\scripts\mc-focus.ps1'
if (-not (Test-Path -LiteralPath $focus)) { Write-Output "NO_FOCUS_HELPER $focus"; exit 3 }

foreach ($c in @('^', '%', '+', '~', '(', ')', '{', '}', '[', ']')) {
  if ($Text.Contains($c)) { Write-Output "BAD_CHAR $c -- SendKeys would eat it"; exit 3 }
}

. $focus
$title = Focus-MinecraftWindow -Keyword $WindowKeyword
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

if (-not $NoEnter) {
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 400
  Write-Output "SENT [$Text] to '$title'"
} else {
  Write-Output "TYPED [$Text] into '$title' (no Enter)"
}
exit 0
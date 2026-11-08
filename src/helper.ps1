# Long-running helper so we do not pay PowerShell start-up cost on every hotkey.
# Reads one command per line on stdin, writes one line of output per command.
#   info -> {"process":"chrome","title":"..."} for the focused window
#   copy -> sends Ctrl+C to the focused window, prints ok
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class MagpieWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint mapType);
}
"@
$wsh = New-Object -ComObject WScript.Shell
function Out-Line($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
# Test-only: simulate a sluggish PC (e.g. right after waking from sleep). Never set in normal use.
$testDelay = [int]("0" + $env:MAGPIE_TEST_HELPER_DELAY_MS)
Out-Line 'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($testDelay -gt 0) { Start-Sleep -Milliseconds $testDelay }
  if ($line -eq 'info') {
    $h = [MagpieWin]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [void][MagpieWin]::GetWindowText($h, $sb, 512)
    $procId = [uint32]0
    [void][MagpieWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $name = (Get-Process -Id $procId).ProcessName
    Out-Line (@{ process = "$name"; title = $sb.ToString() } | ConvertTo-Json -Compress)
  }
  elseif ($line -eq 'copy') {
    # SendKeys is used on purpose: it is the only method verified to copy from modern apps (the new Notepad, WinUI)
    # without typing a stray "c". Raw keybd_event Ctrl+C was tried and typed "c" over the selection there.
    # SendKeys can leave a lock key flipped on a busy PC, so the lock-key states are put back afterwards.
    $num = [Console]::NumberLock; $caps = [Console]::CapsLock
    $wsh.SendKeys('^c')
    Start-Sleep -Milliseconds 30
    if ([Console]::NumberLock -ne $num) { [MagpieWin]::keybd_event(0x90, 0x45, 1, [UIntPtr]::Zero); [MagpieWin]::keybd_event(0x90, 0x45, 3, [UIntPtr]::Zero) }
    if ([Console]::CapsLock -ne $caps) { [MagpieWin]::keybd_event(0x14, 0x3A, 0, [UIntPtr]::Zero); [MagpieWin]::keybd_event(0x14, 0x3A, 2, [UIntPtr]::Zero) }
    Out-Line 'ok'
  }
  elseif ($line -like 'focus *') {
    # Windows refuses to let a background app take the keyboard. Briefly joining the focused window's input
    # queue makes the request count as coming from the foreground, so the popup really receives typing.
    $h = [IntPtr][long]($line.Substring(6))
    $fg = [MagpieWin]::GetForegroundWindow()
    # Already has the keyboard (e.g. this request arrived late): doing it again would make it lose focus.
    if ($fg -eq $h) { Out-Line 'ok'; continue }
    $ignored = [uint32]0
    $fgThread = [MagpieWin]::GetWindowThreadProcessId($fg, [ref]$ignored)
    $me = [MagpieWin]::GetCurrentThreadId()
    $attached = $false
    if ($fgThread -ne 0 -and $fgThread -ne $me) { $attached = [MagpieWin]::AttachThreadInput($me, $fgThread, $true) }
    [void][MagpieWin]::ShowWindow($h, 5)
    [void][MagpieWin]::BringWindowToTop($h)
    [void][MagpieWin]::SetForegroundWindow($h)
    if ($attached) { [void][MagpieWin]::AttachThreadInput($me, $fgThread, $false) }
    Out-Line 'ok'
  }
  else { Out-Line 'unknown' }
}

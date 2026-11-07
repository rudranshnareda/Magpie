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
}
"@
$wsh = New-Object -ComObject WScript.Shell
function Out-Line($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
Out-Line 'ready'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
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
    $wsh.SendKeys('^c')
    Out-Line 'ok'
  }
  elseif ($line -like 'focus *') {
    # Windows refuses to let a background app take the keyboard. Briefly joining the focused window's input
    # queue makes the request count as coming from the foreground, so the popup really receives typing.
    $h = [IntPtr][long]($line.Substring(6))
    $fg = [MagpieWin]::GetForegroundWindow()
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

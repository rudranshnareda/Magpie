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
  else { Out-Line 'unknown' }
}

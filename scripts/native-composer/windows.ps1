param([string]$Layout, [string]$Keys, [long]$WindowHandle)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class NativeKeys {
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public KEYBDINPUT keyboard;
    [FieldOffset(0)] public MOUSEINPUT mouse;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern IntPtr LoadKeyboardLayout(string id, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wp, IntPtr lp);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process);
  [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  public static string Layout(IntPtr window, string layout) {
    SetForegroundWindow(window);
    var hkl=LoadKeyboardLayout(layout, 0);
    if(hkl==IntPtr.Zero) throw new Exception("Cannot load keyboard layout");
    SendMessage(window, 0x50, IntPtr.Zero, hkl);
    var actual=GetKeyboardLayout(GetWindowThreadProcessId(window, IntPtr.Zero));
    if(actual!=hkl) throw new Exception("Target window did not activate layout");
    return actual.ToInt64().ToString("X");
  }
  public static void Key(ushort scan, bool up) {
    var input=new INPUT { type=1, data=new INPUTUNION { keyboard=new KEYBDINPUT { scan=scan, flags=8u|(up?2u:0u) } } };
    if(SendInput(1,new[]{input},Marshal.SizeOf<INPUT>())!=1) throw new Exception("SendInput failed");
    Thread.Sleep(30);
  }
}
'@
$actual = [NativeKeys]::Layout([IntPtr]$WindowHandle, $Layout)
foreach ($key in $Keys.Split(',', [StringSplitOptions]::RemoveEmptyEntries)) {
  if ($key -eq 'pause') { Start-Sleep -Milliseconds 350; continue }
  $shift = $key -eq 'double'
  if ($shift) { [NativeKeys]::Key(0x2A, $false) }
  $scan = switch ($key) { quote {0x28} double {0x28} space {0x39} e {0x12} escape {1} default {throw "Unknown key $key"} }
  [NativeKeys]::Key($scan, $false)
  [NativeKeys]::Key($scan, $true)
  if ($shift) { [NativeKeys]::Key(0x2A, $true) }
}
Write-Output "layout=$Layout active=$actual"

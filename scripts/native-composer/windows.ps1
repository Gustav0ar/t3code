param([string]$Layout, [string]$Keys, [long]$WindowHandle, [switch]$Probe)
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
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint kind);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public uint size, flags;
    public IntPtr active, focus, capture, menuOwner, moveSize, caret;
    public int left, top, right, bottom;
  }
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  public static string Layout(IntPtr window, string layout) {
    SetForegroundWindow(window);
    var hkl=LoadKeyboardLayout(layout, 1);
    if(hkl==IntPtr.Zero) throw new Exception("Cannot load keyboard layout");
    SendMessage(window, 0x50, IntPtr.Zero, hkl);
    var info=new GUITHREADINFO { size=(uint)Marshal.SizeOf<GUITHREADINFO>() };
    if(!GetGUIThreadInfo(0,ref info)) throw new Exception("Cannot inspect focused native window");
    var target=info.focus==IntPtr.Zero?window:info.focus;
    SendMessage(target, 0x50, IntPtr.Zero, hkl);
    var actual=GetKeyboardLayout(GetWindowThreadProcessId(target, IntPtr.Zero));
    if(actual!=hkl) throw new Exception("Target window did not activate layout");
    return actual.ToInt64().ToString("X");
  }
  public static void Key(ushort scan, bool up) {
    var input=new INPUT { type=1, data=new INPUTUNION { keyboard=new KEYBDINPUT { vk=(ushort)MapVirtualKey(scan,3), scan=scan, flags=up?2u:0u } } };
    if(SendInput(1,new[]{input},Marshal.SizeOf<INPUT>())!=1) throw new Exception("SendInput failed");
    Thread.Sleep(30);
  }
}
'@
if ($Probe) {
  Add-Type -AssemblyName System.Windows.Forms
  $form = [System.Windows.Forms.Form]::new()
  $box = [System.Windows.Forms.TextBox]::new()
  $form.Controls.Add($box)
  $form.Show()
  $box.Focus() | Out-Null
  [System.Windows.Forms.Application]::DoEvents()
  $WindowHandle = $form.Handle.ToInt64()
}
$actual = [NativeKeys]::Layout([IntPtr]$WindowHandle, $Layout)
foreach ($key in $Keys.Split(',', [StringSplitOptions]::RemoveEmptyEntries)) {
  if ($key -eq 'pause') { Start-Sleep -Milliseconds 350; continue }
  $shift = $key -eq 'double'
  if ($shift) { [NativeKeys]::Key(0x2A, $false) }
  $scan = switch ($key) { quote {0x28} double {0x28} space {0x39} e {0x12} escape {1} default {throw "Unknown key $key"} }
  [NativeKeys]::Key($scan, $false)
  [NativeKeys]::Key($scan, $true)
  if ($shift) { [NativeKeys]::Key(0x2A, $true) }
  if ($Probe) { [System.Windows.Forms.Application]::DoEvents() }
}
if ($Probe) { Write-Output "native-textbox=$($box.Text)"; $form.Close() }
Write-Output "layout=$Layout active=$actual"

import AppKit
import Carbon
import CoreGraphics

func sourceID(_ source: TISInputSource) -> String {
  let pointer = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)!
  return Unmanaged<CFString>.fromOpaque(pointer).takeUnretainedValue() as String
}

let args = CommandLine.arguments
let desired = args[1] == "intl" ? "com.apple.keylayout.USInternational-PC" : "com.apple.keylayout.US"
let sources = TISCreateInputSourceList(nil, false).takeRetainedValue() as! [TISInputSource]
guard let source = sources.first(where: { sourceID($0) == desired }) else { fatalError("Missing layout \(desired)") }
guard TISEnableInputSource(source) == noErr, TISSelectInputSource(source) == noErr else { fatalError("Cannot select layout") }
guard sourceID(TISCopyCurrentKeyboardInputSource().takeRetainedValue()) == desired else { fatalError("Layout did not activate") }
guard CGPreflightPostEventAccess() else { fatalError("Runner does not permit native event posting") }
guard let app = NSRunningApplication(processIdentifier: pid_t(args[3])!) else { fatalError("No Electron process") }
app.activate(options: [.activateIgnoringOtherApps])
Thread.sleep(forTimeInterval: 0.1)
func key(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags = []) {
  guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down) else { fatalError("Cannot create key event") }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: 0.03)
}
for token in args[2].split(separator: ",") {
  if token == "pause" { Thread.sleep(forTimeInterval: 0.35); continue }
  let code: CGKeyCode
  switch token { case "quote", "double": code = 39; case "space": code = 49; case "e": code = 14; case "escape": code = 53; default: fatalError("Unknown key") }
  let flags: CGEventFlags = token == "double" ? .maskShift : []
  key(code, true, flags)
  key(code, false, flags)
}
print("layout=\(desired)")

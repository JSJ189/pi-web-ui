// Native one-request JSON helper. Build on macOS with swiftc DesktopUse.swift -o DesktopUse.
import Foundation
import AppKit
import ApplicationServices
import Vision
import Darwin

struct HelperError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

struct Request {
    let fields: [String: Any]
    func value(_ key: String) -> Any? {
        fields[key] ?? fields.first(where: { $0.key.caseInsensitiveCompare(key) == .orderedSame })?.value
    }
    func string(_ key: String, _ fallback: String = "") -> String {
        value(key) as? String ?? fallback
    }
    func number(_ key: String, _ fallback: Double = 0) throws -> Double {
        guard let raw = value(key) else { return fallback }
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else {
            throw HelperError("\(key) must be a finite number")
        }
        return n.doubleValue
    }
    func integer(_ key: String, _ fallback: Int, _ range: ClosedRange<Int>) throws -> Int {
        let n = try number(key, Double(fallback))
        guard n.rounded() == n, n >= Double(range.lowerBound), n <= Double(range.upperBound) else {
            throw HelperError("\(key) must be an integer in \(range)")
        }
        return Int(n)
    }
    func flag(_ key: String) -> Bool {
        if let n = value(key) as? NSNumber { return n.boolValue }
        return ["true", "1", "yes"].contains(string(key).lowercased())
    }
    func point(_ x: String = "X", _ y: String = "Y") throws -> CGPoint {
        let px = try number(x), py = try number(y)
        guard abs(px) <= 1_000_000, abs(py) <= 1_000_000 else {
            throw HelperError("Coordinates exceed the supported desktop range")
        }
        return CGPoint(x: px, y: py)
    }
}

func requireAX() throws {
    guard AXIsProcessTrusted() else {
        throw HelperError("Accessibility permission is required. Enable the helper or its launching app in System Settings > Privacy & Security > Accessibility, then restart it. No permission request was opened.")
    }
}

func requireCapture() throws {
    if #available(macOS 10.15, *) {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError("Screen Recording permission is required. Enable the helper or its launching app in System Settings > Privacy & Security > Screen Recording, then restart it. No permission request was opened.")
        }
    } else {
        throw HelperError("Screen capture requires macOS 10.15 or later")
    }
}

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    guard let value = axValue(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func axString(_ element: AXUIElement, _ attribute: String) -> String {
    String((axValue(element, attribute) as? String ?? "").prefix(512))
}

func axRect(_ element: AXUIElement) -> CGRect? {
    guard let p = axValue(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = axValue(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var position = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &position),
          AXValueGetValue(s as! AXValue, .cgSize, &size),
          position.x.isFinite, position.y.isFinite, size.width.isFinite, size.height.isFinite,
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: position, size: size)
}

func rectJSON(_ r: CGRect) -> [String: Double] {
    ["x": Double(r.minX), "y": Double(r.minY), "w": Double(r.width), "h": Double(r.height)]
}

struct Window {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let process: String
    let rect: CGRect
}

func windows() -> [Window] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? NSNumber,
              let pid = info[kCGWindowOwnerPID as String] as? NSNumber,
              let layer = info[kCGWindowLayer as String] as? NSNumber, layer.intValue == 0,
              let bounds = info[kCGWindowBounds as String] as? [String: Any],
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0 else { return nil }
        return Window(id: id.uint32Value, pid: pid.int32Value,
                      title: info[kCGWindowName as String] as? String ?? "",
                      process: info[kCGWindowOwnerName as String] as? String ?? "", rect: rect)
    }
}

func contains(_ text: String, _ query: String) -> Bool {
    text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil
}

func selectWindow(_ request: Request, _ list: [Window]) throws -> Window {
    let hwnd = try request.integer("Hwnd", 0, 0...Int(UInt32.max))
    let title = request.string("Title"), process = request.string("Process")
    if hwnd != 0 {
        guard let match = list.first(where: { $0.id == CGWindowID(hwnd) }) else { throw HelperError("No visible window matches Hwnd \(hwnd)") }
        return match
    }
    if !title.isEmpty || !process.isEmpty {
        guard let match = list.first(where: {
            (title.isEmpty || contains($0.title, title)) && (process.isEmpty || contains($0.process, process))
        }) else { throw HelperError("No visible window matches Title/Process") }
        return match
    }
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
          let match = list.first(where: { $0.pid == pid }) else { throw HelperError("No foreground window is available") }
    return match
}

func windowID(_ element: AXUIElement, _ pid: pid_t, _ list: [Window]) -> CGWindowID? {
    AXUIElementSetMessagingTimeout(element, 0.2)
    guard let r = axRect(element) else { return nil }
    let title = axString(element, kAXTitleAttribute)
    let matches = list.filter {
        $0.pid == pid && abs($0.rect.minX - r.minX) < 3 && abs($0.rect.minY - r.minY) < 3 &&
        abs($0.rect.width - r.width) < 3 && abs($0.rect.height - r.height) < 3
    }
    return matches.first(where: { $0.title == title })?.id ?? (matches.count == 1 ? matches[0].id : nil)
}

func elements(_ request: Request) throws -> [String: Any] {
    try requireAX()
    let scope = request.string("Scope", "foreground").lowercased()
    guard ["foreground", "desktop", "window"].contains(scope) else { throw HelperError("Scope must be foreground, desktop, or window") }
    let maxNodes = try request.integer("MaxNodes", 300, 1...2000)
    let maxDepth = try request.integer("MaxDepth", 5, 0...20)
    let query = request.string("Query")
    let list = windows()
    let deadline = ProcessInfo.processInfo.systemUptime + 8
    var nodes: [[String: Any]] = [], visited: [AXUIElement] = []
    var truncated = false, examined = 0, bytes = 0
    let root: AXUIElement
    var rootName = "desktop"
    if scope == "desktop" {
        root = AXUIElementCreateSystemWide()
    } else {
        let selected = try selectWindow(request, list)
        let app = AXUIElementCreateApplication(selected.pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        let candidates = axValue(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
        if let match = candidates.prefix(64).first(where: {
            ProcessInfo.processInfo.systemUptime < deadline && windowID($0, selected.pid, list) == selected.id
        }) {
            root = match
        } else if request.string("Title").isEmpty && request.string("Process").isEmpty,
                  let focused = axElement(app, kAXFocusedWindowAttribute) {
            root = focused
        } else {
            throw HelperError("The selected window does not expose an accessible window tree")
        }
        rootName = selected.title.isEmpty ? selected.process : selected.title
    }
    AXUIElementSetMessagingTimeout(root, 0.2)

    func walk(_ element: AXUIElement, _ depth: Int, _ path: String) {
        guard ProcessInfo.processInfo.systemUptime < deadline, examined < 6000, nodes.count < maxNodes else { truncated = true; return }
        if visited.contains(where: { CFEqual($0, element) }) { return }
        visited.append(element)
        examined += 1
        AXUIElementSetMessagingTimeout(element, 0.2)
        let role = axString(element, kAXRoleAttribute)
        let type = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
        var name = axString(element, kAXTitleAttribute)
        if name.isEmpty { name = axString(element, kAXDescriptionAttribute) }
        if name.isEmpty { name = axString(element, kAXHelpAttribute) }
        if name.isEmpty && role == kAXStaticTextRole { name = axString(element, kAXValueAttribute) }
        if let rect = axRect(element), query.isEmpty || contains(name, query) || contains(type, query) {
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            let proc = NSRunningApplication(processIdentifier: pid)?.localizedName ?? ""
            var node: [String: Any] = ["id": path, "type": type, "name": name, "rect": rectJSON(rect), "proc": String(proc.prefix(512))]
            if role == kAXWindowRole, let id = windowID(element, pid, list) { node["hwnd"] = id }
            let size = (try? JSONSerialization.data(withJSONObject: node).count) ?? 4096
            guard bytes + size <= 1_000_000 else { truncated = true; return }
            bytes += size
            nodes.append(node)
        }
        // Copy a bounded slice instead of materializing an arbitrarily large AXChildren array.
        var childCount: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &childCount) == .success, childCount > 0 else { return }
        guard depth < maxDepth else { truncated = true; return }
        let limit = min(childCount, 256)
        var children: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, limit, &children) == .success,
              let kids = children as? [AXUIElement] else { return }
        if childCount > limit { truncated = true }
        for (index, child) in kids.enumerated() {
            if nodes.count >= maxNodes || examined >= 6000 || ProcessInfo.processInfo.systemUptime >= deadline { truncated = true; break }
            walk(child, depth + 1, "\(path).\(index)")
        }
    }

    if scope == "desktop" {
        // The system-wide AX root does not enumerate applications through AXChildren.
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated }
        for (index, app) in apps.prefix(128).enumerated() {
            if nodes.count >= maxNodes || ProcessInfo.processInfo.systemUptime >= deadline { truncated = true; break }
            walk(AXUIElementCreateApplication(app.processIdentifier), 0, "0.\(index)")
        }
        if apps.count > 128 { truncated = true }
    } else {
        walk(root, 0, "0")
    }
    return ["scope": scope, "root": rootName, "count": nodes.count, "truncated": truncated, "nodes": nodes]
}

// Resolve the legacy API dynamically: newer SDKs mark the Swift declaration unavailable,
// although the system still exports it. This also gives a useful error if it is removed.
func capture(_ rect: CGRect, _ id: CGWindowID?) throws -> CGImage {
    typealias CaptureFunction = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY) else {
        throw HelperError("Cannot load CoreGraphics")
    }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "CGWindowListCreateImage") else { throw HelperError("CGWindowListCreateImage is unavailable on this macOS version") }
    let function = unsafeBitCast(symbol, to: CaptureFunction.self)
    let options: CGWindowListOption = id == nil ? .optionOnScreenOnly : .optionIncludingWindow
    guard let image = function(rect, options.rawValue, id ?? kCGNullWindowID, CGWindowImageOption.boundsIgnoreFraming.rawValue)?.takeRetainedValue() else {
        throw HelperError("Window capture failed. Verify Screen Recording permission and that the window is visible.")
    }
    return image
}

func screenshot(_ request: Request) throws -> [String: Any] {
    try requireCapture()
    let maxWidth = try request.integer("MaxWidth", 1600, 1...8192)
    let list = windows()
    let hwnd = try request.integer("Hwnd", 0, 0...Int(UInt32.max))
    let hasTarget = !request.string("Title").isEmpty || !request.string("Process").isEmpty || hwnd != 0
    let target: Window?
    if hasTarget { target = try selectWindow(request, list) }
    else { target = try selectWindow(request, list) }
    let rect: CGRect
    if let window = target { rect = window.rect }
    else {
        var displays = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        let capacity = UInt32(displays.count)
        guard CGGetActiveDisplayList(capacity, &displays, &count) == .success, count > 0 else { throw HelperError("No active display is available") }
        rect = displays.prefix(Int(count)).reduce(CGRect.null) { $0.union(CGDisplayBounds($1)) }
    }
    let original = try capture(rect, target?.id)
    let scale = min(1, Double(maxWidth) / Double(original.width))
    let width = max(1, Int((Double(original.width) * scale).rounded()))
    let height = max(1, Int((Double(original.height) * scale).rounded()))
    guard width <= 32768, height <= 32768, width * height <= 64_000_000 else { throw HelperError("Capture dimensions exceed the image budget; reduce MaxWidth") }
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw HelperError("Cannot allocate capture image")
    }
    context.interpolationQuality = .high
    context.draw(original, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let image = context.makeImage(), let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        throw HelperError("Cannot encode capture as PNG")
    }
    let output = request.string("Out")
    let url = output.isEmpty
        ? FileManager.default.temporaryDirectory.appendingPathComponent("desktop-use-\(UUID().uuidString).png")
        : URL(fileURLWithPath: (output as NSString).expandingTildeInPath)
    var ocr: [[String: Any]] = []
    if request.flag("Ocr") {
        if #available(macOS 10.15, *) {
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            recognition.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition])
            for observation in (recognition.results ?? []).prefix(120) {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let r = observation.boundingBox
                let x = r.minX * Double(width), y = (1 - r.maxY) * Double(height)
                let w = r.width * Double(width), h = r.height * Double(height)
                ocr.append(["text": String(candidate.string.prefix(160)), "x": x, "y": y, "w": w, "h": h, "cx": x + w / 2, "cy": y + h / 2])
            }
        } else { throw HelperError("OCR requires macOS 10.15 or later") }
    }
    try png.write(to: url, options: .atomic)
    return ["out": url.path, "x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height,
            "imgW": width, "imgH": height, "method": "CGWindowListCreateImage", "ocr": ocr, "cursorInWin": false]
}

func post(_ event: CGEvent?) throws {
    guard let event = event else { throw HelperError("Cannot create native input event") }
    event.post(tap: .cghidEventTap)
}

func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton = .left, _ clicks: Int64 = 1) throws {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: clicks)
    try post(event)
}

func shortcut(_ text: String) throws {
    let parts = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    let modifiers: [String: (CGKeyCode, CGEventFlags)] = ["ctrl": (59, .maskControl), "alt": (58, .maskAlternate), "shift": (56, .maskShift), "win": (55, .maskCommand)]
    let keys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
        "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
        "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
        "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "enter": 36, "tab": 48, "space": 49,
        "backspace": 51, "esc": 53, "escape": 53, "delete": 117, "home": 115, "end": 119,
        "pgup": 116, "pgdn": 121, "left": 123, "right": 124, "down": 125, "up": 126, "insert": 114,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
        "f16": 106, "f17": 64, "f18": 79, "f19": 80, "f20": 90
    ]
    guard !parts.isEmpty, Set(parts).count == parts.count, !parts.contains(""),
          parts.allSatisfy({ modifiers[$0] != nil || keys[$0] != nil }),
          parts.filter({ modifiers[$0] == nil }).count <= 1 else {
        throw HelperError("Invalid or unsupported macOS shortcut: \(text). Use ctrl/alt/shift/win (win = Command); native function keys support F1–F20.")
    }
    var held: [CGKeyCode] = [], flags: CGEventFlags = []
    defer {
        for code in held.reversed() {
            if let modifier = modifiers.values.first(where: { $0.0 == code }) { flags.subtract(modifier.1) }
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }
    for part in parts {
        if let (code, flag) = modifiers[part] {
            flags.insert(flag)
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
            event?.flags = flags
            held.append(code)
            try post(event)
        }
    }
    if let main = parts.first(where: { modifiers[$0] == nil }), let code = keys[main] {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
        down?.flags = flags
        up?.flags = flags
        guard down != nil, up != nil else { throw HelperError("Cannot create keyboard events") }
        held.append(code)
        try post(down)
        usleep(20_000)
        try post(up)
        held.removeLast()
    }
}

func input(_ request: Request, _ op: String) throws -> [String: Any] {
    try requireAX()
    switch op {
    case "move":
        let p = try request.point()
        try mouse(.mouseMoved, p)
        return ["x": p.x, "y": p.y]
    case "click":
        let p = try request.point(), buttonName = request.string("Button", "left").lowercased()
        let button: CGMouseButton, down: CGEventType, up: CGEventType
        switch buttonName {
        case "left": button = .left; down = .leftMouseDown; up = .leftMouseUp
        case "right": button = .right; down = .rightMouseDown; up = .rightMouseUp
        case "middle": button = .center; down = .otherMouseDown; up = .otherMouseUp
        default: throw HelperError("Button must be left, right, or middle")
        }
        try mouse(.mouseMoved, p)
        defer { try? mouse(up, p, button) }
        for index in 1...(request.flag("Double") ? 2 : 1) {
            try mouse(down, p, button, Int64(index))
            try mouse(up, p, button, Int64(index))
            if index == 1 && request.flag("Double") { usleep(80_000) }
        }
        return ["x": p.x, "y": p.y, "button": buttonName, "double": request.flag("Double") ? 1 : 0]
    case "key":
        let keys = request.string("Keys")
        try shortcut(keys)
        return ["keys": keys]
    case "paste":
        let text = request.string("Text")
        guard text.utf8.count <= 1_000_000 else { throw HelperError("Text exceeds the 1 MB input budget") }
        // Keep each event small and never split a UTF-16 surrogate pair.
        var chunks: [[UniChar]] = [], chunk: [UniChar] = []
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            if chunk.count + units.count > 20 { chunks.append(chunk); chunk = [] }
            chunk.append(contentsOf: units)
        }
        if !chunk.isEmpty { chunks.append(chunk) }
        for units in chunks {
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw HelperError("Cannot create Unicode keyboard events") }
            units.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
            }
            down.flags = []; up.flags = []
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            usleep(1_000)
        }
        return ["chars": text.utf16.count]
    case "scroll":
        let p = try request.point()
        let delta = try request.integer("Delta", 360, -12000...12000)
        let horizontal = request.flag("Horizontal")
        try mouse(.mouseMoved, p)
        usleep(60_000)
        // Win32's 120 units per notch maps to three native scroll lines.
        let lines = Int32((Double(delta) / 40).rounded())
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                            wheel1: horizontal ? 0 : lines, wheel2: horizontal ? lines : 0, wheel3: 0)
        try post(event)
        return ["delta": delta, "horizontal": horizontal ? 1 : 0]
    case "drag":
        let start = try request.point(), end = try request.point("ToX", "ToY")
        let duration = try request.integer("Duration", 500, 100...2000)
        var current = start
        try mouse(.mouseMoved, start)
        defer { try? mouse(.leftMouseUp, current) }
        try mouse(.leftMouseDown, start)
        for index in 1...40 {
            usleep(useconds_t(duration * 1000 / 40))
            let t = Double(index) / 40
            current = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
            try mouse(.leftMouseDragged, current)
        }
        return ["x": end.x, "y": end.y]
    case "focus":
        guard !request.string("Title").isEmpty || !request.string("Process").isEmpty else { throw HelperError("Focus requires Title or Process") }
        let selected = try selectWindow(request, windows())
        let app = AXUIElementCreateApplication(selected.pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        guard let candidates = axValue(app, kAXWindowsAttribute) as? [AXUIElement],
              let window = candidates.prefix(64).first(where: { windowID($0, selected.pid, [selected]) == selected.id }) else {
            throw HelperError("Selected window is not accessible")
        }
        AXUIElementSetMessagingTimeout(window, 0.2)
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        guard let running = NSRunningApplication(processIdentifier: selected.pid), running.activate(options: [.activateIgnoringOtherApps]) else {
            throw HelperError("Cannot activate the selected application")
        }
        guard AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success else { throw HelperError("Cannot raise the selected window") }
        _ = AXUIElementSetAttributeValue(app, kAXFocusedWindowAttribute as CFString, window)
        return ["title": selected.title, "hwnd": selected.id]
    default: throw HelperError("Unknown operation: \(op)")
    }
}

var operation = ""
var response: [String: Any]
do {
    // Read at most 2 MB plus one byte, rejecting oversized requests before JSON parsing.
    var data = Data()
    while true {
        let chunk = FileHandle.standardInput.readData(ofLength: min(65536, 2_000_001 - data.count))
        if chunk.isEmpty { break }
        data.append(chunk)
        guard data.count <= 2_000_000 else { throw HelperError("JSON request exceeds 2 MB") }
    }
    guard let fields = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw HelperError("Expected one JSON object on stdin") }
    let request = Request(fields: fields)
    operation = request.string("Op").lowercased()
    switch operation {
    case "elements": response = try elements(request)
    case "screenshot": response = try screenshot(request)
    case "move", "click", "key", "paste", "scroll", "drag", "focus": response = try input(request, operation)
    default: throw HelperError("Unknown operation: \(operation). Expected elements, screenshot, move, click, key, paste, scroll, drag, or focus.")
    }
    response["ok"] = true
    response["op"] = operation
} catch {
    response = ["ok": false, "op": operation, "error": String(describing: error)]
}
if let output = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data([10]))
} else {
    FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"Cannot encode helper response\"}\n".utf8))
}

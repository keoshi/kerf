// Kerf for Silhouette: a minimal menu-bar app that keeps the Kerf helper running, so the
// Figma plugin can send cuts to a Silhouette cutter.
//
// - Runs the bundled Node (Contents/Helpers/node) with the bundled helper (Contents/Resources/helper/main.js)
//   and restarts it if it crashes.
// - Shows the cutter status from the helper's /status endpoint.
// - "Open at Login" in its menu (off by default) keeps it available for the Figma plugin.
// - Handles kerf:// links (launching the app is all they do).
// - Being an app bundle with NSBluetoothAlwaysUsageDescription gives the helper its own Bluetooth
//   permission; the helper is our child process and shares it.

import AppKit
import CoreBluetooth
import ServiceManagement

/// The helper exits with this code when another helper already owns the port.
let exitPortInUse: Int32 = 3
let statusURL = URL(string: "http://127.0.0.1:47821/status")!

final class AppDelegate: NSObject, NSApplicationDelegate, CBCentralManagerDelegate {
  private var statusItem: NSStatusItem!
  private let stateItem = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
  private let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
  private var process: Process?
  private var restarts = 0
  private var quitting = false
  private var helperNote: String?
  /// Only used to trigger and observe the Bluetooth permission prompt; the helper does the real work.
  private var bluetooth: CBCentralManager?

  private let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/Kerf/helper.log")

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Registered before launch finishes so the URL that launched us is delivered here too.
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleURL(_:reply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // No windows, but the helper must keep running: opt out of macOS quitting idle apps.
    ProcessInfo.processInfo.disableAutomaticTermination("Keeps the cutter helper running")

    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    // A blade cutting a line (Resources/MenuBarIcon.png, drawn by make-icons.swift); macOS tints template images.
    let image = NSImage(named: "MenuBarIcon") ?? NSImage(systemSymbolName: "scissors", accessibilityDescription: "Kerf")
    image?.size = NSSize(width: 18, height: 18)
    image?.isTemplate = true
    image?.accessibilityDescription = "Kerf"
    statusItem.button?.image = image
    statusItem.button?.toolTip = "Kerf: cut Figma designs on your Silhouette"

    let menu = NSMenu()
    let title = NSMenuItem(title: "Kerf for Silhouette", action: nil, keyEquivalent: "")
    title.isEnabled = false
    menu.addItem(title)
    stateItem.isEnabled = false
    menu.addItem(stateItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Open Log", action: #selector(openLog), keyEquivalent: "")
    menu.addItem(withTitle: "Bluetooth Settings…", action: #selector(openBluetoothSettings), keyEquivalent: "")
    menu.addItem(loginItem)
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Kerf", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    for item in menu.items where item.action != nil && item.action != #selector(NSApplication.terminate(_:)) {
      item.target = self
    }
    statusItem.menu = menu

    updateLoginItem()
    requestBluetoothThenStart()
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.pollStatus() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    guard let process, process.isRunning else { return }
    process.terminate()  // SIGTERM: the helper disconnects from the cutter before exiting
    let deadline = Date().addingTimeInterval(3)
    while process.isRunning && Date() < deadline { usleep(50_000) }
  }

  @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    // Being launched is all a kerf:// link asks for; make sure the helper is up.
    if process?.isRunning != true && bluetooth == nil { restarts = 0; requestBluetoothThenStart() }
  }

  // MARK: Bluetooth permission

  /// macOS delays permission prompts for background apps until they come to the front, which a menu-bar
  /// app never does. So ask here, in the foreground, and start the helper once the user has answered.
  private func requestBluetoothThenStart() {
    if CBCentralManager.authorization == .notDetermined {
      setState("Waiting for Bluetooth permission…")
      // The app was launched as a regular (Dock) app for this; see the bottom of the file.
      NSApp.activate(ignoringOtherApps: true)
      bluetooth = CBCentralManager(delegate: self, queue: nil)
    } else {
      bluetoothDecided()
    }
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    guard CBCentralManager.authorization != .notDetermined, bluetooth != nil else { return }
    bluetooth = nil
    bluetoothDecided()
  }

  private func bluetoothDecided() {
    NSApp.setActivationPolicy(.accessory)  // back to menu bar only
    if CBCentralManager.authorization == .allowedAlways {
      if process?.isRunning != true { startHelper() }
    } else {
      helperNote = "Bluetooth access denied: allow it in System Settings"
      setState(helperNote!)
    }
  }

  @objc private func openBluetoothSettings() {
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth")!)
  }

  // MARK: Helper process

  private func startHelper() {
    let bundle = Bundle.main.bundleURL
    let node = bundle.appendingPathComponent("Contents/Helpers/node")
    let script = bundle.appendingPathComponent("Contents/Resources/helper/main.js")

    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    let log = try? FileHandle(forWritingTo: logURL)
    _ = try? log?.seekToEnd()

    let p = Process()
    p.executableURL = node
    p.arguments = [script.path]
    p.currentDirectoryURL = script.deletingLastPathComponent()
    p.standardOutput = log
    p.standardError = log
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async { self?.helperExited(proc.terminationStatus) }
    }
    do {
      try p.run()
      process = p
      helperNote = nil
      setState("Helper running")
    } catch {
      setState("Couldn't start the helper: \(error.localizedDescription)")
    }
  }

  private func helperExited(_ code: Int32) {
    process = nil
    if quitting { return }
    if code == exitPortInUse {
      helperNote = "Another helper is already running (e.g. npm run helper)"
      return setState(helperNote!)
    }
    restarts += 1
    let delay = min(30.0, pow(2.0, Double(restarts)))
    helperNote = "Helper stopped (code \(code)); restarting…"
    setState(helperNote!)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.startHelper() }
  }

  private func pollStatus() {
    var request = URLRequest(url: statusURL)
    request.setValue("1", forHTTPHeaderField: "X-Kerf-Passive")  // don't keep the cutter connected
    URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
      let text = data.flatMap(Self.describe)
      DispatchQueue.main.async {
        guard let self else { return }
        if let text { self.restarts = 0; self.setState(text) } else if let note = self.helperNote { self.setState(note) }
      }
    }.resume()
  }

  private static func describe(_ data: Data) -> String? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    guard let cutter = json["cutter"] as? [String: Any] else { return "Helper running (dry run)" }
    let name = cutter["name"] as? String ?? "cutter"
    switch cutter["connection"] as? String {
    case "connected": return "Connected to \(name)"
    case "scanning": return "Looking for a cutter…"
    case "connecting": return "Connecting to \(name)…"
    default: return "Ready · connects when Figma asks"
    }
  }

  private func setState(_ text: String) { stateItem.title = text }

  // MARK: Login item

  @objc private func toggleLogin() {
    let service = SMAppService.mainApp
    do {
      if service.status == .enabled { try service.unregister() } else { try service.register() }
    } catch {
      let alert = NSAlert()
      alert.messageText = "Couldn't change Open at Login"
      alert.informativeText = "\(error.localizedDescription)\n\nYou can add Kerf in System Settings → General → Login Items."
      alert.runModal()
    }
    updateLoginItem()
  }

  private func updateLoginItem() {
    loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
  }

  @objc private func openLog() { NSWorkspace.shared.open(logURL) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
// Menu bar only, except while the Bluetooth question is pending: macOS shows permission prompts only
// for apps in the foreground, and accessory apps don't count.
app.setActivationPolicy(CBCentralManager.authorization == .notDetermined ? .regular : .accessory)
app.run()

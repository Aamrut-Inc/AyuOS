// AyuOS.app — a native window and menu-bar status for the AyuOS app that runs
// in the background (the login agent serving http://127.0.0.1:3000).
// Quitting this app only closes the window/menu; syncing keeps running.

import AppKit
import WebKit

let appURL = URL(string: "http://127.0.0.1:3000/")!
let statusURL = URL(string: "http://127.0.0.1:3000/api/status")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var statusLine = NSMenuItem(title: "Checking sync status…", action: nil, keyEquivalent: "")
    var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenuBar()
        buildMainMenu()
        let launchedAtLogin = CommandLine.arguments.contains("--background")
        if !launchedAtLogin { showWindow() }
        refreshStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshStatus() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    // MARK: Window

    @objc func showWindow() {
        if window == nil {
            let config = WKWebViewConfiguration()
            webView = WKWebView(frame: .zero, configuration: config)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1000, height: 780),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered, defer: false)
            window.title = "AyuOS"
            window.contentView = webView
            window.isReleasedWhenClosed = false
            window.setFrameAutosaveName("AyuOSMain")
            if window.frame.origin == .zero { window.center() }
            load()
        }
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func load() {
        webView.load(URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    @objc func reload() { if webView != nil { load() } }

    // The background app may still be starting (e.g. right after login, while
    // Docker comes up): show a friendly page and retry.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let html = """
        <html><body style="font-family:-apple-system;max-width:520px;margin:120px auto;color:#333;text-align:center">
        <h2>AyuOS is starting…</h2><p style="color:#777">Waiting for the background app (this can take a minute after a restart).</p>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.load() }
    }

    // Logins with Oura, Whoop and hospitals happen in the user's browser:
    // many sign-in pages refuse to run inside embedded web views.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, let host = url.host,
           host != "127.0.0.1" && host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // Links that open a new window (original PDFs, documents) go to the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // File pickers (lab PDF and Apple Health uploads).
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    // MARK: Menu bar status

    func buildMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Ayu ◌"
        let menu = NSMenu()
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Open AyuOS", action: #selector(showWindow), keyEquivalent: "o")
        menu.addItem(withTitle: "Sync wearables now", action: #selector(syncNow), keyEquivalent: "s")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit AyuOS window (syncing continues)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
    }

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide AyuOS", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit AyuOS", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = main
    }

    @objc func syncNow() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:3000/sync/now")!)
        request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.statusLine.title = "Sync requested — new data lands in a few minutes" }
        }.resume()
    }

    func refreshStatus() {
        URLSession.shared.dataTask(with: statusURL) { [weak self] data, _, error in
            var symbol = "◌"
            var line = "AyuOS isn't running yet"
            if error == nil, let data = data,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let jobs = json["jobs"] as? [[String: Any]] {
                let failing = jobs.filter { ($0["lastStatus"] as? String) == "failed" }
                let free = json["freeDiskBytes"] as? Double
                let lowDisk = free.map { $0 < 5 * 1_073_741_824 } ?? false
                let mirror = jobs.first { ($0["job"] as? String) == "wearables-mirror" }
                let last = (mirror?["lastSuccessAt"] as? String).flatMap(Self.relative) ?? "never"
                if !failing.isEmpty {
                    symbol = "●!"
                    line = "Problem with \(failing.count) sync job(s) — open AyuOS"
                } else if lowDisk {
                    symbol = "●!"
                    line = "Disk space is low — open AyuOS"
                } else {
                    symbol = "●"
                    line = "Wearables synced \(last)"
                }
            }
            DispatchQueue.main.async {
                self?.statusItem.button?.title = "Ayu \(symbol)"
                self?.statusLine.title = line
            }
        }.resume()
    }

    static func relative(_ iso: String) -> String? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else { return nil }
        return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
    }
}

// One instance only: the menu-bar copy starts at login, so opening the app
// from Launchpad/Finder asks that copy to show its window and exits.
let showWindowNotification = Notification.Name("com.ayuos.app.ui.showWindow")
let others = NSRunningApplication.runningApplications(withBundleIdentifier: "com.ayuos.app.ui")
    .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
if !others.isEmpty {
    if !CommandLine.arguments.contains("--background") {
        DistributedNotificationCenter.default().postNotificationName(
            showWindowNotification, object: nil, userInfo: nil, deliverImmediately: true)
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
DistributedNotificationCenter.default().addObserver(
    forName: showWindowNotification, object: nil, queue: .main) { _ in delegate.showWindow() }
app.delegate = delegate
app.setActivationPolicy(CommandLine.arguments.contains("--background") ? .accessory : .regular)
app.run()

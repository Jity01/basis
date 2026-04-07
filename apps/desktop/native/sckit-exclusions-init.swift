import AppKit
import Foundation
import ScreenCaptureKit

@main
struct SCKitExclusionsInit {
  static func main() async {
    guard #available(macOS 12.3, *) else {
      fputs("ScreenCaptureKit unavailable on this macOS version.\n", stderr)
      exit(2)
    }

    guard CommandLine.arguments.count > 1 else {
      fputs("Usage: sckit-exclusions-init <json-bundle-id-array>\n", stderr)
      exit(1)
    }

    let rawArg = CommandLine.arguments[1]
    guard let data = rawArg.data(using: .utf8) else {
      fputs("Invalid UTF-8 argument.\n", stderr)
      exit(1)
    }

    let bundleIds: Set<String>
    do {
      let parsed = try JSONSerialization.jsonObject(with: data, options: [])
      guard let values = parsed as? [String] else {
        fputs("Expected JSON string array.\n", stderr)
        exit(1)
      }
      bundleIds = Set(values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
    } catch {
      fputs("Failed to parse JSON: \(error.localizedDescription)\n", stderr)
      exit(1)
    }

    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first else {
        fputs("No display found for ScreenCaptureKit filter initialization.\n", stderr)
        exit(3)
      }

      let excludedApps = content.applications.filter { app in
        guard let id = app.bundleIdentifier else { return false }
        return bundleIds.contains(id)
      }

      _ = SCContentFilter(display: display, excludingApplications: excludedApps, exceptingWindows: [])
      print("{\"ok\":true,\"excludedApplicationCount\":\(excludedApps.count)}")
      exit(0)
    } catch {
      fputs("Failed to initialize ScreenCaptureKit content filter: \(error.localizedDescription)\n", stderr)
      exit(4)
    }
  }
}

import SwiftUI

/// Maps a vault file to the server convert tool + the output formats it supports.
/// Mirrors server.js TOOL_SPECS (video-convert / audio-convert / image-convert).
enum ConvertKit {
    /// (serverToolName, [targetFormats]) for a file, or nil if it can't be converted.
    static func plan(for item: FileItem) -> (tool: String, formats: [String])? {
        let ext = (item.name as NSString).pathExtension.lowercased()
        let video = ["mp4","ts","mkv","webm","mov","avi","flv","m4v","wmv","mpg","mpeg","3gp"]
        let audio = ["mp3","wav","m4a","aac","flac","ogg","opus","wma"]
        let image = ["png","jpg","jpeg","webp","bmp","tif","tiff","exr"]
        if video.contains(ext) { return ("video-convert", ["mp4","mov","mkv","webm","ts","avi"]) }
        if audio.contains(ext) { return ("audio-convert", ["mp3","m4a","aac","wav","flac","ogg","opus"]) }
        if image.contains(ext) { return ("image-convert", ["png","jpg","webp","tiff","exr","bmp"]) }
        return nil
    }

    static func canConvert(_ item: FileItem) -> Bool { plan(for: item) != nil }
}

/// Convert a vault file to another format on the server (e.g. mp4 → mov). The result is
/// saved into the vault as a new file. Shows live progress from /api/tools/progress.
struct ConvertSheet: View {
    @EnvironmentObject var store: Store
    @Environment(\.dismiss) private var dismiss
    let item: FileItem

    @State private var target: String = ""
    @State private var running = false
    @State private var pct: Int? = nil
    @State private var phase: String = ""
    @State private var error: String?
    @State private var done = false

    private var plan: (tool: String, formats: [String])? { ConvertKit.plan(for: item) }
    private var sourceExt: String { (item.name as NSString).pathExtension.lowercased() }

    var body: some View {
        NavigationStack {
            ZStack {
                SimplexTheme.bg.ignoresSafeArea()
                VStack(spacing: 20) {
                    // source
                    HStack(spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8).fill(SimplexTheme.surface2)
                            Thumbnail(item: item).clipShape(RoundedRectangle(cornerRadius: 8))
                        }.frame(width: 46, height: 46)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).foregroundStyle(SimplexTheme.text).lineLimit(1)
                            Text(formatBytes(item.size)).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
                        }
                        Spacer()
                    }
                    .padding(14)
                    .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 12))

                    if let plan {
                        // target format picker
                        VStack(alignment: .leading, spacing: 8) {
                            Text("CONVERT TO").font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 68), spacing: 8)], spacing: 8) {
                                ForEach(plan.formats.filter { $0 != sourceExt }, id: \.self) { fmt in
                                    Button { target = fmt } label: {
                                        Text(fmt.uppercased())
                                            .font(SimplexTheme.mono(12, weight: .semibold))
                                            .foregroundStyle(target == fmt ? .black : SimplexTheme.text)
                                            .frame(maxWidth: .infinity).padding(.vertical, 10)
                                            .background(target == fmt ? SimplexTheme.accent : SimplexTheme.surface2,
                                                        in: RoundedRectangle(cornerRadius: 8))
                                    }
                                    .disabled(running)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Text("This file type can't be converted.")
                            .foregroundStyle(SimplexTheme.subtle)
                    }

                    if running {
                        VStack(spacing: 8) {
                            ProgressView(value: Double(pct ?? 0), total: 100).tint(SimplexTheme.accent)
                            Text(phase.isEmpty ? "Converting…" : "\(phase.capitalized)… \(pct.map { "\($0)%" } ?? "")")
                                .font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
                        }
                    }
                    if done {
                        Label("Saved to your vault", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                    }

                    Spacer()

                    Button(action: convert) {
                        HStack {
                            if running { ProgressView().tint(.black) }
                            Text(done ? "Done" : "Convert").bold()
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                    }
                    .background(target.isEmpty || plan == nil ? SimplexTheme.surface2 : SimplexTheme.accent,
                                in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(target.isEmpty ? SimplexTheme.subtle : .black)
                    .disabled(running || target.isEmpty || plan == nil || done)
                }
                .padding(18)
            }
            .navigationTitle("Convert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(done ? "Close" : "Cancel") { dismiss() }.disabled(running)
                }
            }
        }
        .preferredColorScheme(Appearance.shared.colorScheme)
    }

    private func convert() {
        guard let plan, !target.isEmpty else { return }
        running = true; error = nil; pct = 0; phase = "processing"
        // poll progress while the conversion runs
        let poller = Task {
            while running {
                if let p = await API.shared.convertProgress(), p.active {
                    await MainActor.run { pct = p.pct; phase = p.phase ?? "processing" }
                }
                try? await Task.sleep(nanoseconds: 700_000_000)
            }
        }
        Task {
            defer { running = false; poller.cancel() }
            do {
                _ = try await API.shared.convertToVault(fileId: item.id, tool: plan.tool, format: target)
                done = true
                await store.refresh()
            } catch let e as APIError {
                error = e.message
                if e.needsReauth { store.handle(e) }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

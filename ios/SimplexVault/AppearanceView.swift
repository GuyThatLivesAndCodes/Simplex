import SwiftUI

/// Compact appearance settings — accent, theme, background ambience, fonts, and default
/// file view. Every change applies live in-app AND is saved to the account's server-side
/// prefs blob (PATCH /api/accounts/me { prefs }), using the same keys/values as the
/// website, so the look stays consistent across the web app and this app.
struct AppearanceView: View {
    @EnvironmentObject var store: Store
    @ObservedObject private var appr = Appearance.shared
    @AppStorage("gridView") private var gridView = true
    @State private var saveTask: Task<Void, Never>?

    var body: some View {
        List {
            // Accent
            Section("Accent color") {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 40), spacing: 12)], spacing: 12) {
                    ForEach(AppearanceCatalog.accents, id: \.name) { opt in
                        AccentSwatch(
                            hex: opt.hex,
                            selected: isSelectedAccent(opt.hex),
                            onPick: { picked in
                                appr.accentHex = picked
                                scheduleSave()
                            }
                        )
                    }
                }
                .padding(.vertical, 4)
            }
            .listRowBackground(SimplexTheme.surface)

            // Theme
            Section("Theme") {
                Picker("Theme", selection: Binding(get: { appr.themeId }, set: { appr.themeId = $0; scheduleSave() })) {
                    ForEach(AppearanceCatalog.themes, id: \.id) { t in Text(t.label).tag(t.id) }
                }
                .pickerStyle(.menu).tint(SimplexTheme.accent)
            }
            .listRowBackground(SimplexTheme.surface)

            // Ambience
            Section("Background ambience") {
                Picker("Ambience", selection: Binding(get: { appr.bgFx }, set: { appr.bgFx = $0; scheduleSave() })) {
                    ForEach(AppearanceCatalog.ambience, id: \.id) { a in Text(a.label).tag(a.id) }
                }
                .pickerStyle(.menu).tint(SimplexTheme.accent)
            }
            .listRowBackground(SimplexTheme.surface)

            // Fonts
            Section("Fonts") {
                Picker("Interface", selection: Binding(get: { appr.uiFont }, set: { appr.uiFont = $0; scheduleSave() })) {
                    ForEach(AppearanceCatalog.uiFonts, id: \.key) { f in Text(f.label).tag(f.key) }
                }.pickerStyle(.menu).tint(SimplexTheme.accent)
                Picker("Monospace", selection: Binding(get: { appr.monoFont }, set: { appr.monoFont = $0; scheduleSave() })) {
                    ForEach(AppearanceCatalog.monoFonts, id: \.key) { f in Text(f.label).tag(f.key) }
                }.pickerStyle(.menu).tint(SimplexTheme.accent)
            }
            .listRowBackground(SimplexTheme.surface)

            // Default view (app-local; also seeds new folder views)
            Section("Default file view") {
                Picker("Default view", selection: $gridView) {
                    Text("Grid").tag(true)
                    Text("List").tag(false)
                }
                .pickerStyle(.segmented)
                .onChange(of: gridView) { v in appr.defaultGrid = v; appr.persistLocal() }
            }
            .listRowBackground(SimplexTheme.surface)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(SimplexTheme.bg)
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { saveTask?.cancel(); Task { await saveNow() } }   // flush a pending save
    }

    private func isSelectedAccent(_ hex: String?) -> Bool {
        // case-insensitive compare; both nil (Amber default) count as equal
        (appr.accentHex ?? "").lowercased() == (hex ?? "").lowercased()
    }

    /// Persist the current appearance. Discrete choices (accent/theme/…) save
    /// immediately — there's no rapid stream to debounce, and the previous debounce +
    /// account-reassignment was the source of the accent instability. The local look is
    /// already applied via the @Published change; this just syncs it to the server, and
    /// we deliberately IGNORE the response so nothing can overwrite what the user picked.
    private func scheduleSave() {
        appr.persistLocal()
        saveTask?.cancel()
        saveTask = Task { await saveNow() }
    }
    private func saveNow() async {
        _ = try? await API.shared.savePrefs(appr.prefsPatch)
    }
}

/// One accent swatch. Owns its own `hex` value and reports exactly that on tap, so there
/// is no chance of a loop variable or shared state resolving to the wrong color (the
/// root of the "always picks the last one" bug).
private struct AccentSwatch: View {
    let hex: String?              // nil = Amber default
    let selected: Bool
    let onPick: (String?) -> Void

    private var color: Color { hex.flatMap { Color(hexString: $0) } ?? Color(hex: 0xe0a64a) }

    var body: some View {
        Button {
            onPick(hex)
        } label: {
            Circle()
                .fill(color)
                .frame(width: 34, height: 34)
                .overlay(Circle().stroke(SimplexTheme.text, lineWidth: selected ? 2.5 : 0))
                .overlay(selected
                         ? Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(.black)
                         : nil)
        }
        .buttonStyle(.plain)
    }
}

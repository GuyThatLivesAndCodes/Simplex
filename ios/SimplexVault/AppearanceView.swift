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
                        let color = opt.hex.flatMap { Color(hexString: $0) } ?? Color(hex: 0xe0a64a)
                        Button {
                            appr.accentHex = opt.hex
                            scheduleSave()
                        } label: {
                            Circle().fill(color)
                                .frame(width: 34, height: 34)
                                .overlay(Circle().stroke(SimplexTheme.text, lineWidth: isSelectedAccent(opt.hex) ? 2.5 : 0))
                                .overlay(isSelectedAccent(opt.hex) ? Image(systemName: "checkmark").font(.caption2.bold()).foregroundStyle(.black) : nil)
                        }
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
        (appr.accentHex ?? "") == (hex ?? "")
    }

    /// Debounce writes to the server so rapid toggling doesn't spam PATCHes; the local
    /// look updates instantly via the @Published change.
    private func scheduleSave() {
        appr.persistLocal()
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
            await saveNow()
        }
    }
    private func saveNow() async {
        do {
            let acct = try await API.shared.savePrefs(appr.prefsPatch)
            store.applyAccount(acct)
        } catch {
            // non-fatal: the local look is already applied; a failed sync just isn't persisted
        }
    }
}

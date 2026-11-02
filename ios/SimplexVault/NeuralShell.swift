import SwiftUI

/// The Neural system's tab shell: **Models**, **Templates**, and the shared **Account**.
/// Follows the app appearance (like every system) via AppShell's preferredColorScheme.
struct NeuralShell: View {
    @EnvironmentObject var neural: NeuralStore   // owned by AppShell, survives switches
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { NeuralModelsView().withSystemSwitcher() }
                .tabItem { Label("Models", systemImage: "brain") }.tag(0)
            NavigationStack { NeuralTemplatesView().withSystemSwitcher() }
                .tabItem { Label("Templates", systemImage: "square.grid.2x2") }.tag(1)
            NavigationStack { AccountView() }
                .tabItem { Label("Account", systemImage: "person") }.tag(2)
        }
        .tint(SimplexTheme.accent)
        .task { if !neural.loaded { await neural.load() } }
    }
}

// MARK: - Models list

struct NeuralModelsView: View {
    @EnvironmentObject var neural: NeuralStore
    @State private var showWizard = false

    var body: some View {
        ZStack {
            SimplexTheme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if neural.models.isEmpty {
                        emptyState
                    } else {
                        ForEach(neural.models) { m in
                            NavigationLink { NeuralWorkspace(modelId: m.id) } label: { modelCard(m) }
                                .buttonStyle(.plain)
                        }
                    }
                    Color.clear.frame(height: 30)
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text("Neural").font(.system(size: 17, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showWizard = true } label: { Image(systemName: "plus") }
            }
        }
        .sheet(isPresented: $showWizard) {
            NeuralWizard(base: nil) { doc in neural.create(doc) }
                .environmentObject(neural)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("YOUR MODELS").font(SimplexTheme.mono(11, weight: .semibold)).tracking(1.5).foregroundStyle(SimplexTheme.subtle)
            Text("Train a language model from the ground up, then chat with it.")
                .font(.system(size: 13)).foregroundStyle(SimplexTheme.subtle)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "brain").font(.system(size: 38)).foregroundStyle(SimplexTheme.accent.opacity(0.7))
            Text("No models yet").font(.system(size: 17, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            Text("Start from a template, or build one from scratch.")
                .font(.system(size: 13)).foregroundStyle(SimplexTheme.subtle).multilineTextAlignment(.center)
            Button { showWizard = true } label: {
                Text("New model").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 20).padding(.vertical, 11)
                    .background(SimplexTheme.accent, in: Capsule())
            }
        }
        .frame(maxWidth: .infinity).padding(.top, 40)
    }

    private func modelCard(_ m: NeuralDoc) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(SimplexTheme.accent.opacity(0.16)).frame(width: 40, height: 40)
                Image(systemName: "brain").foregroundStyle(SimplexTheme.accent)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(m.name).font(.system(size: 15, weight: .medium)).foregroundStyle(SimplexTheme.text)
                Text("\(m.arch.tokMode) · \(m.trainState.steps > 0 ? "\(m.trainState.steps) steps" : "untrained")")
                    .font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 13)).foregroundStyle(SimplexTheme.subtle)
        }
        .padding(14)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
        .contextMenu {
            Button(role: .destructive) { neural.delete(m.id) } label: { Label("Delete", systemImage: "trash") }
        }
    }
}

// MARK: - Templates

struct NeuralTemplatesView: View {
    @EnvironmentObject var neural: NeuralStore
    @State private var createdId: String?

    var body: some View {
        ZStack {
            SimplexTheme.bg.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Pre-built models that ship with their own training data. Pick one and just hit train.")
                        .font(.system(size: 13)).foregroundStyle(SimplexTheme.subtle)
                    ForEach(NeuralTemplate.all) { t in templateCard(t) }
                    Color.clear.frame(height: 30)
                }
                .padding(20)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .principal) { Text("Templates").font(.system(size: 17, weight: .semibold)).foregroundStyle(SimplexTheme.text) } }
        // iOS 16 compatible programmatic nav (navigationDestination(item:) is iOS 17+):
        // an invisible NavigationLink pushed when a template is created.
        .background(
            NavigationLink(isActive: Binding(get: { createdId != nil }, set: { if !$0 { createdId = nil } })) {
                if let id = createdId { NeuralWorkspace(modelId: id) }
            } label: { EmptyView() }.hidden()
        )
    }

    private func templateCard(_ t: NeuralTemplate) -> some View {
        Button {
            createdId = neural.createFromTemplate(t).id
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 9).fill(SimplexTheme.accent.opacity(0.16)).frame(width: 36, height: 36)
                        Image(systemName: t.icon).foregroundStyle(SimplexTheme.accent)
                    }
                    Text(t.name).font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                    Spacer()
                }
                Text(t.desc).font(.system(size: 12.5)).foregroundStyle(SimplexTheme.subtle).fixedSize(horizontal: false, vertical: true)
                Text("\(t.arch.tokMode) · ctx \(t.arch.ctx) · dim \(t.arch.embed) · \(t.pretrain.count + t.finetune.count) data sets")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle.opacity(0.8))
            }
            .padding(15)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Workspace (Data / Training / Inference)

struct NeuralWorkspace: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    @State private var tab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text("Data").tag(0); Text("Training").tag(1); Text("Inference").tag(2)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16).padding(.vertical, 10)

            Group {
                switch tab {
                case 0: NeuralDataTab(modelId: modelId)
                case 1: NeuralTrainingTab(modelId: modelId)
                default: NeuralInferenceTab(modelId: modelId)
                }
            }
        }
        .background(SimplexTheme.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(neural.model(modelId)?.name ?? "Model").font(.system(size: 16, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            }
        }
    }
}

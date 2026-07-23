import SwiftUI

// MARK: - Data tab

struct NeuralDataTab: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    // sheet routing via a single enum (avoids fragile double-optionals)
    private enum Sheet: Identifiable {
        case pretrain(NeuralDoc.DataSet?)   // nil = new
        case convo(String?)                 // conversation id, nil = new
        case stack
        case importJSONL
        var id: String {
            switch self {
            case .pretrain(let s): return "pt-\(s?.id ?? "new")"
            case .convo(let c): return "cv-\(c ?? "new")"
            case .stack: return "stack"
            case .importJSONL: return "import"
            }
        }
    }
    @State private var sheet: Sheet?

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let doc = neural.model(modelId) {
                    pretrainSection(doc)
                    finetuneSection(doc)
                }
                Color.clear.frame(height: 20)
            }
            .padding(16)
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .pretrain(let s): NeuralPretrainSheet(modelId: modelId, existing: s).environmentObject(neural)
            case .convo(let c): NeuralConversationSheet(modelId: modelId, convoId: c).environmentObject(neural)
            case .stack: NeuralStackSheet(modelId: modelId).environmentObject(neural)
            case .importJSONL: NeuralImportSheet(modelId: modelId).environmentObject(neural)
            }
        }
    }

    // ---- Pre-training (free text) ----
    private func pretrainSection(_ doc: NeuralDoc) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Pre-training data").font(.system(size: 14, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                Spacer()
                Text("\(doc.data.pretrain.count) set\(doc.data.pretrain.count == 1 ? "" : "s") · \(doc.data.pretrain.reduce(0){$0+$1.text.count}) chars")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
            }
            Text("The bulk free text the model learns general language patterns from.").font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
            if doc.data.pretrain.isEmpty {
                Text("No sets yet.").font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle).padding(.vertical, 6)
            } else {
                ForEach(doc.data.pretrain) { s in
                    HStack(spacing: 10) {
                        Image(systemName: "doc.text").foregroundStyle(SimplexTheme.subtle)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.name).font(.system(size: 14)).foregroundStyle(SimplexTheme.text)
                            Text("\(s.text.count) chars").font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                        }
                        Spacer()
                        Button { sheet = .pretrain(s) } label: { Image(systemName: "pencil").foregroundStyle(SimplexTheme.subtle) }
                        Button { neural.removePretrain(modelId, setId: s.id) } label: { Image(systemName: "trash").foregroundStyle(SimplexTheme.subtle) }
                    }
                    .padding(10).background(SimplexTheme.bg, in: RoundedRectangle(cornerRadius: 10))
                }
            }
            Button { sheet = .pretrain(nil) } label: { Label("Add text", systemImage: "plus").font(.system(size: 13, weight: .medium)) }
                .buttonStyle(.bordered)
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
    }

    // ---- Fine-tuning (conversations) ----
    private func finetuneSection(_ doc: NeuralDoc) -> some View {
        let totalTurns = doc.data.finetune.reduce(0) { $0 + $1.turns.count }
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Fine-tuning conversations").font(.system(size: 14, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                Spacer()
                Text("\(doc.data.finetune.count) convo\(doc.data.finetune.count == 1 ? "" : "s") · \(totalTurns) turns")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
            }
            Text("User↔AI examples that teach the model to reply in a chat format. Each turn trains as {\"role\":\"user\"/\"assistant\",\"content\":…} — the same schema used in Inference.")
                .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle).fixedSize(horizontal: false, vertical: true)
            if doc.data.finetune.isEmpty {
                Text("No conversations yet.").font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle).padding(.vertical, 6)
            } else {
                ForEach(doc.data.finetune) { c in
                    Button { sheet = .convo(c.id) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(SimplexTheme.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.name).font(.system(size: 14)).foregroundStyle(SimplexTheme.text)
                                Text("\(c.turns.count) turn\(c.turns.count == 1 ? "" : "s") · “\(c.turns.first?.content.prefix(40) ?? "empty")”")
                                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle).lineLimit(1)
                            }
                            Spacer()
                            Button { neural.removeConversation(modelId, convoId: c.id) } label: { Image(systemName: "trash").foregroundStyle(SimplexTheme.subtle) }
                                .buttonStyle(.plain)
                        }
                        .padding(10).background(SimplexTheme.bg, in: RoundedRectangle(cornerRadius: 10))
                    }.buttonStyle(.plain)
                }
            }
            HStack(spacing: 8) {
                Button { sheet = .convo(nil) } label: { Label("New", systemImage: "plus").font(.system(size: 13, weight: .medium)) }.buttonStyle(.bordered)
                Button { sheet = .importJSONL } label: { Label("Import", systemImage: "square.and.arrow.down").font(.system(size: 13)) }.buttonStyle(.bordered)
                Button { sheet = .stack } label: { Label("Stack", systemImage: "square.on.square").font(.system(size: 13)) }.buttonStyle(.bordered)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
    }
}

/// Add/edit one PRE-TRAINING text set.
struct NeuralPretrainSheet: View {
    let modelId: String
    let existing: NeuralDoc.DataSet?
    @EnvironmentObject var neural: NeuralStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var text = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("Name", text: $name) }
                Section("Text") { TextEditor(text: $text).frame(minHeight: 220).font(.system(size: 14)) }
            }
            .navigationTitle(existing == nil ? "Add text" : "Edit text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let nm = name.isEmpty ? "Corpus" : name
                        if let e = existing { neural.editPretrain(modelId, setId: e.id, name: nm, text: text) }
                        else { neural.addPretrain(modelId, name: nm, text: text) }
                        dismiss()
                    }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear { name = existing?.name ?? "Corpus"; text = existing?.text ?? "" }
        }
    }
}

/// Turn-by-turn conversation editor (User/AI rows).
struct NeuralConversationSheet: View {
    let modelId: String
    let convoId: String?
    @EnvironmentObject var neural: NeuralStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var turns: [NeuralDoc.Turn] = []

    var body: some View {
        NavigationStack {
            Form {
                Section("Name") { TextField("Name", text: $name) }
                Section("Conversation") {
                    Text("Alternate User and AI turns. This trains the model to reply in the same chat format.")
                        .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
                    ForEach($turns) { $turn in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Picker("", selection: $turn.role) { Text("User").tag("user"); Text("AI").tag("assistant") }
                                    .pickerStyle(.segmented).frame(width: 140)
                                Spacer()
                                Button { turns.removeAll { $0.id == turn.id } } label: { Image(systemName: "trash").foregroundStyle(SimplexTheme.subtle) }
                                    .buttonStyle(.plain)
                            }
                            TextEditor(text: $turn.content).frame(minHeight: 54).font(.system(size: 14))
                        }
                    }
                    HStack {
                        Button { turns.append(NeuralDoc.Turn(role: "user", content: "")) } label: { Label("User turn", systemImage: "plus") }
                        Spacer()
                        Button { turns.append(NeuralDoc.Turn(role: "assistant", content: "")) } label: { Label("AI turn", systemImage: "plus") }
                    }.font(.system(size: 13))
                }
            }
            .navigationTitle(convoId == nil ? "New conversation" : "Edit conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let kept = turns.filter { !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                        guard !kept.isEmpty else { dismiss(); return }
                        let id = convoId ?? NeuralDoc.newId()
                        neural.saveConversation(modelId, convo: NeuralDoc.Conversation(id: id, name: name.isEmpty ? "Conversation" : name, turns: kept))
                        dismiss()
                    }
                }
            }
            .onAppear {
                if let cid = convoId, let c = neural.conversation(modelId, convoId: cid) { name = c.name; turns = c.turns }
                else { name = "Conversation"; turns = [NeuralDoc.Turn(role: "user", content: ""), NeuralDoc.Turn(role: "assistant", content: "")] }
            }
        }
    }
}

/// Import conversations from JSONL text.
struct NeuralImportSheet: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("JSONL") {
                    Text("One turn per line: {\"role\":\"user\",\"content\":\"…\"} or the shorthand {\"User\":\"…\"} / {\"AI\":\"…\"}. A blank line starts a new conversation.")
                        .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
                    TextEditor(text: $text).frame(minHeight: 200).font(SimplexTheme.mono(13))
                }
                if let e = error { Text(e).foregroundStyle(.red).font(.system(size: 12)) }
            }
            .navigationTitle("Import conversations")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") {
                        let r = neural.importJSONL(modelId, text: text)
                        if let e = r.error { error = e } else { dismiss() }
                    }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// Stack: copy pre-training text or conversations from templates / other owned models.
struct NeuralStackSheet: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    @Environment(\.dismiss) private var dismiss

    struct PT: Identifiable { let id = UUID(); let name: String; let text: String }
    struct CV: Identifiable { let id = UUID(); let name: String; let turns: [NeuralDoc.Turn] }
    struct Source: Identifiable { let id = UUID(); let title: String; let sub: String; let pre: [PT]; let convos: [CV] }

    private var sources: [Source] {
        var out: [Source] = []
        for t in NeuralTemplate.all {
            let pre = t.pretrain.map { PT(name: $0.0, text: $0.1) }
            let cv = t.finetune.map { CV(name: $0.0, turns: $0.1.map { NeuralDoc.Turn(role: $0.0, content: $0.1) }) }
            if !pre.isEmpty || !cv.isEmpty { out.append(Source(title: t.name, sub: "Template", pre: pre, convos: cv)) }
        }
        for m in neural.models where m.id != modelId {
            let pre = m.data.pretrain.map { PT(name: $0.name, text: $0.text) }
            let cv = m.data.finetune.map { CV(name: $0.name, turns: $0.turns) }
            if !pre.isEmpty || !cv.isEmpty { out.append(Source(title: m.name, sub: "Your model", pre: pre, convos: cv)) }
        }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                if sources.isEmpty { Text("Nothing to stack yet.").foregroundStyle(SimplexTheme.subtle) }
                ForEach(sources) { src in
                    Section("\(src.title) · \(src.sub)") {
                        ForEach(src.pre) { p in
                            Button { neural.stackPretrain(modelId, name: p.name, text: p.text) } label: {
                                stackRow(p.name, "\(p.text.count) chars · pre-training")
                            }
                        }
                        ForEach(src.convos) { c in
                            Button { neural.stackConversation(modelId, name: c.name, turns: c.turns) } label: {
                                stackRow(c.name, "\(c.turns.count) turns · conversation")
                            }
                        }
                    }
                }
            }
            .navigationTitle("Stack data")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
    private func stackRow(_ title: String, _ meta: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(SimplexTheme.text)
                Text(meta).font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
            }
            Spacer()
            Image(systemName: "plus.circle").foregroundStyle(SimplexTheme.accent)
        }
    }
}

// MARK: - Training tab

struct NeuralTrainingTab: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    @State private var showUpgrade = false

    private let optimizers = [("adamw","AdamW"),("radam","RAdam"),("lion","Lion"),("lamb","LAMB"),("sgd","SGD")]

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if let doc = neural.model(modelId) {
                    optimizerPanel(doc)
                    lossPanel(doc)
                    upgradePanel
                }
                Color.clear.frame(height: 20)
            }
            .padding(16)
        }
        .sheet(isPresented: $showUpgrade) {
            if let doc = neural.model(modelId) {
                NeuralWizard(base: doc) { updated in neural.upgrade(modelId, arch: updated.arch, name: updated.name) }
                    .environmentObject(neural)
            }
        }
    }

    private func binding(_ keyPath: WritableKeyPath<NeuralDoc.TrainState.Opt, Double>) -> Binding<Double> {
        Binding(get: { neural.model(modelId)?.trainState.opt[keyPath: keyPath] ?? 0 },
                set: { v in guard var d = neural.model(modelId) else { return }; d.trainState.opt[keyPath: keyPath] = v; neural.persist(d) })
    }
    private func intBinding(_ keyPath: WritableKeyPath<NeuralDoc.TrainState.Opt, Int>) -> Binding<Double> {
        Binding(get: { Double(neural.model(modelId)?.trainState.opt[keyPath: keyPath] ?? 0) },
                set: { v in guard var d = neural.model(modelId) else { return }; d.trainState.opt[keyPath: keyPath] = Int(v); neural.persist(d) })
    }

    private func optimizerPanel(_ doc: NeuralDoc) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Optimizer").font(.system(size: 14, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 6)], spacing: 6) {
                ForEach(optimizers, id: \.0) { opt in
                    Button {
                        guard var d = neural.model(modelId) else { return }; d.trainState.opt.kind = opt.0; neural.persist(d)
                    } label: {
                        Text(opt.1).font(.system(size: 12, weight: .medium))
                            .frame(maxWidth: .infinity).padding(.vertical, 8)
                            .background(doc.trainState.opt.kind == opt.0 ? SimplexTheme.accent : SimplexTheme.bg,
                                        in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(doc.trainState.opt.kind == opt.0 ? .white : SimplexTheme.subtle)
                    }
                }
            }
            sliderRow("Learning rate", String(format: "%.4f", doc.trainState.opt.lr), binding(\.lr), 0.0001...0.02, 0.0001)
            sliderRow("Batch size", "\(doc.trainState.opt.batch)", intBinding(\.batch), 1...32, 1)
            sliderRow("Epochs", "\(doc.trainState.opt.epochs)", intBinding(\.epochs), 1...30, 1)

            HStack(spacing: 10) {
                Button {
                    neural.train(modelId)
                } label: {
                    Label(doc.trainState.steps > 0 ? "Continue" : "Start training", systemImage: "play.fill")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(SimplexTheme.accent, in: Capsule())
                }
                .disabled(neural.training || doc.totalDataChars < 8)
                if neural.training && neural.trainingId == modelId {
                    Button { neural.stopTraining() } label: { Image(systemName: "stop.fill").foregroundStyle(SimplexTheme.subtle) }
                }
            }
            if !neural.trainStatus.isEmpty && (neural.trainingId == modelId || !neural.training) {
                Text(neural.trainStatus).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
            } else if doc.totalDataChars < 8 {
                Text("add data on the Data tab").font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
    }

    private func sliderRow(_ label: String, _ value: String, _ binding: Binding<Double>, _ range: ClosedRange<Double>, _ step: Double) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack { Text(label).font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle); Spacer(); Text(value).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.accent) }
            Slider(value: binding, in: range, step: step).tint(SimplexTheme.accent)
        }
    }

    private func lossPanel(_ doc: NeuralDoc) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Text("Loss").font(.system(size: 14, weight: .semibold)).foregroundStyle(SimplexTheme.text); Spacer(); Text("lower = better").font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle) }
            LossChart(values: doc.trainState.lossHistory).frame(height: 130)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(SimplexTheme.line))
    }

    private var upgradePanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Upgrade this model", systemImage: "arrow.triangle.2.circlepath").font(.system(size: 14, weight: .semibold)).foregroundStyle(SimplexTheme.text)
            Text("Change the architecture — bigger, smaller, a different tokenizer — while keeping all your data. Training resets.")
                .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
            Button { showUpgrade = true } label: { Label("Upgrade…", systemImage: "arrow.triangle.2.circlepath").font(.system(size: 14, weight: .medium)) }
                .buttonStyle(.bordered)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(SimplexTheme.line))
    }
}

/// A simple line chart of the loss history.
struct LossChart: View {
    let values: [Double]
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 8).fill(SimplexTheme.bg)
                if values.isEmpty {
                    Text("Loss appears here as it trains.").font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle).padding(10)
                } else {
                    let mx = values.max() ?? 1, mn = values.min() ?? 0
                    Path { p in
                        for (i, v) in values.enumerated() {
                            let x = geo.size.width * (values.count == 1 ? 0.5 : CGFloat(i) / CGFloat(values.count - 1))
                            let y = geo.size.height * (mx == mn ? 0.5 : CGFloat(1 - (v - mn) / (mx - mn)))
                            if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
                        }
                    }
                    .stroke(SimplexTheme.accent, lineWidth: 2)
                    Text(String(format: "%.2f", mx)).font(SimplexTheme.mono(9)).foregroundStyle(SimplexTheme.subtle).padding(4)
                }
            }
        }
    }
}

// MARK: - Inference tab (chat)

struct NeuralInferenceTab: View {
    let modelId: String
    @EnvironmentObject var neural: NeuralStore
    // messages are chat turns {role:'user'|'assistant', content}. Kept in view state and
    // reset whenever the model changes or the user taps Reset.
    @State private var messages: [NeuralDoc.Turn] = []
    @State private var input = ""
    @State private var temperature = 0.8
    @State private var length = 120.0
    @State private var thinking = false

    private var trained: Bool { (neural.model(modelId)?.trainState.steps ?? 0) > 0 && neural.model(modelId)?.model != nil }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(trained ? "Talking to your model in a chat format" : "Not trained yet")
                    .font(SimplexTheme.mono(10)).foregroundStyle(SimplexTheme.subtle)
                Spacer()
                Button { messages = [] } label: { Label("Reset chat", systemImage: "arrow.counterclockwise").font(.system(size: 12)) }
                    .disabled(messages.isEmpty)
            }.padding(.horizontal, 12).padding(.top, 8)

            if !trained {
                Text("Train the model first (Training tab) — then it can chat here.")
                    .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(SimplexTheme.surface).cornerRadius(10).padding(12)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if messages.isEmpty && trained {
                        Text("Each turn is sent as {\"role\":\"user\",\"content\":…} and the model replies as the assistant.")
                            .font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle).padding(.top, 8)
                    }
                    ForEach(messages) { m in bubble(role: m.role, text: m.content) }
                    if thinking { bubble(role: "assistant", text: "▍") }
                }
                .padding(12)
            }
            HStack(spacing: 12) {
                Text("Creativity").font(SimplexTheme.mono(9)).foregroundStyle(SimplexTheme.subtle)
                Slider(value: $temperature, in: 0.1...1.5).tint(SimplexTheme.accent)
                Text("Length").font(SimplexTheme.mono(9)).foregroundStyle(SimplexTheme.subtle)
                Slider(value: $length, in: 20...300, step: 10).tint(SimplexTheme.accent)
            }.padding(.horizontal, 12)
            HStack(spacing: 8) {
                TextField(trained ? "Message your model…" : "Train the model to chat", text: $input)
                    .textFieldStyle(.roundedBorder).disabled(!trained)
                Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 26)).foregroundStyle(SimplexTheme.accent) }
                    .disabled(!trained || input.trimmingCharacters(in: .whitespaces).isEmpty)
            }.padding(12)
        }
    }

    private func bubble(role: String, text: String) -> some View {
        let isUser = role == "user"
        return HStack {
            if isUser { Spacer() }
            Text(text)
                .font(.system(size: 14)).foregroundStyle(isUser ? .white : SimplexTheme.text)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(isUser ? SimplexTheme.accent : SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 13))
                .frame(maxWidth: 280, alignment: isUser ? .trailing : .leading)
            if !isUser { Spacer() }
        }
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        input = ""
        messages.append(NeuralDoc.Turn(role: "user", content: text))
        thinking = true
        // The store serializes `messages` in the chat template, prompts an open assistant
        // turn, stops at "} and cleans the reply — the same schema it was fine-tuned on.
        neural.chat(modelId, history: messages, length: Int(length), temperature: temperature) { reply in
            thinking = false
            messages.append(NeuralDoc.Turn(role: "assistant", content: reply))
        }
    }
}

// MARK: - Create / Upgrade wizard

struct NeuralWizard: View {
    /// nil = new model; non-nil = upgrade (keeps data, rebuilds structure).
    let base: NeuralDoc?
    let onFinish: (NeuralDoc) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var step = 0
    @State private var name: String
    @State private var arch: NeuralDoc.Arch
    @State private var layersText: String

    private let tokModes = [("char","Characters"),("bpe","BPE subwords"),("word","Whole words"),("sentence","Sentences / phrases")]
    private let acts = [("relu","ReLU"),("leaky","Leaky"),("gelu","GELU"),("tanh","Tanh"),("sigmoid","Sigmoid")]
    private let steps = ["Tokenizer","Size","Activation","Layers","Review"]

    init(base: NeuralDoc?, onFinish: @escaping (NeuralDoc) -> Void) {
        self.base = base; self.onFinish = onFinish
        _name = State(initialValue: base?.name ?? "New model")
        _arch = State(initialValue: base?.arch ?? NeuralDoc.Arch())
        _layersText = State(initialValue: (base?.arch.layers ?? [96, 96]).map(String.init).joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                // step indicator
                HStack(spacing: 6) {
                    ForEach(0..<steps.count, id: \.self) { i in
                        Text(steps[i]).font(.system(size: 10, weight: i == step ? .semibold : .regular))
                            .foregroundStyle(i == step ? SimplexTheme.accent : SimplexTheme.subtle)
                        if i < steps.count - 1 { Image(systemName: "chevron.right").font(.system(size: 8)).foregroundStyle(SimplexTheme.subtle) }
                    }
                }.padding(12)

                ScrollView { pageBody.padding(16) }

                HStack {
                    if step > 0 { Button("Back") { step -= 1 } }
                    Spacer()
                    Button(step == steps.count - 1 ? (base == nil ? "Create" : "Rebuild") : "Next") { next() }
                        .fontWeight(.semibold)
                }.padding(16)
            }
            .background(SimplexTheme.bg.ignoresSafeArea())
            .navigationTitle(base == nil ? "New model" : "Upgrade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    @ViewBuilder
    private var pageBody: some View {
        switch step {
        case 0:
            VStack(alignment: .leading, spacing: 12) {
                TextField("Model name", text: $name).textFieldStyle(.roundedBorder)
                Text("How should text be broken into tokens?").font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                ForEach(tokModes, id: \.0) { m in
                    Button { arch.tokMode = m.0 } label: {
                        HStack {
                            Text(m.1 + (m.0 == "bpe" ? "  · recommended" : "")).foregroundStyle(SimplexTheme.text)
                            Spacer()
                            if arch.tokMode == m.0 { Image(systemName: "checkmark").foregroundStyle(SimplexTheme.accent) }
                        }
                        .padding(12).background(SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(arch.tokMode == m.0 ? SimplexTheme.accent : SimplexTheme.line))
                    }.buttonStyle(.plain)
                }
                stepper("Max vocabulary", value: Binding(get: { Double(arch.maxVocab) }, set: { arch.maxVocab = Int($0) }), range: 64...4000, step: 32, fmt: "\(arch.maxVocab)")
            }
        case 1:
            VStack(alignment: .leading, spacing: 16) {
                Text("Context & embedding size").font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                stepper("Context length (tokens)", value: Binding(get: { Double(arch.ctx) }, set: { arch.ctx = Int($0) }), range: 8...256, step: 8, fmt: "\(arch.ctx)")
                stepper("Embedding dim", value: Binding(get: { Double(arch.embed) }, set: { arch.embed = Int($0) }), range: 16...192, step: 8, fmt: "\(arch.embed)")
                Text("Bigger = smarter but slower. Small by design so the phone can train it.").font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
            }
        case 2:
            VStack(alignment: .leading, spacing: 16) {
                Text("Activation & dropout").font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 80))], spacing: 8) {
                    ForEach(acts, id: \.0) { a in
                        Button { arch.act = a.0 } label: {
                            Text(a.1).font(.system(size: 12, weight: .medium)).frame(maxWidth: .infinity).padding(.vertical, 9)
                                .background(arch.act == a.0 ? SimplexTheme.accent : SimplexTheme.surface, in: RoundedRectangle(cornerRadius: 8))
                                .foregroundStyle(arch.act == a.0 ? .white : SimplexTheme.subtle)
                        }
                    }
                }
                stepper("Dropout", value: $arch.dropout, range: 0...0.5, step: 0.05, fmt: String(format: "%.2f", arch.dropout))
            }
        case 3:
            VStack(alignment: .leading, spacing: 12) {
                Text("Hidden layer structure").font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                Text("Each number is one transformer block's feed-forward width. Two or three is plenty.").font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
                TextField("96, 96", text: $layersText).textFieldStyle(.roundedBorder).font(SimplexTheme.mono(14))
                Text("\(parseLayers().count) block(s): \(parseLayers().map(String.init).joined(separator: " → "))")
                    .font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle)
            }
        default:
            VStack(alignment: .leading, spacing: 10) {
                Text(base == nil ? "Review" : "Review the upgrade").font(.system(size: 15, weight: .semibold)).foregroundStyle(SimplexTheme.text)
                Text(base == nil ? "A fresh, untrained model. You can upgrade it later." : "Your data is kept. The model rebuilds with this structure (training resets).")
                    .font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle)
                reviewRow("Name", name)
                reviewRow("Tokenizer", (tokModes.first { $0.0 == arch.tokMode }?.1 ?? arch.tokMode) + " · vocab ≤ \(arch.maxVocab)")
                reviewRow("Context", "\(arch.ctx) tokens")
                reviewRow("Embedding", "\(arch.embed)")
                reviewRow("Activation", acts.first { $0.0 == arch.act }?.1 ?? arch.act)
                reviewRow("Dropout", String(format: "%.2f", arch.dropout))
                reviewRow("Blocks", parseLayers().map(String.init).joined(separator: " → "))
            }
        }
    }

    private func stepper(_ label: String, value: Binding<Double>, range: ClosedRange<Double>, step: Double, fmt: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack { Text(label).font(.system(size: 12)).foregroundStyle(SimplexTheme.subtle); Spacer(); Text(fmt).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.accent) }
            Slider(value: value, in: range, step: step).tint(SimplexTheme.accent)
        }
    }
    private func reviewRow(_ k: String, _ v: String) -> some View {
        HStack { Text(k).font(SimplexTheme.mono(11)).foregroundStyle(SimplexTheme.subtle); Spacer(); Text(v).font(.system(size: 13)).foregroundStyle(SimplexTheme.text) }
            .padding(.vertical, 8).overlay(Divider(), alignment: .bottom)
    }
    private func parseLayers() -> [Int] {
        let arr = layersText.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.map { max(8, min(1024, $0)) }.prefix(8)
        return arr.isEmpty ? [96] : Array(arr)
    }
    private func next() {
        if step == 3 { arch.layers = parseLayers() }
        if step < steps.count - 1 { step += 1; return }
        var doc = base ?? NeuralDoc.fresh(arch: arch, name: name)
        doc.arch = arch; doc.name = name
        onFinish(doc)
        dismiss()
    }
}

import Foundation
import SwiftUI

/// Owns the Neural system's models. LOCAL-FIRST: models live as JSON files on device
/// (`NeuralLocalStore`) and all training/inference runs ON THIS DEVICE via
/// `NeuralEngine`. The server's `/api/networks` API is a backup/cross-device sync
/// target — we push after edits and can pull on a fresh install. This mirrors the
/// Habit system's local-first design.
@MainActor
final class NeuralStore: ObservableObject {
    /// The live instance (set on init). AppShell owns exactly one NeuralStore, so this
    /// weak singleton lets the off-main training task report progress back to the main
    /// actor without capturing `self` into concurrently-executing code (a Swift 6 error).
    static weak var shared: NeuralStore?

    @Published var models: [NeuralDoc] = []
    @Published var loaded = false
    @Published var error: String?

    // training progress (for the open model)
    @Published var training = false
    @Published var trainStatus = ""
    @Published var trainingId: String?

    private var syncTimer: Timer?
    /// server id per local model id (for updates); models created locally get a server id
    /// on first successful push.
    private var serverId: [String: String] = [:]

    init() { NeuralStore.shared = self }

    // MARK: - load / persist

    func load() async {
        models = NeuralLocalStore.list()
        // fresh install: if nothing local, try to pull from the server
        if models.isEmpty {
            do {
                let metas = try await API.shared.listNetworks().filter { $0.kind == "llm2" }
                for meta in metas {
                    if let doc = try? await API.shared.getNetworkDoc(meta.id).doc {
                        serverId[doc.id] = meta.id
                        NeuralLocalStore.save(doc)
                    }
                }
                models = NeuralLocalStore.list()
            } catch let e as APIError where e.needsReauth {
                error = "auth"
            } catch { /* offline is fine; local-first */ }
        } else {
            // map any known server ids by matching names lazily on next sync
        }
        loaded = true
    }

    func model(_ id: String) -> NeuralDoc? { models.first { $0.id == id } }

    /// Save locally (instant) + debounce a background push to the server.
    func persist(_ doc: NeuralDoc) {
        var d = doc
        d.updated = Date().timeIntervalSince1970 * 1000
        NeuralLocalStore.save(d)
        if let i = models.firstIndex(where: { $0.id == d.id }) { models[i] = d } else { models.insert(d, at: 0) }
        scheduleSync(d.id)
    }

    private func scheduleSync(_ id: String) {
        syncTimer?.invalidate()
        syncTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            // Bind `self` OUTSIDE the Task. Writing `Task { await self?.… }` makes
            // the Task close over the optional captured var itself, which Swift 6
            // rejects ("reference to captured var 'self' in concurrently-executing
            // code"). Unwrapping first hands the Task a plain immutable value.
            guard let self else { return }
            Task { await self.pushToServer(id) }
        }
    }

    private func pushToServer(_ id: String) async {
        guard let doc = model(id) else { return }
        do {
            if let sid = serverId[id] {
                try await API.shared.updateNetwork(sid, name: doc.name, doc: doc)
            } else {
                let sid = try await API.shared.createNetwork(name: doc.name, doc: doc)
                serverId[id] = sid
            }
        } catch { /* offline; local file is the source of truth, retry next edit */ }
    }

    // MARK: - create / delete

    func create(_ doc: NeuralDoc) { persist(doc) }
    func createFromTemplate(_ t: NeuralTemplate) -> NeuralDoc { let d = t.makeDoc(); persist(d); return d }

    func delete(_ id: String) {
        NeuralLocalStore.delete(id)
        models.removeAll { $0.id == id }
        if let sid = serverId[id] { Task { try? await API.shared.deleteNetwork(sid) }; serverId[id] = nil }
    }

    func rename(_ id: String, _ name: String) {
        guard var doc = model(id) else { return }
        doc.name = name; persist(doc)
    }

    // MARK: - upgrade (rebuild architecture, keep data)

    func upgrade(_ id: String, arch: NeuralDoc.Arch, name: String) {
        guard var doc = model(id) else { return }
        doc.arch = arch; doc.name = name
        doc.model = nil                    // rebuilt on next train
        doc.trainState.steps = 0; doc.trainState.lossHistory = []
        persist(doc)
    }

    // MARK: - data editing — PRETRAIN is free text, FINETUNE is conversations

    func addPretrain(_ id: String, name: String, text: String) {
        guard var doc = model(id) else { return }
        doc.data.pretrain.append(NeuralDoc.DataSet(id: NeuralDoc.newId(), name: name, text: text)); persist(doc)
    }
    func editPretrain(_ id: String, setId: String, name: String, text: String) {
        guard var doc = model(id) else { return }
        if let i = doc.data.pretrain.firstIndex(where: { $0.id == setId }) { doc.data.pretrain[i].name = name; doc.data.pretrain[i].text = text; persist(doc) }
    }
    func removePretrain(_ id: String, setId: String) {
        guard var doc = model(id) else { return }
        doc.data.pretrain.removeAll { $0.id == setId }; persist(doc)
    }
    /// Add/replace a fine-tune CONVERSATION (turns are already {role,content}).
    func saveConversation(_ id: String, convo: NeuralDoc.Conversation) {
        guard var doc = model(id) else { return }
        if let i = doc.data.finetune.firstIndex(where: { $0.id == convo.id }) { doc.data.finetune[i] = convo }
        else { doc.data.finetune.append(convo) }
        persist(doc)
    }
    func removeConversation(_ id: String, convoId: String) {
        guard var doc = model(id) else { return }
        doc.data.finetune.removeAll { $0.id == convoId }; persist(doc)
    }
    func conversation(_ id: String, convoId: String) -> NeuralDoc.Conversation? {
        model(id)?.data.finetune.first { $0.id == convoId }
    }
    /// Import conversations from JSONL text; returns imported count or an error message.
    func importJSONL(_ id: String, text: String) -> (added: Int, error: String?) {
        let parsed = ChatTemplate.parseJSONL(text)
        if let e = parsed.errors.first { return (0, e + (parsed.errors.count > 1 ? " (+\(parsed.errors.count - 1) more)" : "")) }
        guard !parsed.conversations.isEmpty else { return (0, "No conversations found") }
        guard var doc = model(id) else { return (0, "model missing") }
        for turns in parsed.conversations {
            doc.data.finetune.append(NeuralDoc.Conversation(id: NeuralDoc.newId(), name: "Imported \(doc.data.finetune.count + 1)", turns: turns))
        }
        persist(doc)
        return (parsed.conversations.count, nil)
    }
    /// Stack (copy) a pre-training set or a conversation from a template/other model.
    func stackPretrain(_ id: String, name: String, text: String) { addPretrain(id, name: name, text: text) }
    func stackConversation(_ id: String, name: String, turns: [NeuralDoc.Turn]) {
        guard var doc = model(id), !turns.isEmpty else { return }
        doc.data.finetune.append(NeuralDoc.Conversation(id: NeuralDoc.newId(), name: name, turns: turns)); persist(doc)
    }

    // MARK: - training (on-device, off the main thread, with progress ticks)

    private var stopFlag = false

    func stopTraining() { stopFlag = true }

    func train(_ id: String) {
        guard !training, let doc = model(id) else { return }
        let corpus = doc.buildCorpus()
        guard corpus.count >= 8 else { trainStatus = "add training data first"; return }
        training = true; stopFlag = false; trainingId = id
        trainStatus = "preparing…"

        // Capture ONLY immutable, sendable values for the background work. All access to
        // `self` happens back on the main actor via awaited hops — the detached task
        // touches nothing actor-isolated, which keeps it clean under Swift 6 concurrency.
        let arch = doc.arch
        let optCfg = doc.trainState.opt
        let startModel = doc.model
        let startSteps = doc.trainState.steps
        let startLosses = doc.trainState.lossHistory

        Task.detached(priority: .userInitiated) {
            // build tokenizer + model if needed (heavy; off main)
            var model: NeuralEngine.Model
            if let existing = startModel {
                model = existing
            } else {
                let tok = Tokenizer.train(String(corpus.prefix(500_000)), mode: arch.tokMode, maxVocab: arch.maxVocab)
                model = NeuralEngine.llmInit(tok: tok, ctx: arch.ctx, embed: arch.embed, act: arch.act,
                                             dropout: arch.dropout, layers: arch.layers, seed: optCfg.seed)
                let vocab = tok.vocab.count
                await MainActor.run { NeuralStore.shared?.trainStatus = "tokenizer: \(vocab) tokens" }
            }
            let ids = model.tok.encode(corpus)
            guard ids.count >= model.cfg.ctx + 2 else {
                await MainActor.run { NeuralStore.shared?.finishTraining(id, model: nil, steps: 0, losses: []); NeuralStore.shared?.trainStatus = "not enough text for this context" }
                return
            }

            let opt = NeuralEngine.OptState()
            opt.kind = optCfg.kind; opt.lr = optCfg.lr
            let stepsPerIter = 3
            let itersPerEpoch = max(3, min(50, ids.count / max(1, arch.ctx * optCfg.batch)))
            let totalIters = itersPerEpoch * max(1, optCfg.epochs)

            var steps = startSteps
            var losses = startLosses

            for iter in 0..<totalIters {
                if await NeuralStore.shared?.isStopped() ?? true { break }
                let loss = NeuralEngine.trainChunk(&model, ids: ids, opt: opt, batch: optCfg.batch,
                                                   steps: stepsPerIter, seed: optCfg.seed, iter: steps)
                steps += stepsPerIter
                losses.append(loss)
                if losses.count > 400 { losses = Array(losses.suffix(400)) }
                let epoch = min(optCfg.epochs, iter / itersPerEpoch + 1)
                let snapModel = model, snapSteps = steps, snapLosses = losses
                let statusLine = String(format: "%d steps · loss %.3f · epoch %d/%d", snapSteps, loss, epoch, optCfg.epochs)
                let doCheckpoint = (iter % 4 == 0 || iter == totalIters - 1)
                await MainActor.run {
                    guard let store = NeuralStore.shared else { return }
                    store.trainStatus = statusLine
                    if doCheckpoint { store.checkpoint(id, model: snapModel, steps: snapSteps, losses: snapLosses) }
                }
            }
            let finalModel = model, finalSteps = steps, finalLosses = losses
            await MainActor.run { NeuralStore.shared?.finishTraining(id, model: finalModel, steps: finalSteps, losses: finalLosses) }
        }
    }

    func isStopped() -> Bool { stopFlag }

    /// Mid-training checkpoint into the doc + local store (no server push each tick).
    func checkpoint(_ id: String, model: NeuralEngine.Model, steps: Int, losses: [Double]) {
        guard var doc = self.model(id) else { return }
        doc.model = model; doc.trainState.steps = steps; doc.trainState.lossHistory = losses
        NeuralLocalStore.save(doc)
        if let i = models.firstIndex(where: { $0.id == id }) { models[i] = doc }
    }

    func finishTraining(_ id: String, model: NeuralEngine.Model?, steps: Int, losses: [Double]) {
        training = false; stopFlag = false; trainingId = nil
        guard var doc = self.model(id) else { return }
        if let model { doc.model = model; doc.trainState.steps = steps; doc.trainState.lossHistory = losses }
        persist(doc)   // final save + server push
        if model != nil { trainStatus = "done — try it on the Inference tab" }
    }

    // MARK: - inference

    /// Generate a chat reply. `prompt` is the conversation serialized in the chat template
    /// ending with an open assistant turn; we stop at the closing "} and clean the reply.
    func chat(_ id: String, history: [NeuralDoc.Turn], length: Int, temperature: Double, completion: @escaping @MainActor (String) -> Void) {
        guard let doc = model(id), let model = doc.model, doc.trainState.steps > 0 else { completion("(train the model first)"); return }
        let prompt = ChatTemplate.buildPrompt(history, maxTurns: 8)
        Task.detached(priority: .userInitiated) {
            let raw = NeuralEngine.sample(model, prompt: prompt, length: length, temperature: temperature,
                                          topK: 40, stop: ChatTemplate.stop, seed: UInt32.random(in: 1...UInt32.max))
            let reply = ChatTemplate.extractReply(raw)
            await MainActor.run { completion(reply.isEmpty ? "…" : reply) }
        }
    }
}

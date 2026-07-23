import Foundation
import SwiftUI

/// Owns the Neural system's models. LOCAL-FIRST: models live as JSON files on device
/// (`NeuralLocalStore`) and all training/inference runs ON THIS DEVICE via
/// `NeuralEngine`. The server's `/api/networks` API is a backup/cross-device sync
/// target — we push after edits and can pull on a fresh install. This mirrors the
/// Habit system's local-first design.
@MainActor
final class NeuralStore: ObservableObject {
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
            Task { await self?.pushToServer(id) }
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

    // MARK: - data editing

    func addDataSet(_ id: String, section: DataSection, name: String, text: String) {
        guard var doc = model(id) else { return }
        let set = NeuralDoc.DataSet(id: NeuralDoc.newId(), name: name, text: text)
        switch section { case .pretrain: doc.data.pretrain.append(set); case .finetune: doc.data.finetune.append(set) }
        persist(doc)
    }
    func editDataSet(_ id: String, section: DataSection, setId: String, name: String, text: String) {
        guard var doc = model(id) else { return }
        func edit(_ arr: inout [NeuralDoc.DataSet]) { if let i = arr.firstIndex(where: { $0.id == setId }) { arr[i].name = name; arr[i].text = text } }
        switch section { case .pretrain: edit(&doc.data.pretrain); case .finetune: edit(&doc.data.finetune) }
        persist(doc)
    }
    func removeDataSet(_ id: String, section: DataSection, setId: String) {
        guard var doc = model(id) else { return }
        switch section { case .pretrain: doc.data.pretrain.removeAll { $0.id == setId }; case .finetune: doc.data.finetune.removeAll { $0.id == setId } }
        persist(doc)
    }
    /// Stack (copy) a data set from another model or a template into this one.
    func stack(_ id: String, into section: DataSection, name: String, text: String) {
        addDataSet(id, section: section, name: name, text: text)
    }

    enum DataSection { case pretrain, finetune }

    // MARK: - training (on-device, off the main thread, with progress ticks)

    private var stopFlag = false

    func stopTraining() { stopFlag = true }

    func train(_ id: String) {
        guard !training, var doc = model(id) else { return }
        let corpus = doc.buildCorpus()
        guard corpus.count >= 8 else { trainStatus = "add training data first"; return }
        training = true; stopFlag = false; trainingId = id
        trainStatus = "preparing…"

        // capture immutable inputs for the background task
        let arch = doc.arch
        let optCfg = doc.trainState.opt

        Task.detached(priority: .userInitiated) { [weak self] in
            // build tokenizer + model if needed (heavy; off main)
            var model: NeuralEngine.Model
            if let existing = doc.model {
                model = existing
            } else {
                let tok = Tokenizer.train(String(corpus.prefix(500_000)), mode: arch.tokMode, maxVocab: arch.maxVocab)
                model = NeuralEngine.llmInit(tok: tok, ctx: arch.ctx, embed: arch.embed, act: arch.act,
                                             dropout: arch.dropout, layers: arch.layers, seed: optCfg.seed)
                await MainActor.run { self?.trainStatus = "tokenizer: \(tok.vocab.count) tokens" }
            }
            let ids = model.tok.encode(corpus)
            guard ids.count >= model.cfg.ctx + 2 else {
                await MainActor.run { self?.finishTraining(id, model: nil, steps: 0, losses: []) ; self?.trainStatus = "not enough text for this context" }
                return
            }

            let opt = NeuralEngine.OptState()
            opt.kind = optCfg.kind; opt.lr = optCfg.lr
            let stepsPerIter = 3
            let itersPerEpoch = max(3, min(50, ids.count / max(1, arch.ctx * optCfg.batch)))
            let totalIters = itersPerEpoch * max(1, optCfg.epochs)

            var steps = doc.trainState.steps
            var losses = doc.trainState.lossHistory

            for iter in 0..<totalIters {
                if await self?.isStopped() ?? true { break }
                let loss = NeuralEngine.trainChunk(&model, ids: ids, opt: opt, batch: optCfg.batch,
                                                   steps: stepsPerIter, seed: optCfg.seed, iter: steps)
                steps += stepsPerIter
                losses.append(loss)
                if losses.count > 400 { losses = Array(losses.suffix(400)) }
                let epoch = min(optCfg.epochs, iter / itersPerEpoch + 1)
                let snapModel = model, snapSteps = steps, snapLosses = losses
                await MainActor.run {
                    self?.trainStatus = String(format: "%d steps · loss %.3f · epoch %d/%d", snapSteps, loss, epoch, optCfg.epochs)
                    // periodically checkpoint so progress isn't lost if the app is killed
                    if iter % 4 == 0 || iter == totalIters - 1 {
                        self?.checkpoint(id, model: snapModel, steps: snapSteps, losses: snapLosses)
                    }
                }
            }
            let finalModel = model, finalSteps = steps, finalLosses = losses
            await MainActor.run {
                self?.finishTraining(id, model: finalModel, steps: finalSteps, losses: finalLosses)
            }
        }
    }

    private func isStopped() -> Bool { stopFlag }

    /// Mid-training checkpoint into the doc + local store (no server push each tick).
    private func checkpoint(_ id: String, model: NeuralEngine.Model, steps: Int, losses: [Double]) {
        guard var doc = self.model(id) else { return }
        doc.model = model; doc.trainState.steps = steps; doc.trainState.lossHistory = losses
        NeuralLocalStore.save(doc)
        if let i = models.firstIndex(where: { $0.id == id }) { models[i] = doc }
    }

    private func finishTraining(_ id: String, model: NeuralEngine.Model?, steps: Int, losses: [Double]) {
        training = false; stopFlag = false; trainingId = nil
        guard var doc = self.model(id) else { return }
        if let model { doc.model = model; doc.trainState.steps = steps; doc.trainState.lossHistory = losses }
        persist(doc)   // final save + server push
        if model != nil { trainStatus = "done — try it on the Inference tab" }
    }

    // MARK: - inference

    /// Generate a reply. Runs off-main and returns via the completion on the main actor.
    func generate(_ id: String, prompt: String, length: Int, temperature: Double, completion: @escaping (String) -> Void) {
        guard let doc = model(id), let model = doc.model, doc.trainState.steps > 0 else { completion("(train the model first)"); return }
        Task.detached(priority: .userInitiated) {
            let text = NeuralEngine.sample(model, prompt: prompt, length: length, temperature: temperature,
                                           topK: 40, seed: UInt32.random(in: 1...UInt32.max))
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            await MainActor.run { completion(trimmed.isEmpty ? "…" : trimmed) }
        }
    }
}

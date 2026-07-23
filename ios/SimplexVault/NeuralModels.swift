import Foundation

/// The tokenizer, ported from neural-engine.js. Four modes; specials at indices 0-3.
/// A tokenizer is Codable so it saves inside the model doc.
struct Tokenizer: Codable {
    var mode: String            // char | bpe | word | sentence
    var vocab: [String]
    var merges: [[String]]      // BPE merges (ordered), empty for other modes

    static let specials = ["<pad>", "<unk>", "<bos>", "<eos>"]
    static let PAD = 0, UNK = 1, BOS = 2, EOS = 3

    // stoi cache (not encoded/decoded)
    private var stoiCache: [String: Int]? = nil
    enum CodingKeys: String, CodingKey { case mode, vocab, merges }

    init(mode: String, vocab: [String], merges: [[String]] = []) {
        self.mode = mode; self.vocab = vocab; self.merges = merges
    }

    private func stoi() -> [String: Int] {
        var s: [String: Int] = [:]; s.reserveCapacity(vocab.count)
        for (i, t) in vocab.enumerated() { s[t] = i }
        return s
    }

    // MARK: - splitting helpers

    static func wordPieces(_ text: String) -> [String] {
        var out: [String] = []
        var cur = ""
        func flush() { if !cur.isEmpty { out.append(cur); cur = "" } }
        for ch in text {
            if ch.isLetter || ch.isNumber || ch == "'" { cur.append(ch) }
            else { flush(); if !ch.isWhitespace { out.append(String(ch)) } }
        }
        flush()
        return out
    }
    static func sentencePieces(_ text: String) -> [String] {
        var out: [String] = []
        var cur = ""
        for ch in text {
            cur.append(ch)
            if ch == "." || ch == "!" || ch == "?" || ch == "\n" {
                let trimmed = cur.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { out.append(trimmed) }
                cur = ""
            }
        }
        let trimmed = cur.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { out.append(trimmed) }
        return out
    }
    static func topCounts(_ pieces: [String], _ k: Int) -> [String] {
        var c: [String: Int] = [:]
        for p in pieces { c[p, default: 0] += 1 }
        return c.sorted { $0.value > $1.value }.prefix(max(0, k)).map { $0.key }
    }

    // MARK: - train

    static func train(_ text: String, mode: String, maxVocab: Int) -> Tokenizer {
        let cap = max(16, min(8000, maxVocab))
        switch mode {
        case "word":
            return Tokenizer(mode: "word", vocab: specials + topCounts(wordPieces(text), cap - specials.count))
        case "sentence":
            return Tokenizer(mode: "sentence", vocab: specials + topCounts(sentencePieces(text), cap - specials.count))
        case "bpe":
            return bpeTrain(text, cap)
        default: // char
            var seen = Set<String>(); var vocab = specials
            for ch in text { let s = String(ch); if !seen.contains(s) && vocab.count < cap { seen.insert(s); vocab.append(s) } }
            return Tokenizer(mode: "char", vocab: vocab)
        }
    }

    private static func bpeTrain(_ text: String, _ maxVocab: Int) -> Tokenizer {
        var seen = Set<String>(); var charSet: [String] = []
        for ch in text { let s = String(ch); if !seen.contains(s) { seen.insert(s); charSet.append(s) } }
        var vocab = specials + charSet
        var vset = Set(vocab)
        // pre-tokenize into whitespace-delimited chunks (keeps merges inside "words")
        var chunks: [[String]] = []
        var cur = ""
        var isSpace = false
        func flushChunk() { if !cur.isEmpty { chunks.append(cur.map { String($0) }); cur = "" } }
        for ch in text {
            let sp = ch.isWhitespace
            if sp != isSpace { flushChunk(); isSpace = sp }
            cur.append(ch)
        }
        flushChunk()

        var merges: [[String]] = []
        let budget = min(maxVocab - vocab.count, 4000)
        for _ in 0..<max(0, budget) {
            var pairs: [String: Int] = [:]
            for w in chunks where w.count > 1 {
                for i in 0..<(w.count - 1) { pairs[w[i] + " " + w[i + 1], default: 0] += 1 }
            }
            var best: String? = nil; var bestN = 1
            for (k, n) in pairs where n > bestN { bestN = n; best = k }
            guard let bestPair = best else { break }
            let parts = bestPair.components(separatedBy: " ")
            guard parts.count == 2 else { break }
            let a = parts[0], b = parts[1], merged = a + b
            if vset.contains(merged) { continue }
            merges.append([a, b]); vocab.append(merged); vset.insert(merged)
            for wi in 0..<chunks.count {
                var w = chunks[wi]; var i = 0
                while i < w.count - 1 { if w[i] == a && w[i + 1] == b { w.replaceSubrange(i...(i + 1), with: [merged]) } else { i += 1 } }
                chunks[wi] = w
            }
            if vocab.count >= maxVocab { break }
        }
        return Tokenizer(mode: "bpe", vocab: vocab, merges: merges)
    }

    // MARK: - encode / decode

    func encode(_ text: String) -> [Int] {
        let s = stoi()
        var ids: [Int] = []
        switch mode {
        case "word":
            for p in Tokenizer.wordPieces(text) { ids.append(s[p] ?? Tokenizer.UNK) }
        case "sentence":
            for p in Tokenizer.sentencePieces(text) { ids.append(s[p] ?? Tokenizer.UNK) }
        case "bpe":
            // split into whitespace-delimited chunks, apply merges greedily
            var chunks: [[String]] = []
            var cur = ""; var isSpace = false
            func flush() { if !cur.isEmpty { chunks.append(cur.map { String($0) }); cur = "" } }
            for ch in text { let sp = ch.isWhitespace; if sp != isSpace { flush(); isSpace = sp }; cur.append(ch) }
            flush()
            for var w in chunks {
                for m in merges {
                    var i = 0
                    while i < w.count - 1 { if w[i] == m[0] && w[i + 1] == m[1] { w.replaceSubrange(i...(i + 1), with: [m[0] + m[1]]) } else { i += 1 } }
                }
                for sym in w { ids.append(s[sym] ?? Tokenizer.UNK) }
            }
        default: // char
            for ch in text { ids.append(s[String(ch)] ?? Tokenizer.UNK) }
        }
        return ids
    }

    func decode(_ ids: [Int]) -> String {
        var out = ""
        for id in ids {
            if id == Tokenizer.PAD || id == Tokenizer.BOS || id == Tokenizer.EOS { continue }
            guard id >= 0 && id < vocab.count else { continue }
            let t = id == Tokenizer.UNK ? "\u{fffd}" : vocab[id]
            if mode == "word" {
                let isPunct = t.count == 1 && !(t.first!.isLetter || t.first!.isNumber || t.first! == "'")
                if !out.isEmpty && !isPunct { out += " " }
                out += t
            } else if mode == "sentence" {
                if !out.isEmpty { out += " " }
                out += t
            } else {
                out += t
            }
        }
        return out
    }
}

// MARK: - Model document (local-first, Codable, saved to the vault / server)

/// One neural model on the phone. The PHONE is the source of truth (local JSON files);
/// the server's `networks` API is a backup/cross-device sync target (opaque JSON), same
/// as the web app's `networks` table.
struct NeuralDoc: Codable, Identifiable {
    var id: String
    var name: String
    var arch: Arch
    var data: DataSets
    var trainState: TrainState
    var model: NeuralEngine.Model?          // nil until first train (or after upgrade)
    var updated: Double

    struct Arch: Codable {
        var tokMode: String = "char"
        var maxVocab: Int = 512
        var ctx: Int = 64
        var embed: Int = 48
        var act: String = "gelu"
        var dropout: Double = 0.0
        var layers: [Int] = [96, 96]
    }
    struct DataSet: Codable, Identifiable, Hashable {
        var id: String
        var name: String
        var text: String
    }
    struct DataSets: Codable {
        var pretrain: [DataSet] = []
        var finetune: [DataSet] = []
    }
    struct TrainState: Codable {
        var steps: Int = 0
        var lossHistory: [Double] = []
        var opt: Opt = Opt()
        struct Opt: Codable {
            var kind: String = "adamw"
            var lr: Double = 0.003
            var batch: Int = 8
            var epochs: Int = 1
            var seed: UInt32 = 7
        }
    }

    static func fresh(arch: Arch = Arch(), name: String = "New model") -> NeuralDoc {
        NeuralDoc(id: newId(), name: name, arch: arch, data: DataSets(),
                  trainState: TrainState(), model: nil, updated: Date().timeIntervalSince1970 * 1000)
    }
    static func newId() -> String {
        let raw = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return "n" + String(raw.prefix(15))
    }

    /// Concatenated corpus: pre-training first, fine-tuning (lightly repeated) after.
    func buildCorpus() -> String {
        let pre = data.pretrain.map { $0.text }.joined(separator: "\n\n")
        let fine = data.finetune.map { $0.text }.joined(separator: "\n\n")
        let fineRepeat = fine.isEmpty ? "" : String(repeating: fine + "\n\n", count: pre.count > fine.count * 3 ? 2 : 1)
        return (pre + "\n\n" + fineRepeat).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var totalDataChars: Int { (data.pretrain + data.finetune).reduce(0) { $0 + $1.text.count } }
}

// MARK: - Templates (mirror the web app's NN_TEMPLATES)

struct NeuralTemplate: Identifiable {
    let id: String
    let name: String
    let icon: String
    let desc: String
    let arch: NeuralDoc.Arch
    let pretrain: [(String, String)]
    let finetune: [(String, String)]

    func makeDoc() -> NeuralDoc {
        var doc = NeuralDoc.fresh(arch: arch, name: name)
        doc.data.pretrain = pretrain.map { .init(id: NeuralDoc.newId(), name: $0.0, text: $0.1) }
        doc.data.finetune = finetune.map { .init(id: NeuralDoc.newId(), name: $0.0, text: $0.1) }
        return doc
    }

    static let all: [NeuralTemplate] = [
        NeuralTemplate(
            id: "tinytales", name: "Tiny Storyteller", icon: "text.book.closed",
            desc: "A character model that writes short fairy-tale sentences. A great first train.",
            arch: .init(tokMode: "char", maxVocab: 96, ctx: 64, embed: 48, act: "gelu", dropout: 0.05, layers: [96, 96]),
            pretrain: [("Little stories", String(repeating: """
            Once upon a time a small fox lived by a river. The fox loved to watch the stars.
            One night the moon was bright and the fox made a wish. A gentle owl heard the wish and smiled.
            The little fox ran through the tall grass and found a shiny stone. The stone glowed in the dark.
            Every morning the sun rose over the green hills and the birds began to sing.
            A kind rabbit shared her carrots with the hungry fox. They became the best of friends.

            """, count: 4))],
            finetune: [("Story openers", String(repeating: """
            Once upon a time, there was a brave little mouse.
            Long ago, in a land of snow, a friendly bear woke up.

            """, count: 3))]),
        NeuralTemplate(
            id: "chatbot", name: "Politeness Bot", icon: "bubble.left.and.bubble.right",
            desc: "A subword model fine-tuned on short, friendly question and answer pairs.",
            arch: .init(tokMode: "bpe", maxVocab: 800, ctx: 48, embed: 56, act: "gelu", dropout: 0.1, layers: [112, 112]),
            pretrain: [("Everyday sentences", String(repeating: """
            Hello there. How are you today? I am doing very well, thank you.
            Please let me know if you need any help. I am happy to assist you.
            Thank you so much for your patience. Have a wonderful afternoon.

            """, count: 6))],
            finetune: [("Q and A", String(repeating: """
            Q: How are you? A: I am doing great, thank you for asking!
            Q: What is your name? A: You can call me Simplex, your friendly model.
            Q: Can you help me? A: Of course! I would be glad to help you.

            """, count: 5))]),
        NeuralTemplate(
            id: "poet", name: "Couplet Poet", icon: "sparkles",
            desc: "A word-level model that learns rhythmic, rhyming lines from a small poem set.",
            arch: .init(tokMode: "word", maxVocab: 1200, ctx: 24, embed: 64, act: "tanh", dropout: 0.1, layers: [128]),
            pretrain: [("Little poems", String(repeating: """
            the moon is bright the night is deep the little stars begin to sleep
            the river flows the willows bend the winding road will never end
            the morning light the golden sun the day has only just begun

            """, count: 8))],
            finetune: [])
    ]
}

// MARK: - Local store (JSON files in Documents, one per model)

enum NeuralLocalStore {
    private static var dir: URL {
        let d = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("neural", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }
    private static func url(_ id: String) -> URL { dir.appendingPathComponent(id + ".json") }

    static func list() -> [NeuralDoc] {
        guard let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var docs: [NeuralDoc] = []
        for f in files where f.pathExtension == "json" {
            if let data = try? Data(contentsOf: f), let doc = try? JSONDecoder().decode(NeuralDoc.self, from: data) { docs.append(doc) }
        }
        return docs.sorted { $0.updated > $1.updated }
    }
    static func save(_ doc: NeuralDoc) {
        var d = doc; d.updated = Date().timeIntervalSince1970 * 1000
        if let data = try? JSONEncoder().encode(d) { try? data.write(to: url(doc.id)) }
    }
    static func delete(_ id: String) { try? FileManager.default.removeItem(at: url(id)) }
}

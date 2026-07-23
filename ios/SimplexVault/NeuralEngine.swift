import Foundation

/// A small-but-real decoder-only transformer language model, ported from the web app's
/// `neural-engine.js` so the iOS "Neural" system trains models ON-DEVICE with the same
/// math. Educational-scale by design (small vocab / context / params) so a phone can
/// actually train it, but it is a genuine transformer trained by backprop: token +
/// positional embeddings → N transformer blocks (multi-head causal attention + MLP +
/// layernorm) → output head, cross-entropy on next-token, optimized with a real
/// optimizer (AdamW / RAdam / Lion / LAMB / SGD).
///
/// Everything is `Double` arrays and value types so a model round-trips through JSON
/// (Codable) and can be saved to the vault or shipped to the server, exactly like the
/// web/Node engine.
enum NeuralEngine {

    // MARK: - RNG (mulberry32, matches the JS engine for reproducibility)

    struct RNG {
        var a: UInt32
        init(_ seed: UInt32) { a = seed == 0 ? 1 : seed }
        mutating func next() -> Double {
            a = a &+ 0x6D2B79F5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
        }
        mutating func gaussian() -> Double {
            var u = 0.0, v = 0.0
            while u == 0 { u = next() }
            while v == 0 { v = next() }
            return (-2 * log(u)).squareRoot() * cos(2 * .pi * v)
        }
    }

    static func zeros(_ n: Int) -> [Double] { [Double](repeating: 0, count: n) }
    static func ones(_ n: Int) -> [Double] { [Double](repeating: 1, count: n) }
    static func randMat(_ rows: Int, _ cols: Int, _ rng: inout RNG, _ scale: Double) -> [Double] {
        var m = [Double](repeating: 0, count: rows * cols)
        for i in 0..<m.count { m[i] = rng.gaussian() * scale }
        return m
    }

    // MARK: - Activations

    static func actF(_ name: String, _ x: Double) -> Double {
        switch name {
        case "relu":    return x > 0 ? x : 0
        case "leaky":   return x > 0 ? x : 0.01 * x
        case "tanh":    return Foundation.tanh(x)
        case "sigmoid": return 1 / (1 + exp(-x))
        case "gelu":    return 0.5 * x * (1 + Foundation.tanh(0.7978845608 * (x + 0.044715 * x * x * x)))
        default:        return x
        }
    }
    /// Derivative in terms of the pre-activation x (needed for gelu; others fine too).
    static func actDF(_ name: String, _ x: Double, _ y: Double) -> Double {
        switch name {
        case "relu":    return y > 0 ? 1 : 0
        case "leaky":   return y > 0 ? 1 : 0.01
        case "tanh":    return 1 - y * y
        case "sigmoid": return y * (1 - y)
        case "gelu":
            let c = 0.7978845608, a = 0.044715
            let t = Foundation.tanh(c * (x + a * x * x * x))
            let sech2 = 1 - t * t
            return 0.5 * (1 + t) + 0.5 * x * sech2 * c * (1 + 3 * a * x * x)
        default:        return 1
        }
    }

    // MARK: - Model types (Codable = JSON-serializable to the vault / server)

    struct Block: Codable {
        var ln1g: [Double]; var ln1b: [Double]
        var Wq: [Double]; var Wk: [Double]; var Wv: [Double]; var Wo: [Double]
        var ln2g: [Double]; var ln2b: [Double]
        var W1: [Double]; var b1: [Double]; var W2: [Double]; var b2: [Double]
        var h: Int
    }
    struct Config: Codable {
        var ctx: Int; var embed: Int; var act: String; var dropout: Double
        var layers: [Int]; var heads: Int
    }
    struct Model: Codable {
        var tok: Tokenizer
        var cfg: Config
        var Wtok: [Double]; var Wpos: [Double]
        var blocks: [Block]
        var lnFg: [Double]; var lnFb: [Double]
        var Wout: [Double]; var bout: [Double]
        var seed: UInt32
    }

    // MARK: - Construction

    static func pickHeads(_ E: Int) -> Int {
        for h in [8, 6, 4, 3, 2] where E % h == 0 && E / h >= 8 { return h }
        return 1
    }
    static func clampInt(_ v: Int, _ lo: Int, _ hi: Int) -> Int { max(lo, min(hi, v)) }
    static func clampD(_ v: Double, _ lo: Double, _ hi: Double) -> Double { max(lo, min(hi, v)) }

    static func newBlock(_ E: Int, _ hidden: Int, _ rng: inout RNG) -> Block {
        Block(
            ln1g: ones(E), ln1b: zeros(E),
            Wq: randMat(E, E, &rng, 1 / Double(E).squareRoot()),
            Wk: randMat(E, E, &rng, 1 / Double(E).squareRoot()),
            Wv: randMat(E, E, &rng, 1 / Double(E).squareRoot()),
            Wo: randMat(E, E, &rng, 1 / Double(E).squareRoot()),
            ln2g: ones(E), ln2b: zeros(E),
            W1: randMat(hidden, E, &rng, (2 / Double(E)).squareRoot()), b1: zeros(hidden),
            W2: randMat(E, hidden, &rng, 1 / Double(hidden).squareRoot()), b2: zeros(E),
            h: hidden)
    }

    static func llmInit(tok: Tokenizer, ctx: Int, embed: Int, act: String, dropout: Double,
                        layers: [Int], seed: UInt32) -> Model {
        let V = tok.vocab.count
        let E = clampInt(embed, 8, 256)
        let ctxC = clampInt(ctx, 8, 512)
        let layersC = (layers.isEmpty ? [E * 2] : layers).map { clampInt($0, 8, 1024) }.prefix(8).map { $0 }
        let heads = pickHeads(E)
        var rng = RNG(seed == 0 ? 7 : seed)
        var blocks: [Block] = []
        for h in layersC { blocks.append(newBlock(E, h, &rng)) }
        return Model(
            tok: tok,
            cfg: Config(ctx: ctxC, embed: E, act: act, dropout: clampD(dropout, 0, 0.6), layers: Array(layersC), heads: heads),
            Wtok: randMat(V, E, &rng, 0.4),
            Wpos: randMat(ctxC, E, &rng, 0.02),
            blocks: blocks,
            lnFg: ones(E), lnFb: zeros(E),
            Wout: randMat(V, E, &rng, 1 / Double(E).squareRoot()), bout: zeros(V),
            seed: seed == 0 ? 7 : seed)
    }

    static func paramCount(_ m: Model) -> Int {
        var n = m.Wtok.count + m.Wpos.count + m.Wout.count + m.bout.count + m.lnFg.count + m.lnFb.count
        for b in m.blocks {
            n += b.Wq.count + b.Wk.count + b.Wv.count + b.Wo.count + b.W1.count + b.b1.count + b.W2.count + b.b2.count + b.ln1g.count * 2 + b.ln2g.count * 2
        }
        return n
    }

    // MARK: - low-level ops

    static func layerNorm(_ x: [Double], _ g: [Double], _ b: [Double], _ E: Int) -> (y: [Double], xh: [Double], inv: Double) {
        var mean = 0.0; for i in 0..<E { mean += x[i] }; mean /= Double(E)
        var v = 0.0; for i in 0..<E { let d = x[i] - mean; v += d * d }; v /= Double(E)
        let inv = 1 / (v + 1e-5).squareRoot()
        var y = [Double](repeating: 0, count: E), xh = [Double](repeating: 0, count: E)
        for i in 0..<E { xh[i] = (x[i] - mean) * inv; y[i] = xh[i] * g[i] + b[i] }
        return (y, xh, inv)
    }
    static func layerNormBack(_ dy: [Double], _ xh: [Double], _ inv: Double, _ g: [Double], _ E: Int,
                              _ dg: inout [Double], _ db: inout [Double]) -> [Double] {
        var dx = [Double](repeating: 0, count: E)
        var sumDy = 0.0, sumDyXh = 0.0
        var dxh = [Double](repeating: 0, count: E)
        for i in 0..<E { dxh[i] = dy[i] * g[i]; dg[i] += dy[i] * xh[i]; db[i] += dy[i]; sumDy += dxh[i]; sumDyXh += dxh[i] * xh[i] }
        for i in 0..<E { dx[i] = inv / Double(E) * (Double(E) * dxh[i] - sumDy - xh[i] * sumDyXh) }
        return dx
    }
    static func matVec(_ W: [Double], _ x: [Double], _ rows: Int, _ cols: Int, _ bias: [Double]?) -> [Double] {
        var o = [Double](repeating: 0, count: rows)
        for r in 0..<rows {
            var s = bias?[r] ?? 0
            let base = r * cols
            for c in 0..<cols { s += W[base + c] * x[c] }
            o[r] = s
        }
        return o
    }

    // MARK: - Gradients container (mirrors Model's trainable tensors)

    struct Grads {
        var Wtok: [Double]; var Wpos: [Double]; var Wout: [Double]; var bout: [Double]
        var lnFg: [Double]; var lnFb: [Double]
        var blocks: [Block]
    }
    static func blankGrads(_ m: Model) -> Grads {
        Grads(
            Wtok: zeros(m.Wtok.count), Wpos: zeros(m.Wpos.count), Wout: zeros(m.Wout.count), bout: zeros(m.bout.count),
            lnFg: zeros(m.lnFg.count), lnFb: zeros(m.lnFb.count),
            blocks: m.blocks.map { b in
                Block(ln1g: zeros(b.ln1g.count), ln1b: zeros(b.ln1b.count),
                      Wq: zeros(b.Wq.count), Wk: zeros(b.Wk.count), Wv: zeros(b.Wv.count), Wo: zeros(b.Wo.count),
                      ln2g: zeros(b.ln2g.count), ln2b: zeros(b.ln2b.count),
                      W1: zeros(b.W1.count), b1: zeros(b.b1.count), W2: zeros(b.W2.count), b2: zeros(b.b2.count), h: b.h)
            })
    }
    static func addGrads(_ dst: inout Grads, _ src: Grads) {
        for i in 0..<dst.Wtok.count { dst.Wtok[i] += src.Wtok[i] }
        for i in 0..<dst.Wpos.count { dst.Wpos[i] += src.Wpos[i] }
        for i in 0..<dst.Wout.count { dst.Wout[i] += src.Wout[i] }
        for i in 0..<dst.bout.count { dst.bout[i] += src.bout[i] }
        for i in 0..<dst.lnFg.count { dst.lnFg[i] += src.lnFg[i]; dst.lnFb[i] += src.lnFb[i] }
        for L in 0..<dst.blocks.count {
            addTensor(&dst.blocks[L].ln1g, src.blocks[L].ln1g); addTensor(&dst.blocks[L].ln1b, src.blocks[L].ln1b)
            addTensor(&dst.blocks[L].Wq, src.blocks[L].Wq); addTensor(&dst.blocks[L].Wk, src.blocks[L].Wk)
            addTensor(&dst.blocks[L].Wv, src.blocks[L].Wv); addTensor(&dst.blocks[L].Wo, src.blocks[L].Wo)
            addTensor(&dst.blocks[L].ln2g, src.blocks[L].ln2g); addTensor(&dst.blocks[L].ln2b, src.blocks[L].ln2b)
            addTensor(&dst.blocks[L].W1, src.blocks[L].W1); addTensor(&dst.blocks[L].b1, src.blocks[L].b1)
            addTensor(&dst.blocks[L].W2, src.blocks[L].W2); addTensor(&dst.blocks[L].b2, src.blocks[L].b2)
        }
    }
    private static func addTensor(_ a: inout [Double], _ b: [Double]) { for i in 0..<a.count { a[i] += b[i] } }
    static func scaleGrads(_ g: inout Grads, _ s: Double) {
        for i in 0..<g.Wtok.count { g.Wtok[i] *= s }
        for i in 0..<g.Wpos.count { g.Wpos[i] *= s }
        for i in 0..<g.Wout.count { g.Wout[i] *= s }
        for i in 0..<g.bout.count { g.bout[i] *= s }
        for i in 0..<g.lnFg.count { g.lnFg[i] *= s; g.lnFb[i] *= s }
        for L in 0..<g.blocks.count {
            scaleTensor(&g.blocks[L].ln1g, s); scaleTensor(&g.blocks[L].ln1b, s)
            scaleTensor(&g.blocks[L].Wq, s); scaleTensor(&g.blocks[L].Wk, s); scaleTensor(&g.blocks[L].Wv, s); scaleTensor(&g.blocks[L].Wo, s)
            scaleTensor(&g.blocks[L].ln2g, s); scaleTensor(&g.blocks[L].ln2b, s)
            scaleTensor(&g.blocks[L].W1, s); scaleTensor(&g.blocks[L].b1, s); scaleTensor(&g.blocks[L].W2, s); scaleTensor(&g.blocks[L].b2, s)
        }
    }
    private static func scaleTensor(_ a: inout [Double], _ s: Double) { for i in 0..<a.count { a[i] *= s } }

    // MARK: - Forward + backward over one sequence (causal LM)

    /// Returns loss and (optionally) grads for the window `ids` (length T+1: predict
    /// ids[t+1] from ids[0..t]). Mirrors llmForwardBackward in neural-engine.js.
    static func forwardBackward(_ m: Model, _ ids: [Int], training: Bool, _ rng: inout RNG) -> (loss: Double, grads: Grads?) {
        let E = m.cfg.embed, heads = m.cfg.heads, hd = E / heads
        let V = m.tok.vocab.count
        let T = min(ids.count - 1, m.cfg.ctx)
        let drop = training ? m.cfg.dropout : 0
        var grads = blankGrads(m)

        // embeddings → residual stream
        var stream: [[Double]] = []
        stream.reserveCapacity(T)
        for t in 0..<T {
            let id = ids[t]; var x = [Double](repeating: 0, count: E)
            let tb = id * E, pb = t * E
            for i in 0..<E { x[i] = m.Wtok[tb + i] + m.Wpos[pb + i] }
            stream.append(x)
        }

        // caches per block for backward
        struct BC {
            var ln1xh: [[Double]] = [], ln1inv: [Double] = []
            var normed1: [[Double]] = [], q: [[Double]] = [], k: [[Double]] = [], v: [[Double]] = []
            var attProb: [[[Double]]] = [], attnOut: [[Double]] = []
            var res1: [[Double]] = []
            var ln2xh: [[Double]] = [], ln2inv: [Double] = [], normed2: [[Double]] = []
            var hPre: [[Double]] = [], hAct: [[Double]] = []
        }
        var caches: [BC] = []

        for L in 0..<m.blocks.count {
            let blk = m.blocks[L]
            var c = BC()
            var normed: [[Double]] = []
            for t in 0..<T {
                let ln = layerNorm(stream[t], blk.ln1g, blk.ln1b, E)
                normed.append(ln.y); c.ln1xh.append(ln.xh); c.ln1inv.append(ln.inv)
            }
            c.normed1 = normed
            var Q: [[Double]] = [], K: [[Double]] = [], Vv: [[Double]] = []
            for t in 0..<T { Q.append(matVec(blk.Wq, normed[t], E, E, nil)); K.append(matVec(blk.Wk, normed[t], E, E, nil)); Vv.append(matVec(blk.Wv, normed[t], E, E, nil)) }
            c.q = Q; c.k = K; c.v = Vv
            var attnOut: [[Double]] = [], attProb: [[[Double]]] = []
            for t in 0..<T {
                var outVec = [Double](repeating: 0, count: E)
                var probsHeads: [[Double]] = []
                for h in 0..<heads {
                    let off = h * hd
                    var scores = [Double](repeating: 0, count: t + 1)
                    for j in 0...t { var s = 0.0; for d in 0..<hd { s += Q[t][off + d] * K[j][off + d] }; scores[j] = s / Double(hd).squareRoot() }
                    var mx = -Double.infinity; for j in 0...t { if scores[j] > mx { mx = scores[j] } }
                    var sm = 0.0; for j in 0...t { scores[j] = exp(scores[j] - mx); sm += scores[j] }
                    for j in 0...t { scores[j] /= sm }
                    probsHeads.append(scores)
                    for d in 0..<hd { var acc = 0.0; for j in 0...t { acc += scores[j] * Vv[j][off + d] }; outVec[off + d] = acc }
                }
                attnOut.append(outVec); attProb.append(probsHeads)
            }
            c.attProb = attProb; c.attnOut = attnOut
            var res1: [[Double]] = []
            for t in 0..<T { let p = matVec(blk.Wo, attnOut[t], E, E, nil); var r = [Double](repeating: 0, count: E); for i in 0..<E { r[i] = stream[t][i] + p[i] }; res1.append(r) }
            c.res1 = res1
            var out2: [[Double]] = []
            for t in 0..<T {
                let ln = layerNorm(res1[t], blk.ln2g, blk.ln2b, E)
                c.ln2xh.append(ln.xh); c.ln2inv.append(ln.inv); c.normed2.append(ln.y)
                let pre = matVec(blk.W1, ln.y, blk.h, E, blk.b1)
                var a = [Double](repeating: 0, count: blk.h)
                for i in 0..<blk.h { a[i] = actF(m.cfg.act, pre[i]) }
                if drop > 0 { for i in 0..<blk.h { if rng.next() < drop { a[i] = 0 } else { a[i] /= (1 - drop) } } }
                c.hPre.append(pre); c.hAct.append(a)
                let o = matVec(blk.W2, a, E, blk.h, blk.b2)
                var r = [Double](repeating: 0, count: E); for i in 0..<E { r[i] = res1[t][i] + o[i] }
                out2.append(r)
            }
            caches.append(c)
            stream = out2
        }

        // final LN + head + loss
        var loss = 0.0; var count = 0
        var dStream = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
        var fXh: [[Double]] = [], fInv: [Double] = [], fFn: [[Double]] = []
        for t in 0..<T {
            let ln = layerNorm(stream[t], m.lnFg, m.lnFb, E)
            fXh.append(ln.xh); fInv.append(ln.inv); fFn.append(ln.y)
            let logits = matVec(m.Wout, ln.y, V, E, m.bout)
            var mx = -Double.infinity; for i in 0..<V { if logits[i] > mx { mx = logits[i] } }
            var s = 0.0; var probs = [Double](repeating: 0, count: V)
            for i in 0..<V { probs[i] = exp(logits[i] - mx); s += probs[i] }
            for i in 0..<V { probs[i] /= s }
            let y = ids[t + 1]
            loss += -log(max(probs[y], 1e-9)); count += 1
            // dlogits
            probs[y] -= 1
            var dfn = [Double](repeating: 0, count: E)
            for i in 0..<V { let dl = probs[i]; grads.bout[i] += dl; let base = i * E; for j in 0..<E { grads.Wout[base + j] += dl * fFn[t][j]; dfn[j] += dl * m.Wout[base + j] } }
            let dx = layerNormBack(dfn, fXh[t], fInv[t], m.lnFg, E, &grads.lnFg, &grads.lnFb)
            for j in 0..<E { dStream[t][j] += dx[j] }
        }

        // backward through blocks
        var dOut = dStream
        for L in stride(from: m.blocks.count - 1, through: 0, by: -1) {
            let blk = m.blocks[L]; let c = caches[L]
            var dRes1 = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            // MLP backward
            for t in 0..<T {
                let dO = dOut[t]
                for i in 0..<E { dRes1[t][i] += dO[i] }
                let a = c.hAct[t]; var da = [Double](repeating: 0, count: blk.h)
                for i in 0..<E { let dl = dO[i]; grads.blocks[L].b2[i] += dl; let base = i * blk.h; for k in 0..<blk.h { grads.blocks[L].W2[base + k] += dl * a[k]; da[k] += dl * blk.W2[base + k] } }
                var dpre = [Double](repeating: 0, count: blk.h); let pre = c.hPre[t]
                for k in 0..<blk.h { dpre[k] = da[k] * actDF(m.cfg.act, pre[k], a[k]) }
                var dn2 = [Double](repeating: 0, count: E); let n2 = c.normed2[t]
                for k in 0..<blk.h { let dl = dpre[k]; grads.blocks[L].b1[k] += dl; let base = k * E; for j in 0..<E { grads.blocks[L].W1[base + j] += dl * n2[j]; dn2[j] += dl * blk.W1[base + j] } }
                let dx = layerNormBack(dn2, c.ln2xh[t], c.ln2inv[t], blk.ln2g, E, &grads.blocks[L].ln2g, &grads.blocks[L].ln2b)
                for j in 0..<E { dRes1[t][j] += dx[j] }
            }
            // attention backward
            var dStreamIn = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            var dNormed = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            var dAttnOut = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            for t in 0..<T {
                for i in 0..<E { dStreamIn[t][i] += dRes1[t][i] }
                let ao = c.attnOut[t]; let dO = dRes1[t]
                for i in 0..<E { let dl = dO[i]; let base = i * E; for k in 0..<E { grads.blocks[L].Wo[base + k] += dl * ao[k]; dAttnOut[t][k] += dl * blk.Wo[base + k] } }
            }
            var dQ = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            var dK = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            var dV = [[Double]](repeating: [Double](repeating: 0, count: E), count: T)
            for t in 0..<T {
                for h in 0..<heads {
                    let off = h * hd; let probs = c.attProb[t][h]
                    var dScores = [Double](repeating: 0, count: t + 1)
                    for d in 0..<hd {
                        let grad = dAttnOut[t][off + d]
                        for j in 0...t { dV[j][off + d] += probs[j] * grad; dScores[j] += grad * c.v[j][off + d] }
                    }
                    var dot = 0.0; for j in 0...t { dot += dScores[j] * probs[j] }
                    for j in 0...t {
                        let ds = probs[j] * (dScores[j] - dot) / Double(hd).squareRoot()
                        for d in 0..<hd { dQ[t][off + d] += ds * c.k[j][off + d]; dK[j][off + d] += ds * c.q[t][off + d] }
                    }
                }
            }
            for t in 0..<T {
                let n1 = c.normed1[t]
                accumProj(&grads.blocks[L].Wq, blk.Wq, dQ[t], n1, &dNormed[t], E)
                accumProj(&grads.blocks[L].Wk, blk.Wk, dK[t], n1, &dNormed[t], E)
                accumProj(&grads.blocks[L].Wv, blk.Wv, dV[t], n1, &dNormed[t], E)
            }
            for t in 0..<T {
                let dx = layerNormBack(dNormed[t], c.ln1xh[t], c.ln1inv[t], blk.ln1g, E, &grads.blocks[L].ln1g, &grads.blocks[L].ln1b)
                for j in 0..<E { dStreamIn[t][j] += dx[j] }
            }
            dOut = dStreamIn
        }

        // embeddings backward
        for t in 0..<T {
            let id = ids[t]; let tb = id * E, pb = t * E
            for i in 0..<E { grads.Wtok[tb + i] += dOut[t][i]; grads.Wpos[pb + i] += dOut[t][i] }
        }

        return (loss / Double(max(1, count)), grads)
    }
    private static func accumProj(_ dW: inout [Double], _ W: [Double], _ dy: [Double], _ x: [Double], _ dx: inout [Double], _ E: Int) {
        for r in 0..<E { let dl = dy[r]; let base = r * E; for c in 0..<E { dW[base + c] += dl * x[c]; dx[c] += dl * W[base + c] } }
    }

    // MARK: - Optimizer state + step

    /// Persistent optimizer moments, flattened to match a stable tensor ordering.
    final class OptState {
        var kind = "adamw"; var lr = 0.003; var wd = 0.01
        var mom: [[Double]] = []; var vel: [[Double]] = []; var t = 0
    }
    /// One optimizer step given mean grads. Handles adamw/radam/lion/lamb/sgd.
    static func optStep(_ m: inout Model, _ g: Grads, _ opt: OptState) {
        // Build a flat, ordered array of tensor (value, grad) pairs, apply, write back.
        var vals: [[Double]] = []
        var grads: [[Double]] = []
        vals.append(m.Wtok); grads.append(g.Wtok)
        vals.append(m.Wpos); grads.append(g.Wpos)
        vals.append(m.Wout); grads.append(g.Wout)
        vals.append(m.bout); grads.append(g.bout)
        vals.append(m.lnFg); grads.append(g.lnFg)
        vals.append(m.lnFb); grads.append(g.lnFb)
        for L in 0..<m.blocks.count {
            let b = m.blocks[L], gb = g.blocks[L]
            vals.append(b.ln1g); grads.append(gb.ln1g); vals.append(b.ln1b); grads.append(gb.ln1b)
            vals.append(b.Wq); grads.append(gb.Wq); vals.append(b.Wk); grads.append(gb.Wk)
            vals.append(b.Wv); grads.append(gb.Wv); vals.append(b.Wo); grads.append(gb.Wo)
            vals.append(b.ln2g); grads.append(gb.ln2g); vals.append(b.ln2b); grads.append(gb.ln2b)
            vals.append(b.W1); grads.append(gb.W1); vals.append(b.b1); grads.append(gb.b1)
            vals.append(b.W2); grads.append(gb.W2); vals.append(b.b2); grads.append(gb.b2)
        }
        if opt.mom.count != vals.count {
            opt.mom = vals.map { zeros($0.count) }; opt.vel = vals.map { zeros($0.count) }; opt.t = 0
        }
        opt.t += 1
        let b1 = 0.9, b2 = 0.999, eps = 1e-8, clip = 5.0
        let bc1 = 1 - pow(b1, Double(opt.t)), bc2 = 1 - pow(b2, Double(opt.t))
        let lr = opt.lr, wd = opt.wd, kind = opt.kind

        for ti in 0..<vals.count {
            var arr = vals[ti]; let gr = grads[ti]
            if kind == "sgd" {
                for i in 0..<arr.count { var gi = gr[i]; gi = max(-clip, min(clip, gi)); opt.mom[ti][i] = 0.9 * opt.mom[ti][i] + gi; arr[i] -= lr * opt.mom[ti][i] }
            } else if kind == "lion" {
                for i in 0..<arr.count { var gi = gr[i]; gi = max(-clip, min(clip, gi)); let upd = (0.9 * opt.mom[ti][i] + 0.1 * gi); arr[i] -= lr * ((upd > 0 ? 1 : (upd < 0 ? -1 : 0)) + wd * arr[i]); opt.mom[ti][i] = 0.99 * opt.mom[ti][i] + 0.01 * gi }
            } else {
                var r1 = 0.0, r2 = 0.0
                var updBuf = kind == "lamb" ? [Double](repeating: 0, count: arr.count) : []
                for i in 0..<arr.count {
                    var gi = gr[i]; gi = max(-clip, min(clip, gi))
                    opt.mom[ti][i] = b1 * opt.mom[ti][i] + (1 - b1) * gi
                    opt.vel[ti][i] = b2 * opt.vel[ti][i] + (1 - b2) * gi * gi
                    let mh = opt.mom[ti][i] / bc1, vh = opt.vel[ti][i] / bc2
                    var upd: Double
                    if kind == "radam" {
                        let rhoInf = 2 / (1 - b2) - 1
                        let rho = rhoInf - 2 * Double(opt.t) * pow(b2, Double(opt.t)) / bc2
                        if rho > 4 { let rect = (((rho - 4) * (rho - 2) * rhoInf) / ((rhoInf - 4) * (rhoInf - 2) * rho)).squareRoot(); upd = rect * mh / (vh.squareRoot() + eps) }
                        else { upd = mh }
                    } else { upd = mh / (vh.squareRoot() + eps) }
                    if kind == "lamb" { updBuf[i] = upd + wd * arr[i]; r2 += updBuf[i] * updBuf[i]; r1 += arr[i] * arr[i] }
                    else { arr[i] -= lr * (upd + (kind == "adamw" ? wd * arr[i] : 0)) }
                }
                if kind == "lamb" {
                    let wNorm = r1.squareRoot(), uNorm = max(r2.squareRoot(), 1)
                    let trust = wNorm > 0 ? wNorm / uNorm : 1
                    for i in 0..<arr.count { arr[i] -= lr * trust * updBuf[i] }
                }
            }
            vals[ti] = arr
        }
        // write back
        m.Wtok = vals[0]; m.Wpos = vals[1]; m.Wout = vals[2]; m.bout = vals[3]; m.lnFg = vals[4]; m.lnFb = vals[5]
        var idx = 6
        for L in 0..<m.blocks.count {
            m.blocks[L].ln1g = vals[idx]; idx += 1; m.blocks[L].ln1b = vals[idx]; idx += 1
            m.blocks[L].Wq = vals[idx]; idx += 1; m.blocks[L].Wk = vals[idx]; idx += 1
            m.blocks[L].Wv = vals[idx]; idx += 1; m.blocks[L].Wo = vals[idx]; idx += 1
            m.blocks[L].ln2g = vals[idx]; idx += 1; m.blocks[L].ln2b = vals[idx]; idx += 1
            m.blocks[L].W1 = vals[idx]; idx += 1; m.blocks[L].b1 = vals[idx]; idx += 1
            m.blocks[L].W2 = vals[idx]; idx += 1; m.blocks[L].b2 = vals[idx]; idx += 1
        }
    }

    // MARK: - Training driver (bounded chunk)

    static func sampleWindow(_ ids: [Int], _ ctx: Int, _ rng: inout RNG) -> [Int] {
        let T = min(ids.count - 1, ctx)
        let span = ids.count - 1 - T
        let start = span <= 0 ? 0 : Int(rng.next() * Double(span))
        return Array(ids[start...(start + T)])
    }

    /// Runs `steps` optimizer steps, each over a micro-batch of `batch` windows (grads
    /// averaged). Returns the last step's loss. Mutates the model + optimizer in place.
    static func trainChunk(_ m: inout Model, ids: [Int], opt: OptState, batch: Int, steps: Int, seed: UInt32, iter: Int) -> Double {
        var rng = RNG(seed &+ UInt32(truncatingIfNeeded: iter))
        var lastLoss = 0.0
        for _ in 0..<steps {
            var total = blankGrads(m); var lossSum = 0.0; var n = 0
            for _ in 0..<batch {
                let win = sampleWindow(ids, m.cfg.ctx, &rng)
                let r = forwardBackward(m, win, training: true, &rng)
                if let g = r.grads { addGrads(&total, g); lossSum += r.loss; n += 1 }
            }
            scaleGrads(&total, 1 / Double(max(1, n)))
            optStep(&m, total, opt)
            lastLoss = lossSum / Double(max(1, n))
        }
        return lastLoss
    }

    // MARK: - Sampling / chat

    static func logitsLast(_ m: Model, _ ids: [Int]) -> [Double] {
        let E = m.cfg.embed, heads = m.cfg.heads, hd = E / heads
        let V = m.tok.vocab.count
        let T = min(ids.count, m.cfg.ctx)
        var stream: [[Double]] = []
        for t in 0..<T { let id = ids[ids.count - T + t]; var x = [Double](repeating: 0, count: E); let tb = id * E, pb = t * E; for i in 0..<E { x[i] = m.Wtok[tb + i] + m.Wpos[pb + i] }; stream.append(x) }
        for blk in m.blocks {
            let normed = stream.map { layerNorm($0, blk.ln1g, blk.ln1b, E).y }
            let Q = normed.map { matVec(blk.Wq, $0, E, E, nil) }
            let K = normed.map { matVec(blk.Wk, $0, E, E, nil) }
            let Vv = normed.map { matVec(blk.Wv, $0, E, E, nil) }
            var attn: [[Double]] = []
            for t in 0..<T {
                var outVec = [Double](repeating: 0, count: E)
                for h in 0..<heads {
                    let off = h * hd; var scores = [Double](repeating: 0, count: t + 1)
                    for j in 0...t { var s = 0.0; for d in 0..<hd { s += Q[t][off + d] * K[j][off + d] }; scores[j] = s / Double(hd).squareRoot() }
                    var mx = -Double.infinity; for j in 0...t { if scores[j] > mx { mx = scores[j] } }
                    var sm = 0.0; for j in 0...t { scores[j] = exp(scores[j] - mx); sm += scores[j] }
                    for j in 0...t { scores[j] /= sm }
                    for d in 0..<hd { var acc = 0.0; for j in 0...t { acc += scores[j] * Vv[j][off + d] }; outVec[off + d] = acc }
                }
                attn.append(outVec)
            }
            var res1: [[Double]] = []
            for t in 0..<T { let p = matVec(blk.Wo, attn[t], E, E, nil); var r = [Double](repeating: 0, count: E); for i in 0..<E { r[i] = stream[t][i] + p[i] }; res1.append(r) }
            stream = res1.map { r in
                let n2 = layerNorm(r, blk.ln2g, blk.ln2b, E).y
                let pre = matVec(blk.W1, n2, blk.h, E, blk.b1)
                var a = [Double](repeating: 0, count: blk.h); for i in 0..<blk.h { a[i] = actF(m.cfg.act, pre[i]) }
                let o = matVec(blk.W2, a, E, blk.h, blk.b2)
                var out = [Double](repeating: 0, count: E); for i in 0..<E { out[i] = r[i] + o[i] }; return out
            }
        }
        let fn = layerNorm(stream[T - 1], m.lnFg, m.lnFb, E).y
        return matVec(m.Wout, fn, V, E, m.bout)
    }

    static func sample(_ m: Model, prompt: String, length: Int, temperature: Double, topK: Int, seed: UInt32) -> String {
        var rng = RNG(seed == 0 ? 3 : seed)
        let temp = clampD(temperature, 0.05, 2)
        let maxNew = clampInt(length, 1, 400)
        var ids = [Tokenizer.BOS] + m.tok.encode(prompt)
        let startLen = ids.count
        for _ in 0..<maxNew {
            let window = Array(ids.suffix(m.cfg.ctx))
            var logits = logitsLast(m, window)
            for i in 0..<logits.count { logits[i] /= temp }
            var mx = -Double.infinity; for v in logits { if v > mx { mx = v } }
            var sm = 0.0; var probs = [Double](repeating: 0, count: logits.count)
            for i in 0..<logits.count { probs[i] = exp(logits[i] - mx); sm += probs[i] }
            for i in 0..<logits.count { probs[i] /= sm }
            let pick = sampleProbs(&probs, topK: topK, rng: &rng)
            if pick == Tokenizer.EOS { break }
            ids.append(pick)
        }
        return m.tok.decode(Array(ids.suffix(from: startLen)))
    }
    private static func sampleProbs(_ probs: inout [Double], topK: Int, rng: inout RNG) -> Int {
        let V = probs.count
        if topK > 0 && topK < V {
            let idx = Array(0..<V).sorted { probs[$0] > probs[$1] }.prefix(topK)
            var keep = [Double](repeating: 0, count: V); var s = 0.0
            for k in idx { keep[k] = probs[k]; s += probs[k] }
            for k in 0..<V { probs[k] = keep[k] / (s == 0 ? 1 : s) }
        }
        var rv = rng.next(), acc = 0.0
        for k in 0..<V { acc += probs[k]; if rv <= acc { return k } }
        return V - 1
    }
}

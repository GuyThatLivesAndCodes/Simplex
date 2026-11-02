/* trading-train-worker.js — the Trading app's model training, off the main thread.

   A training round (build features from ~900 price bars, one epoch of Adam over
   them) takes 0.5–1 s of pure number crunching. Run in server.js it froze every
   request, upload and video stream for that long, every 5 seconds ("slow train
   round" / "EVENT LOOP BLOCKED"). Here it runs on its own thread.

   Protocol (one round at a time):
     in : { id, model, bars, fresh }   fresh = forget the Adam state (new or reset model)
     out: { id, model, trained }  or  { id, error }
   The Adam moment state lives here between rounds - it is per-model, and the
   server says `fresh` whenever the model it sends is a new one. */
const { parentPort } = require('worker_threads');
const TR = require('../trading-engine');

let opt = {};
parentPort.on('message', ({ id, model, bars, fresh }) => {
  try {
    if (fresh) opt = {};
    const ds = TR.buildDataset(bars);
    let trained = false;
    // 1 epoch + a large batch keeps each round short while progress accrues via Adam
    if (ds.X.length >= 30) { TR.train(model, ds, Object.assign(opt, { epochs: 1, batch: 256 })); trained = true; }
    parentPort.postMessage({ id, model, trained });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.message) || String(e) });
  }
});

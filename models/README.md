# Local AI models

Drop **GGUF** model files (`*.gguf`) into this folder. Each one becomes available
to every account with the *Can use AI* permission, under the AI app's **Local** tab.

- Models are run **entirely on this server** by the bundled llama.cpp engine in
  [`../engine/`](../engine) — nothing is sent to any external service.
- They load on first use and unload after an idle period, so an unused model
  doesn't sit in RAM.
- Users can also use their own `.gguf` files uploaded into their Database — those
  show up in the Local tab automatically and don't need to live here.

Where to get GGUF files: Hugging Face hosts thousands (search for "GGUF"). Pick a
size that fits your server's RAM — a 0.5–3B parameter model quantized to Q4 is a
good starting point for a CPU-only box.

The folder location is configurable in **Settings → AI providers → Local AI** (or
the `ai.models_dir` setting). The weights themselves are git-ignored.

A good first model to try is **Qwen2.5-0.5B-Instruct** (Q4_K_M, ~490 MB) — small
enough to load fast on a CPU box and coherent enough to be useful. Drop the
`.gguf` here and it appears in the Local tab right away (no restart needed).

> Note: pick a model with a real context window (≥4K). Tiny toy models trained at
> 2K context can't hold the assistant's system prompt and will report a
> context-size error.

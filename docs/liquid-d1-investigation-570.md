# Running Liquid D1 — investigation #570

Checked 2026-10-12. Recommendation: start with **d1-3B Q8_0 on a recent CUDA llama-server**, kept resident on the 4090 if a few GB of VRAM are spare. Use the remote 3090 when local GPU contention matters. Existing llama-swap is viable after checking its versions. A separate optional Scribe pack is feasible, but requires runtime management work.

This is a source/code investigation: no weights downloaded, runtime installed, remote PC accessed, or GPU benchmark performed. Commands below are proposed setup instructions.

## Model choice and hardware

| Model | Inputs | Main GGUF / projector | Recommendation |
|---|---|---|---|
| d1-3B | Text/JSON and images | Q8_0 2.87 GB / Q8_0 583 MB; BF16 5.4 GB / 856 MB | First choice for decision quality |
| d1-omni-600M | Text + images **or** text + audio | Q8_0 407 MB / Q8_0 263 MB; BF16 764 MB / 442 MB | Small footprint or audio experiments |

Sizes are disk weights, **not total VRAM**. Runtime buffers, context, projector and concurrency add memory. Both GPUs have enough capacity for either model in isolation; available VRAM alongside your existing LLM determines coexistence. Start at 4096 context and one slot; measure before increasing. [3B files](https://huggingface.co/LiquidAI/d1-3B-GGUF/tree/main), [omni files](https://huggingface.co/LiquidAI/d1-omni-600M-GGUF/tree/main).

D1 chooses bounded answers rather than writing text. The 3B model supports 32K context; omni supports 16K combined positions, with text cut to 896 tokens when images are present. Omni audio is limited to 30 seconds and trained around English speaker/assistant requests. It is experimental and substantially weaker on the vendor's Decision Index. Use it when size/audio justifies that tradeoff. [3B model](https://huggingface.co/LiquidAI/d1-3B), [omni model](https://huggingface.co/LiquidAI/d1-omni-600M), [launch](https://www.liquid.ai/blog/d1-open).

The vendor's **8 ms on 4090** is warm bf16 PyTorch inference with compilation for one question; its model card reports 16 ms without compilation and 102 ms for a 3.4K-token state. These are not llama.cpp Q8 numbers or network-inclusive predictions. There is no 3090 measurement in those sources. Both are suitable CUDA targets; compare actual warm/cold latency on your workload. Use conventional CUDA Q8/BF16 here; native NVFP4 acceleration belongs to Blackwell hardware. [Benchmark conditions](https://huggingface.co/LiquidAI/d1-3B), [NVIDIA NVFP4 explanation](https://developer.nvidia.com/blog/introducing-nvfp4-for-efficient-and-accurate-low-precision-inference/).

## llama.cpp: supported upstream now

3B support merged October 7 as commit `88dcc46`; omni merged October 8 as `a657f7e`. Use a CUDA build containing the relevant merge; an old installed binary may load a related backbone without implementing the D1 decision path correctly. [3B PR](https://github.com/ggml-org/llama.cpp/pull/30110), [omni PR](https://github.com/ggml-org/llama.cpp/pull/30114).

Download a recent Windows CUDA binary and its required companion libraries from [upstream releases](https://github.com/ggml-org/llama.cpp/releases), matching the NVIDIA driver requirements. On Linux, use a CUDA build or build upstream with the CUDA backend. Check GPU detection in the startup log. Keep the existing working LLM binary until D1 passes a smoke check.

On this Windows PC, from the extracted runtime folder:

```powershell
.\llama-server.exe -hf LiquidAI/d1-3B-GGUF:Q8_0 -ngl 99 -c 4096 -np 1 --host 127.0.0.1 --port 8091 --alias d1-3b
```

On Linux the same arguments work with `./llama-server`. `-hf` downloads the GGUF and available projector automatically; `--no-mmproj` avoids the projector for a text-only service. Explicit port avoids relying on changing defaults. For offline operation, download once and use `-m /path/to/d1-3B-Q8_0.gguf --mmproj /path/to/mmproj-d1-3B-Q8_0.gguf`. [Server flags](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

Smoke request from PowerShell:

```powershell
$d1Body = @{
  model = "d1-3b"
  state = "I was charged twice; please refund one payment."
  questions = @{
    refund = @{ type = "noul"; instructions = "Is a refund requested?" }
    team = @{
      type = "choice"; instructions = "Which team should handle this?"
      criteria = @{ billing = "Charges and refunds"; technical = "App faults" }
    }
  }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -Uri "http://127.0.0.1:8091/v1/systemone" -Method Post -ContentType "application/json" -Body $d1Body
```

Check for named answers, a `noul` probability, a choice distribution, and zero output tokens. Test opposite examples, not just HTTP success. This endpoint does not stream. Do not use the generic Hugging Face “Use this model” chat/generate snippets: the author-written GGUF instructions use System One. [3B GGUF instructions](https://huggingface.co/LiquidAI/d1-3B-GGUF).

For omni, replace the repository with `LiquidAI/d1-omni-600M-GGUF:Q8_0`, set a suitable alias, and add `-b 4096 -ub 4096`. Its bidirectional input must fit a single batch; increase batch, microbatch and context together for longer inputs, up to model limits. Audio uses `files` with a base64 audio data URL; image requests use `images`. A request can carry images or one audio clip, not both. [Omni runtime instructions](https://huggingface.co/LiquidAI/d1-omni-600M-GGUF).

## Existing llama-swap

**Yes, with a sufficiently recent version.** Current source explicitly registers `/v1/systemone` among JSON-body model routes. Inspected main revision: `a025e0373addc2cd76e77a5064d60c517f05dcf8`. The installed remote version was not inspected. [Route source](https://github.com/mostlygeek/llama-swap/blob/a025e0373addc2cd76e77a5064d60c517f05dcf8/internal/server/server.go).

Add this model entry to the existing config, adapting the executable path (example uses Linux):

```yaml
models:
  d1-3b:
    cmd: >
      /path/to/llama-server -hf LiquidAI/d1-3B-GGUF:Q8_0
      -ngl 99 -c 4096 -np 1 --alias d1-3b
      --host 127.0.0.1 --port ${PORT}
    proxy: http://127.0.0.1:${PORT}
    ttl: 0
```

Send to swap's `/v1/systemone` with `"model": "d1-3b"`. Older swap builds can use the arbitrary upstream route `/upstream/d1-3b/v1/systemone` if they support that route, or bypass swap with a dedicated server. Scribe's corresponding base URL would be `http://HOST:SWAPPORT/upstream/d1-3b`.

`ttl: 0` prevents idle unloading but does not prevent another model swapping D1 out. Current config supports persistent groups; keeping D1 resident requires suitable group settings and spare VRAM. Merge those into the existing configuration rather than overwriting its groups. Cold reloads can swamp the few-ms inference benefit and Scribe's short feature deadlines. [Group/config reference](https://github.com/mostlygeek/llama-swap/blob/main/docs/config.example.yaml), [upstream routing](https://github.com/mostlygeek/llama-swap/blob/main/internal/server/api.go).

## Connecting Scribe today

Settings → Classifier already accepts a name, base URL, key and model. For the direct server use `http://127.0.0.1:8091`, model `d1-3b`, key blank on loopback. For swap use its root URL and model key. **Do not append /v1**: Scribe appends `/v1/systemone` itself. Make it the default source and test it.

Code inspection confirms yes/no becomes `noul`, and choice options become `criteria`; those wire shapes align. Real end-to-end compatibility remains untested. Local evidence: `src/ml/adapters/jev.ts`, `src/ml/types.ts`, `docs/decision-service.md`.

**Score caveat — design issue #572:** llama.cpp documents zero-based score indices and probability keys, while Scribe promises one-based scores and passes both through unchanged. Normalize explicitly before relying on score consumers; do not blindly shift every Jev provider. Scribe's source test alone does not prove score semantics. [System One response example](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1systemone-typesafe-compatible-system-one-api).

Scribe currently sends text/JSON only: its ML state does not admit null or media fields. Using D1 images/audio inside the app needs an API/permission extension. Text classifier uses are the small first integration.

For the remote PC, keep the backend on loopback and use an SSH tunnel where SSH is available, e.g. `ssh -N -L 8091:127.0.0.1:8091 user@remote-pc`. Then Scribe uses the same local base URL. A LAN/VPN endpoint is another option; bind deliberately, restrict access, and set a server API key. An OS, address and launch method are still needed to turn this into an installed service.

## Bundling into Scribe

**A separate decision pack is the best packaging direction** (engineering recommendation). Reuse the search pack's manifest/hash/platform validation and child-process lifecycle patterns, but create a distinct pack/runtime manager. Existing search pack limits are 2 GiB ZIP / 4 GiB extracted: a 3B Q8 model plus projector and CUDA libraries may exceed the archive limit, and bf16 already exceeds the extracted limit. This cannot be treated as an ordinary existing search pack.

Proposed pack: pinned llama-server and companion libraries, pinned GGUFs, upstream notices/license, platform/backend manifest, hashes, optional projector. Let the daemon manage a loopback server with readiness, port selection, clean shutdown, bounded requests, warmup, GPU fallback and offline operation. Keep model execution out of the main Node process. Windows CUDA first; other OS/backend combinations need separate builds and validation. This is moderate product work, not just bundling a weight file. Local evidence: `docs/search-pack.md`; current Scribe manages external classifier endpoints, not a D1 runtime.

Retain the model's LFM Open License and notices. Its commercial-use provision has a $10M annual-revenue threshold; this differs from unrestricted permissive redistribution. Check distribution terms for the intended audience. [License](https://huggingface.co/LiquidAI/d1-3B/blob/main/LICENSE).

## Other routes and next decision

For Python experiments, the author model card uses `AutoModel.from_pretrained(..., trust_remote_code=True, dtype=torch.bfloat16).to("cuda")` and `model.system_one(state, questions)`; 3B needs `transformers>=5.14`, torch, torchvision and pillow. This gives the reference runtime but adds a Python/PyTorch environment and requires an HTTP wrapper for Scribe. [Reference usage](https://huggingface.co/LiquidAI/d1-3B). Native llama-server is simpler for your existing infrastructure.

The least setup overall is Liquid's hosted API: Scribe base URL `https://api.liquid.ai/decisions`, model `d1:free`, Liquid key. Free is text-only; hosted `d1` supports paid vision. This sends content off the PC and does not establish equivalence with either open checkpoint. [Hosted docs](https://docs.liquid.ai/lfm/models/d1).

Suggested rollout: direct resident 3B Q8 server → test Scribe yes/no and choice → verify/resolve #572 for scores → compare 20–50 representative cases with existing Jev and measure uncached warm/cold p50/p95 → decide whether to make an optional pack. On the 3090 also measure network delay and interaction with the current swapped LLM.

The linked Scribe investigation includes a form to choose local 4090, remote 3090/swap, pack design, or investigation only, with an OS/version/access notes field. Per worker instructions, #570 goes to Needs input because no deployment or app implementation was requested or performed.


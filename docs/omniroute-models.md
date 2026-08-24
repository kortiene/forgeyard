# OmniRoute Provider — Exhaustive Model List

- **Gateway**: https://omniroute.kortiene.com/v1 (`GET /models`, OpenAI-compatible)
- **Retrieved**: 2026-08-23, live, via the running DSH host's `llm.discoverModels` RPC
- **Total advertised models**: 588
- **Families**: 24
- **Machine-readable copy**: [omniroute-models.json](omniroute-models.json)

Every entry the gateway advertises is listed below, grouped by id family in the gateway's own order. Context is the maximum combined request+response window; Max out is the maximum output tokens. A dash means the gateway disclosed nothing.

## Family summary

| Family | Models | Typical context | Typical max out |
|---|---:|---:|---:|
| `auto/` | 38 | varied | varied |
| `cc/` | 45 | varied | varied |
| `claude/` | 45 | varied | varied |
| `kmc/` | 3 | varied | 1,048,576 |
| `kimi-coding/` | 3 | varied | 1,048,576 |
| `antigravity/` | 22 | varied | varied |
| `pepper/` | 1 | 128,000 | — |
| `ddgw/` | 6 | varied | 131,072 |
| `felo/` | 5 | 128,000 | — |
| `aug/` | 28 | varied | varied |
| `oc/` | 6 | varied | varied |
| `tllm/` | 26 | varied | — |
| `cx/` | 27 | varied | 128,000 |
| `codex/` | 27 | varied | 128,000 |
| `mcode/` | 1 | 1,000,000 | 128,000 |
| `(top-level)/` | 1 | 400,000 | — |
| `gemini/` | 58 | varied | varied |
| `groq/` | 16 | varied | — |
| `moonshot/` | 4 | varied | varied |
| `openai/` | 128 | varied | varied |
| `zai/` | 6 | varied | varied |
| `veoaifree-web/` | 2 | — | — |
| `veo-free/` | 2 | — | — |
| `no-think/` | 88 | 200,000 | — |

## All models by family

### `auto/` (38)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `auto/best-coding` | — | 1,050,000 | 1,048,576 |
| `auto/best-reasoning` | — | 1,050,000 | 1,048,576 |
| `auto/best-fast` | — | 1,050,000 | 1,048,576 |
| `auto/best-vision` | — | 1,050,000 | 1,048,576 |
| `auto/best-chat` | — | 1,050,000 | 1,048,576 |
| `auto/best-coding-fast` | — | 1,050,000 | 1,048,576 |
| `auto/pro-coding` | — | 1,050,000 | 1,048,576 |
| `auto/pro-reasoning` | — | 1,050,000 | 1,048,576 |
| `auto/pro-vision` | — | 1,050,000 | 1,048,576 |
| `auto/pro-chat` | — | 1,050,000 | 1,048,576 |
| `auto/pro-fast` | — | 1,050,000 | 1,048,576 |
| `auto/coding` | — | 1,050,000 | 1,048,576 |
| `auto/fast` | — | 1,050,000 | 1,048,576 |
| `auto/chat` | — | 1,050,000 | 1,048,576 |
| `auto/cheap` | — | 1,050,000 | 1,048,576 |
| `auto/offline` | — | 1,050,000 | 1,048,576 |
| `auto/smart` | — | 1,050,000 | 1,048,576 |
| `auto/claude-opus` | — | 1,050,000 | 1,048,576 |
| `auto/claude-sonnet` | — | 1,050,000 | 1,048,576 |
| `auto/best-free` | — | 1,048,576 | 384,000 |
| `auto/best-chaos` | — | 1,050,000 | 1,048,576 |
| `auto/chaos` | — | 1,050,000 | 1,048,576 |
| `auto/coding:fast` | — | 1,050,000 | 1,048,576 |
| `auto/coding:cheap` | — | 1,050,000 | 1,048,576 |
| `auto/coding:free` | — | 1,048,576 | 384,000 |
| `auto/coding:pro` | — | 1,050,000 | 1,048,576 |
| `auto/coding:reliable` | — | 1,050,000 | 1,048,576 |
| `auto/reasoning` | — | 1,050,000 | 1,048,576 |
| `auto/reasoning:pro` | — | 1,050,000 | 1,048,576 |
| `auto/vision` | — | 1,050,000 | 1,048,576 |
| `auto/multimodal` | — | 1,050,000 | 1,048,576 |
| `auto/glm` | — | 1,000,000 | 131,072 |
| `auto/minimax` | — | 128,000 | 8,192 |
| `auto/mimo` | — | 1,048,576 | 131,072 |
| `auto/zai` | — | 1,000,000 | 131,072 |
| `auto/gemma` | — | 32,768 | 8,192 |
| `auto/llama` | — | 131,072 | 8,192 |
| `auto/gemini` | — | 1,048,576 | 65,536 |

### `cc/` (45)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `cc/claude-fable-5` | cc/Claude Fable 5 | 1,000,000 | 128,000 |
| `cc/claude-opus-5` | cc/Claude Opus 5 | 1,000,000 | 128,000 |
| `cc/claude-opus-4-8` | cc/Claude Opus 4.8 | 1,000,000 | 128,000 |
| `cc/claude-opus-4-7` | cc/Claude Opus 4.7 | 1,000,000 | 128,000 |
| `cc/claude-opus-4-6` | cc/Claude Opus 4.6 | 1,000,000 | 128,000 |
| `cc/claude-opus-4-5-20251101` | cc/Claude Opus 4.5 | 200,000 | 64,000 |
| `cc/claude-sonnet-5` | cc/Claude Sonnet 5 | 1,000,000 | 128,000 |
| `cc/claude-sonnet-4-6` | cc/Claude 4.6 Sonnet | 1,000,000 | 64,000 |
| `cc/claude-sonnet-4-5-20250929` | cc/Claude 4.5 Sonnet | 200,000 | 64,000 |
| `cc/claude-haiku-4-5-20251001` | cc/Claude 4.5 Haiku | 200,000 | 64,000 |
| `cc/claude-fable-5-low` | cc/claude-fable-5-low | 1,000,000 | 128,000 |
| `cc/claude-fable-5-medium` | cc/claude-fable-5-medium | 1,000,000 | 128,000 |
| `cc/claude-fable-5-high` | cc/claude-fable-5-high | 1,000,000 | 128,000 |
| `cc/claude-fable-5-xhigh` | cc/claude-fable-5-xhigh | 1,000,000 | 128,000 |
| `cc/claude-opus-5-low` | cc/claude-opus-5-low | 1,000,000 | 128,000 |
| `cc/claude-opus-5-medium` | cc/claude-opus-5-medium | 1,000,000 | 128,000 |
| `cc/claude-opus-5-high` | cc/claude-opus-5-high | 1,000,000 | 128,000 |
| `cc/claude-opus-5-xhigh` | cc/claude-opus-5-xhigh | 1,000,000 | 128,000 |
| `cc/claude-opus-4-8-low` | cc/claude-opus-4-8-low | 1,000,000 | 128,000 |
| `cc/claude-opus-4-8-medium` | cc/claude-opus-4-8-medium | 1,000,000 | 128,000 |
| `cc/claude-opus-4-8-high` | cc/claude-opus-4-8-high | 1,000,000 | 128,000 |
| `cc/claude-opus-4-8-xhigh` | cc/claude-opus-4-8-xhigh | 1,000,000 | 128,000 |
| `cc/claude-opus-4-7-low` | cc/claude-opus-4-7-low | 1,000,000 | 128,000 |
| `cc/claude-opus-4-7-medium` | cc/claude-opus-4-7-medium | 1,000,000 | 128,000 |
| `cc/claude-opus-4-7-high` | cc/claude-opus-4-7-high | 1,000,000 | 128,000 |
| `cc/claude-opus-4-7-xhigh` | cc/claude-opus-4-7-xhigh | 1,000,000 | 128,000 |
| `cc/claude-opus-4-6-low` | cc/claude-opus-4-6-low | 1,000,000 | 128,000 |
| `cc/claude-opus-4-6-medium` | cc/claude-opus-4-6-medium | 1,000,000 | 128,000 |
| `cc/claude-opus-4-6-high` | cc/claude-opus-4-6-high | 1,000,000 | 128,000 |
| `cc/claude-opus-4-5-20251101-low` | cc/claude-opus-4-5-20251101-low | 200,000 | 32,768 |
| `cc/claude-opus-4-5-20251101-medium` | cc/claude-opus-4-5-20251101-medium | 200,000 | 32,768 |
| `cc/claude-opus-4-5-20251101-high` | cc/claude-opus-4-5-20251101-high | 200,000 | 32,768 |
| `cc/claude-sonnet-5-low` | cc/claude-sonnet-5-low | 1,000,000 | 128,000 |
| `cc/claude-sonnet-5-medium` | cc/claude-sonnet-5-medium | 1,000,000 | 128,000 |
| `cc/claude-sonnet-5-high` | cc/claude-sonnet-5-high | 1,000,000 | 128,000 |
| `cc/claude-sonnet-5-xhigh` | cc/claude-sonnet-5-xhigh | 1,000,000 | 128,000 |
| `cc/claude-sonnet-4-6-low` | cc/claude-sonnet-4-6-low | 1,000,000 | 64,000 |
| `cc/claude-sonnet-4-6-medium` | cc/claude-sonnet-4-6-medium | 1,000,000 | 64,000 |
| `cc/claude-sonnet-4-6-high` | cc/claude-sonnet-4-6-high | 1,000,000 | 64,000 |
| `cc/claude-sonnet-4-5-20250929-low` | cc/claude-sonnet-4-5-20250929-low | 200,000 | 64,000 |
| `cc/claude-sonnet-4-5-20250929-medium` | cc/claude-sonnet-4-5-20250929-medium | 200,000 | 64,000 |
| `cc/claude-sonnet-4-5-20250929-high` | cc/claude-sonnet-4-5-20250929-high | 200,000 | 64,000 |
| `cc/claude-haiku-4-5-20251001-low` | cc/claude-haiku-4-5-20251001-low | 200,000 | 64,000 |
| `cc/claude-haiku-4-5-20251001-medium` | cc/claude-haiku-4-5-20251001-medium | 200,000 | 64,000 |
| `cc/claude-haiku-4-5-20251001-high` | cc/claude-haiku-4-5-20251001-high | 200,000 | 64,000 |

### `claude/` (45)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `claude/claude-fable-5` | claude/Claude Fable 5 | 1,000,000 | 128,000 |
| `claude/claude-opus-5` | claude/Claude Opus 5 | 1,000,000 | 128,000 |
| `claude/claude-opus-4-8` | claude/Claude Opus 4.8 | 1,000,000 | 128,000 |
| `claude/claude-opus-4-7` | claude/Claude Opus 4.7 | 1,000,000 | 128,000 |
| `claude/claude-opus-4-6` | claude/Claude Opus 4.6 | 1,000,000 | 128,000 |
| `claude/claude-opus-4-5-20251101` | claude/Claude Opus 4.5 | 200,000 | 64,000 |
| `claude/claude-sonnet-5` | claude/Claude Sonnet 5 | 1,000,000 | 128,000 |
| `claude/claude-sonnet-4-6` | claude/Claude 4.6 Sonnet | 1,000,000 | 64,000 |
| `claude/claude-sonnet-4-5-20250929` | claude/Claude 4.5 Sonnet | 200,000 | 64,000 |
| `claude/claude-haiku-4-5-20251001` | claude/Claude 4.5 Haiku | 200,000 | 64,000 |
| `claude/claude-fable-5-low` | claude/claude-fable-5-low | 1,000,000 | 128,000 |
| `claude/claude-fable-5-medium` | claude/claude-fable-5-medium | 1,000,000 | 128,000 |
| `claude/claude-fable-5-high` | claude/claude-fable-5-high | 1,000,000 | 128,000 |
| `claude/claude-fable-5-xhigh` | claude/claude-fable-5-xhigh | 1,000,000 | 128,000 |
| `claude/claude-opus-5-low` | claude/claude-opus-5-low | 1,000,000 | 128,000 |
| `claude/claude-opus-5-medium` | claude/claude-opus-5-medium | 1,000,000 | 128,000 |
| `claude/claude-opus-5-high` | claude/claude-opus-5-high | 1,000,000 | 128,000 |
| `claude/claude-opus-5-xhigh` | claude/claude-opus-5-xhigh | 1,000,000 | 128,000 |
| `claude/claude-opus-4-8-low` | claude/claude-opus-4-8-low | 1,000,000 | 128,000 |
| `claude/claude-opus-4-8-medium` | claude/claude-opus-4-8-medium | 1,000,000 | 128,000 |
| `claude/claude-opus-4-8-high` | claude/claude-opus-4-8-high | 1,000,000 | 128,000 |
| `claude/claude-opus-4-8-xhigh` | claude/claude-opus-4-8-xhigh | 1,000,000 | 128,000 |
| `claude/claude-opus-4-7-low` | claude/claude-opus-4-7-low | 1,000,000 | 128,000 |
| `claude/claude-opus-4-7-medium` | claude/claude-opus-4-7-medium | 1,000,000 | 128,000 |
| `claude/claude-opus-4-7-high` | claude/claude-opus-4-7-high | 1,000,000 | 128,000 |
| `claude/claude-opus-4-7-xhigh` | claude/claude-opus-4-7-xhigh | 1,000,000 | 128,000 |
| `claude/claude-opus-4-6-low` | claude/claude-opus-4-6-low | 1,000,000 | 128,000 |
| `claude/claude-opus-4-6-medium` | claude/claude-opus-4-6-medium | 1,000,000 | 128,000 |
| `claude/claude-opus-4-6-high` | claude/claude-opus-4-6-high | 1,000,000 | 128,000 |
| `claude/claude-opus-4-5-20251101-low` | claude/claude-opus-4-5-20251101-low | 200,000 | 32,768 |
| `claude/claude-opus-4-5-20251101-medium` | claude/claude-opus-4-5-20251101-medium | 200,000 | 32,768 |
| `claude/claude-opus-4-5-20251101-high` | claude/claude-opus-4-5-20251101-high | 200,000 | 32,768 |
| `claude/claude-sonnet-5-low` | claude/claude-sonnet-5-low | 1,000,000 | 128,000 |
| `claude/claude-sonnet-5-medium` | claude/claude-sonnet-5-medium | 1,000,000 | 128,000 |
| `claude/claude-sonnet-5-high` | claude/claude-sonnet-5-high | 1,000,000 | 128,000 |
| `claude/claude-sonnet-5-xhigh` | claude/claude-sonnet-5-xhigh | 1,000,000 | 128,000 |
| `claude/claude-sonnet-4-6-low` | claude/claude-sonnet-4-6-low | 1,000,000 | 64,000 |
| `claude/claude-sonnet-4-6-medium` | claude/claude-sonnet-4-6-medium | 1,000,000 | 64,000 |
| `claude/claude-sonnet-4-6-high` | claude/claude-sonnet-4-6-high | 1,000,000 | 64,000 |
| `claude/claude-sonnet-4-5-20250929-low` | claude/claude-sonnet-4-5-20250929-low | 200,000 | 64,000 |
| `claude/claude-sonnet-4-5-20250929-medium` | claude/claude-sonnet-4-5-20250929-medium | 200,000 | 64,000 |
| `claude/claude-sonnet-4-5-20250929-high` | claude/claude-sonnet-4-5-20250929-high | 200,000 | 64,000 |
| `claude/claude-haiku-4-5-20251001-low` | claude/claude-haiku-4-5-20251001-low | 200,000 | 64,000 |
| `claude/claude-haiku-4-5-20251001-medium` | claude/claude-haiku-4-5-20251001-medium | 200,000 | 64,000 |
| `claude/claude-haiku-4-5-20251001-high` | claude/claude-haiku-4-5-20251001-high | 200,000 | 64,000 |

### `kmc/` (3)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `kmc/k3` | kmc/Kimi K3 | 1,048,576 | 1,048,576 |
| `kmc/kimi-for-coding` | kmc/Kimi K2.7 Code | 262,144 | — |
| `kmc/kimi-for-coding-highspeed` | kmc/Kimi K2.7 Code (High Speed) | 262,144 | — |

### `kimi-coding/` (3)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `kimi-coding/k3` | kimi-coding/Kimi K3 | 1,048,576 | 1,048,576 |
| `kimi-coding/kimi-for-coding` | kimi-coding/Kimi K2.7 Code | 262,144 | — |
| `kimi-coding/kimi-for-coding-highspeed` | kimi-coding/Kimi K2.7 Code (High Speed) | 262,144 | — |

### `antigravity/` (22)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `antigravity/gemini-3.6-flash-high` | Gemini 3.6 Flash (High) | 1,048,576 | 65,536 |
| `antigravity/gemini-3.6-flash-medium` | Gemini 3.6 Flash (Medium) | 1,048,576 | 65,536 |
| `antigravity/gemini-3.6-flash-low` | Gemini 3.6 Flash (Low) | 1,048,576 | 65,536 |
| `antigravity/claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | 1,048,576 | 65,536 |
| `antigravity/claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | 1,048,576 | 65,536 |
| `antigravity/gemini-pro-agent` | Gemini 3.1 Pro (High) | 1,048,576 | 65,535 |
| `antigravity/gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) | 1,048,576 | 65,535 |
| `antigravity/gemini-3-flash-agent` | Gemini 3.5 Flash (High) | 1,048,576 | 65,536 |
| `antigravity/gemini-3.5-flash-low` | Gemini 3.5 Flash (Medium) | 1,048,576 | 65,536 |
| `antigravity/gemini-3.5-flash-extra-low` | Gemini 3.5 Flash (Low) | 1,048,576 | 65,536 |
| `antigravity/gemini-3.1-flash-lite` | antigravity/Gemini 3.1 Flash Lite | 1,048,576 | 65,535 |
| `antigravity/gemini-2.5-flash-thinking` | Gemini 2.5 Flash Thinking | 1,048,576 | 65,535 |
| `antigravity/gemini-2.5-flash` | antigravity/Gemini 2.5 Flash | 1,048,576 | 65,535 |
| `antigravity/gemini-2.5-flash-lite` | antigravity/Gemini 2.5 Flash Lite | 1,048,576 | 65,535 |
| `antigravity/gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | 131,072 | 32,768 |
| `antigravity/gemini-3.1-flash-image` | antigravity/gemini-3.1-flash-image | — | — |
| `antigravity/claude-opus-4-6-thinking-low` | claude-opus-4-6-thinking-low | 1,000,000 | 128,000 |
| `antigravity/claude-opus-4-6-thinking-medium` | claude-opus-4-6-thinking-medium | 1,000,000 | 128,000 |
| `antigravity/claude-opus-4-6-thinking-high` | claude-opus-4-6-thinking-high | 1,000,000 | 128,000 |
| `antigravity/claude-sonnet-4-6-low` | antigravity/claude-sonnet-4-6-low | 1,000,000 | 64,000 |
| `antigravity/claude-sonnet-4-6-medium` | antigravity/claude-sonnet-4-6-medium | 1,000,000 | 64,000 |
| `antigravity/claude-sonnet-4-6-high` | antigravity/claude-sonnet-4-6-high | 1,000,000 | 64,000 |

### `pepper/` (1)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `pepper/pepper-1` | Pepper (Chipotle AI 🌯) | 128,000 | — |

### `ddgw/` (6)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `ddgw/gpt-5.4-mini` | ddgw/GPT-5.4 Mini | 409,600 | 131,072 |
| `ddgw/gpt-5.4-nano` | ddgw/GPT-5.4 Nano | 409,600 | 131,072 |
| `ddgw/claude-haiku-4-5` | Claude Haiku 4.5 | 200,000 | — |
| `ddgw/mistral-small-2603` | Mistral Small 4 | 128,000 | — |
| `ddgw/tinfoil/gpt-oss-120b` | gpt-oss 120B | 400,000 | — |
| `ddgw/tinfoil/gemma4-31b` | Gemma 4 31B | 128,000 | — |

### `felo/` (5)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `felo/felo-chat` | Felo Chat | 128,000 | — |
| `felo/felo-search` | Felo Search | 128,000 | — |
| `felo/felo-scholar` | Felo Scholar | 128,000 | — |
| `felo/felo-social` | Felo Social | 128,000 | — |
| `felo/felo-document` | Felo Document | 128,000 | — |

### `aug/` (28)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `aug/sonnet4.6` | Sonnet 4.6 | 200,000 | — |
| `aug/fable-5` | aug/Claude Fable 5 | 200,000 | — |
| `aug/haiku4.5` | Haiku 4.5 | 200,000 | — |
| `aug/sonnet4.5` | Sonnet 4.5 | 200,000 | — |
| `aug/sonnet4.6-500k` | Sonnet 4.6 (500K) | 500,000 | — |
| `aug/sonnet5-high` | aug/Claude Sonnet 5 | 200,000 | — |
| `aug/sonnet5-500k` | Claude Sonnet 5 (500K) | 500,000 | — |
| `aug/opus4.5` | Opus 4.5 | 200,000 | — |
| `aug/opus4.6` | Opus 4.6 | 200,000 | — |
| `aug/opus4.6-500k` | Opus 4.6 (500K) | 500,000 | — |
| `aug/opus4.7` | Opus 4.7 | 200,000 | — |
| `aug/opus4.7-500k` | Opus 4.7 (500K) | 500,000 | — |
| `aug/opus4.8` | Opus 4.8 | 200,000 | — |
| `aug/gemini-3.1-pro-preview` | Gemini 3.1 Pro | 1,000,000 | 65,535 |
| `aug/gpt5` | GPT-5 | 200,000 | — |
| `aug/gpt5.1` | GPT-5.1 | 200,000 | — |
| `aug/gpt5.2` | GPT-5.2 | 200,000 | — |
| `aug/gpt5.4` | aug/GPT-5.4 | 200,000 | — |
| `aug/gpt5.4-mini` | aug/GPT-5.4 Mini | 200,000 | — |
| `aug/gpt5.5` | aug/GPT-5.5 | 200,000 | — |
| `aug/gpt5.6-luna` | aug/GPT-5.6 Luna | 200,000 | — |
| `aug/gpt5.6-sol` | aug/GPT-5.6 Sol | 200,000 | — |
| `aug/gpt5.6-terra` | aug/GPT-5.6 Terra | 200,000 | — |
| `aug/glm-5.2` | aug/GLM 5.2 | 1,000,000 | 131,072 |
| `aug/kimi-k2.6` | aug/Kimi K2.6 | 131,000 | 262,144 |
| `aug/kimi-k2.7` | aug/Kimi K2.7 Code | 131,000 | 262,144 |
| `aug/prism-a` | Prism (Claude + Gemini) | 200,000 | — |
| `aug/prism-b` | Prism (GPT + Kimi) | 200,000 | — |

### `oc/` (6)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `oc/big-pickle` | Big Pickle | 200,000 | — |
| `oc/deepseek-v4-flash-free` | DeepSeek V4 Flash Free | 1,000,000 | 384,000 |
| `oc/mimo-v2.5-free` | mimo-v2.5-free | 1,048,576 | 131,072 |
| `oc/hy3-free` | hy3-free | 200,000 | — |
| `oc/nemotron-3-ultra-free` | nemotron-3-ultra-free | 200,000 | — |
| `oc/north-mini-code-free` | north-mini-code-free | 200,000 | — |

### `tllm/` (26)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `tllm/GPT_5_4` | GPT-5.4 (The Old LLM 🆓) | 400,000 | — |
| `tllm/GPT_5_3` | GPT-5.3 (The Old LLM 🆓) | 400,000 | — |
| `tllm/GPT_5_2` | GPT-5.2 (The Old LLM 🆓) | 400,000 | — |
| `tllm/GPT_5_1` | GPT-5.1 (The Old LLM 🆓) | 400,000 | — |
| `tllm/GPT_5` | GPT-5 (The Old LLM 🆓) | 400,000 | — |
| `tllm/GPT_o4_mini` | o4-mini (The Old LLM 🆓) | 200,000 | — |
| `tllm/GPT_o3_mini` | o3-mini (The Old LLM 🆓) | 200,000 | — |
| `tllm/gemini_3_pro` | Gemini 3 Pro (The Old LLM 🆓) | 1,000,000 | — |
| `tllm/gemini_2_5_pro` | Gemini 2.5 Pro (The Old LLM 🆓) | 1,000,000 | — |
| `tllm/gemini_2_0_flash` | Gemini 2.0 Flash (The Old LLM 🆓) | 1,000,000 | — |
| `tllm/gemini_1_5_flash` | Gemini 1.5 Flash (The Old LLM 🆓) | 1,000,000 | — |
| `tllm/CLAUDE_4_6_OPUS` | Claude 4.6 Opus (The Old LLM 🆓) | 200,000 | — |
| `tllm/CLAUDE_4_6_SONNET` | Claude 4.6 Sonnet (The Old LLM 🆓) | 200,000 | — |
| `tllm/CLAUDE_4_5_HAIKU` | Claude 4.5 Haiku (The Old LLM 🆓) | 200,000 | — |
| `tllm/openrouter_gpt_4_o` | GPT-4o (The Old LLM 🆓) | 200,000 | — |
| `tllm/openrouter_gpt_4_o_mini` | GPT-4o mini (The Old LLM 🆓) | 200,000 | — |
| `tllm/openrouter_grok_4` | Grok 4 (The Old LLM 🆓) | 200,000 | — |
| `tllm/together_deepseek_v3` | DeepSeek V3 (The Old LLM 🆓) | 200,000 | — |
| `tllm/openrouter_deepseek_r1` | DeepSeek R1 (The Old LLM 🆓) | 200,000 | — |
| `tllm/sonar-pro` | Sonar Pro (The Old LLM 🆓) | 200,000 | — |
| `tllm/GPT_4o` | GPT-4o (The Old LLM 🆓) | 200,000 | — |
| `tllm/claude_opus_4` | Claude Opus 4 (The Old LLM 🆓) | 200,000 | — |
| `tllm/claude_sonnet_4` | Claude Sonnet 4 (The Old LLM 🆓) | 200,000 | — |
| `tllm/claude_haiku_3_5` | Claude Haiku 3.5 (The Old LLM 🆓) | 200,000 | — |
| `tllm/deepseek_v4` | DeepSeek V4 (The Old LLM 🆓) | 200,000 | — |
| `tllm/gemini_3_flash` | Gemini 3 Flash (The Old LLM 🆓) | 1,000,000 | — |

### `cx/` (27)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `cx/gpt-5.6-sol` | cx/GPT 5.6 Sol | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-ultra` | cx/GPT 5.6 Sol (Ultra) | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-max` | cx/GPT 5.6 Sol (Max) | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-xhigh` | cx/GPT 5.6 Sol (xHigh) | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-high` | cx/GPT 5.6 Sol (High) | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-medium` | cx/GPT 5.6 Sol (Medium) | 272,000 | 128,000 |
| `cx/gpt-5.6-sol-low` | cx/GPT 5.6 Sol (Low) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra` | cx/GPT 5.6 Terra | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-ultra` | cx/GPT 5.6 Terra (Ultra) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-max` | cx/GPT 5.6 Terra (Max) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-xhigh` | cx/GPT 5.6 Terra (xHigh) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-high` | cx/GPT 5.6 Terra (High) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-medium` | cx/GPT 5.6 Terra (Medium) | 272,000 | 128,000 |
| `cx/gpt-5.6-terra-low` | cx/GPT 5.6 Terra (Low) | 272,000 | 128,000 |
| `cx/gpt-5.6-luna` | cx/GPT 5.6 Luna | 272,000 | 128,000 |
| `cx/gpt-5.6-luna-max` | cx/GPT 5.6 Luna (Max) | 272,000 | 128,000 |
| `cx/gpt-5.6-luna-xhigh` | cx/GPT 5.6 Luna (xHigh) | 272,000 | 128,000 |
| `cx/gpt-5.6-luna-high` | cx/GPT 5.6 Luna (High) | 272,000 | 128,000 |
| `cx/gpt-5.6-luna-medium` | cx/GPT 5.6 Luna (Medium) | 272,000 | 128,000 |
| `cx/gpt-5.6-luna-low` | cx/GPT 5.6 Luna (Low) | 272,000 | 128,000 |
| `cx/gpt-5.5` | cx/GPT 5.5 | 400,000 | 128,000 |
| `cx/gpt-5.5-xhigh` | cx/GPT 5.5 (xHigh) | 400,000 | 128,000 |
| `cx/gpt-5.5-high` | cx/GPT 5.5 (High) | 400,000 | 128,000 |
| `cx/gpt-5.5-medium` | cx/GPT 5.5 (Medium) | 400,000 | 128,000 |
| `cx/gpt-5.5-low` | cx/GPT 5.5 (Low) | 400,000 | 128,000 |
| `cx/gpt-5.3-codex-spark` | cx/GPT 5.3 Codex Spark | 400,000 | — |
| `cx/codex-auto-review` | cx/codex-auto-review | 400,000 | — |

### `codex/` (27)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `codex/gpt-5.6-sol-ultra` | codex/GPT 5.6 Sol (Ultra) | 272,000 | 128,000 |
| `codex/gpt-5.6-sol-max` | codex/GPT 5.6 Sol (Max) | 272,000 | 128,000 |
| `codex/gpt-5.6-sol-xhigh` | codex/GPT 5.6 Sol (xHigh) | 272,000 | 128,000 |
| `codex/gpt-5.6-sol-high` | codex/GPT 5.6 Sol (High) | 272,000 | 128,000 |
| `codex/gpt-5.6-sol-medium` | codex/GPT 5.6 Sol (Medium) | 272,000 | 128,000 |
| `codex/gpt-5.6-sol-low` | codex/GPT 5.6 Sol (Low) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-ultra` | codex/GPT 5.6 Terra (Ultra) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-max` | codex/GPT 5.6 Terra (Max) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-xhigh` | codex/GPT 5.6 Terra (xHigh) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-high` | codex/GPT 5.6 Terra (High) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-medium` | codex/GPT 5.6 Terra (Medium) | 272,000 | 128,000 |
| `codex/gpt-5.6-terra-low` | codex/GPT 5.6 Terra (Low) | 272,000 | 128,000 |
| `codex/gpt-5.6-luna-max` | codex/GPT 5.6 Luna (Max) | 272,000 | 128,000 |
| `codex/gpt-5.6-luna-xhigh` | codex/GPT 5.6 Luna (xHigh) | 272,000 | 128,000 |
| `codex/gpt-5.6-luna-high` | codex/GPT 5.6 Luna (High) | 272,000 | 128,000 |
| `codex/gpt-5.6-luna-medium` | codex/GPT 5.6 Luna (Medium) | 272,000 | 128,000 |
| `codex/gpt-5.6-luna-low` | codex/GPT 5.6 Luna (Low) | 272,000 | 128,000 |
| `codex/gpt-5.5` | codex/GPT 5.5 | 400,000 | 128,000 |
| `codex/gpt-5.5-xhigh` | codex/GPT 5.5 (xHigh) | 400,000 | 128,000 |
| `codex/gpt-5.5-high` | codex/GPT 5.5 (High) | 400,000 | 128,000 |
| `codex/gpt-5.5-medium` | codex/GPT 5.5 (Medium) | 400,000 | 128,000 |
| `codex/gpt-5.5-low` | codex/GPT 5.5 (Low) | 400,000 | 128,000 |
| `codex/gpt-5.3-codex-spark` | codex/GPT 5.3 Codex Spark | 400,000 | — |
| `codex/codex-auto-review` | codex/codex-auto-review | 400,000 | — |
| `codex/gpt-5.6-sol` | codex/GPT 5.6 Sol | — | 128,000 |
| `codex/gpt-5.6-terra` | codex/GPT 5.6 Terra | — | 128,000 |
| `codex/gpt-5.6-luna` | codex/GPT 5.6 Luna | — | 128,000 |

### `mcode/` (1)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `mcode/mimo-auto` | MiMo Auto | 1,000,000 | 128,000 |

### `(top-level)/` (1)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `codex-auto-review` | codex-auto-review | 400,000 | — |

### `gemini/` (58)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `gemini/gemini-2.5-flash` | gemini/Gemini 2.5 Flash | 1,048,576 | 65,536 |
| `gemini/gemini-2.5-pro` | Gemini 2.5 Pro | 1,048,576 | 65,536 |
| `gemini/gemini-2.0-flash` | gemini-2.0-flash | 1,048,576 | 8,192 |
| `gemini/gemini-2.0-flash-001` | gemini-2.0-flash-001 | 1,048,576 | 8,192 |
| `gemini/gemini-2.0-flash-lite-001` | gemini-2.0-flash-lite-001 | 1,048,576 | 8,192 |
| `gemini/gemini-2.0-flash-lite` | gemini-2.0-flash-lite | 1,048,576 | 8,192 |
| `gemini/gemini-2.5-flash-preview-tts` | gemini-2.5-flash-preview-tts | 8,192 | 65,536 |
| `gemini/gemini-2.5-pro-preview-tts` | gemini-2.5-pro-preview-tts | 8,192 | 16,384 |
| `gemini/gemma-4-26b-a4b-it` | gemma-4-26b-a4b-it | 262,144 | 32,768 |
| `gemini/gemma-4-31b-it` | gemma-4-31b-it | 262,144 | 32,768 |
| `gemini/gemini-flash-latest` | gemini-flash-latest | 1,048,576 | 65,536 |
| `gemini/gemini-flash-lite-latest` | gemini-flash-lite-latest | 1,048,576 | 65,536 |
| `gemini/gemini-pro-latest` | gemini-pro-latest | 1,048,576 | 65,536 |
| `gemini/gemini-2.5-flash-lite` | gemini/Gemini 2.5 Flash Lite | 1,048,576 | 65,536 |
| `gemini/gemini-2.5-flash-image` | gemini-2.5-flash-image | 32,768 | 65,536 |
| `gemini/gemini-3-pro-preview` | gemini-3-pro-preview | 1,048,576 | 65,535 |
| `gemini/gemini-3-flash-preview` | Gemini 3 Flash Preview | 1,048,576 | 65,536 |
| `gemini/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | 1,048,576 | 65,535 |
| `gemini/gemini-3.1-pro-preview-customtools` | gemini-3.1-pro-preview-customtools | 1,048,576 | 65,535 |
| `gemini/gemini-3.1-flash-lite-preview` | gemini-3.1-flash-lite-preview | 1,048,576 | 65,536 |
| `gemini/gemini-3.1-flash-lite` | gemini/Gemini 3.1 Flash Lite | 1,048,576 | 65,536 |
| `gemini/gemini-3-pro-image-preview` | gemini-3-pro-image-preview | 131,072 | 32,768 |
| `gemini/gemini-3-pro-image` | gemini-3-pro-image | 131,072 | 32,768 |
| `gemini/nano-banana-pro-preview` | nano-banana-pro-preview | 131,072 | 32,768 |
| `gemini/gemini-3.1-flash-image-preview` | gemini-3.1-flash-image-preview | 65,536 | 65,536 |
| `gemini/gemini-3.1-flash-image` | gemini/gemini-3.1-flash-image | 65,536 | 65,536 |
| `gemini/gemini-3.1-flash-lite-image` | gemini-3.1-flash-lite-image | 65,536 | 65,536 |
| `gemini/gemini-3.5-flash` | Gemini 3.5 Flash | 1,048,576 | 65,536 |
| `gemini/gemini-3.5-flash-lite` | gemini-3.5-flash-lite | 1,048,576 | 65,536 |
| `gemini/gemini-omni-flash-preview` | gemini-omni-flash-preview | 131,072 | 65,536 |
| `gemini/gemini-3.6-flash` | gemini-3.6-flash | 1,048,576 | 65,536 |
| `gemini/lyria-3-clip-preview` | lyria-3-clip-preview | 1,048,576 | 65,536 |
| `gemini/lyria-3-pro-preview` | lyria-3-pro-preview | 1,048,576 | 65,536 |
| `gemini/gemini-3.1-flash-tts-preview` | Gemini 3.1 Flash TTS | 8,192 | 16,384 |
| `gemini/gemini-robotics-er-1.5-preview` | gemini-robotics-er-1.5-preview | 1,048,576 | 65,536 |
| `gemini/gemini-robotics-er-1.6-preview` | gemini-robotics-er-1.6-preview | 131,072 | 65,536 |
| `gemini/gemini-robotics-er-2-preview` | gemini-robotics-er-2-preview | 131,072 | 65,536 |
| `gemini/gemini-2.5-computer-use-preview-10-2025` | gemini-2.5-computer-use-preview-10-2025 | 131,072 | 65,536 |
| `gemini/antigravity-preview-05-2026` | antigravity-preview-05-2026 | 131,072 | 65,536 |
| `gemini/deep-research-max-preview-04-2026` | deep-research-max-preview-04-2026 | 131,072 | 65,536 |
| `gemini/deep-research-preview-04-2026` | deep-research-preview-04-2026 | 131,072 | 65,536 |
| `gemini/deep-research-pro-preview-12-2025` | deep-research-pro-preview-12-2025 | 131,072 | 65,536 |
| `gemini/gemini-embedding-001` | gemini-embedding-001 | 2,048 | 1 |
| `gemini/gemini-embedding-2-preview` | gemini-embedding-2-preview | 8,192 | 1 |
| `gemini/gemini-embedding-2` | gemini-embedding-2 | 8,192 | 1 |
| `gemini/aqa` | aqa | 7,168 | 1,024 |
| `gemini/veo-3.1-generate-preview` | veo-3.1-generate-preview | 480 | 8,192 |
| `gemini/veo-3.1-fast-generate-preview` | veo-3.1-fast-generate-preview | 480 | 8,192 |
| `gemini/veo-3.1-lite-generate-preview` | veo-3.1-lite-generate-preview | 480 | 8,192 |
| `gemini/gemini-2.5-flash-native-audio-latest` | gemini-2.5-flash-native-audio-latest | 131,072 | 65,536 |
| `gemini/gemini-2.5-flash-native-audio-preview-09-2025` | gemini-2.5-flash-native-audio-preview-09-2025 | 131,072 | 65,536 |
| `gemini/gemini-2.5-flash-native-audio-preview-12-2025` | gemini-2.5-flash-native-audio-preview-12-2025 | 131,072 | 65,536 |
| `gemini/gemini-3.1-flash-live-preview` | gemini-3.1-flash-live-preview | 131,072 | 65,536 |
| `gemini/gemini-robotics-er-2-streaming-preview` | gemini-robotics-er-2-streaming-preview | 131,072 | 65,536 |
| `gemini/gemini-3.5-live-translate-preview` | gemini-3.5-live-translate-preview | 16,384 | 32,768 |
| `gemini/imagen-4.0-generate-001` | imagen-4.0-generate-001 | — | — |
| `gemini/imagen-4.0-ultra-generate-001` | imagen-4.0-ultra-generate-001 | — | — |
| `gemini/imagen-4.0-fast-generate-001` | imagen-4.0-fast-generate-001 | — | — |

### `groq/` (16)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `groq/allam-2-7b` | allam-2-7b | 4,096 | — |
| `groq/llama-3.3-70b-versatile` | Llama 3.3 70B | 131,072 | — |
| `groq/openai/gpt-oss-safeguard-20b` | GPT-OSS Safeguard 20B | 131,072 | — |
| `groq/groq/compound-mini` | groq/compound-mini | 131,072 | — |
| `groq/canopylabs/orpheus-v1-english` | canopylabs/orpheus-v1-english | 4,000 | — |
| `groq/openai/gpt-oss-20b` | GPT-OSS 20B | 131,072 | — |
| `groq/qwen/qwen3.6-27b` | Qwen3.6 27B | 131,072 | — |
| `groq/meta-llama/llama-prompt-guard-2-22m` | meta-llama/llama-prompt-guard-2-22m | 512 | — |
| `groq/openai/gpt-oss-120b` | GPT-OSS 120B | 131,072 | — |
| `groq/canopylabs/orpheus-arabic-saudi` | canopylabs/orpheus-arabic-saudi | 4,000 | — |
| `groq/meta-llama/llama-prompt-guard-2-86m` | meta-llama/llama-prompt-guard-2-86m | 512 | — |
| `groq/groq/compound` | groq/compound | 131,072 | — |
| `groq/llama-3.1-8b-instant` | llama-3.1-8b-instant | 131,072 | — |
| `groq/whisper-large-v3` | whisper-large-v3 | — | — |
| `groq/whisper-large-v3-turbo` | whisper-large-v3-turbo | — | — |
| `groq/distil-whisper-large-v3-en` | distil-whisper-large-v3-en | — | — |

### `moonshot/` (4)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `moonshot/kimi-k3` | moonshot/Kimi K3 | 1,048,576 | 1,048,576 |
| `moonshot/kimi-k2.7-code-highspeed` | moonshot/Kimi K2.7 Code (High Speed) | 262,144 | 262,144 |
| `moonshot/kimi-k2.6` | moonshot/Kimi K2.6 | 262,144 | 262,144 |
| `moonshot/kimi-k2.7-code` | moonshot/Kimi K2.7 Code | 262,144 | 262,144 |

### `openai/` (128)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `openai/text-embedding-ada-002` | text-embedding-ada-002 | 128,000 | — |
| `openai/gpt-3.5-turbo` | gpt-3.5-turbo | 128,000 | — |
| `openai/gpt-3.5-turbo-16k` | gpt-3.5-turbo-16k | 128,000 | — |
| `openai/gpt-4-0613` | gpt-4-0613 | 128,000 | — |
| `openai/gpt-4` | gpt-4 | 128,000 | — |
| `openai/davinci-002` | davinci-002 | 128,000 | — |
| `openai/babbage-002` | babbage-002 | 128,000 | — |
| `openai/gpt-3.5-turbo-instruct` | gpt-3.5-turbo-instruct | 128,000 | — |
| `openai/gpt-3.5-turbo-instruct-0914` | gpt-3.5-turbo-instruct-0914 | 128,000 | — |
| `openai/gpt-3.5-turbo-1106` | gpt-3.5-turbo-1106 | 128,000 | — |
| `openai/tts-1-1106` | tts-1-1106 | 128,000 | — |
| `openai/tts-1-hd-1106` | tts-1-hd-1106 | 128,000 | — |
| `openai/text-embedding-3-small` | text-embedding-3-small | 128,000 | — |
| `openai/text-embedding-3-large` | text-embedding-3-large | 128,000 | — |
| `openai/gpt-3.5-turbo-0125` | gpt-3.5-turbo-0125 | 128,000 | — |
| `openai/gpt-4-turbo` | gpt-4-turbo | 128,000 | — |
| `openai/gpt-4-turbo-2024-04-09` | gpt-4-turbo-2024-04-09 | 128,000 | — |
| `openai/gpt-4o` | GPT-4o | 128,000 | 16,384 |
| `openai/gpt-4o-2024-05-13` | gpt-4o-2024-05-13 | 128,000 | 16,384 |
| `openai/gpt-4o-mini-2024-07-18` | gpt-4o-mini-2024-07-18 | 128,000 | 16,384 |
| `openai/gpt-4o-mini` | GPT-4o Mini | 128,000 | 16,384 |
| `openai/gpt-4o-2024-08-06` | gpt-4o-2024-08-06 | 128,000 | 16,384 |
| `openai/omni-moderation-2024-09-26` | omni-moderation-2024-09-26 | 128,000 | — |
| `openai/o1-2024-12-17` | o1-2024-12-17 | 128,000 | — |
| `openai/o1` | o1 | 128,000 | — |
| `openai/o3-mini` | O3 Mini | 200,000 | — |
| `openai/o3-mini-2025-01-31` | o3-mini-2025-01-31 | 128,000 | — |
| `openai/gpt-4o-2024-11-20` | GPT-4o (Nov 2024) | 128,000 | 16,384 |
| `openai/gpt-4o-mini-search-preview-2025-03-11` | gpt-4o-mini-search-preview-2025-03-11 | 128,000 | 16,384 |
| `openai/gpt-4o-mini-search-preview` | gpt-4o-mini-search-preview | 128,000 | 16,384 |
| `openai/gpt-4o-transcribe` | gpt-4o-transcribe | 128,000 | 16,384 |
| `openai/gpt-4o-mini-transcribe` | gpt-4o-mini-transcribe | 128,000 | 16,384 |
| `openai/o1-pro-2025-03-19` | o1-pro-2025-03-19 | 128,000 | — |
| `openai/o1-pro` | o1-pro | 128,000 | — |
| `openai/o3-2025-04-16` | o3-2025-04-16 | 128,000 | — |
| `openai/o4-mini-2025-04-16` | o4-mini-2025-04-16 | 128,000 | — |
| `openai/o3` | O3 | 200,000 | — |
| `openai/o4-mini` | O4 Mini | 200,000 | — |
| `openai/gpt-4.1-2025-04-14` | gpt-4.1-2025-04-14 | 128,000 | — |
| `openai/gpt-4.1` | GPT-4.1 | 1,047,576 | — |
| `openai/gpt-4.1-mini-2025-04-14` | gpt-4.1-mini-2025-04-14 | 128,000 | — |
| `openai/gpt-4.1-mini` | GPT-4.1 Mini | 1,047,576 | — |
| `openai/gpt-4.1-nano-2025-04-14` | gpt-4.1-nano-2025-04-14 | 128,000 | — |
| `openai/gpt-4.1-nano` | GPT-4.1 Nano | 1,047,576 | — |
| `openai/gpt-image-1` | gpt-image-1 | 128,000 | — |
| `openai/o4-mini-deep-research` | o4-mini-deep-research | 128,000 | — |
| `openai/gpt-4o-transcribe-diarize` | gpt-4o-transcribe-diarize | 128,000 | 16,384 |
| `openai/o4-mini-deep-research-2025-06-26` | o4-mini-deep-research-2025-06-26 | 128,000 | — |
| `openai/gpt-5-chat-latest` | gpt-5-chat-latest | 128,000 | — |
| `openai/gpt-5-2025-08-07` | gpt-5-2025-08-07 | 128,000 | — |
| `openai/gpt-5` | gpt-5 | 128,000 | — |
| `openai/gpt-5-mini-2025-08-07` | gpt-5-mini-2025-08-07 | 128,000 | — |
| `openai/gpt-5-mini` | gpt-5-mini | 128,000 | — |
| `openai/gpt-5-nano-2025-08-07` | gpt-5-nano-2025-08-07 | 128,000 | — |
| `openai/gpt-5-nano` | gpt-5-nano | 128,000 | — |
| `openai/gpt-audio-2025-08-28` | gpt-audio-2025-08-28 | 128,000 | — |
| `openai/gpt-realtime` | gpt-realtime | 128,000 | — |
| `openai/gpt-realtime-2025-08-28` | gpt-realtime-2025-08-28 | 128,000 | — |
| `openai/gpt-audio` | gpt-audio | 128,000 | — |
| `openai/gpt-5-codex` | gpt-5-codex | 128,000 | — |
| `openai/gpt-5-pro-2025-10-06` | gpt-5-pro-2025-10-06 | 128,000 | — |
| `openai/gpt-5-pro` | gpt-5-pro | 128,000 | — |
| `openai/gpt-audio-mini` | gpt-audio-mini | 128,000 | — |
| `openai/gpt-audio-mini-2025-10-06` | gpt-audio-mini-2025-10-06 | 128,000 | — |
| `openai/gpt-5-search-api` | gpt-5-search-api | 128,000 | — |
| `openai/gpt-realtime-mini` | gpt-realtime-mini | 128,000 | — |
| `openai/sora-2` | sora-2 | 128,000 | — |
| `openai/sora-2-pro` | sora-2-pro | 128,000 | — |
| `openai/gpt-5-search-api-2025-10-14` | gpt-5-search-api-2025-10-14 | 128,000 | — |
| `openai/gpt-5.1-chat-latest` | gpt-5.1-chat-latest | 128,000 | — |
| `openai/gpt-5.1-2025-11-13` | gpt-5.1-2025-11-13 | 128,000 | — |
| `openai/gpt-5.1` | gpt-5.1 | 128,000 | — |
| `openai/gpt-5.1-codex` | gpt-5.1-codex | 128,000 | — |
| `openai/gpt-5.1-codex-mini` | gpt-5.1-codex-mini | 128,000 | — |
| `openai/gpt-5.1-codex-max` | gpt-5.1-codex-max | 128,000 | — |
| `openai/gpt-5.2-2025-12-11` | gpt-5.2-2025-12-11 | 128,000 | — |
| `openai/gpt-5.2` | gpt-5.2 | 128,000 | — |
| `openai/gpt-5.2-pro-2025-12-11` | gpt-5.2-pro-2025-12-11 | 128,000 | — |
| `openai/gpt-5.2-pro` | gpt-5.2-pro | 128,000 | — |
| `openai/gpt-5.2-chat-latest` | gpt-5.2-chat-latest | 128,000 | — |
| `openai/gpt-4o-mini-transcribe-2025-12-15` | gpt-4o-mini-transcribe-2025-12-15 | 128,000 | 16,384 |
| `openai/gpt-4o-mini-transcribe-2025-03-20` | gpt-4o-mini-transcribe-2025-03-20 | 128,000 | 16,384 |
| `openai/gpt-4o-mini-tts-2025-03-20` | gpt-4o-mini-tts-2025-03-20 | 128,000 | 16,384 |
| `openai/gpt-4o-mini-tts-2025-12-15` | gpt-4o-mini-tts-2025-12-15 | 128,000 | 16,384 |
| `openai/gpt-realtime-mini-2025-12-15` | gpt-realtime-mini-2025-12-15 | 128,000 | — |
| `openai/gpt-audio-mini-2025-12-15` | gpt-audio-mini-2025-12-15 | 128,000 | — |
| `openai/chatgpt-image-latest` | chatgpt-image-latest | 128,000 | — |
| `openai/gpt-5.2-codex` | gpt-5.2-codex | 128,000 | — |
| `openai/gpt-5.3-codex` | gpt-5.3-codex | 128,000 | — |
| `openai/gpt-realtime-1.5` | gpt-realtime-1.5 | 128,000 | — |
| `openai/gpt-audio-1.5` | gpt-audio-1.5 | 128,000 | — |
| `openai/gpt-4o-search-preview` | gpt-4o-search-preview | 128,000 | 16,384 |
| `openai/gpt-4o-search-preview-2025-03-11` | gpt-4o-search-preview-2025-03-11 | 128,000 | 16,384 |
| `openai/gpt-5.3-chat-latest` | gpt-5.3-chat-latest | 128,000 | — |
| `openai/gpt-5.4-2026-03-05` | gpt-5.4-2026-03-05 | 409,600 | 131,072 |
| `openai/gpt-5.4-pro` | GPT-5.4 Pro | 1,050,000 | 131,072 |
| `openai/gpt-5.4-pro-2026-03-05` | gpt-5.4-pro-2026-03-05 | 409,600 | 131,072 |
| `openai/gpt-5.4` | openai/GPT-5.4 | 1,050,000 | 131,072 |
| `openai/gpt-5.4-nano-2026-03-17` | gpt-5.4-nano-2026-03-17 | 409,600 | 131,072 |
| `openai/gpt-5.4-nano` | openai/GPT-5.4 Nano | 400,000 | 131,072 |
| `openai/gpt-5.4-mini-2026-03-17` | gpt-5.4-mini-2026-03-17 | 409,600 | 131,072 |
| `openai/gpt-5.4-mini` | openai/GPT-5.4 Mini | 400,000 | 131,072 |
| `openai/gpt-image-2-2026-04-21` | gpt-image-2-2026-04-21 | 128,000 | — |
| `openai/gpt-5.5` | openai/GPT-5.5 | 1,050,000 | 128,000 |
| `openai/gpt-5.5-2026-04-23` | gpt-5.5-2026-04-23 | 1,050,000 | 128,000 |
| `openai/gpt-5.5-pro` | GPT-5.5 Pro | 1,050,000 | 128,000 |
| `openai/gpt-5.5-pro-2026-04-23` | gpt-5.5-pro-2026-04-23 | 1,050,000 | 128,000 |
| `openai/chat-latest` | chat-latest | 128,000 | — |
| `openai/gpt-realtime-translate` | gpt-realtime-translate | 128,000 | — |
| `openai/gpt-realtime-2` | gpt-realtime-2 | 128,000 | — |
| `openai/gpt-realtime-whisper` | gpt-realtime-whisper | 128,000 | — |
| `openai/gpt-5.6-sol` | openai/GPT-5.6 Sol | 1,050,000 | 128,000 |
| `openai/gpt-5.6-terra` | openai/GPT-5.6 Terra | 1,050,000 | 128,000 |
| `openai/gpt-5.6-luna` | openai/GPT-5.6 Luna | 1,050,000 | 128,000 |
| `openai/gpt-realtime-2.1` | gpt-realtime-2.1 | 128,000 | — |
| `openai/gpt-realtime-2.1-mini` | gpt-realtime-2.1-mini | 128,000 | — |
| `openai/gpt-transcribe` | gpt-transcribe | 128,000 | — |
| `openai/gpt-live-transcribe` | gpt-live-transcribe | 128,000 | — |
| `openai/gpt-image-2` | gpt-image-2 | — | — |
| `openai/gpt-image-1.5` | gpt-image-1.5 | — | — |
| `openai/gpt-image-1-mini` | gpt-image-1-mini | — | — |
| `openai/whisper-1` | whisper-1 | — | — |
| `openai/gpt-4o-transcription` | gpt-4o-transcription | — | 16,384 |
| `openai/tts-1-hd` | tts-1-hd | — | — |
| `openai/tts-1` | tts-1 | — | — |
| `openai/gpt-4o-mini-tts` | gpt-4o-mini-tts | — | 16,384 |
| `openai/omni-moderation-latest` | omni-moderation-latest | — | — |
| `openai/text-moderation-latest` | text-moderation-latest | — | — |

### `zai/` (6)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `zai/glm-5.2` | zai/GLM 5.2 | 1,000,000 | 131,072 |
| `zai/glm-5.1` | GLM 5.1 | 200,000 | 128,000 |
| `zai/glm-5` | GLM 5 | 200,000 | 128,000 |
| `zai/glm-5-turbo` | GLM 5 Turbo | 200,000 | 128,000 |
| `zai/glm-4.7-flash` | GLM 4.7 Flash | 128,000 | — |
| `zai/glm-4.7` | GLM 4.7 | 128,000 | — |

### `veoaifree-web/` (2)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `veoaifree-web/veo` | veoaifree-web/VEO 3.1 | — | — |
| `veoaifree-web/seedance` | veoaifree-web/Seedance | — | — |

### `veo-free/` (2)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `veo-free/veo` | veo-free/VEO 3.1 | — | — |
| `veo-free/seedance` | veo-free/Seedance | — | — |

### `no-think/` (88)

| ID | Name | Context | Max out |
|---|---|---:|---:|
| `no-think/cc/claude-opus-5` | no-think/cc/claude-opus-5 | 200,000 | — |
| `no-think/claude/claude-opus-5` | no-think/claude/claude-opus-5 | 200,000 | — |
| `no-think/cc/claude-opus-4-8` | no-think/cc/claude-opus-4-8 | 200,000 | — |
| `no-think/claude/claude-opus-4-8` | no-think/claude/claude-opus-4-8 | 200,000 | — |
| `no-think/cc/claude-opus-4-7` | no-think/cc/claude-opus-4-7 | 200,000 | — |
| `no-think/claude/claude-opus-4-7` | no-think/claude/claude-opus-4-7 | 200,000 | — |
| `no-think/cc/claude-opus-4-6` | no-think/cc/claude-opus-4-6 | 200,000 | — |
| `no-think/claude/claude-opus-4-6` | no-think/claude/claude-opus-4-6 | 200,000 | — |
| `no-think/cc/claude-opus-4-5-20251101` | no-think/cc/claude-opus-4-5-20251101 | 200,000 | — |
| `no-think/claude/claude-opus-4-5-20251101` | no-think/claude/claude-opus-4-5-20251101 | 200,000 | — |
| `no-think/cc/claude-sonnet-5` | no-think/cc/claude-sonnet-5 | 200,000 | — |
| `no-think/claude/claude-sonnet-5` | no-think/claude/claude-sonnet-5 | 200,000 | — |
| `no-think/cc/claude-sonnet-4-6` | no-think/cc/claude-sonnet-4-6 | 200,000 | — |
| `no-think/claude/claude-sonnet-4-6` | no-think/claude/claude-sonnet-4-6 | 200,000 | — |
| `no-think/cc/claude-sonnet-4-5-20250929` | no-think/cc/claude-sonnet-4-5-20250929 | 200,000 | — |
| `no-think/claude/claude-sonnet-4-5-20250929` | no-think/claude/claude-sonnet-4-5-20250929 | 200,000 | — |
| `no-think/cc/claude-haiku-4-5-20251001` | no-think/cc/claude-haiku-4-5-20251001 | 200,000 | — |
| `no-think/claude/claude-haiku-4-5-20251001` | no-think/claude/claude-haiku-4-5-20251001 | 200,000 | — |
| `no-think/antigravity/claude-opus-4-6-thinking` | no-think/antigravity/claude-opus-4-6-thinking | 200,000 | — |
| `no-think/antigravity/claude-sonnet-4-6` | no-think/antigravity/claude-sonnet-4-6 | 200,000 | — |
| `no-think/cc/claude-opus-5-low` | no-think/cc/claude-opus-5-low | 200,000 | — |
| `no-think/cc/claude-opus-5-medium` | no-think/cc/claude-opus-5-medium | 200,000 | — |
| `no-think/cc/claude-opus-5-high` | no-think/cc/claude-opus-5-high | 200,000 | — |
| `no-think/cc/claude-opus-5-xhigh` | no-think/cc/claude-opus-5-xhigh | 200,000 | — |
| `no-think/claude/claude-opus-5-low` | no-think/claude/claude-opus-5-low | 200,000 | — |
| `no-think/claude/claude-opus-5-medium` | no-think/claude/claude-opus-5-medium | 200,000 | — |
| `no-think/claude/claude-opus-5-high` | no-think/claude/claude-opus-5-high | 200,000 | — |
| `no-think/claude/claude-opus-5-xhigh` | no-think/claude/claude-opus-5-xhigh | 200,000 | — |
| `no-think/cc/claude-opus-4-8-low` | no-think/cc/claude-opus-4-8-low | 200,000 | — |
| `no-think/cc/claude-opus-4-8-medium` | no-think/cc/claude-opus-4-8-medium | 200,000 | — |
| `no-think/cc/claude-opus-4-8-high` | no-think/cc/claude-opus-4-8-high | 200,000 | — |
| `no-think/cc/claude-opus-4-8-xhigh` | no-think/cc/claude-opus-4-8-xhigh | 200,000 | — |
| `no-think/claude/claude-opus-4-8-low` | no-think/claude/claude-opus-4-8-low | 200,000 | — |
| `no-think/claude/claude-opus-4-8-medium` | no-think/claude/claude-opus-4-8-medium | 200,000 | — |
| `no-think/claude/claude-opus-4-8-high` | no-think/claude/claude-opus-4-8-high | 200,000 | — |
| `no-think/claude/claude-opus-4-8-xhigh` | no-think/claude/claude-opus-4-8-xhigh | 200,000 | — |
| `no-think/cc/claude-opus-4-7-low` | no-think/cc/claude-opus-4-7-low | 200,000 | — |
| `no-think/cc/claude-opus-4-7-medium` | no-think/cc/claude-opus-4-7-medium | 200,000 | — |
| `no-think/cc/claude-opus-4-7-high` | no-think/cc/claude-opus-4-7-high | 200,000 | — |
| `no-think/cc/claude-opus-4-7-xhigh` | no-think/cc/claude-opus-4-7-xhigh | 200,000 | — |
| `no-think/claude/claude-opus-4-7-low` | no-think/claude/claude-opus-4-7-low | 200,000 | — |
| `no-think/claude/claude-opus-4-7-medium` | no-think/claude/claude-opus-4-7-medium | 200,000 | — |
| `no-think/claude/claude-opus-4-7-high` | no-think/claude/claude-opus-4-7-high | 200,000 | — |
| `no-think/claude/claude-opus-4-7-xhigh` | no-think/claude/claude-opus-4-7-xhigh | 200,000 | — |
| `no-think/cc/claude-opus-4-6-low` | no-think/cc/claude-opus-4-6-low | 200,000 | — |
| `no-think/cc/claude-opus-4-6-medium` | no-think/cc/claude-opus-4-6-medium | 200,000 | — |
| `no-think/cc/claude-opus-4-6-high` | no-think/cc/claude-opus-4-6-high | 200,000 | — |
| `no-think/claude/claude-opus-4-6-low` | no-think/claude/claude-opus-4-6-low | 200,000 | — |
| `no-think/claude/claude-opus-4-6-medium` | no-think/claude/claude-opus-4-6-medium | 200,000 | — |
| `no-think/claude/claude-opus-4-6-high` | no-think/claude/claude-opus-4-6-high | 200,000 | — |
| `no-think/cc/claude-opus-4-5-20251101-low` | no-think/cc/claude-opus-4-5-20251101-low | 200,000 | — |
| `no-think/cc/claude-opus-4-5-20251101-medium` | no-think/cc/claude-opus-4-5-20251101-medium | 200,000 | — |
| `no-think/cc/claude-opus-4-5-20251101-high` | no-think/cc/claude-opus-4-5-20251101-high | 200,000 | — |
| `no-think/claude/claude-opus-4-5-20251101-low` | no-think/claude/claude-opus-4-5-20251101-low | 200,000 | — |
| `no-think/claude/claude-opus-4-5-20251101-medium` | no-think/claude/claude-opus-4-5-20251101-medium | 200,000 | — |
| `no-think/claude/claude-opus-4-5-20251101-high` | no-think/claude/claude-opus-4-5-20251101-high | 200,000 | — |
| `no-think/cc/claude-sonnet-5-low` | no-think/cc/claude-sonnet-5-low | 200,000 | — |
| `no-think/cc/claude-sonnet-5-medium` | no-think/cc/claude-sonnet-5-medium | 200,000 | — |
| `no-think/cc/claude-sonnet-5-high` | no-think/cc/claude-sonnet-5-high | 200,000 | — |
| `no-think/cc/claude-sonnet-5-xhigh` | no-think/cc/claude-sonnet-5-xhigh | 200,000 | — |
| `no-think/claude/claude-sonnet-5-low` | no-think/claude/claude-sonnet-5-low | 200,000 | — |
| `no-think/claude/claude-sonnet-5-medium` | no-think/claude/claude-sonnet-5-medium | 200,000 | — |
| `no-think/claude/claude-sonnet-5-high` | no-think/claude/claude-sonnet-5-high | 200,000 | — |
| `no-think/claude/claude-sonnet-5-xhigh` | no-think/claude/claude-sonnet-5-xhigh | 200,000 | — |
| `no-think/cc/claude-sonnet-4-6-low` | no-think/cc/claude-sonnet-4-6-low | 200,000 | — |
| `no-think/cc/claude-sonnet-4-6-medium` | no-think/cc/claude-sonnet-4-6-medium | 200,000 | — |
| `no-think/cc/claude-sonnet-4-6-high` | no-think/cc/claude-sonnet-4-6-high | 200,000 | — |
| `no-think/claude/claude-sonnet-4-6-low` | no-think/claude/claude-sonnet-4-6-low | 200,000 | — |
| `no-think/claude/claude-sonnet-4-6-medium` | no-think/claude/claude-sonnet-4-6-medium | 200,000 | — |
| `no-think/claude/claude-sonnet-4-6-high` | no-think/claude/claude-sonnet-4-6-high | 200,000 | — |
| `no-think/cc/claude-sonnet-4-5-20250929-low` | no-think/cc/claude-sonnet-4-5-20250929-low | 200,000 | — |
| `no-think/cc/claude-sonnet-4-5-20250929-medium` | no-think/cc/claude-sonnet-4-5-20250929-medium | 200,000 | — |
| `no-think/cc/claude-sonnet-4-5-20250929-high` | no-think/cc/claude-sonnet-4-5-20250929-high | 200,000 | — |
| `no-think/claude/claude-sonnet-4-5-20250929-low` | no-think/claude/claude-sonnet-4-5-20250929-low | 200,000 | — |
| `no-think/claude/claude-sonnet-4-5-20250929-medium` | no-think/claude/claude-sonnet-4-5-20250929-medium | 200,000 | — |
| `no-think/claude/claude-sonnet-4-5-20250929-high` | no-think/claude/claude-sonnet-4-5-20250929-high | 200,000 | — |
| `no-think/cc/claude-haiku-4-5-20251001-low` | no-think/cc/claude-haiku-4-5-20251001-low | 200,000 | — |
| `no-think/cc/claude-haiku-4-5-20251001-medium` | no-think/cc/claude-haiku-4-5-20251001-medium | 200,000 | — |
| `no-think/cc/claude-haiku-4-5-20251001-high` | no-think/cc/claude-haiku-4-5-20251001-high | 200,000 | — |
| `no-think/claude/claude-haiku-4-5-20251001-low` | no-think/claude/claude-haiku-4-5-20251001-low | 200,000 | — |
| `no-think/claude/claude-haiku-4-5-20251001-medium` | no-think/claude/claude-haiku-4-5-20251001-medium | 200,000 | — |
| `no-think/claude/claude-haiku-4-5-20251001-high` | no-think/claude/claude-haiku-4-5-20251001-high | 200,000 | — |
| `no-think/antigravity/claude-opus-4-6-thinking-low` | no-think/antigravity/claude-opus-4-6-thinking-low | 200,000 | — |
| `no-think/antigravity/claude-opus-4-6-thinking-medium` | no-think/antigravity/claude-opus-4-6-thinking-medium | 200,000 | — |
| `no-think/antigravity/claude-opus-4-6-thinking-high` | no-think/antigravity/claude-opus-4-6-thinking-high | 200,000 | — |
| `no-think/antigravity/claude-sonnet-4-6-low` | no-think/antigravity/claude-sonnet-4-6-low | 200,000 | — |
| `no-think/antigravity/claude-sonnet-4-6-medium` | no-think/antigravity/claude-sonnet-4-6-medium | 200,000 | — |
| `no-think/antigravity/claude-sonnet-4-6-high` | no-think/antigravity/claude-sonnet-4-6-high | 200,000 | — |

## Cross-check against the local DSH configuration

The omniroute route in `~/.dsh/settings.yaml` pins 10 models; an explicit `models:` list **replaces** the advertised catalog in every DSH picker, which is why the model selector shows only these 10. Advertised status per pinned id:

| Pinned in settings.yaml | Advertised by gateway |
|---|---|
| `auto/best-coding` | yes |
| `auto/best-fast` | yes |
| `auto/best-reasoning` | yes |
| `anthropic/claude-opus-5-high` | **no** |
| `anthropic/claude-sonnet-5-high` | **no** |
| `openrouter/openai/gpt-5.6-terra-pro-high` | **no** |
| `openrouter/openai/gpt-5.3-codex-high` | **no** |
| `openrouter/deepseek/deepseek-v4-pro-high` | **no** |
| `openrouter/z-ai/glm-5.2-xhigh` | **no** |
| `openrouter/x-ai/grok-4.5-high` | **no** |

7 of the pinned ids (the `anthropic/*` and `openrouter/*` direct routes) are absent from `GET /models` above. They may still be served on request — a gateway can accept more than it advertises — but the gateway does not list them.

To adopt any advertised model in DSH: **Settings → Models → OmniRoute → Edit → “Fetch models”** lists these same candidates with checkboxes; or add ids by hand to the `models:` list of the omniroute provider in `~/.dsh/settings.yaml`.

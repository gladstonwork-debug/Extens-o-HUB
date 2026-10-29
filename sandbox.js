/*
 * HubSpot Sinalizador 3.0.6 TESTE
 * Sandbox isolado para transcrição local com Whisper via Transformers.js.
 *
 * Melhorias desta versão:
 * - modelo multilingual Whisper Base no lugar do Tiny;
 * - proteção de geração contra repetição excessiva;
 * - pós-processamento conservador para loops consecutivos;
 * - diagnóstico de modelo, WebGPU/WASM e último estado.
 *
 * O áudio chega como Float32Array mono/16kHz por postMessage, é processado
 * localmente e não é persistido neste sandbox.
 */

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js";
const MODEL_ID = "onnx-community/whisper-base";

function neutralizeUnavailableCacheStorage() {
  try {
    void globalThis.caches;
    return true;
  } catch (_) {
    try {
      Object.defineProperty(globalThis, "caches", {
        value: undefined,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch (_) {}
    return false;
  }
}

const CACHE_STORAGE_AVAILABLE = neutralizeUnavailableCacheStorage();

let transformersModulePromise = null;
let transcriberPromise = null;
let activeDevice = null;
let queue = Promise.resolve();

function send(type, payload = {}) {
  window.parent.postMessage({ type, ...payload }, "*");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function getTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import(TRANSFORMERS_URL);
  }
  return transformersModulePromise;
}

function progressText(info) {
  if (!info || typeof info !== "object") return "Preparando modelo local…";

  if (info.status === "progress_total" && Number.isFinite(info.progress)) {
    const pct = Math.max(0, Math.min(100, Math.round(info.progress)));
    const loaded = formatBytes(info.loaded);
    const total = formatBytes(info.total);
    return `Baixando Whisper Base… ${pct}%${loaded && total ? ` (${loaded}/${total})` : ""}`;
  }

  if (info.status === "progress" && Number.isFinite(info.progress)) {
    return `Baixando Whisper Base… ${Math.round(info.progress)}%`;
  }

  if (info.status === "initiate") return "Preparando arquivos do Whisper Base…";
  if (info.status === "download") return "Baixando arquivos do Whisper Base…";
  if (info.status === "done") return "Arquivo do Whisper Base pronto…";
  if (info.status === "ready") return "Whisper Base pronto…";

  return "Preparando Whisper Base…";
}

async function buildTranscriber(requestId) {
  const { pipeline, env } = await getTransformersModule();

  env.allowRemoteModels = true;
  env.useBrowserCache = CACHE_STORAGE_AVAILABLE;
  if (!CACHE_STORAGE_AVAILABLE) {
    env.useBrowserCache = false;
    if ("useWasmCache" in env) env.useWasmCache = false;
    if ("experimental_useCrossOriginStorage" in env) {
      env.experimental_useCrossOriginStorage = false;
    }
  }

  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }

  const progress_callback = (info) => {
    send("HS_WHISPER_PROGRESS", {
      requestId,
      message: progressText(info),
      rawStatus: info?.status || "",
      progress: Number.isFinite(info?.progress) ? info.progress : null,
      model: MODEL_ID,
    });
  };

  if (navigator.gpu) {
    try {
      send("HS_WHISPER_PROGRESS", {
        requestId,
        message: "Inicializando Whisper Base com WebGPU…",
        model: MODEL_ID,
      });

      const pipe = await pipeline("automatic-speech-recognition", MODEL_ID, {
        device: "webgpu",
        dtype: "q4",
        progress_callback,
      });
      activeDevice = "WebGPU";
      return pipe;
    } catch (error) {
      send("HS_WHISPER_PROGRESS", {
        requestId,
        message: "WebGPU não inicializou; tentando Whisper Base em modo compatível (WASM)…",
        model: MODEL_ID,
      });
      console.warn("[HubSpot Sinalizador] Whisper Base WebGPU falhou; usando WASM.", error);
    }
  }

  const pipe = await pipeline("automatic-speech-recognition", MODEL_ID, {
    dtype: "q4",
    progress_callback,
  });
  activeDevice = "WASM";
  return pipe;
}

async function getTranscriber(requestId) {
  if (!transcriberPromise) {
    transcriberPromise = buildTranscriber(requestId).catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

function sentenceKey(value) {
  return String(value || "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collapseRepeatedSentences(text) {
  const parts = String(text || "").match(/[^.!?]+(?:[.!?]+|$)/g) || [];
  if (parts.length < 2) return { text: String(text || ""), adjustments: 0 };

  const out = [];
  let previous = "";
  let adjustments = 0;
  for (const part of parts) {
    const key = sentenceKey(part);
    const wordCount = key ? key.split(" ").length : 0;
    if (key && key === previous && wordCount >= 4) {
      adjustments += 1;
      continue;
    }
    out.push(part.trim());
    previous = key;
  }
  return { text: out.join(" ").trim(), adjustments };
}

function normalizeToken(token) {
  return String(token || "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function sameTokenBlock(tokens, a, b, length) {
  for (let i = 0; i < length; i += 1) {
    if (normalizeToken(tokens[a + i]) !== normalizeToken(tokens[b + i])) return false;
  }
  return true;
}

function collapseRepeatedWordRuns(text) {
  const tokens = String(text || "").split(/\s+/).filter(Boolean);
  if (tokens.length < 15) return { text: String(text || ""), adjustments: 0 };

  const out = [];
  let i = 0;
  let adjustments = 0;

  while (i < tokens.length) {
    let matched = 0;
    const maxBlock = Math.min(14, Math.floor((tokens.length - i) / 3));

    for (let size = maxBlock; size >= 5; size -= 1) {
      if (
        sameTokenBlock(tokens, i, i + size, size) &&
        sameTokenBlock(tokens, i, i + size * 2, size)
      ) {
        matched = size;
        break;
      }
    }

    if (!matched) {
      out.push(tokens[i]);
      i += 1;
      continue;
    }

    out.push(...tokens.slice(i, i + matched));
    let repeats = 1;
    let cursor = i + matched;
    while (
      cursor + matched <= tokens.length &&
      sameTokenBlock(tokens, i, cursor, matched)
    ) {
      repeats += 1;
      cursor += matched;
    }

    adjustments += Math.max(0, repeats - 1);
    i = cursor;
  }

  return { text: out.join(" ").trim(), adjustments };
}

function cleanTranscript(rawText) {
  const normalized = String(rawText || "").replace(/\s+/g, " ").trim();
  const sentencePass = collapseRepeatedSentences(normalized);
  const wordPass = collapseRepeatedWordRuns(sentencePass.text);
  return {
    text: wordPass.text.replace(/\s+([,.!?;:])/g, "$1").trim(),
    adjustments: sentencePass.adjustments + wordPass.adjustments,
  };
}

async function transcribe({ requestId, audioBuffer }) {
  if (!(audioBuffer instanceof ArrayBuffer) || audioBuffer.byteLength === 0) {
    throw new Error("O áudio preparado para o Whisper está vazio.");
  }

  const audio = new Float32Array(audioBuffer);
  const transcriber = await getTranscriber(requestId);

  send("HS_WHISPER_PROGRESS", {
    requestId,
    message: `Transcrevendo com Whisper Base (${activeDevice || "local"})…`,
    model: MODEL_ID,
  });

  const result = await transcriber(audio, {
    language: "portuguese",
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
    do_sample: false,
    repetition_penalty: 1.12,
    no_repeat_ngram_size: 4,
    renormalize_logits: true,
  });

  const cleaned = cleanTranscript(result?.text || "");
  if (!cleaned.text) {
    throw new Error("O Whisper não identificou fala neste áudio.");
  }

  send("HS_WHISPER_RESULT", {
    requestId,
    text: cleaned.text,
    device: activeDevice || "local",
    model: MODEL_ID,
    antiRepeatAdjustments: cleaned.adjustments,
  });
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "HS_WHISPER_TRANSCRIBE") return;

  queue = queue
    .then(() => transcribe(data))
    .catch((error) => {
      console.error("[HubSpot Sinalizador] Falha no Whisper Base local:", error);
      send("HS_WHISPER_ERROR", {
        requestId: data.requestId,
        error: error?.message || "Não foi possível executar o Whisper Base local.",
        model: MODEL_ID,
      });
    });
});

send("HS_WHISPER_SANDBOX_READY", {
  version: "3.0.6",
  cacheStorage: CACHE_STORAGE_AVAILABLE,
  model: MODEL_ID,
  webgpu: !!navigator.gpu,
  wasm: typeof WebAssembly === "object",
});

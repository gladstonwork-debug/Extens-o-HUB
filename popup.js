"use strict";

const SETTINGS_KEY = "hs-sinalizador-settings-v1";
const DEFAULT_SETTINGS = {
  ticketColors: true,
  firstResponseAlert: true,
  assignmentToast: true,
  audioSpeed: true,
  transcription: true,
  historicalSummary: true,
  toastDurationSec: 10,
  audioPreferredSpeed: null,
};

const TOGGLE_KEYS = [
  "ticketColors",
  "firstResponseAlert",
  "assignmentToast",
  "audioSpeed",
  "transcription",
  "historicalSummary",
];

let currentSettings = { ...DEFAULT_SETTINGS };
let lastDiagnostic = null;
let diagnosticTimer = null;

function $(id) { return document.getElementById(id); }

function sanitize(raw) {
  const next = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return next;
  for (const key of TOGGLE_KEYS) {
    if (typeof raw[key] === "boolean") next[key] = raw[key];
  }
  const duration = Number(raw.toastDurationSec);
  if (Number.isFinite(duration)) next.toastDurationSec = Math.max(3, Math.min(30, Math.round(duration)));
  const speed = Number(raw.audioPreferredSpeed);
  next.audioPreferredSpeed = [1, 1.5, 2].includes(speed) ? speed : null;
  return next;
}

function renderSettings() {
  for (const key of TOGGLE_KEYS) $(key).checked = !!currentSettings[key];
  $("toastDurationSec").value = String(currentSettings.toastDurationSec || 10);
  $("audioPreferredSpeed").value = currentSettings.audioPreferredSpeed == null ? "" : String(currentSettings.audioPreferredSpeed);
}

function flashSaved(text = "Configurações salvas localmente neste Chrome.") {
  $("saveStatus").textContent = text;
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => {
    $("saveStatus").textContent = "Configurações salvas localmente neste Chrome.";
  }, 1800);
}

function saveSettings() {
  chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings }, () => flashSaved());
}

function bindSettings() {
  for (const key of TOGGLE_KEYS) {
    $(key).addEventListener("change", () => {
      currentSettings[key] = $(key).checked;
      saveSettings();
    });
  }

  $("toastDurationSec").addEventListener("change", () => {
    currentSettings.toastDurationSec = Number($("toastDurationSec").value) || 10;
    saveSettings();
  });

  $("audioPreferredSpeed").addEventListener("change", () => {
    const value = Number($("audioPreferredSpeed").value);
    currentSettings.audioPreferredSpeed = [1, 1.5, 2].includes(value) ? value : null;
    saveSettings();
  });

  $("resetSettings").addEventListener("click", () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    renderSettings();
    saveSettings();
    flashSaved("Configurações padrão restauradas.");
  });
}

function yesNo(value, on = "✅ Sim", off = "❌ Não") {
  return value ? on : off;
}

function formatTime(timestamp) {
  if (!timestamp) return "—";
  try {
    return new Date(timestamp).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch (_) {
    return "—";
  }
}

function setHealth(kind, text) {
  const badge = $("healthBadge");
  badge.className = `health health-${kind}`;
  badge.textContent = text;
}

function renderDiagnostic(diag) {
  lastDiagnostic = diag || null;
  if (!diag) {
    setHealth("warn", "Abra o Help Desk");
    $("diagHubspot").textContent = "❌ Aba não encontrada";
    for (const id of ["diagHelpdesk","diagDark","diagTickets","diagAssigned","diagQueue","diagAudio","diagSpeed","diagHistory","diagWebgpu","diagWasm","diagWhisper","diagModel","diagStatus"]) {
      $(id).textContent = "—";
    }
    $("diagError").textContent = "O diagnóstico funciona em uma aba do HubSpot Help Desk.";
    return;
  }

  $("diagHubspot").textContent = yesNo(diag.hubspotDetected);
  $("diagHelpdesk").textContent = yesNo(diag.helpDeskDetected);
  $("diagDark").textContent = diag.darkReader ? "✅ Ativo" : "⚪ Inativo";
  $("diagTickets").textContent = String(diag.ticketsFound ?? 0);
  $("diagAssigned").textContent = diag.assignedCount == null ? "—" : String(diag.assignedCount);
  $("diagQueue").textContent = formatTime(diag.lastQueueReadAt);
  $("diagAudio").textContent = String(diag.audioPlayersFound ?? 0);
  $("diagSpeed").textContent = diag.settings?.audioSpeed === false ? "⚪ Desativado" : `${diag.speedControlsFound ?? 0} controle(s)`;
  $("diagHistory").textContent = diag.settings?.historicalSummary === false
    ? "⚪ Desativado"
    : diag.historicalSummaryVisible
      ? "✅ Exibido"
      : diag.historicalSummaryFound && !diag.historicalSummaryAnchorFound
        ? "⚠️ Âncora não encontrada"
        : "⚪ Sem histórico";
  $("diagWebgpu").textContent = yesNo(diag.webgpuAvailable, "✅ Disponível", "⚠️ Indisponível");
  $("diagWasm").textContent = yesNo(diag.wasmAvailable, "✅ Disponível", "❌ Indisponível");
  $("diagWhisper").textContent = diag.settings?.transcription === false ? "⚪ Desativado" : String(diag.whisperState || "não carregado");
  $("diagModel").textContent = diag.whisperModel || "onnx-community/whisper-base";
  $("diagStatus").textContent = diag.whisperLastStatus || "—";
  $("diagError").textContent = diag.whisperLastError || "Nenhum";

  if (!diag.hubspotDetected || !diag.helpDeskDetected) {
    setHealth("error", "Help Desk não detectado");
  } else if (diag.settings?.transcription !== false && diag.whisperLastError) {
    setHealth("warn", "Funcionando parcialmente");
  } else {
    setHealth("ok", "Funcionando normalmente");
  }
}

function requestDiagnostic() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs?.[0]?.id;
    if (tabId == null) {
      renderDiagnostic(null);
      return;
    }
    chrome.tabs.sendMessage(tabId, { type: "HS_SIGNAL_GET_DIAGNOSTICS" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        renderDiagnostic(null);
        return;
      }
      renderDiagnostic(response);
    });
  });
}

function diagnosticText() {
  const d = lastDiagnostic;
  if (!d) return "HubSpot Sinalizador 3.0.12\nDiagnóstico indisponível na aba atual.";
  return [
    `HubSpot Sinalizador ${d.version || "3.0.12"}`,
    `HubSpot: ${d.hubspotDetected ? "OK" : "não detectado"}`,
    `Help Desk: ${d.helpDeskDetected ? "OK" : "não detectado"}`,
    `Dark Reader: ${d.darkReader ? "ativo" : "inativo"}`,
    `Tickets visíveis: ${d.ticketsFound ?? 0}`,
    `Atribuído a mim: ${d.assignedCount ?? "—"}`,
    `Última leitura: ${formatTime(d.lastQueueReadAt)}`,
    `Players de áudio: ${d.audioPlayersFound ?? 0}`,
    `Controle de velocidade: ${d.settings?.audioSpeed === false ? "desativado" : "ativo"}`,
    `Transcrição: ${d.settings?.transcription === false ? "desativada" : "ativa"}`,
    `Resumo histórico IA: ${d.settings?.historicalSummary === false ? "desativado" : d.historicalSummaryVisible ? "exibido" : d.historicalSummaryFound ? "encontrado, aguardando âncora" : "sem histórico"}`,
    `WebGPU: ${d.webgpuAvailable ? "disponível" : "indisponível"}`,
    `WASM: ${d.wasmAvailable ? "disponível" : "indisponível"}`,
    `Whisper: ${d.whisperState || "não carregado"}`,
    `Modelo: ${d.whisperModel || "onnx-community/whisper-base"}`,
    `Dispositivo: ${d.whisperDevice || "—"}`,
    `Último status: ${d.whisperLastStatus || "—"}`,
    `Ajustes anti-repetição: ${d.antiRepeatAdjustments || 0}`,
    `Último erro: ${d.whisperLastError || "nenhum"}`,
  ].join("\n");
}

function init() {
  const manifest = chrome.runtime.getManifest();
  $("versionLabel").textContent = `Versão ${manifest.version}`;

  chrome.storage.local.get(SETTINGS_KEY, (result) => {
    currentSettings = sanitize(result?.[SETTINGS_KEY]);
    renderSettings();
  });

  bindSettings();

  $("copyDiagnostic").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(diagnosticText());
      $("copyDiagnostic").textContent = "Copiado ✓";
    } catch (_) {
      $("copyDiagnostic").textContent = "Falhou";
    }
    setTimeout(() => { $("copyDiagnostic").textContent = "Copiar"; }, 1300);
  });

  requestDiagnostic();
  diagnosticTimer = setInterval(requestDiagnostic, 1500);
}

document.addEventListener("DOMContentLoaded", init);
window.addEventListener("unload", () => clearInterval(diagnosticTimer));

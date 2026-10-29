"use strict";

const ALLOWED_HOSTS = [
  "api-na1.hubspot.com",
  "api-eu1.hubspot.com",
];

function isAllowedAudioUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    if (ALLOWED_HOSTS.includes(url.hostname)) return true;
    return (
      url.hostname.endsWith(".hubspotusercontent-na1.net") ||
      url.hostname.endsWith(".hubspotusercontent-eu1.net")
    );
  } catch (_) {
    return false;
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "HS_SIGNAL_FETCH_AUDIO_FOR_TRANSCRIPTION") return;

  (async () => {
    if (!isAllowedAudioUrl(message.url)) {
      throw new Error("URL de áudio fora dos domínios autorizados do HubSpot.");
    }

    const response = await fetch(message.url, {
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(`HubSpot retornou HTTP ${response.status} ao buscar o áudio.`);
    }

    const buffer = await response.arrayBuffer();
    const mime = response.headers.get("content-type") || "audio/mp4";

    // Limite defensivo de 24 MB para esta versão de teste.
    if (buffer.byteLength > 24 * 1024 * 1024) {
      throw new Error("Este áudio excede 24 MB e não será processado nesta versão de teste.");
    }

    sendResponse({
      ok: true,
      mime,
      base64: arrayBufferToBase64(buffer),
      size: buffer.byteLength,
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error?.message || "Falha ao obter o áudio do HubSpot.",
    });
  });

  return true;
});

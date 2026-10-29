/* ========================================================================
   HubSpot Sinalizador 3.0.11 TESTE — núcleo de configurações e diagnóstico
   ======================================================================== */
(function () {
  "use strict";

  const VERSION = "3.0.13";
  const SETTINGS_KEY = "hs-sinalizador-settings-v1";
  const DEFAULT_SETTINGS = Object.freeze({
    ticketColors: true,
    firstResponseAlert: true,
    assignmentToast: true,
    audioSpeed: true,
    transcription: true,
    historicalSummary: true,
    toastDurationSec: 10,
    audioPreferredSpeed: null,
  });

  const listeners = new Set();
  const diagnostics = {
    version: VERSION,
    hubspotDetected: /app\.hubspot\.com$/i.test(location.hostname),
    helpDeskDetected: location.pathname.includes("/help-desk/"),
    darkReader: document.documentElement.getAttribute("data-darkreader-scheme") === "dark",
    ticketsFound: 0,
    assignedCount: null,
    currentView: "other",
    lastQueueReadAt: 0,
    mainObserverActive: false,
    audioPlayersFound: 0,
    speedControlsFound: 0,
    audioSpeedEnabled: true,
    transcriptionEnabled: true,
    historicalSummaryEnabled: true,
    historicalSummaryFound: false,
    historicalSummaryAnchorFound: false,
    historicalSummaryVisible: false,
    historicalSummaryLastSyncAt: 0,
    webgpuAvailable: !!navigator.gpu,
    wasmAvailable: typeof WebAssembly === "object",
    whisperState: "não carregado",
    whisperModel: "onnx-community/whisper-base",
    whisperDevice: "",
    whisperCacheStorage: null,
    whisperLastStatus: "",
    whisperLastError: "",
    whisperLastSuccessAt: 0,
    antiRepeatAdjustments: 0,
    lastUpdatedAt: Date.now(),
  };

  let settings = { ...DEFAULT_SETTINGS };

  function sanitize(raw) {
    const next = { ...DEFAULT_SETTINGS };
    if (!raw || typeof raw !== "object") return next;
    for (const key of ["ticketColors", "firstResponseAlert", "assignmentToast", "audioSpeed", "transcription", "historicalSummary"]) {
      if (typeof raw[key] === "boolean") next[key] = raw[key];
    }
    const duration = Number(raw.toastDurationSec);
    if (Number.isFinite(duration)) next.toastDurationSec = Math.max(3, Math.min(30, Math.round(duration)));
    const speed = Number(raw.audioPreferredSpeed);
    next.audioPreferredSpeed = [1, 1.5, 2].includes(speed) ? speed : null;
    return next;
  }

  function notify(previous) {
    const changed = Object.keys(DEFAULT_SETTINGS).filter((key) => previous[key] !== settings[key]);
    if (!changed.length) return;
    for (const fn of listeners) {
      try { fn({ ...settings }, { ...previous }, changed); } catch (_) {}
    }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(SETTINGS_KEY, (result) => {
        const previous = { ...settings };
        settings = sanitize(result?.[SETTINGS_KEY]);
        diagnostics.audioSpeedEnabled = settings.audioSpeed;
        diagnostics.transcriptionEnabled = settings.transcription;
        diagnostics.historicalSummaryEnabled = settings.historicalSummary;
        notify(previous);
      });
    } catch (_) {}
  }

  function updateDiagnostic(patch) {
    if (!patch || typeof patch !== "object") return;
    Object.assign(diagnostics, patch, { lastUpdatedAt: Date.now() });
  }

  function getDiagnosticSnapshot() {
    return {
      ...diagnostics,
      settings: { ...settings },
    };
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    const previous = { ...settings };
    settings = sanitize(changes[SETTINGS_KEY].newValue);
    diagnostics.audioSpeedEnabled = settings.audioSpeed;
    diagnostics.transcriptionEnabled = settings.transcription;
    diagnostics.historicalSummaryEnabled = settings.historicalSummary;
    notify(previous);
  });

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === "HS_SIGNAL_GET_DIAGNOSTICS") {
      sendResponse(getDiagnosticSnapshot());
      return;
    }
    if (message?.type === "HS_SIGNAL_GET_SETTINGS") {
      sendResponse({ settings: { ...settings } });
    }
  });

  globalThis.__HS_SIGNALIZER__ = {
    VERSION,
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    getSetting(key, fallback) {
      return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
    },
    isEnabled(key) {
      return settings[key] !== false;
    },
    onSettingsChange(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    updateDiagnostic,
    getDiagnosticSnapshot,
  };

  loadSettings();
})();

(function () {
  "use strict";
  const EXT = globalThis.__HS_SIGNALIZER__;

  /* ================================================================
     HubSpot Help Desk — Sinalizador 2.6.6.4 DARK TEST — base funcional 2.6.6 + visual Dark Reader

     Regras principais:
     - Em conversas normais, a ÚLTIMA interação define a cor:
       cliente = vermelho fixo / técnico = azul fixo.
     - Observação interna = laranja persistente até uma resposta real do técnico.
     - 24h+ = roxo fixo e prioritário.
     - Sirene vermelha SOMENTE para primeira resposta pendente:
       • todos os tickets visíveis em "Não atribuído";
       • em "Atribuído a mim", o aumento real do contador comprova uma
         nova entrada; o card associado continua piscando até a primeira
         resposta real do técnico.
     - Depois da primeira resposta, nunca volta a piscar apenas porque o
       cliente enviou outra mensagem: fica vermelho fixo.
     ================================================================ */

  // ^= também encontra o card selecionado, pois o HubSpot pode trocar o
  // valor para algo como "thread-list-member-row-selected".
  const ROW_SELECTOR = '[data-test-id^="thread-list-member-row"]';
  const HEADER_SELECTOR = '[data-test-id="member-header"]';
  const REPLY_ICON_SELECTOR = 'svg[data-icon-name="Reply"]';
  const NO_CONVERSATION_TEXT = "nenhuma conversa iniciada";

  const UNASSIGNED_VIEW_ID = "373875548";
  const ASSIGNED_TO_ME_VIEW_ID = "109251880";

  const CLASS_CLIENT_WAITING = "hs-unread-client";
  const CLASS_AGENT_REPLIED = "hs-unread-agent";
  const CLASS_OLD_TICKET = "hs-old-ticket";
  const CLASS_NOTE = "hs-unread-note";
  const CLASS_FIRST_RESPONSE_ALERT = "hs-first-response-alert";

  const BASE_CLASSES = [
    CLASS_CLIENT_WAITING,
    CLASS_AGENT_REPLIED,
    CLASS_OLD_TICKET,
    CLASS_NOTE,
  ];

  const ALL_CLASSES = BASE_CLASSES.concat(CLASS_FIRST_RESPONSE_ALERT);

  // Nova chave de estado: propositalmente não migra a inferência da 2.5.0,
  // porque aquela versão podia considerar um atendimento antigo em vermelho
  // como se ainda aguardasse a PRIMEIRA resposta.
  const STORAGE_KEY = "hs-sinalizador-state-v10";
  const AGENT_CONFIRM_MS = 700;

  function loadState() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  let state = loadState();

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function normalizeText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function urlContainsViewId(viewId) {
    return [
      window.location.href,
      window.location.pathname,
      window.location.search,
      window.location.hash,
    ].some((value) => String(value || "").includes(viewId));
  }

  function activeNavigationContains(viewId, label) {
    const selectors = [
      '[aria-current="page"]',
      '[aria-current="true"]',
      '[data-active="true"]',
      '[data-selected="true"]',
      '[aria-selected="true"]',
      '.active',
      '.selected',
    ];

    const wanted = normalizeText(label);

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = normalizeText(element.textContent);
        const ownHref = element.getAttribute && element.getAttribute("href");
        const hrefs = [ownHref || ""]
          .concat(
            Array.from(element.querySelectorAll ? element.querySelectorAll("a[href]") : [])
              .map((a) => a.href || "")
          )
          .join(" ");

        if (hrefs.includes(viewId) || text === wanted || text.includes(wanted)) {
          return true;
        }
      }
    }

    return false;
  }

  function currentView() {
    if (urlContainsViewId(UNASSIGNED_VIEW_ID)) return "unassigned";
    if (urlContainsViewId(ASSIGNED_TO_ME_VIEW_ID)) return "assigned";

    if (activeNavigationContains(UNASSIGNED_VIEW_ID, "Não atribuído")) return "unassigned";
    if (activeNavigationContains(ASSIGNED_TO_ME_VIEW_ID, "Atribuído a mim")) return "assigned";

    return "other";
  }

  /* ------------------------ Identidade do ticket ------------------------ */

  function pushUnique(list, value) {
    if (value && !list.includes(value)) list.push(value);
  }

  function stableIdLooksUseful(value) {
    const text = String(value || "").trim();
    if (!text || text.length > 300) return false;
    if (/^(true|false|null|undefined)$/i.test(text)) return false;
    if (/thread-list-member-row|member-header|member-preview/i.test(text)) return false;
    return /\d{5,}|[a-f0-9]{8}-[a-f0-9-]{20,}/i.test(text);
  }

  function getRowKeyCandidates(row) {
    const candidates = [];
    const exactAttrs = [
      "data-ticket-id",
      "data-thread-id",
      "data-conversation-id",
      "data-record-id",
      "data-object-id",
      "data-id",
    ];

    const nodes = [row].concat(Array.from(row.querySelectorAll("*")));

    // 1) IDs explícitos no card/filhos.
    for (const node of nodes) {
      if (!node.getAttribute) continue;
      for (const attr of exactAttrs) {
        const value = node.getAttribute(attr);
        if (stableIdLooksUseful(value)) pushUnique(candidates, attr + ":" + value);
      }
    }

    // 2) Outros data-* com aparência de identificador real.
    for (const node of nodes) {
      if (!node.getAttributeNames) continue;
      for (const attr of node.getAttributeNames()) {
        if (!/^data-/i.test(attr)) continue;
        if (/^data-test-?id$/i.test(attr) || /^data-testid$/i.test(attr)) continue;
        if (!/(ticket|thread|conversation|record|object|inbox|message).*(id|key)|(^|-)id$/i.test(attr)) continue;
        const value = node.getAttribute(attr);
        if (stableIdLooksUseful(value)) pushUnique(candidates, attr + ":" + value);
      }
    }

    // 3) IDs presentes nos links.
    for (const link of row.querySelectorAll("a[href]")) {
      const href = link.href || link.getAttribute("href") || "";
      if (!href) continue;

      try {
        const url = new URL(href, window.location.origin);
        const params = [
          "ticketId", "ticket_id",
          "threadId", "thread_id",
          "conversationId", "conversation_id",
          "recordId", "record_id",
          "objectId", "object_id",
        ];

        for (const param of params) {
          const value = url.searchParams.get(param);
          if (stableIdLooksUseful(value)) {
            pushUnique(candidates, "url-param:" + param + ":" + value);
          }
        }

        const pathPatterns = [
          /\/(?:ticket|tickets)\/(\d{5,})/i,
          /\/(?:thread|threads)\/(\d{5,})/i,
          /\/(?:conversation|conversations)\/(\d{5,})/i,
          /\/(?:record|records)\/(\d{5,})/i,
        ];

        for (const pattern of pathPatterns) {
          const match = url.pathname.match(pattern);
          if (match) pushUnique(candidates, "url-path:" + match[1]);
        }

        const numbers = (url.pathname + " " + url.search + " " + url.hash).match(/\d{8,}/g) || [];
        for (let i = numbers.length - 1; i >= 0; i--) {
          const value = numbers[i];
          if (value === UNASSIGNED_VIEW_ID || value === ASSIGNED_TO_ME_VIEW_ID) continue;
          pushUnique(candidates, "url-number:" + value);
        }
      } catch (_) {}
    }

    // 4) Fallback visual estável: tenta usar cabeçalho/identidade sem horário,
    // preview ou ícones, para não mudar a chave a cada mensagem.
    try {
      const clone = row.cloneNode(true);
      const header = clone.querySelector(HEADER_SELECTOR);
      if (header && header.lastElementChild) header.lastElementChild.remove();
      clone.querySelectorAll('[data-testid="unread-indicator"], svg').forEach((el) => el.remove());

      // O preview costuma ser a última linha do card. Quando houver seletor
      // próprio, removemos para a identidade não acompanhar o texto da mensagem.
      clone.querySelectorAll('[data-test-id="member-preview"]').forEach((el) => el.remove());

      const identityText = normalizeText(clone.textContent).slice(0, 260);
      if (identityText) pushUnique(candidates, "identity:" + identityText);
    } catch (_) {}

    return candidates;
  }

  /* ---------------------------- Tempo / 24h ---------------------------- */

  const OLD_PATTERNS = [
    /^(?:2[4-9]|[3-9]\d|\d{3,})\s*h$/i,
    /^\d{1,3}\s*d$/i,
    /^\d{1,3}\s*dias?$/i,
    /^\d{1,2}\s*(de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\.?$/i,
    /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/,
    /^ontem$/i,
  ];

  const RECENT_PATTERNS = [
    /^agora( mesmo)?$/i,
    /^\d+\s*s$/i,
    /^\d+\s*(min|m)$/i,
    /^(?:[0-9]|1\d|2[0-3])\s*h$/i,
    /^\d{1,2}:\d{2}$/,
    /^hoje/i,
  ];

  function isOldTimestamp(text) {
    const value = String(text || "").trim();
    return OLD_PATTERNS.some((re) => re.test(value));
  }

  function looksLikeTimestamp(text) {
    const value = String(text || "").trim();
    return isOldTimestamp(value) || RECENT_PATTERNS.some((re) => re.test(value));
  }

  function findAgeBadgeText(row) {
    // Primeiro tenta o cabeçalho conhecido.
    const header = row.querySelector(HEADER_SELECTOR);
    if (header && header.lastElementChild) {
      const headerText = (header.lastElementChild.textContent || "").trim();
      if (looksLikeTimestamp(headerText)) return headerText;
    }

    // Fallback resiliente: procura um elemento-folha com formato de tempo.
    for (const el of row.querySelectorAll("*")) {
      if (el.children.length > 0) continue;
      const text = (el.textContent || "").trim();
      if (!text || text.length > 20) continue;
      if (looksLikeTimestamp(text)) return text;
    }

    return null;
  }

  /* ---------------------- Remetente / observação ---------------------- */

  function hasNoConversationYet(row) {
    return normalizeText(row.textContent).includes(NO_CONVERSATION_TEXT);
  }

  function lastMessageIsFromAgent(row) {
    // IMPORTANTE: observação interna NÃO conta como primeira resposta ao cliente.
    return !!row.querySelector(REPLY_ICON_SELECTOR);
  }

  function isNoteHighlightColor(rgbString) {
    const m = rgbString && rgbString.match(
      /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
    );
    if (!m) return false;

    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a === 0 || (r === g && g === b)) return false;

    const rN = r / 255;
    const gN = g / 255;
    const bN = b / 255;
    const max = Math.max(rN, gN, bN);
    const min = Math.min(rN, gN, bN);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return false;

    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === rN) h = (gN - bN) / d + (gN < bN ? 6 : 0);
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h *= 60;

    // Compatibilidade exclusiva com Dark Reader: ele preserva a matiz
    // amarela/laranja da observação, mas reduz a luminosidade calculada.
    // Esta adaptação NÃO altera a lógica do contador/toast da 2.6.6.
    const darkReaderActive =
      document.documentElement.getAttribute("data-darkreader-scheme") === "dark";

    if (darkReaderActive) {
      return h >= 18 && h <= 60 && s >= 0.18 && l >= 0.12 && l <= 0.82;
    }

    return h >= 20 && h <= 55 && s >= 0.2 && l >= 0.6 && l <= 0.97;
  }

  function hasInternalNotePreview(row) {
    const rowRect = row.getBoundingClientRect();
    if (!rowRect.height || !rowRect.width) return false;

    // O HubSpot nem sempre aplica o amarelo/laranja diretamente no nó de texto.
    // Em alguns layouts (ex.: menção/observação), a cor fica no container da
    // faixa inteira. Por isso inspecionamos também containers, e não só folhas.
    // Limitamos a busca à metade inferior do card para evitar confundir selos
    // coloridos próximos ao título com uma observação interna.
    for (const el of row.querySelectorAll("*")) {
      const text = (el.textContent || "").trim();
      if (text.length < 2) continue;

      const bg = window.getComputedStyle(el).backgroundColor;
      if (!isNoteHighlightColor(bg)) continue;

      const elRect = el.getBoundingClientRect();
      if (!elRect.height || !elRect.width) continue;

      const relativeTop = elRect.top - rowRect.top;
      const relativeBottom = elRect.bottom - rowRect.top;
      const isInContentArea =
        relativeTop >= rowRect.height * 0.28 ||
        relativeBottom >= rowRect.height * 0.62;

      // Uma faixa de observação costuma ocupar uma porção relevante do card.
      // Também aceitamos elementos menores quando estão dentro do member-preview,
      // porque alguns layouts aplicam o fundo somente em um wrapper interno.
      const hasUsefulWidth = elRect.width >= rowRect.width * 0.28;
      const isInsidePreview = !!el.closest('[data-test-id="member-preview"]');

      if (isInContentArea && (hasUsefulWidth || isInsidePreview)) return true;
    }

    return false;
  }

  /* ---------------------------- Aparência ---------------------------- */

  function clearSignalClasses(row) {
    row.classList.remove(...ALL_CLASSES);
    try {
      delete row.dataset.hsSignalState;
      delete row.dataset.hsFirstResponsePending;
    } catch (_) {}
  }

  function applyVisualState(row, baseClass, firstResponsePending) {
    const showBase = EXT.isEnabled("ticketColors");
    const wantsAlert =
      EXT.isEnabled("firstResponseAlert") &&
      firstResponsePending &&
      baseClass !== CLASS_OLD_TICKET;

    // A lógica do ticket continua rodando mesmo quando o usuário desliga um
    // módulo visual. Assim, reativar o recurso restaura imediatamente o estado
    // correto sem reiniciar o ciclo de primeira resposta.
    for (const className of BASE_CLASSES) {
      row.classList.toggle(className, showBase && className === baseClass);
    }
    row.classList.toggle(CLASS_FIRST_RESPONSE_ALERT, wantsAlert);
  }

  function chooseNormalBaseClass(row, isOld, hasNote, fromAgent) {
    if (isOld) return CLASS_OLD_TICKET;
    if (hasNote) return CLASS_NOTE;
    if (hasNoConversationYet(row)) return null;
    return fromAgent ? CLASS_AGENT_REPLIED : CLASS_CLIENT_WAITING;
  }

  /* ----------------------- Estado de primeira resposta ----------------------- */

  function createTicketState(view, fromAgent, noConversation) {
    // Um ticket observado em "Não atribuído" abre o ciclo imediatamente.
    // Em "Atribuído a mim", um novo ciclo também pode ser aberto depois
    // quando o contador comprovar que houve uma nova entrada e o card for
    // associado a esse aumento.
    const pendingFirstResponse = view === "unassigned";

    return {
      pendingFirstResponse,
      seenInUnassigned: view === "unassigned",
      lastSeenUnassignedAt: view === "unassigned" ? Date.now() : 0,
      assignedNotificationSent: false,
      assignedToastSent: false,
      assignedByCounter: false,
      agentReplyCandidateAt: 0,
      notePending: false,
      noteDetectedAt: 0,
      lastView: view,
      updatedAt: Date.now(),
    };
  }

  function ensureTicketShape(ticket) {
    let changed = false;
    const defaults = {
      pendingFirstResponse: false,
      seenInUnassigned: false,
      lastSeenUnassignedAt: 0,
      assignedNotificationSent: false,
      assignedToastSent: false,
      assignedByCounter: false,
      agentReplyCandidateAt: 0,
      notePending: false,
      noteDetectedAt: 0,
      lastView: "other",
      updatedAt: Date.now(),
    };

    for (const [key, value] of Object.entries(defaults)) {
      if (typeof ticket[key] === "undefined") {
        ticket[key] = value;
        changed = true;
      }
    }

    return changed;
  }

  function getTicketNotificationText(row) {
    const lines = String(row.innerText || row.textContent || "")
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .filter((line) => !looksLikeTimestamp(line));

    const useful = [];
    for (const line of lines) {
      if (/^selecionar/i.test(line)) continue;
      if (!useful.includes(line)) useful.push(line);
      if (useful.length >= 2) break;
    }

    return useful.join(" — ").slice(0, 180) || "Novo atendimento";
  }

  /* ------------------------- Toast interno ------------------------- */

  const toastRecentKeys = new Map();

  // O contador da pasta "Atribuído a mim" é o gatilho principal desta versão.
  // Não usamos a classe visual gerada pelo HubSpot, pois ela pode mudar.
  const ASSIGNED_VIEW_LINK_SELECTOR =
    'a[data-test-id="Atribuído a mim"][href*="/view/' + ASSIGNED_TO_ME_VIEW_ID + '"]';
  const ASSIGNMENT_RUNTIME_KEY = "hs-sinalizador-assignment-counter-v1";
  const UNMATCHED_ASSIGNMENT_TTL_MS = 15 * 60 * 1000;

  function loadAssignmentRuntime() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(ASSIGNMENT_RUNTIME_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  const assignmentRuntime = loadAssignmentRuntime();
  let lastAssignedCount = Number.isFinite(assignmentRuntime.lastAssignedCount)
    ? assignmentRuntime.lastAssignedCount
    : null;
  let pendingUnmatchedAssignments = Number.isFinite(assignmentRuntime.pendingUnmatchedAssignments)
    ? Math.max(0, assignmentRuntime.pendingUnmatchedAssignments)
    : 0;
  let pendingUnmatchedAt = Number.isFinite(assignmentRuntime.pendingUnmatchedAt)
    ? assignmentRuntime.pendingUnmatchedAt
    : 0;
  const knownAssignedKeys = new Set(
    Array.isArray(assignmentRuntime.knownAssignedKeys)
      ? assignmentRuntime.knownAssignedKeys.slice(0, 500)
      : []
  );

  function saveAssignmentRuntime() {
    try {
      sessionStorage.setItem(
        ASSIGNMENT_RUNTIME_KEY,
        JSON.stringify({
          lastAssignedCount,
          pendingUnmatchedAssignments,
          pendingUnmatchedAt,
          knownAssignedKeys: Array.from(knownAssignedKeys).slice(-500),
        })
      );
    } catch (_) {}
  }

  function extractTicketNumber(text) {
    const matches = String(text || "").match(/\d{8,}/g) || [];
    return matches.length ? matches[matches.length - 1] : "";
  }

  function toastDedupKey(key, text) {
    const ticketNumber = extractTicketNumber(text);
    return ticketNumber ? "ticket:" + ticketNumber : "key:" + String(key || text || "unknown");
  }

  function canShowToast(key, text) {
    const dedup = toastDedupKey(key, text);
    const now = Date.now();
    const previous = toastRecentKeys.get(dedup) || 0;
    if (now - previous < 30000) return false;
    toastRecentKeys.set(dedup, now);

    // Limpeza simples para a estrutura não crescer indefinidamente.
    for (const [savedKey, savedAt] of toastRecentKeys.entries()) {
      if (now - savedAt > 5 * 60 * 1000) toastRecentKeys.delete(savedKey);
    }

    return true;
  }

  function ensureToastRoot() {
    let root = document.getElementById("hs-sinalizador-toast-root");
    if (root) return root;

    root = document.createElement("div");
    root.id = "hs-sinalizador-toast-root";
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-relevant", "additions");
    document.body.appendChild(root);
    return root;
  }

  function showAssignedToast(text, key, row, options) {
    if (!EXT.isEnabled("assignmentToast")) return;
    if (!canShowToast(key, text)) return;

    const root = ensureToastRoot();
    const toast = document.createElement("div");
    toast.className = "hs-sinalizador-toast hs-sinalizador-toast-assigned";
    toast.setAttribute("role", "status");

    const icon = document.createElement("div");
    icon.className = "hs-sinalizador-toast-icon";
    icon.textContent = "!";

    const content = document.createElement("div");
    content.className = "hs-sinalizador-toast-content";

    const settings = options && typeof options === "object" ? options : {};

    const eyebrow = document.createElement("div");
    eyebrow.className = "hs-sinalizador-toast-eyebrow";
    eyebrow.textContent = settings.eyebrow || "NOVO ATENDIMENTO";

    const title = document.createElement("div");
    title.className = "hs-sinalizador-toast-title";
    title.textContent = settings.title || "Atendimento atribuído a você";

    const body = document.createElement("div");
    body.className = "hs-sinalizador-toast-body";
    body.textContent = String(text || "Novo atendimento").slice(0, 220);

    const hint = document.createElement("div");
    hint.className = "hs-sinalizador-toast-hint";
    hint.textContent = settings.hint || "Aguardando sua primeira resposta";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "hs-sinalizador-toast-close";
    close.setAttribute("aria-label", "Fechar aviso");
    close.textContent = "×";

    const progress = document.createElement("div");
    progress.className = "hs-sinalizador-toast-progress";

    content.append(eyebrow, title, body, hint);
    toast.append(icon, content, close, progress);

    const removeToast = () => {
      if (toast.dataset.closing === "true") return;
      toast.dataset.closing = "true";
      toast.classList.add("hs-sinalizador-toast-leave");
      window.setTimeout(() => toast.remove(), 240);
    };

    close.addEventListener("click", (event) => {
      event.stopPropagation();
      removeToast();
    });

    // Se o card ainda estiver renderizado, clicar no aviso leva o técnico até ele.
    toast.addEventListener("click", () => {
      if (!row || !row.isConnected) return;
      try {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
        row.classList.add("hs-toast-focus-pulse");
        window.setTimeout(() => row.classList.remove("hs-toast-focus-pulse"), 1500);
      } catch (_) {}
    });

    root.prepend(toast);

    const durationMs = Math.max(3000, Math.min(30000, Number(EXT.getSetting("toastDurationSec", 10)) * 1000 || 10000));
    progress.style.animationDuration = durationMs + "ms";

    // Mantém no máximo 3 avisos empilhados.
    const currentToasts = Array.from(root.querySelectorAll(".hs-sinalizador-toast"));
    currentToasts.slice(3).forEach((oldToast) => oldToast.remove());

    window.setTimeout(removeToast, durationMs);
  }

  function readAssignedCount() {
    const link = document.querySelector(ASSIGNED_VIEW_LINK_SELECTOR);
    if (!link) return null;

    // O HTML fornecido expõe o contador em um span data-test-vr-hidden=true.
    // Procuramos apenas spans numéricos dentro do link para não depender
    // das classes dinâmicas do HubSpot.
    const spans = Array.from(link.querySelectorAll('span[data-test-vr-hidden="true"]'));
    for (let i = spans.length - 1; i >= 0; i--) {
      const text = String(spans[i].textContent || "").trim();
      if (/^\d+$/.test(text)) return Number(text);
    }

    // Fallback: extrai o último número do texto acessível do próprio item.
    const text = String(link.textContent || "").replace(/\s+/g, " ").trim();
    const matches = text.match(/\d+/g);
    if (!matches || !matches.length) return null;
    return Number(matches[matches.length - 1]);
  }

  function showAssignedCounterToast(previousCount, currentCount) {
    const delta = currentCount - previousCount;
    if (delta <= 0) return;

    const singular = delta === 1;
    const body = singular
      ? '1 novo atendimento entrou em “Atribuído a mim”.'
      : delta + ' novos atendimentos entraram em “Atribuído a mim”.';

    showAssignedToast(
      body,
      'assigned-count:' + previousCount + '->' + currentCount + ':' + Date.now(),
      null,
      {
        eyebrow: singular ? 'NOVO ATENDIMENTO' : 'NOVOS ATENDIMENTOS',
        title: singular
          ? 'Atendimento atribuído a você'
          : delta + ' atendimentos atribuídos a você',
        hint: singular
          ? 'Aguardando sua primeira resposta'
          : 'Revise os novos atendimentos na sua fila',
      }
    );
  }

  function trackAssignedCount() {
    const current = readAssignedCount();
    if (current == null || !Number.isFinite(current)) return;

    // Primeira leitura: cria apenas a referência. Não gera notificação para
    // os atendimentos que já estavam na pasta antes da extensão observar.
    if (lastAssignedCount == null) {
      lastAssignedCount = current;
      saveAssignmentRuntime();
      return;
    }

    if (current > lastAssignedCount) {
      const delta = current - lastAssignedCount;
      pendingUnmatchedAssignments += delta;
      pendingUnmatchedAt = Date.now();
      showAssignedCounterToast(lastAssignedCount, current);
    }

    // Queda de contador nunca gera toast. Apenas atualiza a nova referência.
    lastAssignedCount = current;

    // Um aumento antigo que nunca pôde ser associado a um card expira para
    // evitar que, muito tempo depois, um card qualquer seja marcado como novo.
    if (
      pendingUnmatchedAssignments > 0 &&
      pendingUnmatchedAt > 0 &&
      Date.now() - pendingUnmatchedAt > UNMATCHED_ASSIGNMENT_TTL_MS
    ) {
      pendingUnmatchedAssignments = 0;
      pendingUnmatchedAt = 0;
    }

    saveAssignmentRuntime();
  }

  function markTicketPendingFromCounter(key) {
    let ticket = state[key];
    if (!ticket || typeof ticket !== "object") {
      ticket = createTicketState("assigned", false, false);
      state[key] = ticket;
    } else {
      ensureTicketShape(ticket);
    }

    ticket.pendingFirstResponse = true;
    ticket.agentReplyCandidateAt = 0;
    ticket.assignedByCounter = true;
    ticket.updatedAt = Date.now();
    saveState();
  }

  function associatePendingAssignments(rows, rowKeys, view) {
    if (view !== "assigned" || pendingUnmatchedAssignments <= 0) return;

    if (
      pendingUnmatchedAt > 0 &&
      Date.now() - pendingUnmatchedAt > UNMATCHED_ASSIGNMENT_TTL_MS
    ) {
      pendingUnmatchedAssignments = 0;
      pendingUnmatchedAt = 0;
      saveAssignmentRuntime();
      return;
    }

    const candidates = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const key = rowKeys[i];
      if (!key || knownAssignedKeys.has(key)) continue;

      const fromAgent = lastMessageIsFromAgent(row);
      const isOld = isOldTimestamp(findAgeBadgeText(row));

      // O contador já comprovou que houve nova entrada. Aqui usamos o card
      // somente para associar essa entrada. Evitamos cards já respondidos ou
      // 24h+, e priorizamos a ordem visual da lista (normalmente mais recente).
      if (fromAgent || isOld) continue;
      candidates.push({ key, row, index: i });
    }

    const toAssociate = candidates.slice(0, pendingUnmatchedAssignments);
    for (const candidate of toAssociate) {
      markTicketPendingFromCounter(candidate.key);
      pendingUnmatchedAssignments = Math.max(0, pendingUnmatchedAssignments - 1);
    }

    if (pendingUnmatchedAssignments === 0) pendingUnmatchedAt = 0;
    saveAssignmentRuntime();
  }

  // Controla a troca de pasta em tempo de execução. O HubSpot é uma SPA e
  // recria os cards ao voltar para uma visualização. Sem esta referência,
  // cards antigos de "Atribuído a mim" podiam parecer recém-chegados e gerar
  // vários toasts falsos apenas ao sair e voltar para a pasta.
  let runtimeView = null;

  function updateRow(row, key, view, navigationContext) {
    const ageText = findAgeBadgeText(row);
    const isOld = !!ageText && isOldTimestamp(ageText);
    const fromAgent = lastMessageIsFromAgent(row);
    const noConversation = hasNoConversationYet(row);
    const hasNote = hasInternalNotePreview(row);

    let ticket = state[key];
    let changed = false;

    if (!ticket || typeof ticket !== "object") {
      ticket = createTicketState(view, fromAgent, noConversation);
      state[key] = ticket;
      changed = true;
    } else if (ensureTicketShape(ticket)) {
      changed = true;
    }

    const previousView = ticket.lastView;

    // Observação interna é um estado persistente: ao detectar a faixa de
    // observação do HubSpot, o card inteiro passa a laranja. Mesmo que depois
    // chegue uma nova mensagem do cliente e a prévia amarela deixe de aparecer,
    // mantemos o laranja até existir uma resposta REAL do técnico.
    if (hasNote) {
      if (!ticket.notePending) {
        ticket.notePending = true;
        ticket.noteDetectedAt = Date.now();
        changed = true;
      }
    } else if (ticket.notePending && fromAgent) {
      // O ícone Reply indica que a última mensagem real foi enviada pelo técnico.
      // Como a observação não conta como resposta, só encerramos o estado quando
      // a faixa de observação já não é a atividade atual e o Reply está presente.
      ticket.notePending = false;
      ticket.noteDetectedAt = 0;
      changed = true;
    }

    // Entrou/está em Não atribuído: todos os tickets visíveis recebem sirene.
    // Se o ticket voltou para essa fila, iniciamos um novo ciclo de atribuição.
    if (view === "unassigned") {
      if (!ticket.pendingFirstResponse) {
        ticket.pendingFirstResponse = true;
        changed = true;
      }
      if (!ticket.seenInUnassigned) {
        ticket.seenInUnassigned = true;
        changed = true;
      }
      ticket.lastSeenUnassignedAt = Date.now();
      changed = true;
      if (previousView !== "unassigned") {
        ticket.assignedNotificationSent = false;
        ticket.assignedToastSent = false;
        ticket.agentReplyCandidateAt = 0;
        changed = true;
      }
    }

    // Atribuído a mim: continua piscando quando o ciclo de primeira resposta
    // veio de "Não atribuído" ou foi associado a um aumento comprovado do
    // contador da própria pasta.
    if (view === "assigned" && ticket.pendingFirstResponse) {
      if (fromAgent) {
        const now = Date.now();

        if (!ticket.agentReplyCandidateAt) {
          ticket.agentReplyCandidateAt = now;
          changed = true;
        } else if (now - ticket.agentReplyCandidateAt >= AGENT_CONFIRM_MS) {
          ticket.pendingFirstResponse = false;
          ticket.agentReplyCandidateAt = 0;
          changed = true;
        }
      } else if (ticket.agentReplyCandidateAt) {
        ticket.agentReplyCandidateAt = 0;
        changed = true;
      }

      // Nesta versão de teste, o toast NÃO nasce do card. O gatilho é
      // exclusivamente o aumento real do contador de "Atribuído a mim".
    }

    ticket.lastView = view;
    ticket.updatedAt = Date.now();

    if (changed) saveState();

    // 24h+ tem prioridade visual absoluta: roxo fixo, sem piscar.
    const baseClass = chooseNormalBaseClass(row, isOld, ticket.notePending, fromAgent);
    const shouldSiren =
      !isOld &&
      ((view === "unassigned") || (view === "assigned" && ticket.pendingFirstResponse));

    applyVisualState(row, baseClass, shouldSiren);

    // Pequeno diagnóstico útil no DevTools, sem mudar o conteúdo visual.
    try {
      row.dataset.hsSignalState = isOld
        ? "old"
        : ticket.notePending
          ? "note"
          : fromAgent
            ? "agent"
            : noConversation
              ? "no-conversation"
              : "client";
      row.dataset.hsFirstResponsePending = shouldSiren ? "true" : "false";
      row.dataset.hsNotePending = ticket.notePending ? "true" : "false";
      row.__hsSignalTicketKey = key;
    } catch (_) {}
  }

  function updateAllRows() {
    const view = currentView();
    const previousRuntimeView = runtimeView;
    const enteredAssignedNow = view === "assigned" && previousRuntimeView !== "assigned";

    // Atualizamos antes de processar os cards; o contexto acima preserva a
    // origem da navegação para esta única varredura.
    runtimeView = view;

    const navigationContext = {
      previousRuntimeView,
      enteredAssignedNow,
    };

    const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
    EXT.updateDiagnostic({
      hubspotDetected: /app\.hubspot\.com$/i.test(location.hostname),
      helpDeskDetected: location.pathname.includes("/help-desk/"),
      darkReader: document.documentElement.getAttribute("data-darkreader-scheme") === "dark",
      ticketsFound: rows.length,
      assignedCount: readAssignedCount(),
      currentView: view,
      lastQueueReadAt: Date.now(),
      mainObserverActive: true,
    });
    const candidateLists = rows.map(getRowKeyCandidates);

    const candidateCounts = new Map();
    for (const list of candidateLists) {
      for (const candidate of list) {
        candidateCounts.set(candidate, (candidateCounts.get(candidate) || 0) + 1);
      }
    }

    const rowKeys = rows.map((row, index) => {
      const candidates = candidateLists[index];
      let key = candidates.find((candidate) => candidateCounts.get(candidate) === 1);

      // Último fallback: isola somente quando o HubSpot não expõe nenhuma
      // identidade única. Na prática os IDs/links costumam evitar este caso.
      if (!key) {
        const identity = candidates[0] || normalizeText(row.textContent).slice(0, 180) || "row";
        key = "isolated:" + identity + ":" + index;
      }
      return key;
    });

    // Se o contador comprovou uma nova atribuição, tentamos associá-la aos
    // cards que realmente apareceram agora na lista. O toast já foi exibido
    // pelo contador; esta etapa existe apenas para manter a sirene até a
    // primeira resposta do técnico.
    associatePendingAssignments(rows, rowKeys, view);

    rows.forEach((row, index) => {
      try {
        updateRow(row, rowKeys[index], view, navigationContext);
      } catch (_) {
        // Uma mudança inesperada em um card não deve interromper os demais.
      }
    });

    if (view === "assigned") {
      for (const key of rowKeys) {
        if (key) knownAssignedKeys.add(key);
      }
      saveAssignmentRuntime();
    }
  }

  let scheduled = false;
  function scheduleUpdate() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      trackAssignedCount();
      updateAllRows();
    });
  }

  const observer = new MutationObserver(scheduleUpdate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "class",
      "style",
      "aria-current",
      "aria-selected",
      "data-active",
      "data-selected",
      "href",
    ],
  });

  // O MutationObserver acompanha inclusive a troca do texto do contador
  // (ex.: 26 → 27). O intervalo é apenas um fallback para atualizações da SPA
  // e para confirmar a primeira resposta sem recarregar a página.
  setInterval(() => {
    trackAssignedCount();
    updateAllRows();
  }, 1000);

  EXT.onSettingsChange(() => {
    scheduleUpdate();
  });

  trackAssignedCount();
  updateAllRows();
})();


/* ========================================================================
   HubSpot Sinalizador 3.0.1 TESTE — controle de velocidade dos áudios

   ADIÇÃO ISOLADA sobre a base 2.6.6:
   - não altera nenhuma regra dos cards/tickets;
   - detecta o player nativo <audio> do HubSpot;
   - adiciona um botão 1x → 1,5x → 2x antes do menu de três pontos;
   - mantém a última velocidade escolhida entre tickets e áudios.
   ======================================================================== */
(function () {
  "use strict";
  const EXT = globalThis.__HS_SIGNALIZER__;

  const AUDIO_WRAPPER_SELECTOR = '[data-test-id="inline-audio-attachment"]';
  const AUDIO_DROPDOWN_SELECTOR = '[data-test-id="audio-dropdown"]';
  const SPEED_BUTTON_SELECTOR = '[data-hs-audio-speed-control="true"]';
  const AUDIO_SPEED_STORAGE_KEY = "hs-sinalizador-audio-speed-v1";
  const AUDIO_SPEEDS = [1, 1.5, 2];

  function normalizeSpeed(value) {
    const parsed = Number(value);
    return AUDIO_SPEEDS.includes(parsed) ? parsed : 1;
  }

  function loadPreferredSpeed() {
    try {
      return normalizeSpeed(localStorage.getItem(AUDIO_SPEED_STORAGE_KEY));
    } catch (_) {
      return 1;
    }
  }

  let preferredSpeed = loadPreferredSpeed();

  function savePreferredSpeed() {
    try {
      localStorage.setItem(AUDIO_SPEED_STORAGE_KEY, String(preferredSpeed));
    } catch (_) {}
  }

  function speedLabel(speed) {
    if (speed === 1.5) return "1,5x";
    return speed + "x";
  }

  function applySpeedToAudio(audio) {
    if (!(audio instanceof HTMLAudioElement)) return;
    const speed = EXT.isEnabled("audioSpeed") ? preferredSpeed : 1;
    try {
      audio.defaultPlaybackRate = speed;
      audio.playbackRate = speed;
    } catch (_) {}
  }

  function updateAllSpeedButtons() {
    document.querySelectorAll(SPEED_BUTTON_SELECTOR).forEach((button) => {
      const label = speedLabel(preferredSpeed);
      button.textContent = label;
      button.setAttribute("aria-label", "Velocidade do áudio: " + label);
      button.setAttribute("title", "Velocidade do áudio: " + label);
    });
  }

  function applySpeedToAllAudios() {
    document
      .querySelectorAll(AUDIO_WRAPPER_SELECTOR + " audio")
      .forEach(applySpeedToAudio);
  }

  function cyclePreferredSpeed() {
    const currentIndex = AUDIO_SPEEDS.indexOf(preferredSpeed);
    preferredSpeed = AUDIO_SPEEDS[(currentIndex + 1) % AUDIO_SPEEDS.length];
    savePreferredSpeed();
    applySpeedToAllAudios();
    updateAllSpeedButtons();
  }

  function bindAudio(audio) {
    if (!(audio instanceof HTMLAudioElement)) return;

    applySpeedToAudio(audio);

    if (audio.dataset.hsAudioSpeedBound === "true") return;
    audio.dataset.hsAudioSpeedBound = "true";

    // O HubSpot pode recarregar metadados ou ajustar o player ao iniciar.
    // Reaplicamos somente a preferência de velocidade, sem interferir nos
    // controles nativos de play, progresso, volume ou menu.
    ["loadedmetadata", "canplay", "play"].forEach((eventName) => {
      audio.addEventListener(eventName, () => applySpeedToAudio(audio));
    });
  }

  function createSpeedButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hs-audio-speed-control";
    button.dataset.hsAudioSpeedControl = "true";
    button.setAttribute("data-hs-audio-speed-control", "true");
    button.setAttribute("aria-live", "polite");

    const label = speedLabel(preferredSpeed);
    button.textContent = label;
    button.setAttribute("aria-label", "Velocidade do áudio: " + label);
    button.setAttribute("title", "Velocidade do áudio: " + label);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cyclePreferredSpeed();
    });

    return button;
  }

  function enhanceAudioWrapper(wrapper) {
    if (!(wrapper instanceof Element)) return;

    const audio = wrapper.querySelector("audio");
    if (!audio) return;

    bindAudio(audio);

    let button = wrapper.querySelector(SPEED_BUTTON_SELECTOR);
    if (!EXT.isEnabled("audioSpeed")) {
      if (button) button.remove();
      return;
    }
    if (!button) {
      button = createSpeedButton();
      const dropdown = wrapper.querySelector(AUDIO_DROPDOWN_SELECTOR);

      if (dropdown && dropdown.parentElement) {
        dropdown.parentElement.insertBefore(button, dropdown);
      } else {
        // Fallback: permanece dentro do próprio anexo de áudio se o HubSpot
        // alterar a estrutura do menu de três pontos em alguma atualização.
        wrapper.appendChild(button);
      }
    }

    const label = speedLabel(preferredSpeed);
    button.textContent = label;
    button.setAttribute("aria-label", "Velocidade do áudio: " + label);
    button.setAttribute("title", "Velocidade do áudio: " + label);
  }

  function enhanceAllAudioPlayers() {
    const wrappers = Array.from(document.querySelectorAll(AUDIO_WRAPPER_SELECTOR));
    wrappers.forEach(enhanceAudioWrapper);
    EXT.updateDiagnostic({
      audioPlayersFound: wrappers.length,
      speedControlsFound: document.querySelectorAll(SPEED_BUTTON_SELECTOR).length,
      audioSpeedEnabled: EXT.isEnabled("audioSpeed"),
    });
  }

  let audioScanScheduled = false;
  function scheduleAudioScan() {
    if (audioScanScheduled) return;
    audioScanScheduled = true;

    requestAnimationFrame(() => {
      audioScanScheduled = false;
      enhanceAllAudioPlayers();
    });
  }

  const audioObserver = new MutationObserver(scheduleAudioScan);
  audioObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  // Fallback leve para re-renderizações do player que não produzam uma
  // mutação útil para o observador naquele instante.
  setInterval(enhanceAllAudioPlayers, 2000);

  EXT.onSettingsChange((next, _previous, changed) => {
    if (changed.includes("audioPreferredSpeed")) {
      const requested = Number(next.audioPreferredSpeed);
      if (AUDIO_SPEEDS.includes(requested)) {
        preferredSpeed = requested;
        savePreferredSpeed();
      }
    }
    enhanceAllAudioPlayers();
  });

  enhanceAllAudioPlayers();
})();

/* ========================================================================
   HubSpot Sinalizador 3.0.6 TESTE — transcrição local aprimorada com Whisper Base

   Base preservada: 3.0.2 (visual Dark aprovado + velocidade do áudio).
   Este módulo apenas adiciona a transcrição.

   Fluxo:
   1) obtém o áudio do HubSpot sob demanda;
   2) decodifica e reamostra para mono/16 kHz em memória;
   3) envia SOMENTE a amostra PCM a um sandbox da própria extensão;
   4) o sandbox roda Whisper local com Transformers.js;
   5) somente o texto da transcrição é salvo no localStorage.
   ======================================================================== */
(function () {
  "use strict";
  const EXT = globalThis.__HS_SIGNALIZER__;

  const WRAPPER_SELECTOR = '[data-test-id="inline-audio-attachment"]';
  const MESSAGE_SELECTOR = '[data-cv-message-history-id]';
  const TRANSCRIPT_STORAGE_KEY = "hs-sinalizador-audio-transcripts-v2";
  const MAX_SAVED_TRANSCRIPTS = 120;
  const MAX_AUDIO_SECONDS = 10 * 60;

  let sandboxFrame = null;
  let sandboxReadyPromise = null;
  let sandboxResolveReady = null;
  let requestSequence = 0;
  const pendingRequests = new Map();

  function loadTranscriptStore() {
    try {
      const raw = localStorage.getItem(TRANSCRIPT_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveTranscript(messageId, text) {
    if (!messageId || !text) return;
    try {
      const store = loadTranscriptStore();
      store[messageId] = { text, savedAt: Date.now(), model: "onnx-community/whisper-base" };

      const ids = Object.keys(store).sort(
        (a, b) => (store[b]?.savedAt || 0) - (store[a]?.savedAt || 0),
      );
      for (const id of ids.slice(MAX_SAVED_TRANSCRIPTS)) delete store[id];

      localStorage.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify(store));
    } catch (_) {}
  }

  function getSavedTranscript(messageId) {
    if (!messageId) return "";
    const item = loadTranscriptStore()[messageId];
    return item && typeof item.text === "string" ? item.text : "";
  }

  function getMessageId(wrapper) {
    return (
      wrapper.closest(MESSAGE_SELECTOR)?.getAttribute("data-cv-message-history-id") ||
      ""
    );
  }

  function getAudioUrl(wrapper) {
    const audio = wrapper.querySelector("audio");
    if (!audio) return "";
    return audio.querySelector("source")?.src || audio.currentSrc || audio.src || "";
  }

  function bytesFromBase64(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out.buffer;
  }

  async function requestAudioBytes(url) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        redirect: "follow",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (_) {
      const result = await chrome.runtime.sendMessage({
        type: "HS_SIGNAL_FETCH_AUDIO_FOR_TRANSCRIPTION",
        url,
      });

      if (!result?.ok || !result?.base64) {
        throw new Error(result?.error || "Não foi possível obter o áudio do HubSpot.");
      }
      return bytesFromBase64(result.base64);
    }
  }

  async function decodeToMono16k(arrayBuffer, setStatus) {
    setStatus("Preparando áudio em memória…");

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor || !window.OfflineAudioContext) {
      throw new Error("Este Chrome não disponibilizou os recursos de áudio necessários.");
    }

    const decodeContext = new AudioContextCtor();
    try {
      const decoded = await decodeContext.decodeAudioData(arrayBuffer.slice(0));

      if (!Number.isFinite(decoded.duration) || decoded.duration <= 0) {
        throw new Error("Não foi possível identificar a duração deste áudio.");
      }
      if (decoded.duration > MAX_AUDIO_SECONDS) {
        throw new Error("Nesta versão de teste, áudios acima de 10 minutos não são processados.");
      }

      const targetRate = 16000;
      const targetLength = Math.max(1, Math.ceil(decoded.duration * targetRate));
      const offline = new OfflineAudioContext(1, targetLength, targetRate);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(0);

      const rendered = await offline.startRendering();
      return rendered.getChannelData(0).slice();
    } finally {
      try {
        await decodeContext.close();
      } catch (_) {}
    }
  }

  function ensureSandbox() {
    if (sandboxReadyPromise) return sandboxReadyPromise;

    sandboxReadyPromise = new Promise((resolve, reject) => {
      sandboxResolveReady = resolve;

      const frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("sandbox.html");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText =
        "position:fixed!important;width:1px!important;height:1px!important;opacity:0!important;pointer-events:none!important;left:-9999px!important;top:-9999px!important;border:0!important;";

      frame.addEventListener("error", () => {
        reject(new Error("Não foi possível iniciar o módulo local de transcrição."));
      });

      document.documentElement.appendChild(frame);
      sandboxFrame = frame;

      setTimeout(() => {
        if (sandboxResolveReady) {
          reject(
            new Error(
              "O módulo Whisper não respondeu. Recarregue o HubSpot e tente novamente.",
            ),
          );
          sandboxResolveReady = null;
          sandboxReadyPromise = null;
        }
      }, 12000);
    });

    return sandboxReadyPromise;
  }

  window.addEventListener("message", (event) => {
    if (!sandboxFrame || event.source !== sandboxFrame.contentWindow) return;
    const data = event.data;
    if (!data || typeof data.type !== "string") return;

    if (data.type === "HS_WHISPER_SANDBOX_READY") {
      EXT.updateDiagnostic({
        whisperState: "pronto para carregar",
        whisperModel: data.model || "onnx-community/whisper-base",
        whisperCacheStorage: typeof data.cacheStorage === "boolean" ? data.cacheStorage : null,
        webgpuAvailable: typeof data.webgpu === "boolean" ? data.webgpu : !!navigator.gpu,
        wasmAvailable: typeof data.wasm === "boolean" ? data.wasm : typeof WebAssembly === "object",
        whisperLastError: "",
      });
      if (sandboxResolveReady) {
        sandboxResolveReady(true);
        sandboxResolveReady = null;
      }
      return;
    }

    const pending = pendingRequests.get(data.requestId);
    if (!pending) return;

    if (data.type === "HS_WHISPER_PROGRESS") {
      const message = data.message || "Preparando transcrição local…";
      EXT.updateDiagnostic({
        whisperState: "carregando/transcrevendo",
        whisperLastStatus: message,
        whisperLastError: "",
      });
      pending.onProgress(message);
      return;
    }

    if (data.type === "HS_WHISPER_RESULT") {
      pendingRequests.delete(data.requestId);
      EXT.updateDiagnostic({
        whisperState: "pronto",
        whisperDevice: data.device || "local",
        whisperLastStatus: "Última transcrição concluída",
        whisperLastError: "",
        whisperLastSuccessAt: Date.now(),
        antiRepeatAdjustments: Number(data.antiRepeatAdjustments) || 0,
      });
      pending.resolve({
        text: data.text || "",
        device: data.device || "local",
        antiRepeatAdjustments: Number(data.antiRepeatAdjustments) || 0,
      });
      return;
    }

    if (data.type === "HS_WHISPER_ERROR") {
      pendingRequests.delete(data.requestId);
      const errorText = data.error || "Falha no Whisper local.";
      EXT.updateDiagnostic({
        whisperState: "erro",
        whisperLastStatus: "",
        whisperLastError: errorText,
      });
      pending.reject(new Error(errorText));
    }
  });

  async function transcribeWithWhisper(pcm16k, onProgress) {
    await ensureSandbox();
    if (!sandboxFrame?.contentWindow) {
      throw new Error("O módulo Whisper local não foi inicializado.");
    }

    const requestId = `hs-whisper-${Date.now()}-${++requestSequence}`;
    const audioBuffer = pcm16k.buffer;

    const resultPromise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject, onProgress });

      setTimeout(() => {
        const pending = pendingRequests.get(requestId);
        if (!pending) return;
        pendingRequests.delete(requestId);
        reject(
          new Error(
            "A transcrição excedeu o tempo esperado. Tente novamente com um áudio menor.",
          ),
        );
      }, 8 * 60 * 1000);
    });

    sandboxFrame.contentWindow.postMessage(
      {
        type: "HS_WHISPER_TRANSCRIBE",
        requestId,
        audioBuffer,
      },
      "*",
      [audioBuffer],
    );

    return resultPromise;
  }

  function makeTranscriptPanel(text) {
    const panel = document.createElement("div");
    panel.className = "hs-audio-transcription-panel";
    panel.dataset.hsAudioTranscriptionPanel = "true";

    const header = document.createElement("div");
    header.className = "hs-audio-transcription-header";

    const title = document.createElement("div");
    title.className = "hs-audio-transcription-title";
    title.textContent = "📝 Transcrição";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "hs-audio-transcription-copy";
    copy.textContent = "Copiar";

    const body = document.createElement("div");
    body.className = "hs-audio-transcription-text";
    body.textContent = text;

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(body.textContent || "");
        copy.textContent = "Copiado ✓";
      } catch (_) {
        copy.textContent = "Falhou";
      }
      setTimeout(() => {
        copy.textContent = "Copiar";
      }, 1300);
    });

    header.append(title, copy);
    panel.append(header, body);
    return panel;
  }

  function showTranscript(wrapper, text) {
    let panel = wrapper.querySelector('[data-hs-audio-transcription-panel="true"]');
    if (!panel) {
      panel = makeTranscriptPanel(text);
      wrapper.appendChild(panel);
    } else {
      const body = panel.querySelector(".hs-audio-transcription-text");
      if (body) body.textContent = text;
      panel.hidden = false;
    }
  }

  function enhanceTranscription(wrapper) {
    if (!(wrapper instanceof Element) || !wrapper.querySelector("audio")) return;

    if (!EXT.isEnabled("transcription")) {
      wrapper.querySelector('[data-hs-audio-transcription-actions="true"]')?.remove();
      wrapper.querySelector('[data-hs-audio-transcription-panel="true"]')?.remove();
      return;
    }

    const messageId = getMessageId(wrapper);
    const saved = getSavedTranscript(messageId);

    let actions = wrapper.querySelector('[data-hs-audio-transcription-actions="true"]');
    if (!actions) {
      actions = document.createElement("div");
      actions.className = "hs-audio-transcription-actions";
      actions.dataset.hsAudioTranscriptionActions = "true";

      const status = document.createElement("span");
      status.className = "hs-audio-transcription-status";
      status.dataset.hsAudioTranscriptionStatus = "true";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "hs-audio-transcribe-button";
      button.dataset.hsAudioTranscribe = "true";
      button.textContent = saved ? "📝 Ver transcrição" : "📝 Transcrever";

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const currentMessageId = getMessageId(wrapper);
        const existing = getSavedTranscript(currentMessageId);
        if (existing) {
          const panel = wrapper.querySelector('[data-hs-audio-transcription-panel="true"]');
          if (panel && !panel.hidden) {
            panel.hidden = true;
            button.textContent = "📝 Ver transcrição";
          } else {
            showTranscript(wrapper, existing);
            button.textContent = "📝 Ocultar transcrição";
          }
          return;
        }

        const url = getAudioUrl(wrapper);
        if (!url) {
          status.textContent = "Não encontrei a URL deste áudio.";
          return;
        }

        button.disabled = true;
        const setStatus = (message) => {
          status.textContent = message;
        };

        try {
          setStatus("Obtendo áudio do HubSpot…");
          const bytes = await requestAudioBytes(url);
          const pcm = await decodeToMono16k(bytes, setStatus);

          setStatus("Inicializando Whisper local…");
          const result = await transcribeWithWhisper(pcm, setStatus);
          const transcript = String(result?.text || "").trim();
          if (!transcript) throw new Error("O Whisper não retornou texto para este áudio.");

          saveTranscript(currentMessageId, transcript);
          showTranscript(wrapper, transcript);
          status.textContent = `Transcrição concluída localmente${result.device ? ` (${result.device})` : ""} ✓`;
          button.textContent = "📝 Ocultar transcrição";
        } catch (error) {
          console.warn("[HubSpot Sinalizador] Falha na transcrição Whisper:", error);
          const errorText = error?.message || "Não foi possível transcrever este áudio nesta versão de teste.";
          EXT.updateDiagnostic({ whisperState: "erro", whisperLastError: errorText });
          status.textContent = errorText;
        } finally {
          button.disabled = false;
        }
      });

      actions.append(status, button);
      wrapper.appendChild(actions);
    }

    if (saved && !wrapper.querySelector('[data-hs-audio-transcription-panel="true"]')) {
      showTranscript(wrapper, saved);
      const button = actions.querySelector('[data-hs-audio-transcribe="true"]');
      if (button) button.textContent = "📝 Ocultar transcrição";
    }
  }

  function enhanceAllTranscriptionPlayers() {
    const wrappers = Array.from(document.querySelectorAll(WRAPPER_SELECTOR));
    wrappers.forEach(enhanceTranscription);
    EXT.updateDiagnostic({
      transcriptionEnabled: EXT.isEnabled("transcription"),
      audioPlayersFound: wrappers.length,
      webgpuAvailable: !!navigator.gpu,
      wasmAvailable: typeof WebAssembly === "object",
    });
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhanceAllTranscriptionPlayers();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(enhanceAllTranscriptionPlayers, 2500);
  EXT.onSettingsChange(() => {
    enhanceAllTranscriptionPlayers();
  });

  enhanceAllTranscriptionPlayers();
})();


/* ========================================================================
   HubSpot Sinalizador 3.0.7 TESTE — Aba local "Atenção"

   ADIÇÃO ISOLADA sobre a 3.0.6:
   - não altera cores, sirene, toast, áudio, transcrição ou diagnóstico;
   - permite marcar manualmente tickets de "Atribuído a mim";
   - salva apenas uma referência local do ticket neste perfil do Chrome;
   - cria uma subaba "Atenção" sem criar/mover pastas ou tickets no HubSpot;
   - a lista de Atenção é desenhada sobre a lista nativa, sem reordenar ou
     remover os cards originais do Help Desk.
   ======================================================================== */
(function () {
  "use strict";

  const ROW_SELECTOR = '[data-test-id^="thread-list-member-row"]';
  const HEADER_SELECTOR = '[data-test-id="member-header"]';
  const CONTEXT_SELECTOR = '[data-test-id="member-context"]';
  const ASSIGNED_VIEW_ID = "109251880";
  const ASSIGNED_LINK_SELECTOR =
    'a[data-test-id="Atribuído a mim"][href*="/view/' + ASSIGNED_VIEW_ID + '"]';

  const STORAGE_KEY = "hs-sinalizador-attention-v1";
  const NAV_ID = "hs-attention-nav";
  const PANEL_ID = "hs-attention-panel";
  const PIN_SELECTOR = '[data-hs-attention-pin="true"]';
  const MAX_ITEMS = 100;

  let items = [];
  let panelOpen = false;
  let requestOpenAfterNavigation = false;
  let scanScheduled = false;
  let storageLoaded = false;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function assignedViewActive() {
    const urlParts = [location.href, location.pathname, location.search, location.hash];
    if (urlParts.some((part) => String(part || "").includes(ASSIGNED_VIEW_ID))) return true;

    const link = document.querySelector(ASSIGNED_LINK_SELECTOR);
    if (!link) return false;
    if (link.getAttribute("aria-current") === "page" || link.getAttribute("aria-current") === "true") return true;
    if (link.getAttribute("data-active") === "true" || link.getAttribute("data-selected") === "true") return true;
    if (link.getAttribute("aria-selected") === "true") return true;
    return false;
  }

  function selectedRow() {
    return document.querySelector(
      ROW_SELECTOR + '[aria-selected="true"], ' +
      ROW_SELECTOR + '[data-selected="true"]'
    );
  }

  function getTicketKey(row) {
    if (!(row instanceof Element)) return "";
    const exposed = String(row.__hsSignalTicketKey || "").trim();
    if (exposed) return exposed;

    const attrs = [
      "data-ticket-id",
      "data-thread-id",
      "data-conversation-id",
      "data-record-id",
      "data-object-id",
      "data-id",
    ];
    const nodes = [row].concat(Array.from(row.querySelectorAll("*")));
    for (const node of nodes) {
      if (!node.getAttribute) continue;
      for (const attr of attrs) {
        const value = String(node.getAttribute(attr) || "").trim();
        if (/\d{5,}|[a-f0-9]{8}-[a-f0-9-]{20,}/i.test(value)) {
          return attr + ":" + value;
        }
      }
    }

    const meta = getRowMetadata(row);
    const identity = [meta.title, meta.contact].filter(Boolean).join("|").toLowerCase();
    return identity ? "attention-identity:" + identity : "";
  }

  function cleanHeaderText(row) {
    const header = row.querySelector(HEADER_SELECTOR);
    if (!header) return "";
    try {
      const clone = header.cloneNode(true);
      clone.querySelectorAll(PIN_SELECTOR).forEach((node) => node.remove());
      const children = Array.from(clone.children || []);
      if (children.length > 1) {
        const lastText = normalizeText(children[children.length - 1].textContent);
        if (/^(agora( mesmo)?|\d+\s*(s|min|m|h|d|dias?)|\d{1,2}:\d{2}|hoje|ontem)$/i.test(lastText)) {
          children[children.length - 1].remove();
        }
      }
      return normalizeText(clone.textContent);
    } catch (_) {
      return normalizeText(header.textContent);
    }
  }

  function getBestHref(row) {
    const links = Array.from(row.querySelectorAll("a[href]"));
    const hrefs = links
      .map((a) => a.href || a.getAttribute("href") || "")
      .filter(Boolean)
      .filter((href) => /^https?:/i.test(href));

    const specific = hrefs.find((href) => {
      try {
        const url = new URL(href, location.origin);
        if (url.origin !== location.origin) return false;
        if (!url.pathname.includes("/help-desk/")) return false;
        return (
          /ticket|thread|conversation|record/i.test(url.pathname + url.search + url.hash) ||
          /[?&#](ticket|thread|conversation|record|object).*id=/i.test(url.href)
        );
      } catch (_) {
        return false;
      }
    });

    return specific || "";
  }

  function getRowMetadata(row) {
    const title = cleanHeaderText(row) || "Atendimento sem título";
    const context = row.querySelector(CONTEXT_SELECTOR);
    const contact = context ? normalizeText(context.textContent) : "";
    const combined = [title, contact, normalizeText(row.textContent)].join(" ");
    const codeMatch = combined.match(/#?\d{5,}/);
    return {
      title: title.slice(0, 160),
      contact: contact.slice(0, 160),
      ticketCode: codeMatch ? codeMatch[0].replace(/^#/, "") : "",
      directHref: getBestHref(row),
      signalState: String(row.dataset.hsSignalState || ""),
    };
  }

  function normalizeStored(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const normalized = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const key = String(entry.key || "").trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        key,
        title: normalizeText(entry.title || "Atendimento sem título").slice(0, 160),
        contact: normalizeText(entry.contact || "").slice(0, 160),
        ticketCode: String(entry.ticketCode || "").replace(/\D/g, "").slice(0, 30),
        directHref: String(entry.directHref || "").slice(0, 1200),
        pageUrl: String(entry.pageUrl || "").slice(0, 1200),
        addedAt: Number(entry.addedAt) || Date.now(),
        lastSeenAt: Number(entry.lastSeenAt) || Number(entry.addedAt) || Date.now(),
        signalState: String(entry.signalState || "").slice(0, 40),
        waitingFor: normalizeText(entry.waitingFor || "").slice(0, 300),
        nextAction: normalizeText(entry.nextAction || "").slice(0, 500),
        dueAt: Number.isFinite(entry.dueAt) && entry.dueAt > 0 && entry.dueAt < 8640000000000000 ? entry.dueAt : null,
        priority: ["low", "normal", "high"].includes(entry.priority) ? entry.priority : "normal",
        completedAt: Number.isFinite(entry.completedAt) && entry.completedAt > 0 ? entry.completedAt : null,
      });
      if (normalized.length >= MAX_ITEMS) break;
    }
    return normalized;
  }

  function loadItems() {
    try {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        items = normalizeStored(result?.[STORAGE_KEY]);
        storageLoaded = true;
        refreshUI();
      });
    } catch (_) {
      storageLoaded = true;
    }
  }

  function persistItems() {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: items.slice(0, MAX_ITEMS) });
    } catch (_) {}
  }

  function isSaved(key) {
    return !!key && items.some((item) => item.key === key);
  }

  function findSaved(key) {
    return items.find((item) => item.key === key) || null;
  }

  function saveRow(row) {
    const key = getTicketKey(row);
    if (!key) {
      showNotice("Não foi possível identificar este atendimento para salvar em Atenção.", "warn");
      return;
    }

    const existing = findSaved(key);
    const meta = getRowMetadata(row);
    const now = Date.now();
    if (existing) {
      Object.assign(existing, meta, { lastSeenAt: now });
      persistItems();
      refreshUI();
      return;
    }

    items.unshift({
      key,
      ...meta,
      pageUrl: selectedRow() === row ? location.href : "",
      addedAt: now,
      lastSeenAt: now,
    });
    if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
    persistItems();
    refreshUI();
    showNotice("Atendimento adicionado em Atenção.", "ok");
  }

  function removeKey(key, notify = true) {
    const before = items.length;
    items = items.filter((item) => item.key !== key);
    if (items.length === before) return;
    persistItems();
    refreshUI();
    if (notify) showNotice("Atendimento removido de Atenção.", "ok");
  }

  function toggleRow(row) {
    const key = getTicketKey(row);
    if (!key) {
      showNotice("Não foi possível identificar este atendimento para salvar em Atenção.", "warn");
      return;
    }
    if (isSaved(key)) removeKey(key);
    else saveRow(row);
  }

  function createPinButton(row) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hs-attention-pin";
    button.dataset.hsAttentionPin = "true";
    button.setAttribute("data-hs-attention-pin", "true");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRow(row);
    });
    return button;
  }

  function updatePin(row) {
    if (!(row instanceof Element)) return;
    const header = row.querySelector(HEADER_SELECTOR);
    if (!header) return;

    let button = header.querySelector(PIN_SELECTOR);
    if (!button) {
      button = createPinButton(row);
      const last = header.lastElementChild;
      if (last) header.insertBefore(button, last);
      else header.appendChild(button);
    }

    const key = getTicketKey(row);
    const active = isSaved(key);
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute(
      "aria-label",
      active ? "Remover atendimento de Atenção" : "Adicionar atendimento em Atenção"
    );
    button.setAttribute(
      "title",
      active ? "Remover de Atenção" : "Adicionar em Atenção"
    );
  }

  function removePinsOutsideAssigned() {
    document.querySelectorAll(PIN_SELECTOR).forEach((button) => button.remove());
  }

  function ensureNav() {
    const assignedLink = document.querySelector(ASSIGNED_LINK_SELECTOR);
    if (!assignedLink || !assignedLink.parentElement) return null;

    let nav = document.getElementById(NAV_ID);
    if (!nav) {
      nav = document.createElement("div");
      nav.id = NAV_ID;
      nav.className = "hs-attention-nav";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "hs-attention-nav-button";
      button.dataset.hsAttentionNavButton = "true";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!assignedViewActive()) {
          requestOpenAfterNavigation = true;
          try { assignedLink.click(); } catch (_) {}
          window.setTimeout(scheduleScan, 350);
          return;
        }
        setPanelOpen(!panelOpen);
      });
      nav.appendChild(button);
      assignedLink.insertAdjacentElement("afterend", nav);
    }

    updateNav();
    return nav;
  }

  function updateNav() {
    const nav = document.getElementById(NAV_ID);
    if (!nav) return;
    const button = nav.querySelector('[data-hs-attention-nav-button="true"]');
    if (!button) return;
    button.textContent = "⚠ Atenção " + items.length;
    button.classList.toggle("is-active", panelOpen && assignedViewActive());
    button.setAttribute("aria-pressed", panelOpen && assignedViewActive() ? "true" : "false");
    button.title = items.length
      ? items.length + (items.length === 1 ? " atendimento marcado" : " atendimentos marcados")
      : "Nenhum atendimento marcado";
  }

  function findTicketGrid() {
    const grids = Array.from(document.querySelectorAll('[aria-label="grid"]'));
    return grids.find((grid) => grid.querySelector(ROW_SELECTOR)) ||
      document.querySelector(".ReactVirtualized__Grid.ReactVirtualized__List") ||
      document.querySelector(".ReactVirtualized__Grid");
  }

  function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "hs-attention-panel";
    panel.hidden = true;
    panel.setAttribute("aria-label", "Atendimentos em Atenção");
    document.body.appendChild(panel);
    return panel;
  }

  function positionPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.hidden) return;
    const grid = findTicketGrid();
    if (!grid) {
      panel.hidden = true;
      return;
    }
    const rect = grid.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 120) {
      panel.hidden = true;
      return;
    }
    panel.style.left = Math.round(rect.left) + "px";
    panel.style.top = Math.round(rect.top) + "px";
    panel.style.width = Math.round(rect.width) + "px";
    panel.style.height = Math.round(rect.height) + "px";
  }

  function relativeTime(timestamp) {
    const diff = Math.max(0, Date.now() - Number(timestamp || Date.now()));
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "agora";
    if (minutes < 60) return "há " + minutes + " min";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return "há " + hours + (hours === 1 ? " h" : " h");
    const days = Math.floor(hours / 24);
    return "há " + days + (days === 1 ? " dia" : " dias");
  }

  function agendaButton(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hs-agenda-button";
    button.textContent = text;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return button;
  }

  function editAgenda(key) {
    const item = findSaved(key);
    if (!item || document.querySelector(".hs-agenda-dialog")) return;
    const dialog = document.createElement("dialog");
    dialog.className = "hs-agenda-dialog";
    dialog.setAttribute("aria-label", "Editar acompanhamento");
    const form = document.createElement("form");
    const heading = document.createElement("h3");
    heading.textContent = "Acompanhamento pessoal";
    const ticket = document.createElement("p");
    ticket.textContent = item.title;
    const help = document.createElement("p");
    help.textContent = "Salvo neste navegador. Não altera o chamado no HubSpot. Horário local do computador.";
    form.append(heading, ticket, help);
    function field(labelText, name, type, value, maxLength) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.name = name;
      input.type = type;
      input.value = value;
      if (maxLength) input.maxLength = maxLength;
      label.append(input);
      form.append(label);
      return input;
    }
    const waiting = field("Aguardando", "waitingFor", "text", item.waitingFor || "", 300);
    const next = field("Próxima ação", "nextAction", "text", item.nextAction || "", 500);
    let localDate = "";
    if (item.dueAt) {
      const date = new Date(item.dueAt);
      localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
    const due = field("Data e hora (opcional)", "dueAt", "datetime-local", localDate);
    const priorityLabel = document.createElement("label");
    priorityLabel.textContent = "Prioridade pessoal";
    const priority = document.createElement("select");
    priority.name = "priority";
    for (const [value, text] of [["low", "Baixa"], ["normal", "Normal"], ["high", "Alta"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      priority.append(option);
    }
    priority.value = item.priority || "normal";
    priorityLabel.append(priority);
    form.append(priorityLabel);
    const footer = document.createElement("div");
    const cancel = agendaButton("Cancelar", () => dialog.close());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "hs-agenda-button";
    save.textContent = "Salvar acompanhamento";
    footer.append(cancel, save);
    form.append(footer);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const current = findSaved(key);
      if (!current) {
        dialog.close();
        showNotice("Este atendimento foi removido de Atenção.", "warn");
        return;
      }
      const timestamp = due.value ? new Date(due.value).getTime() : null;
      if (due.value && !Number.isFinite(timestamp)) return;
      Object.assign(current, {
        waitingFor: waiting.value.trim(), nextAction: next.value.trim(),
        dueAt: timestamp, priority: priority.value, completedAt: null,
      });
      persistItems();
      dialog.close();
      refreshUI();
      showNotice("Acompanhamento salvo neste navegador.", "ok");
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    waiting.focus();
  }

  function createPanelItem(item) {
    const card = document.createElement("article");
    card.className = "hs-attention-item";
    card.dataset.attentionKey = item.key;

    const main = document.createElement("div");
    main.className = "hs-attention-item-main";

    const title = document.createElement("div");
    title.className = "hs-attention-item-title";
    title.textContent = item.title || (item.ticketCode ? "Ticket #" + item.ticketCode : "Atendimento");

    const meta = document.createElement("div");
    meta.className = "hs-attention-item-meta";
    const pieces = [];
    if (item.contact) pieces.push(item.contact);
    if (item.ticketCode && !String(item.title || "").includes(item.ticketCode)) pieces.push("#" + item.ticketCode);
    pieces.push(relativeTime(item.addedAt));
    meta.textContent = pieces.join(" · ");

    main.append(title, meta);
    const agenda = document.createElement("div");
    agenda.className = "hs-agenda-details";
    const overdue = !item.completedAt && item.dueAt && item.dueAt <= Date.now();
    card.classList.toggle("hs-agenda-overdue", !!overdue);
    function line(text) {
      const element = document.createElement("div");
      element.textContent = text;
      agenda.append(element);
    }
    line("Prioridade: " + ({ low: "Baixa", normal: "Normal", high: "Alta" }[item.priority] || "Normal"));
    if (item.waitingFor) line("Aguardando: " + item.waitingFor);
    if (item.nextAction) line("Próxima ação: " + item.nextAction);
    if (item.completedAt) line("✓ Ação concluída");
    else if (item.dueAt) line((overdue ? "⚠ Vencido: " : "🕒 ") + new Date(item.dueAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }));
    else line("Sem lembrete definido");
    const controls = document.createElement("div");
    controls.className = "hs-agenda-controls";
    controls.append(agendaButton("Editar acompanhamento", () => editAgenda(item.key)));
    if (!item.completedAt && (item.nextAction || item.dueAt)) {
      controls.append(agendaButton("Concluir ação", () => {
        const current = findSaved(item.key);
        if (!current) return;
        current.completedAt = Date.now();
        persistItems();
        refreshUI();
      }));
    }
    main.append(agenda, controls);

    const actions = document.createElement("div");
    actions.className = "hs-attention-item-actions";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "hs-attention-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", "Remover de Atenção");
    remove.title = "Remover de Atenção";
    remove.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeKey(item.key);
    });

    actions.append(remove);
    card.append(main, actions);
    return card;
  }

  let renderedPanelSignature = "";

  function renderPanel() {
    const panel = ensurePanel();
    // Preserve the buttons between scans so a refresh cannot interrupt a click.
    const visible = panelOpen && assignedViewActive();
    const signature = JSON.stringify(items.map(({ key, title, contact, ticketCode, addedAt, waitingFor, nextAction, dueAt, priority, completedAt }) =>
      [key, title, contact, ticketCode, addedAt, relativeTime(addedAt), waitingFor, nextAction, dueAt, priority, completedAt, !!dueAt && dueAt <= Date.now()]));
    if (signature === renderedPanelSignature && panel.childElementCount) {
      panel.hidden = !visible;
      if (visible) positionPanel();
      return;
    }
    renderedPanelSignature = signature;
    panel.replaceChildren();

    const head = document.createElement("div");
    head.className = "hs-attention-panel-head";

    const headText = document.createElement("div");
    const title = document.createElement("div");
    title.className = "hs-attention-panel-title";
    title.textContent = "⚠ Atenção";
    const subtitle = document.createElement("div");
    subtitle.className = "hs-attention-panel-subtitle";
    subtitle.textContent = items.length
      ? items.length + (items.length === 1 ? " atendimento separado" : " atendimentos separados")
      : "Nenhum atendimento marcado";
    headText.append(title, subtitle);

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "hs-attention-back";
    allButton.textContent = "Todos";
    allButton.title = "Voltar para todos os atendimentos";
    allButton.addEventListener("click", () => setPanelOpen(false));

    head.append(headText, allButton);

    const body = document.createElement("div");
    body.className = "hs-attention-panel-body";

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "hs-attention-empty";
      empty.innerHTML = "<strong>Nenhum atendimento em Atenção.</strong><span>Use a estrela nos cards de “Atribuído a mim” para separar um chamado importante.</span>";
      body.appendChild(empty);
    } else {
      const sorted = [...items].sort((a, b) => {
        const aDue = !a.completedAt && a.dueAt ? a.dueAt : Infinity;
        const bDue = !b.completedAt && b.dueAt ? b.dueAt : Infinity;
        return (aDue === bDue ? 0 : aDue < bDue ? -1 : 1) || Number(a.addedAt) - Number(b.addedAt);
      });
      sorted.forEach((item) => body.appendChild(createPanelItem(item)));
    }

    panel.append(head, body);
    panel.hidden = !(panelOpen && assignedViewActive());
    if (!panel.hidden) positionPanel();
  }

  function setPanelOpen(open) {
    panelOpen = !!open && assignedViewActive();
    renderPanel();
    updateNav();
  }

  function clickVisibleRow(row) {
    if (!(row instanceof Element)) return false;
    try {
      const target = row.querySelector(HEADER_SELECTOR) || row;
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    } catch (_) {
      return false;
    }
  }

  function findVisibleRow(item) {
    const rows = Array.from(document.querySelectorAll(ROW_SELECTOR));
    return rows.find((row) => getTicketKey(row) === item.key) ||
      rows.find((row) => {
        const meta = getRowMetadata(row);
        if (item.ticketCode && meta.ticketCode === item.ticketCode) return true;
        return item.title && meta.title === item.title && (!item.contact || meta.contact === item.contact);
      }) || null;
  }

  async function copyFallback(item) {
    const value = item.ticketCode ? "#" + item.ticketCode : item.title || item.contact || "";
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function openSavedItem(item) {
    if (!assignedViewActive()) {
      const assignedLink = document.querySelector(ASSIGNED_LINK_SELECTOR);
      if (assignedLink) {
        requestOpenAfterNavigation = false;
        try { assignedLink.click(); } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 450));
      }
    }

    const row = findVisibleRow(item);
    if (row && clickVisibleRow(row)) {
      item.lastSeenAt = Date.now();
      persistItems();
      setPanelOpen(false);
      return;
    }

    if (item.directHref) {
      try {
        const url = new URL(item.directHref, location.origin);
        if (url.origin === location.origin) {
          setPanelOpen(false);
          location.assign(url.href);
          return;
        }
      } catch (_) {}
    }

    // Em algumas versões do Help Desk o endereço da página não carrega um ID
    // do ticket. Nessa situação não inventamos uma rota do HubSpot: copiamos o
    // código/título para facilitar a localização pela busca nativa.
    const copied = await copyFallback(item);
    showNotice(
      copied
        ? "O card não está renderizado na fila. O identificador foi copiado para você localizar pela busca do HubSpot."
        : "O card não está renderizado na fila. Volte para Todos e localize o atendimento pela busca do HubSpot.",
      "warn"
    );
  }

  function showNotice(text, kind) {
    let notice = document.getElementById("hs-attention-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "hs-attention-notice";
      notice.className = "hs-attention-notice";
      notice.setAttribute("role", "status");
      document.body.appendChild(notice);
    }
    notice.className = "hs-attention-notice " + (kind === "warn" ? "is-warn" : "is-ok");
    notice.textContent = text;
    notice.hidden = false;
    clearTimeout(showNotice.timer);
    showNotice.timer = setTimeout(() => { notice.hidden = true; }, 4200);
  }

  function refreshSavedMetadataFromVisibleRows() {
    let changed = false;
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const key = getTicketKey(row);
      const saved = findSaved(key);
      if (!saved) continue;
      const meta = getRowMetadata(row);
      const next = {
        title: meta.title,
        contact: meta.contact,
        ticketCode: meta.ticketCode || saved.ticketCode,
        directHref: meta.directHref || saved.directHref,
        signalState: meta.signalState || saved.signalState,
        lastSeenAt: Date.now(),
      };
      for (const [field, value] of Object.entries(next)) {
        if (saved[field] !== value) {
          saved[field] = value;
          changed = true;
        }
      }
    }
    if (changed) persistItems();
  }

  function refreshUI() {
    if (!storageLoaded) return;
    ensureNav();

    if (!assignedViewActive()) {
      panelOpen = false;
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.hidden = true;
      removePinsOutsideAssigned();
      updateNav();
      return;
    }

    if (requestOpenAfterNavigation) {
      requestOpenAfterNavigation = false;
      panelOpen = true;
    }

    document.querySelectorAll(ROW_SELECTOR).forEach(updatePin);
    refreshSavedMetadataFromVisibleRows();
    renderPanel();
    updateNav();
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      refreshUI();
    });
  }

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    items = normalizeStored(changes[STORAGE_KEY].newValue);
    storageLoaded = true;
    scheduleScan();
  });

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-current", "aria-selected", "data-active", "data-selected", "href"],
  });

  window.addEventListener("resize", positionPanel, { passive: true });
  window.addEventListener("scroll", positionPanel, { passive: true, capture: true });

  setInterval(() => {
    scheduleScan();
    if (panelOpen) positionPanel();
  }, 1500);

  loadItems();
})();

/* ========================================================================
   3.0.11 TESTE — Resumo histórico IA: composer adaptável Chat/Observação

   ALTERAÇÃO ISOLADA SOBRE A 3.0.9:
   - Mantém a mesma captura do HubSpot:
     [data-selenium-test="property-input-resumo_historico_analista"]
   - Se o resumo já existe ao abrir/trocar o ticket, lê e renderiza imediatamente.
   - MutationObserver continua disponível como detector, porém só dispara nova
     leitura quando a mutação envolve o resumo, a troca de ticket ou a âncora.
   - O timer não é mais reiniciado por qualquer mutação do HubSpot.
   - Fallback leve consulta somente o seletor do resumo enquanto ele ainda não
     existe, para capturar o autopreenchimento da IA do HubSpot rapidamente.
   - Mantém o card in-flow, Minimizar/Expandir e o controle ON/OFF existentes.
   ======================================================================== */
(function () {
  "use strict";

  const EXT = globalThis.__HS_SIGNALIZER__;
  if (!EXT) return;

  const SUMMARY_SELECTOR = '[data-selenium-test="property-input-resumo_historico_analista"]';
  // 3.0.11: o HubSpot expõe um identificador específico para o redimensionador
  // do composer ativo. Ele é preferido para que o painel acompanhe tanto Chat
  // quanto Observação sem depender das classes internas/dinâmicas do HubSpot.
  const COMPOSER_HANDLE_SELECTOR = '[data-test-id="composer-drag-resize-handle"]';
  const LEGACY_DRAG_HANDLE_SELECTOR = '[data-transitional-component="DragHandle"]';
  const DRAG_HANDLE_SELECTOR = `${COMPOSER_HANDLE_SELECTOR}, ${LEGACY_DRAG_HANDLE_SELECTOR}`;
  const ROW_SELECTOR = '[data-test-id^="thread-list-member-row"]';
  const HEADER_SELECTOR = '[data-test-id="member-header"]';
  const PANEL_ID = 'hs-historical-summary-panel';
  const SLOT_ID = 'hs-historical-summary-slot';
  const PLACEHOLDER_RE = /^(?:nenhum histórico anterior disponível|nenhum historico anterior disponivel)/i;

  let observer = null;
  let scanTimer = null;
  let contextTimer = null;
  let pendingPollTimer = null;
  let pendingPollDeadline = 0;
  let lastSummary = "";
  let lastContextSignature = "";
  let lastHref = location.href;
  let expanded = false;
  let collapsed = false;
  let cachedInsertionPoint = null;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getSummaryText() {
    const node = document.querySelector(SUMMARY_SELECTOR);
    if (!node) return "";
    const text = normalizeText(node.innerText || node.textContent || "");
    if (!text || PLACEHOLDER_RE.test(text)) return "";
    return text;
  }

  function getContextSignature() {
    const selected = document.querySelector(
      `${ROW_SELECTOR}[aria-selected="true"], ${ROW_SELECTOR}[data-selected="true"]`
    );
    const header = selected?.querySelector(HEADER_SELECTOR);
    const title = normalizeText(header?.textContent || "").slice(0, 180);
    return `${location.href}|${title}`;
  }

  function stopPendingPoll() {
    if (pendingPollTimer) clearInterval(pendingPollTimer);
    pendingPollTimer = null;
    pendingPollDeadline = 0;
  }

  function removePanel() {
    document.getElementById(SLOT_ID)?.remove();
    document.getElementById(PANEL_ID)?.remove();
    EXT.updateDiagnostic({
      historicalSummaryVisible: false,
    });
  }

  function clearForTicketChange() {
    stopPendingPoll();
    lastSummary = "";
    expanded = false;
    collapsed = false;
    removePanel();
  }

  function invalidateAnchor() {
    cachedInsertionPoint = null;
  }

  function isVisibleElement(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 1) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function getPreferredHandleEntries() {
    // Primeiro usamos o seletor específico do composer. Em versões/estados do
    // HubSpot onde ele ainda não exista, preservamos o DragHandle anterior como
    // fallback para não regredir o comportamento já aprovado no Chat.
    const composerHandles = Array.from(document.querySelectorAll(COMPOSER_HANDLE_SELECTOR))
      .filter(isVisibleElement)
      .map((handle) => ({ handle, composerSpecific: true }));

    if (composerHandles.length) return composerHandles;

    return Array.from(document.querySelectorAll(LEGACY_DRAG_HANDLE_SELECTOR))
      .filter(isVisibleElement)
      .map((handle) => ({ handle, composerSpecific: false }));
  }

  function findBestAnchor() {
    const entries = getPreferredHandleEntries();
    const candidates = [];

    for (const entry of entries) {
      const { handle, composerSpecific } = entry;
      let node = handle;
      let chosen = null;

      // O data-test-id específico já representa a barra horizontal do composer.
      // No fallback legado ainda subimos alguns níveis até localizar essa barra.
      const maxDepth = composerSpecific ? 2 : 5;
      for (let depth = 0; depth < maxDepth && node; depth += 1, node = node.parentElement) {
        const rect = node.getBoundingClientRect();
        const wideEnough = rect.width >= Math.min(420, Math.max(300, window.innerWidth * 0.28));
        const horizontal = rect.width > Math.max(1, rect.height) * 3.5;
        const usableHeight = rect.height > 0 && rect.height < 180;
        if (wideEnough && horizontal && usableHeight) {
          chosen = { element: node, rect, sourceHandle: handle, composerSpecific };
          break;
        }
      }

      if (!chosen) continue;
      const { rect } = chosen;
      if (rect.bottom < window.innerHeight * 0.35 || rect.top > window.innerHeight * 0.98) continue;
      if (rect.right < window.innerWidth * 0.35) continue;

      const bottomAffinity = Math.max(
        0,
        1 - Math.abs(rect.top - window.innerHeight * 0.72) / window.innerHeight
      );
      const leftPenalty = rect.left > window.innerWidth * 0.72 ? 800 : 0;
      // O composer-drag-resize-handle recebe prioridade explícita sobre o
      // DragHandle genérico quando ambos aparecem simultaneamente no DOM.
      const specificBonus = composerSpecific ? 1500 : 0;
      const score = rect.width + bottomAffinity * 350 - leftPenalty + specificBonus;
      candidates.push({ ...chosen, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function isCachedPointUsable(point) {
    return !!(
      point?.parent?.isConnected &&
      point?.reference?.isConnected &&
      point.reference.parentElement === point.parent &&
      (!point?.sourceHandle || point.sourceHandle.isConnected)
    );
  }

  function findComposerRoot(handle) {
    if (!(handle instanceof Element)) return null;
    const handleRect = handle.getBoundingClientRect();
    let node = handle.parentElement;
    let best = null;

    // Procuramos o menor ancestral que claramente representa o bloco do composer:
    // largura semelhante à barra, começa próximo dela e possui conteúdo abaixo.
    // O limite de altura impede que escolhamos a coluna inteira da conversa.
    for (let depth = 0; depth < 6 && node?.parentElement; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const similarWidth = rect.width >= handleRect.width * 0.82;
      const startsNearHandle = rect.top <= handleRect.top + 24 && rect.top >= handleRect.top - 70;
      const hasComposerBody = rect.bottom >= handleRect.bottom + 55;
      const reasonableHeight = rect.height >= 75 && rect.height <= Math.max(520, window.innerHeight * 0.55);
      const central = rect.right > window.innerWidth * 0.38 && rect.left < window.innerWidth * 0.80;

      if (similarWidth && startsNearHandle && hasComposerBody && reasonableHeight && central) {
        best = node;
        break;
      }
    }

    // Mesmo que o HubSpot altere levemente a estrutura, o pai imediato é um
    // fallback mais seguro que inserir o painel sobre o conteúdo do editor.
    return best || handle.parentElement;
  }

  // O composer específico permite posicionar o painel como IRMÃO do bloco do
  // editor. Assim ele ocupa espaço real e empurra mensagens/editor nas duas abas.
  // O algoritmo anterior é mantido apenas como fallback para versões do HubSpot
  // que não exponham data-test-id="composer-drag-resize-handle".
  function findInsertionPoint() {
    if (isCachedPointUsable(cachedInsertionPoint)) return cachedInsertionPoint;

    const anchor = findBestAnchor();
    if (!anchor?.element) return null;

    if (anchor.composerSpecific && anchor.sourceHandle) {
      const composerRoot = findComposerRoot(anchor.sourceHandle);
      if (composerRoot?.parentElement) {
        cachedInsertionPoint = {
          parent: composerRoot.parentElement,
          reference: composerRoot,
          anchor,
          sourceHandle: anchor.sourceHandle,
          mode: "composer-specific",
        };
        return cachedInsertionPoint;
      }
    }

    let node = anchor.element;
    let fallback = null;

    for (let depth = 0; depth < 5 && node?.parentElement; depth += 1, node = node.parentElement) {
      const parent = node.parentElement;
      const nodeRect = node.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      const display = style.display || "";
      const direction = style.flexDirection || "row";

      const central = parentRect.right > window.innerWidth * 0.38 && parentRect.left < window.innerWidth * 0.78;
      const wide = parentRect.width >= Math.min(420, Math.max(300, window.innerWidth * 0.28));
      const room = parentRect.height >= Math.max(140, nodeRect.height + 80);
      if (!central || !wide) continue;

      const isColumnFlex = display.includes("flex") && direction.startsWith("column");
      const isNormalFlow = !display.includes("flex") && !display.includes("table");

      if ((isColumnFlex || isNormalFlow) && room) {
        cachedInsertionPoint = {
          parent,
          reference: node,
          anchor,
          sourceHandle: anchor.sourceHandle,
          mode: "legacy",
        };
        return cachedInsertionPoint;
      }

      if (!fallback && !display.includes("flex")) {
        fallback = {
          parent,
          reference: node,
          anchor,
          sourceHandle: anchor.sourceHandle,
          mode: "legacy-fallback",
        };
      }
    }

    cachedInsertionPoint = fallback || {
      parent: anchor.element.parentElement,
      reference: anchor.element,
      anchor,
      sourceHandle: anchor.sourceHandle,
      mode: "legacy-direct",
    };
    return cachedInsertionPoint;
  }

  function getCurrentComposerHandle() {
    const specific = Array.from(document.querySelectorAll(COMPOSER_HANDLE_SELECTOR))
      .filter(isVisibleElement);
    if (!specific.length) return null;

    // Normalmente existe apenas um composer ativo. Se houver mais de um no DOM,
    // preferimos o que estiver na região inferior/central da tela.
    return specific
      .map((handle) => {
        const rect = handle.getBoundingClientRect();
        const bottomAffinity = Math.max(0, 1 - Math.abs(rect.top - window.innerHeight * 0.72) / window.innerHeight);
        const central = rect.right > window.innerWidth * 0.38 && rect.left < window.innerWidth * 0.80;
        return { handle, score: (central ? 1000 : 0) + rect.width + bottomAffinity * 300 };
      })
      .sort((a, b) => b.score - a.score)[0]?.handle || null;
  }

  function splitSummary(text) {
    const marker = /Ponto recorrente\/padrão\s*:\s*/i;
    const match = marker.exec(text);
    if (!match) return { main: text, recurring: "" };
    return {
      main: text.slice(0, match.index).trim(),
      recurring: text.slice(match.index + match[0].length).trim(),
    };
  }

  function syncCollapseUI(panel) {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    const collapseToggle = panel.querySelector('[data-role="collapse-toggle"]');
    if (collapseToggle) {
      collapseToggle.textContent = collapsed ? "Expandir" : "Minimizar";
      collapseToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      collapseToggle.title = collapsed
        ? "Expandir resumo histórico"
        : "Minimizar resumo histórico";
    }
  }

  function makePanel() {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "hs-historical-summary-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Histórico anterior do cliente gerado pela IA do HubSpot");
    panel.dataset.expanded = "false";
    panel.dataset.collapsed = "false";

    const header = document.createElement("div");
    header.className = "hs-historical-summary-header";

    const heading = document.createElement("div");
    heading.className = "hs-historical-summary-heading";
    heading.textContent = "🧠 Histórico anterior do cliente";

    const controls = document.createElement("div");
    controls.className = "hs-historical-summary-header-controls";

    const badge = document.createElement("span");
    badge.className = "hs-historical-summary-badge";
    badge.textContent = "IA HubSpot";

    const collapseToggle = document.createElement("button");
    collapseToggle.type = "button";
    collapseToggle.className = "hs-historical-summary-collapse";
    collapseToggle.dataset.role = "collapse-toggle";
    collapseToggle.textContent = "Minimizar";
    collapseToggle.setAttribute("aria-expanded", "true");
    collapseToggle.title = "Minimizar resumo histórico";
    collapseToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      collapsed = !collapsed;
      syncCollapseUI(panel);
    });

    controls.append(badge, collapseToggle);
    header.append(heading, controls);

    const body = document.createElement("div");
    body.className = "hs-historical-summary-body";

    const main = document.createElement("div");
    main.className = "hs-historical-summary-main";
    main.dataset.role = "main";

    const recurringBox = document.createElement("div");
    recurringBox.className = "hs-historical-summary-recurring";
    recurringBox.dataset.role = "recurring-box";
    recurringBox.hidden = true;

    const recurringLabel = document.createElement("div");
    recurringLabel.className = "hs-historical-summary-recurring-label";
    recurringLabel.textContent = "⚠ Ponto recorrente/padrão";

    const recurringText = document.createElement("div");
    recurringText.className = "hs-historical-summary-recurring-text";
    recurringText.dataset.role = "recurring";

    recurringBox.append(recurringLabel, recurringText);
    body.append(main, recurringBox);

    const footer = document.createElement("div");
    footer.className = "hs-historical-summary-footer";

    const source = document.createElement("span");
    source.className = "hs-historical-summary-source";
    source.textContent = "Fonte: resumo histórico gerado pela IA do HubSpot";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "hs-historical-summary-toggle";
    toggle.dataset.role = "toggle";
    toggle.textContent = "Ver mais ▾";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      expanded = !expanded;
      panel.dataset.expanded = expanded ? "true" : "false";
      toggle.textContent = expanded ? "Mostrar menos ▴" : "Ver mais ▾";
    });

    footer.append(source, toggle);
    panel.append(header, body, footer);
    syncCollapseUI(panel);
    return panel;
  }

  function ensurePanelPlaced(panel) {
    const point = findInsertionPoint();

    EXT.updateDiagnostic({
      historicalSummaryAnchorFound: !!point?.parent && !!point?.reference,
      historicalSummaryVisible: !!point?.parent && !!point?.reference,
    });

    if (!point?.parent || !point?.reference) {
      document.getElementById(SLOT_ID)?.remove();
      return false;
    }

    let slot = document.getElementById(SLOT_ID);
    if (!slot) {
      slot = document.createElement("div");
      slot.id = SLOT_ID;
      slot.className = "hs-historical-summary-slot";
      slot.dataset.hsHistoricalSummarySlot = "true";
    }

    if (slot.parentElement !== point.parent || slot.nextSibling !== point.reference) {
      point.parent.insertBefore(slot, point.reference);
    }

    if (panel.parentElement !== slot) slot.appendChild(panel);
    slot.hidden = false;
    return true;
  }

  function renderSummary(text) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) panel = makePanel();

    const parts = splitSummary(text);
    const main = panel.querySelector('[data-role="main"]');
    const recurringBox = panel.querySelector('[data-role="recurring-box"]');
    const recurring = panel.querySelector('[data-role="recurring"]');
    const toggle = panel.querySelector('[data-role="toggle"]');

    if (main) main.textContent = parts.main || text;
    if (recurring) recurring.textContent = parts.recurring;
    if (recurringBox) recurringBox.hidden = !parts.recurring;

    const shouldToggle = text.length > 520 || text.split("\n").length > 6;
    if (toggle) {
      toggle.hidden = !shouldToggle;
      toggle.textContent = expanded ? "Mostrar menos ▴" : "Ver mais ▾";
    }
    panel.dataset.expanded = expanded && shouldToggle ? "true" : "false";
    syncCollapseUI(panel);
    ensurePanelPlaced(panel);
  }

  function ensurePendingPoll() {
    if (pendingPollTimer || !EXT.isEnabled("historicalSummary")) return;
    pendingPollDeadline = Date.now() + 120000;
    pendingPollTimer = setInterval(() => {
      if (!EXT.isEnabled("historicalSummary") || Date.now() > pendingPollDeadline) {
        stopPendingPoll();
        return;
      }
      // Apenas uma query pelo seletor do resumo; não reprocessa a página.
      if (getSummaryText()) {
        stopPendingPoll();
        runScanNow();
      }
    }, 400);
  }

  function scan() {
    scanTimer = null;

    if (!EXT.isEnabled("historicalSummary")) {
      stopPendingPoll();
      removePanel();
      EXT.updateDiagnostic({
        historicalSummaryEnabled: false,
        historicalSummaryFound: false,
        historicalSummaryAnchorFound: false,
      });
      return;
    }

    const signature = getContextSignature();
    if (lastContextSignature && signature !== lastContextSignature) {
      clearForTicketChange();
    }
    lastContextSignature = signature;
    lastHref = location.href;

    const text = getSummaryText();
    if (!text) {
      lastSummary = "";
      expanded = false;
      collapsed = false;
      removePanel();
      ensurePendingPoll();
      EXT.updateDiagnostic({
        historicalSummaryEnabled: true,
        historicalSummaryFound: false,
        historicalSummaryAnchorFound: false,
      });
      return;
    }

    stopPendingPoll();
    const changed = text !== lastSummary;
    let panel = document.getElementById(PANEL_ID);
    lastSummary = text;

    if (changed) {
      expanded = false;
      collapsed = false;
    }

    if (changed || !panel) {
      renderSummary(text);
      panel = document.getElementById(PANEL_ID);
    } else if (panel) {
      ensurePanelPlaced(panel);
    }

    EXT.updateDiagnostic({
      historicalSummaryEnabled: true,
      historicalSummaryFound: true,
      historicalSummaryVisible: !!document.getElementById(SLOT_ID)?.isConnected,
      historicalSummaryLastSyncAt: Date.now(),
    });
  }

  // Coalescência sem starvation: a primeira mutação agenda a leitura e as
  // mutações seguintes NÃO reiniciam o relógio.
  function scheduleScan(delay = 32) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, Math.max(0, delay));
  }

  function runScanNow() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    scan();
  }

  function elementTouchesSelector(node, selector) {
    if (!(node instanceof Element)) return false;
    return node.matches?.(selector) || !!node.querySelector?.(selector);
  }

  function isOwnUI(node) {
    const el = node instanceof Element ? node : node?.parentElement;
    return !!el?.closest?.(`#${SLOT_ID}, #${PANEL_ID}`);
  }

  function mutationHandler(records) {
    if (!EXT.isEnabled("historicalSummary")) return;

    let ticketChanged = location.href !== lastHref;
    let summaryChanged = false;
    let anchorChanged = false;

    for (const record of records) {
      if (isOwnUI(record.target)) continue;

      if (
        record.type === "attributes" &&
        (record.attributeName === "aria-selected" || record.attributeName === "data-selected") &&
        record.target instanceof Element &&
        record.target.matches?.(ROW_SELECTOR)
      ) {
        ticketChanged = true;
        continue;
      }

      if (record.type === "characterData") {
        const parent = record.target?.parentElement;
        if (parent?.closest?.(SUMMARY_SELECTOR)) summaryChanged = true;
        continue;
      }

      if (record.type === "childList") {
        const targetEl = record.target instanceof Element ? record.target : record.target?.parentElement;
        if (targetEl?.matches?.(SUMMARY_SELECTOR) || targetEl?.closest?.(SUMMARY_SELECTOR)) {
          summaryChanged = true;
        }

        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (elementTouchesSelector(node, SUMMARY_SELECTOR)) summaryChanged = true;
          if (elementTouchesSelector(node, DRAG_HANDLE_SELECTOR)) anchorChanged = true;
        }
      }
    }

    if (anchorChanged) invalidateAnchor();

    if (ticketChanged) {
      clearForTicketChange();
      invalidateAnchor();
      lastHref = location.href;
      // A leitura é síncrona: se o HubSpot já trouxe o resumo, aparece agora.
      runScanNow();
      return;
    }

    if (summaryChanged) {
      scheduleScan(0);
      return;
    }

    if (anchorChanged && lastSummary) scheduleScan(16);
  }

  function startObserver() {
    if (observer || !document.body) return;

    observer = new MutationObserver(mutationHandler);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-selected", "data-selected"],
    });

    // Primeira leitura não espera MutationObserver nem debounce.
    runScanNow();

    // Fallback leve para trocas de rota/seleção que o React faça sem expor
    // uma mutação identificável. Máximo de ~2 verificações por segundo.
    if (!contextTimer) {
      contextTimer = setInterval(() => {
        if (!EXT.isEnabled("historicalSummary")) return;
        const signature = getContextSignature();
        if (location.href !== lastHref || (lastContextSignature && signature !== lastContextSignature)) {
          clearForTicketChange();
          invalidateAnchor();
          lastHref = location.href;
          lastContextSignature = signature;
          runScanNow();
          return;
        }

        // Chat e Observação podem reconstruir o composer sem alterar URL/ticket.
        // Quando a barra ativa mudar, apenas reposicionamos o card existente.
        if (lastSummary) {
          const activeComposerHandle = getCurrentComposerHandle();
          const cachedHandle = cachedInsertionPoint?.sourceHandle || null;
          if (
            !isCachedPointUsable(cachedInsertionPoint) ||
            (activeComposerHandle && cachedHandle && activeComposerHandle !== cachedHandle) ||
            (activeComposerHandle && !cachedHandle)
          ) {
            invalidateAnchor();
            scheduleScan(0);
          }
        }
      }, 500);
    }
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (contextTimer) clearInterval(contextTimer);
    contextTimer = null;
    stopPendingPoll();
    invalidateAnchor();
    clearForTicketChange();
    EXT.updateDiagnostic({
      historicalSummaryEnabled: false,
      historicalSummaryFound: false,
      historicalSummaryAnchorFound: false,
      historicalSummaryVisible: false,
    });
  }

  EXT.onSettingsChange((_next, _previous, changed) => {
    if (!changed.includes("historicalSummary")) return;
    if (EXT.isEnabled("historicalSummary")) startObserver();
    else stopObserver();
  });

  window.addEventListener("resize", () => {
    invalidateAnchor();
    if (lastSummary) scheduleScan(16);
  }, { passive: true });

  setTimeout(() => {
    if (EXT.isEnabled("historicalSummary")) startObserver();
    else stopObserver();
  }, 350);
})();

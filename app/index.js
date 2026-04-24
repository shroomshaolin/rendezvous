(function () {
  const state = {
    personas: [],
    history: [],
    lastTranscript: "",
    pendingDividerLabel: "",
    showInnerThoughts: localStorage.getItem("rvShowInnerThoughts") === "true",
    viewMode: "live",
    sessionActive: false
  };

  async function api(path, options = {}) {
    const res = await fetch(`/api/plugin/rendezvous/${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }
  window.__rvApi = api;

  /* ===== Rendezvous Sapphire/Kokoro TTS ===== */
  const RV_TTS_VOICE_KEYS = {
    one: "rendezvous.tts.voice1.v1",
    two: "rendezvous.tts.voice2.v1",
    user: "rendezvous.tts.userVoice.v1"
  };
  const RV_TTS_SPEED_KEY = "rendezvous.tts.sapphireSpeed.v1";
  const RV_TTS_AUTO_KEY = "rendezvous.tts.autoVoice.v1";

  function rvCleanText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/⊕/g, "")
      .trim();
  }

  function rvNormText(value) {
    return rvCleanText(value).toLowerCase();
  }

  function rvCsrfHeaders() {
    const token =
      document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ||
      window.csrfToken ||
      window.CSRF_TOKEN ||
      "";

    return token ? { "X-CSRF-Token": token } : {};
  }

  function rvStoredVoice(slot = "one") {
    try {
      return localStorage.getItem(RV_TTS_VOICE_KEYS[slot] || RV_TTS_VOICE_KEYS.one) || "";
    } catch (err) {
      return "";
    }
  }

  function rvSetStoredVoice(slot = "one", value = "") {
    try {
      localStorage.setItem(RV_TTS_VOICE_KEYS[slot] || RV_TTS_VOICE_KEYS.one, value || "");
    } catch (err) {}
  }

  function rvStoredSpeed() {
    try {
      const raw = localStorage.getItem(RV_TTS_SPEED_KEY);
      const value = raw ? Number(raw) : 1.0;
      return Number.isFinite(value) ? value : 1.0;
    } catch (err) {
      return 1.0;
    }
  }

  function rvSetStoredSpeed(value) {
    try {
      localStorage.setItem(RV_TTS_SPEED_KEY, String(value));
    } catch (err) {}
  }

  function rvAutoVoiceEnabled() {
    try {
      return localStorage.getItem(RV_TTS_AUTO_KEY) === "true";
    } catch (err) {
      return false;
    }
  }

  function rvSetAutoVoice(value) {
    try {
      localStorage.setItem(RV_TTS_AUTO_KEY, value ? "true" : "false");
    } catch (err) {}
  }

  function rvSplitText(text) {
    const clean = rvCleanText(text);
    if (!clean) return [];

    const chunks = [];
    let rest = clean;

    while (rest.length > 0) {
      if (rest.length <= 360) {
        chunks.push(rest);
        break;
      }

      let cut = rest.lastIndexOf(". ", 360);
      if (cut < 120) cut = rest.lastIndexOf("; ", 360);
      if (cut < 120) cut = rest.lastIndexOf(", ", 360);
      if (cut < 120) cut = 360;

      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }

    return chunks.filter(Boolean);
  }

  function rvTtsStatus(text) {
    const status = document.getElementById("rv-tts-status");
    if (status) status.textContent = text;
  }

  function rvUpdateAutoButton(root = document) {
    const btn = root.querySelector("#rv-tts-auto");
    if (!btn) return;
    btn.textContent = rvAutoVoiceEnabled() ? "🟢 Auto Voice: On" : "⚪ Auto Voice: Off";
  }

  function rvStopLocalAudio() {
    const audio = window.__rvTtsAudio;
    if (audio) {
      try {
        audio.pause();
        audio.src = "";
      } catch (err) {}
    }

    if (window.__rvTtsObjectUrl) {
      try {
        URL.revokeObjectURL(window.__rvTtsObjectUrl);
      } catch (err) {}
      window.__rvTtsObjectUrl = "";
    }
  }

  async function rvStopSpeaking(options = {}) {
    if (!options.keepQueue) {
      window.__rvTtsQueueToken = (window.__rvTtsQueueToken || 0) + 1;
    }

    window.__rvTtsSpeaking = false;

    if (window.__rvTtsAbortController) {
      try {
        window.__rvTtsAbortController.abort();
      } catch (err) {}
      window.__rvTtsAbortController = null;
    }

    rvStopLocalAudio();

    try {
      window.speechSynthesis.cancel();
    } catch (err) {}

    try {
      await fetch("/api/tts/stop", {
        method: "POST",
        credentials: "same-origin",
        headers: rvCsrfHeaders()
      });
    } catch (err) {}

    rvTtsStatus("Stopped.");
  }

  window.__rvTtsStopSpeaking = rvStopSpeaking;

  function rvVoiceOptionsHtml(voices, saved, fallbackVoice = "") {
    const want = saved || fallbackVoice || "";
    const body = voices.length
      ? voices.map((voice) => {
          const id = voice.voice_id || voice.id || voice.name || "";
          const label = `${voice.name || id}${voice.category ? " — " + voice.category : ""}`;
          const selected = id === want ? " selected" : "";
          return `<option value="${escapeHtml(id)}"${selected}>${escapeHtml(label)}</option>`;
        }).join("")
      : `<option value="">Default Sapphire voice</option>`;

    return `<option value="">Default Sapphire voice</option>${body}`;
  }

  async function rvLoadSapphireVoices(root) {
    const selects = Array.from(root.querySelectorAll(".rv-tts-voice-select"));
    const rate = root.querySelector("#rv-tts-rate");
    if (!selects.length) return;

    try {
      const res = await fetch("/api/tts/voices", {
        method: "GET",
        credentials: "same-origin"
      });

      if (!res.ok) throw new Error(`voices ${res.status}`);

      const data = await res.json();
      const voices = Array.isArray(data.voices) ? data.voices : [];
      const defaultVoice = data.default_voice || (voices[0] && (voices[0].voice_id || voices[0].id || voices[0].name)) || "";
      const secondVoice = voices[1] ? (voices[1].voice_id || voices[1].id || voices[1].name || "") : "";

      selects.forEach((select) => {
        const slot = select.getAttribute("data-rv-tts-slot") || "one";
        const saved = rvStoredVoice(slot);
        const fallback = slot === "two" ? (secondVoice || defaultVoice) : defaultVoice;
        select.innerHTML = rvVoiceOptionsHtml(voices, saved, fallback);

        if (saved || fallback) {
          select.value = saved || fallback;
          rvSetStoredVoice(slot, select.value || "");
        }
      });

      if (rate && data.speed_min != null && data.speed_max != null) {
        rate.min = String(data.speed_min);
        rate.max = String(data.speed_max);
      }

      rvTtsStatus(`Sapphire TTS ready${data.provider ? " · " + data.provider : ""}.`);
    } catch (err) {
      selects.forEach((select) => {
        select.innerHTML = `<option value="">Browser fallback</option>`;
      });
      rvTtsStatus("Sapphire voices unavailable; browser fallback ready.");
    }
  }

  async function rvPlayAudioBlob(blob) {
    rvStopLocalAudio();

    const url = URL.createObjectURL(blob);
    window.__rvTtsObjectUrl = url;

    const audio = new Audio(url);
    window.__rvTtsAudio = audio;

    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("Audio playback failed."));
      audio.oncanplaythrough = () => {
        rvTtsStatus("Sapphire audio ready; playing…");
      };
      audio.play().catch((err) => {
        reject(new Error(`Browser refused Sapphire audio playback: ${err && err.message ? err.message : err}`));
      });
    });
  }

  async function rvSpeakWithSapphire(text, label = "Reading", voiceOverride = "") {
    const chunks = rvSplitText(text);
    if (!chunks.length) {
      rvTtsStatus("Nothing to read yet.");
      return;
    }

    await rvStopSpeaking({ keepQueue: true });
    window.__rvTtsSpeaking = true;

    const voice = voiceOverride || rvStoredVoice("one");
    const speed = rvStoredSpeed();

    for (let i = 0; i < chunks.length; i += 1) {
      if (!window.__rvTtsSpeaking) return;

      rvTtsStatus(`${label} with Sapphire voice… ${i + 1}/${chunks.length}`);

      const controller = new AbortController();
      window.__rvTtsAbortController = controller;

      const res = await fetch("/api/tts/preview", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...rvCsrfHeaders()
        },
        body: JSON.stringify({
          text: chunks[i],
          voice: voice || undefined,
          speed: speed,
          pitch: 1.0
        })
      });

      if (!res.ok) {
        let msg = `Sapphire TTS failed (${res.status})`;
        try {
          const data = await res.json();
          msg = data.detail || data.error || msg;
        } catch (err) {}
        throw new Error(msg);
      }

      const blob = await res.blob();

      if (!blob || blob.size < 128) {
        throw new Error(`Sapphire TTS returned empty audio (${blob ? blob.size : 0} bytes).`);
      }

      rvTtsStatus(`Playing Sapphire audio… ${Math.round(blob.size / 1024)} KB`);
      await rvPlayAudioBlob(blob);
    }

    window.__rvTtsSpeaking = false;
    rvTtsStatus("Finished reading.");
  }

  function rvSpeakWithBrowserFallback(text, label = "Reading") {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        rvTtsStatus("Read aloud is not supported in this browser.");
        resolve();
        return;
      }

      const chunks = rvSplitText(text);
      if (!chunks.length) {
        rvTtsStatus("Nothing to read yet.");
        resolve();
        return;
      }

      try {
        window.speechSynthesis.cancel();
      } catch (err) {}

      window.__rvTtsSpeaking = true;
      rvTtsStatus(`${label} with browser fallback…`);

      let index = 0;

      const speakNext = () => {
        if (!window.__rvTtsSpeaking) {
          resolve();
          return;
        }

        if (index >= chunks.length) {
          window.__rvTtsSpeaking = false;
          rvTtsStatus("Finished reading.");
          resolve();
          return;
        }

        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        utterance.rate = Math.max(0.65, Math.min(1.35, rvStoredSpeed()));
        utterance.pitch = 1.0;
        utterance.volume = 1.0;

        utterance.onend = () => {
          index += 1;
          speakNext();
        };

        utterance.onerror = () => {
          window.__rvTtsSpeaking = false;
          rvTtsStatus("Read aloud stopped.");
          resolve();
        };

        window.speechSynthesis.speak(utterance);
      };

      speakNext();
    });
  }

  async function rvSpeakText(text, label = "Reading", voiceOverride = "") {
    try {
      await rvSpeakWithSapphire(text, label, voiceOverride);
    } catch (err) {
      if (!window.__rvTtsSpeaking) {
        rvTtsStatus("Stopped.");
        return;
      }

      console.warn("Rendezvous Sapphire TTS failed; falling back to browser TTS.", err);
      rvTtsStatus("Sapphire TTS failed; using browser voice.");
      await rvSpeakWithBrowserFallback(text, label);
    }
  }

  function rvPersonaTokens(selector) {
    const select = document.querySelector(selector);
    if (!select) return [];

    const out = [];
    out.push(select.value || "");

    const option = select.options && select.selectedIndex >= 0
      ? select.options[select.selectedIndex]
      : null;

    if (option) out.push(option.textContent || "");

    return out.map(rvNormText).filter(Boolean);
  }

  function rvUserSpeakerName(speaker) {
    const key = rvNormText(speaker);
    return key === "donna" || key === "user" || key === "you" || key === "mystic";
  }

  function rvSpeakerOrderFromTranscript() {
    const parsed = splitTranscript(state.lastTranscript || "") || {};
    const entries = filterTranscriptParts(parsed.entries || []);
    const order = [];

    entries.forEach((entry) => {
      if (!entry || isInnerThoughtPart(entry)) return;

      const speaker = rvNormText(entry.speaker || entry.name || "");
      if (!speaker || rvUserSpeakerName(speaker) || speaker === "scene") return;

      if (!order.includes(speaker)) order.push(speaker);
    });

    return order;
  }

  function rvSlotForSpeaker(speaker) {
    const key = rvNormText(speaker);

    if (rvUserSpeakerName(key)) return "user";

    const oneTokens = rvPersonaTokens("#rv-persona-1");
    const twoTokens = rvPersonaTokens("#rv-persona-2");

    if (oneTokens.some(token => token && (key === token || token.includes(key) || key.includes(token)))) {
      return "one";
    }

    if (twoTokens.some(token => token && (key === token || token.includes(key) || key.includes(token)))) {
      return "two";
    }

    const order = rvSpeakerOrderFromTranscript();

    if (order[0] && key === order[0]) return "one";
    if (order[1] && key === order[1]) return "two";

    return order.length % 2 === 0 ? "one" : "two";
  }

  function rvVoiceForEntry(entry) {
    const slot = rvSlotForSpeaker(entry && (entry.speaker || entry.name || ""));
    return rvStoredVoice(slot);
  }

  function rvEntryReadText(entry) {
    if (!entry || isInnerThoughtPart(entry)) return "";

    const body = rvCleanText(entry.body || entry.text || entry.content || "");
    if (!body) return "";

    const speaker = rvCleanText(entry.speaker || entry.name || "");
    return speaker ? `${speaker}: ${body}` : body;
  }

  function rvEntrySpeechText(entry) {
    if (!entry || isInnerThoughtPart(entry)) return "";

    const body = rvCleanText(entry.body || entry.text || entry.content || "");
    if (!body) return "";

    return body;
  }

  async function rvSpeakEntriesSequentially(entries) {
    const readable = entries
      .filter(entry => entry && !isInnerThoughtPart(entry))
      .map(entry => ({ entry, text: rvEntrySpeechText(entry) }))
      .filter(item => item.text);

    if (!readable.length) return;

    const token = (window.__rvTtsQueueToken || 0) + 1;
    window.__rvTtsQueueToken = token;

    for (const item of readable) {
      if (window.__rvTtsQueueToken !== token) return;
      if (!rvAutoVoiceEnabled()) return;

      const speaker = rvCleanText(item.entry.speaker || item.entry.name || "Turn");
      const voice = rvVoiceForEntry(item.entry);

      await rvSpeakText(item.text, speaker ? `Reading ${speaker}` : "Reading turn", voice);

      if (window.__rvTtsQueueToken !== token) return;
    }
  }

  function rvMaybeAutoSpeakTranscript(currentRaw) {
    const current = String(currentRaw || "");
    const previous = String(window.__rvTtsLastAutoRaw || "");


    if (!rvAutoVoiceEnabled()) return;

    if (
      window.__rvTtsAutoTimer &&
      String(window.__rvTtsPendingRaw || "") === current
    ) {
      return;
    }

    if (window.__rvTtsAutoTimer) {
      clearTimeout(window.__rvTtsAutoTimer);
      window.__rvTtsAutoTimer = null;
    }

    if (!previous.trim()) {
      const parsed = splitTranscript(current) || {};
      const entries = filterTranscriptParts(parsed.entries || [])
        .filter(entry => entry && !isInnerThoughtPart(entry));

      if (!state.sessionActive || !entries.length) {
        window.__rvTtsLastAutoRaw = current;
        return;
      }
    }

    window.__rvTtsPendingRaw = current;

    window.__rvTtsAutoTimer = setTimeout(() => {
      const stableCurrent = String(window.__rvTtsPendingRaw || "");
      const stablePrevious = String(window.__rvTtsLastAutoRaw || "");

      if (!rvAutoVoiceEnabled()) return;
      if (!stableCurrent.trim() || stableCurrent === stablePrevious) return;

      const previousParsed = splitTranscript(stablePrevious) || {};
      const currentParsed = splitTranscript(stableCurrent) || {};

      const previousEntries = filterTranscriptParts(previousParsed.entries || [])
        .filter(entry => entry && !isInnerThoughtPart(entry));

      const currentEntries = filterTranscriptParts(currentParsed.entries || [])
        .filter(entry => entry && !isInnerThoughtPart(entry));

      if (currentEntries.length <= previousEntries.length) {
        window.__rvTtsLastAutoRaw = stableCurrent;
        return;
      }

      const freshEntries = currentEntries.slice(previousEntries.length);


      if (freshEntries.length) {
        window.__rvTtsLastAutoRaw = stableCurrent;
        rvSpeakEntriesSequentially(freshEntries).catch((err) => {
          console.warn("Rendezvous auto voice failed.", err);
          rvTtsStatus("Auto voice failed.");
        });
      } else {
        window.__rvTtsLastAutoRaw = stableCurrent;
      }
    }, state.sessionActive ? 3200 : 400);
  }

  function initRvTtsControls(root) {
    if (!root || root.__rvTtsControlsReady) return;
    root.__rvTtsControlsReady = true;

    root.querySelectorAll(".rv-tts-voice-select").forEach((select) => {
      const slot = select.getAttribute("data-rv-tts-slot") || "one";
      select.addEventListener("change", () => {
        rvSetStoredVoice(slot, select.value || "");
        const label = slot === "two" ? "Voice 2" : slot === "user" ? "User voice" : "Voice 1";
        rvTtsStatus(select.value ? `${label} set: ${select.value}` : `${label}: default voice.`);
      });
    });

    const rateInput = root.querySelector("#rv-tts-rate");
    if (rateInput) {
      rateInput.value = String(rvStoredSpeed());
      rateInput.addEventListener("input", () => {
        const value = Number(rateInput.value || "1");
        rvSetStoredSpeed(value);
        rvTtsStatus(`Speed: ${value.toFixed(2)}x`);
      });
    }

    const auto = root.querySelector("#rv-tts-auto");
    if (auto) {
      rvUpdateAutoButton(root);
      auto.addEventListener("click", () => {
        const next = !rvAutoVoiceEnabled();
        rvSetAutoVoice(next);
        window.__rvTtsLastAutoRaw = state.lastTranscript || "";
        rvUpdateAutoButton(root);
        rvTtsStatus(next ? "Auto voice on. New turns will speak." : "Auto voice off.");
      });
    }

    const stop = root.querySelector("#rv-tts-stop");
    if (stop) {
      stop.addEventListener("click", async () => {
        await rvStopSpeaking();
      });
    }

    setTimeout(() => rvLoadSapphireVoices(root), 50);
  }

  window.__rvTtsAutoTimer = null;

  window.addEventListener("beforeunload", () => {
    rvStopSpeaking();
  });



  function turnsEachToMessages(value) {
    return Math.max(1, parseInt(value, 10) || 2) * 2;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function personaTrimColor(name) {
    const key = String(name || "").trim().toLowerCase();
    const hit = (state.personas || []).find(p => {
      const k = String(p.key || "").trim().toLowerCase();
      const n = String(p.name || "").trim().toLowerCase();
      return key === k || key === n;
    });

    const color = String((hit && hit.trim_color) || "").trim();
    return color || "";
  }

  function speakerColor(name) {
    const key = String(name || "").trim().toLowerCase();

    if (key === "donna") return "#ffb347";
    if (key === "scene") return "#9bbcff";

    const trim = personaTrimColor(key);
    if (trim) return trim;

    const palette = [
      "#7dd3fc",
      "#86efac",
      "#f9a8d4",
      "#fca5a5",
      "#c4b5fd",
      "#fdba74",
      "#93c5fd",
      "#fcd34d",
      "#a7f3d0",
      "#d8b4fe"
    ];

    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
    }

    return palette[Math.abs(hash) % palette.length];
  }

  function splitTranscript(text) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/);

    let scene = "";
    const entries = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("Scene:")) {
        scene = trimmed;
        continue;
      }

      const match = trimmed.match(/^([^:]+):\s*(.*)$/);
      if (match) {
        entries.push({
          type: "line",
          speaker: match[1].trim(),
          body: match[2].trim()
        });
      } else {
        entries.push({
          type: "note",
          body: trimmed
        });
      }
    }

    return { scene, entries };
  }


  function normalizeThoughtText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\\*_`:#>\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isInnerThoughtPart(part) {
    const header = normalizeThoughtText([
      part && part.speaker,
      part && part.role,
      part && part.label,
      part && part.title,
      part && part.header,
      part && part.name,
      part && part.type,
      part && part.kind
    ].filter(Boolean).join(" "));

    const body = normalizeThoughtText([
      part && part.text,
      part && part.body,
      part && part.content
    ].filter(Boolean).join(" "));

    return (
      header.includes("inner thoughts") ||
      header.includes("inner thought") ||
      header.includes("private thoughts") ||
      header.includes("private thought") ||
      body.startsWith("inner thoughts") ||
      body.startsWith("inner thought") ||
      body.startsWith("private thoughts") ||
      body.startsWith("private thought")
    );
  }

  function filterTranscriptParts(parts) {
    let normalized = [];

    if (Array.isArray(parts)) {
      normalized = parts;
    } else if (parts && Array.isArray(parts.parts)) {
      normalized = parts.parts;
    } else if (parts && Array.isArray(parts.lines)) {
      normalized = parts.lines;
    } else if (parts && typeof parts[Symbol.iterator] === "function" && typeof parts !== "string") {
      normalized = Array.from(parts);
    } else if (typeof parts === "string") {
      const parsed = splitTranscript(parts);

      if (Array.isArray(parsed)) {
        normalized = parsed;
      } else if (parsed && Array.isArray(parsed.parts)) {
        normalized = parsed.parts;
      } else if (parsed && Array.isArray(parsed.lines)) {
        normalized = parsed.lines;
      } else {
        normalized = [];
      }
    } else {
      normalized = [];
    }

    if (!Array.isArray(normalized)) {
      normalized = [];
    }

    return state.showInnerThoughts
      ? normalized
      : normalized.filter(part => !isInnerThoughtPart(part));
  }

  function renderTranscriptHtml(text) {
    const raw = String(text || "");
    if (!raw.trim()) return "";

    const current = splitTranscript(raw) || {};
    const previous = splitTranscript(state.lastTranscript || "") || {};
    const currentEntries = filterTranscriptParts(current.entries || current);
    const previousEntries = filterTranscriptParts(previous.entries || previous);

    let firstNewIndex = -1;
    if (state.lastTranscript && state.viewMode === "live") {
      const prevLen = previousEntries.length;
      const currLen = currentEntries.length;
      if (currLen > prevLen) firstNewIndex = prevLen;
    }

    const html = [];

    if (current.scene) {
      html.push(
        `<div style="
          position: sticky;
          top: 0;
          z-index: 2;
          margin: 0 0 14px 0;
          padding: 10px 12px;
          border: 1px solid #3b4d7a;
          border-radius: 10px;
          background: rgba(32,40,70,.92);
          color: ${speakerColor("scene")};
          font-weight: 700;
          backdrop-filter: blur(4px);
        ">${escapeHtml(current.scene)}</div>`
      );
    }

    currentEntries.forEach((entry, index) => {
      if (firstNewIndex === index && state.pendingDividerLabel) {
        html.push(
          `<div style="display:flex; align-items:center; gap:10px; margin:14px 0 16px 0;">
             <div style="height:1px; flex:1; background:linear-gradient(90deg, transparent, #7c3aed, transparent);"></div>
             <div style="
               padding: 4px 10px;
               border: 1px solid #7c3aed;
               border-radius: 999px;
               color: #d8b4fe;
               font-size: 12px;
               font-weight: 700;
               letter-spacing: .04em;
               text-transform: uppercase;
               background: rgba(76, 29, 149, .18);
             ">${escapeHtml(state.pendingDividerLabel)}</div>
             <div style="height:1px; flex:1; background:linear-gradient(90deg, transparent, #7c3aed, transparent);"></div>
           </div>`
        );
      }

      if (entry.type !== "line") {
        return;
      }

      if (
        /^\*.*\*$/.test(entry.body) ||
        /^\(.*\)$/.test(entry.body) ||
        /^\[.*\]$/.test(entry.body)
      ) {
        return;
      }

      const color = speakerColor(entry.speaker);
      const isNew = firstNewIndex !== -1 && index >= firstNewIndex;

      html.push(
        `<div style="
          margin: 0 0 12px 0;
          padding: 10px 12px;
          border-radius: 12px;
          border: 1px solid ${isNew ? "rgba(124, 58, 237, .55)" : "rgba(120,120,140,.28)"};
          background: ${isNew ? "rgba(76, 29, 149, .10)" : "rgba(255,255,255,.02)"};
          box-shadow: ${isNew ? "0 0 0 1px rgba(168, 85, 247, .08) inset" : "none"};
        ">
          <div style="margin:0 0 4px 0;">
            <span style="color:${color}; font-weight:800;">${escapeHtml(entry.speaker)}</span>
          </div>
          <div style="color:#f3e8ff; white-space:pre-wrap;">${escapeHtml(entry.body)}</div>
        </div>`
      );
    });

    return html.join("");
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  function timestampForFilename() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  function downloadTextFile(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function render(root) {
    root.innerHTML = `
      <div style="max-width: 1580px; margin: 0 auto; padding: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px;">
          <div>
            <h2 style="margin:0;">🍺 Rendezvous</h2>
            <div style="opacity:.75; margin-top:6px;">A separate stage for two personas to meet, talk, and pause.</div>
          </div>
          <div id="rv-status" style="opacity:.8; font-weight:700;"></div>
        </div>

        <div style="display:grid; grid-template-columns: 290px minmax(0, 1.75fr) 290px; gap:20px; align-items:start;">
          <section style="border:1px solid #555; border-radius:12px; padding:16px;">
            <h3 style="margin-top:0;">Setup</h3>

            <label style="display:block; margin-bottom:12px;">
              <div style="margin-bottom:6px;">Persona 1</div>
              <select id="rv-persona-1" style="width:100%; padding:10px; border-radius:8px;"></select>
            </label>

            <label style="display:block; margin-bottom:12px;">
              <div style="margin-bottom:6px;">Persona 2</div>
              <select id="rv-persona-2" style="width:100%; padding:10px; border-radius:8px;"></select>
            </label>

            <label style="display:block; margin-bottom:12px;">
              <div style="margin-bottom:6px;">Scene seed</div>
              <textarea id="rv-scene" rows="4" style="width:100%; padding:10px; border-radius:8px;">meeting for beers in a quiet bar at dusk</textarea>
            </label>

            <label style="display:block; margin-bottom:12px;">
              <div style="margin-bottom:6px;">Tempo</div>
              <select id="rv-turns-each" style="width:100%; padding:10px; border-radius:8px;">
                <option value="1">Sip — 1 turn each</option>
                <option value="2" selected>Scene — 2 turns each</option>
                <option value="3">Drift — 3 turns each</option>
                <option value="5">Deep — 5 turns each</option>
              </select>
            </label>

            <button id="rv-start" style="width:100%; padding:12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Start Rendezvous</button>
          </section>

          <section style="border:1px solid #555; border-radius:12px; padding:16px; min-height:520px; max-height:calc(100vh - 170px); display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px; flex-wrap:wrap; position:sticky; top:0; z-index:2; background:rgba(24,24,32,.96); padding-bottom:10px;">
              <h3 style="margin:0;">Transcript</h3>
              <div style="display:flex; gap:8px; flex-wrap:wrap;">
                <button id="rv-copy" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Copy Transcript</button>
                <button id="rv-toggle-thoughts" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">&#x1F9E0; Inner thoughts: <span id="rv-toggle-thoughts-label">Off</span></button>
                <button id="rv-tts-auto" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #16a34a; background:rgba(20, 83, 45, .22); color:#bbf7d0; font-weight:700;">⚪ Auto Voice: Off</button>
                <button id="rv-tts-stop" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #dc2626; background:rgba(127, 29, 29, .22); color:#fecaca; font-weight:700;">⏹ Stop Voice</button>
                <label style="display:flex; align-items:center; gap:6px; color:#c4b5fd; font-size:13px;">
                  Voice 1
                  <select class="rv-tts-voice-select" data-rv-tts-slot="one" title="Voice for Persona 1" style="max-width:180px; padding:9px 10px; border-radius:10px; border:1px solid #7c3aed; background:rgba(24,24,32,.96); color:#e9d5ff;">
                    <option value="">Loading voices…</option>
                  </select>
                </label>
                <label style="display:flex; align-items:center; gap:6px; color:#c4b5fd; font-size:13px;">
                  Voice 2
                  <select class="rv-tts-voice-select" data-rv-tts-slot="two" title="Voice for Persona 2" style="max-width:180px; padding:9px 10px; border-radius:10px; border:1px solid #7c3aed; background:rgba(24,24,32,.96); color:#e9d5ff;">
                    <option value="">Loading voices…</option>
                  </select>
                </label>
                <label style="display:flex; align-items:center; gap:6px; color:#c4b5fd; font-size:13px;">
                  User
                  <select class="rv-tts-voice-select" data-rv-tts-slot="user" title="Voice for Donna/User interjections" style="max-width:180px; padding:9px 10px; border-radius:10px; border:1px solid #7c3aed; background:rgba(24,24,32,.96); color:#e9d5ff;">
                    <option value="">Loading voices…</option>
                  </select>
                </label>
                <label style="display:flex; align-items:center; gap:6px; color:#c4b5fd; font-size:13px;">
                  Speed
                  <input id="rv-tts-rate" type="range" min="0.65" max="1.35" step="0.05" value="1" style="width:82px;">
                </label>
                <span id="rv-tts-status" style="font-size:13px; color:#c4b5fd;">Voice ready.</span>
                <button id="rv-export" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Save Session</button>
                <button type="button" id="rv-archive" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Create Archive</button>
              </div>
            </div>

            <div id="rv-transcript" style="
              overflow:auto;
              flex:1;
              min-height:320px;
              max-height:calc(100vh - 300px);
              margin:0;
              padding-right:8px;
              padding-bottom:12px;
              font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
              line-height:1.35;
            "></div>
          </section>

          <section style="border:1px solid #555; border-radius:12px; padding:16px;">
            <h3 style="margin-top:0;">Controls</h3>

            <button id="rv-continue" style="width:100%; padding:12px; border-radius:10px; margin-bottom:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Continue</button>
            <button id="rv-end" style="width:100%; padding:12px; border-radius:10px; margin-bottom:10px; cursor:pointer; border:1px solid #dc2626; background:rgba(127, 29, 29, .22); color:#fecaca; font-weight:700;">End</button>
            <button id="rv-clear" style="width:100%; padding:12px; border-radius:10px; margin-bottom:16px; cursor:pointer; border:1px solid #f59e0b; background:rgba(120, 53, 15, .20); color:#fde68a; font-weight:700;">Clear Session</button>

            <label style="display:block; margin-bottom:12px;">
              <div style="margin-bottom:6px;">You say</div>
              <textarea id="rv-user-message" rows="5" style="width:100%; padding:10px; border-radius:8px;" placeholder="Type something when you want to step in..."></textarea>
            </label>

            <button id="rv-send" style="width:100%; padding:12px; border-radius:10px; margin-bottom:18px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Send My Message</button>

            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:10px;">
              <h3 style="margin:0; font-size:18px;">Archive</h3>
              <button id="rv-refresh-history" style="padding:8px 10px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Refresh</button>
            </div>

            <div id="rv-history-list" style="
              max-height: 260px;
              overflow:auto;
              border:1px solid rgba(120,120,140,.28);
              border-radius:12px;
              padding:10px;
              background: rgba(255,255,255,.02);
            "></div>
          </section>
        </div>
      </div>
    `;

    const status = root.querySelector("#rv-status");
    const transcript = root.querySelector("#rv-transcript");
    initRvTtsControls(root);

    function updateInnerThoughtsToggle() {
      const label = root.querySelector("#rv-toggle-thoughts-label");
      const btn = root.querySelector("#rv-toggle-thoughts");
      if (label) label.textContent = state.showInnerThoughts ? "On" : "Off";
      if (btn) {
        btn.style.borderColor = state.showInnerThoughts ? "#34d399" : "#7c3aed";
        btn.style.color = state.showInnerThoughts ? "#d1fae5" : "#e9d5ff";
        btn.style.background = state.showInnerThoughts
          ? "rgba(6, 95, 70, .24)"
          : "rgba(76, 29, 149, .18)";
      }
    }

    updateInnerThoughtsToggle();

    const p1 = root.querySelector("#rv-persona-1");
    const p2 = root.querySelector("#rv-persona-2");
    const userBox = root.querySelector("#rv-user-message");
    const historyList = root.querySelector("#rv-history-list");

    function setStatus(text) {
      status.textContent = text || "";
    }

    function polishTranscriptDom() {
      transcript.style.display = "flex";
      transcript.style.flexDirection = "column";
      transcript.style.gap = "16px";

      const blocks = Array.from(transcript.children);

      blocks.forEach((el) => {
        if (!(el instanceof HTMLElement)) return;

        const raw = (el.textContent || "").trim();
        const compact = raw.replace(/\s+/g, " ");
        const lower = compact.toLowerCase();

        const isDivider =
          lower === "next batch" ||
          lower === "donna steps in" ||
          lower === "new session";

        const isScene = lower.startsWith("scene:");
        const isYou = lower.startsWith("you") || lower.startsWith("donna");

        el.style.margin = "0";
        el.style.transition = "all .18s ease";
        el.style.overflowWrap = "anywhere";
        el.style.boxSizing = "border-box";

        if (isDivider) {
          el.style.alignSelf = "center";
          el.style.padding = "6px 14px";
          el.style.borderRadius = "999px";
          el.style.border = "1px solid rgba(168, 85, 247, .45)";
          el.style.background = "rgba(76, 29, 149, .14)";
          el.style.color = "#e9d5ff";
          el.style.fontSize = "13px";
          el.style.fontWeight = "800";
          el.style.letterSpacing = ".06em";
          el.style.textTransform = "uppercase";
          el.style.boxShadow = "0 0 0 1px rgba(255,255,255,.02) inset";
          return;
        }

        if (isScene) {
          el.style.margin = "0 0 2px 0";
          el.style.padding = "12px 14px 12px 16px";
          el.style.borderRadius = "14px";
          el.style.borderStyle = "solid";
          el.style.borderWidth = "1px 1px 1px 5px";
          el.style.borderColor = "rgba(59, 130, 246, .32) rgba(59, 130, 246, .22) rgba(59, 130, 246, .22) rgba(96, 165, 250, .95)";
          el.style.background = "linear-gradient(90deg, rgba(15, 23, 42, .96) 0%, rgba(20, 32, 61, .88) 100%)";
          el.style.boxShadow = "0 0 0 1px rgba(255,255,255,.02) inset";
          return;
        }

        const speaker = el.querySelector("span");
        const accent = speaker
          ? (speaker.style.color || getComputedStyle(speaker).color || "#c084fc")
          : (isYou ? "#60a5fa" : "#f472b6");

        el.style.padding = "20px 22px 20px 18px";
        el.style.borderRadius = "22px";
        el.style.borderStyle = "solid";
        el.style.borderWidth = "1px 1px 1px 6px";
        el.style.boxShadow = "0 0 0 1px rgba(255,255,255,.02) inset";

        if (isYou) {
          el.style.borderColor = "rgba(59, 130, 246, .22) rgba(59, 130, 246, .22) rgba(59, 130, 246, .22) rgba(96, 165, 250, .95)";
          el.style.background = "linear-gradient(90deg, rgba(15, 23, 42, .98) 0%, rgba(17, 24, 39, .92) 100%)";
        } else {
          el.style.borderColor = "rgba(168, 85, 247, .22) rgba(168, 85, 247, .22) rgba(168, 85, 247, .22) " + accent;
          el.style.background = "linear-gradient(90deg, rgba(46, 24, 58, .78) 0%, rgba(28, 18, 44, .52) 100%)";
        }

        if (speaker) {
          speaker.style.fontSize = "15px";
          speaker.style.fontWeight = "800";
          speaker.style.letterSpacing = ".02em";
        }

        const body = el.lastElementChild;
        if (body instanceof HTMLElement) {
          body.style.fontSize = "15px";
          body.style.lineHeight = "1.6";
          body.style.color = "#f8fafc";
        }
      });
    }

    function setTranscript(text) {
      transcript.innerHTML = renderTranscriptHtml(text || "");
      polishTranscriptDom();
      requestAnimationFrame(() => {
        transcript.scrollTop = transcript.scrollHeight;
      });
      state.lastTranscript = String(text || "");
      rvMaybeAutoSpeakTranscript(text);
      state.pendingDividerLabel = "";
    }

    function fillPersonas(items) {
      const options = items.map(p => {
        const label = p.tagline ? `${p.key} — ${p.tagline}` : (p.name || p.key);
        return `<option value="${p.key}">${escapeHtml(label)}</option>`;
      }).join("");

      p1.innerHTML = options;
      p2.innerHTML = options;

      if (items.find(p => p.key === "dawn")) p1.value = "dawn";
      if (items.find(p => p.key === "fox")) p2.value = "fox";
      if (p1.value === p2.value && items.length > 1) p2.selectedIndex = 1;
    }

    function renderHistoryList() {
    if (!Array.isArray(state.history) || !state.history.length) {
      historyList.innerHTML = `<div style="opacity:.75;">No archived sessions yet.</div>`;
      return;
    }

    historyList.innerHTML = state.history.map((item) => {
      const speakers = Array.isArray(item && item.speakers) ? item.speakers.filter(Boolean) : [];
      const title = speakers.length ? speakers.join(" × ") : String((item && item.filename) || "Archived session");

      const metaBits = [];
      if (item && item.created_at) {
        try {
          metaBits.push(new Date(item.created_at).toLocaleString());
        } catch (e) {}
      }
      if (item && item.session_id) metaBits.push(String(item.session_id));

      const meta = metaBits.join(" • ");
      const filename = String((item && item.filename) || "");

      return `
        <div style="
          margin-bottom: 10px;
          padding: 10px 12px;
          border: 1px solid #3b2b6b;
          border-radius: 12px;
          background: rgba(24,18,44,.88);
        ">
          <div style="font-weight:700; color:#f3e8ff; margin-bottom:4px;">
            ${escapeHtml(title)}
          </div>
          <div style="font-size:12px; opacity:.82; margin-bottom:6px;">
            ${escapeHtml(meta)}
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
            ${filename ? `<div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;"><button data-load-filename="${escapeHtml(filename)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Load</button><button data-delete-filename="${escapeHtml(filename)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid rgba(239,68,68,.35); background:rgba(239,68,68,.12); color:#fecaca; font-weight:700;">Delete 🗑️</button></div>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

    async function loadPersonas() {
      const data = await api("personas");
      state.personas = data.personas || [];
      fillPersonas(state.personas);
    }


    


    /* RV_FORCE_DELETE_HANDLER */
    historyList.onclick = async (e) => {
      const loadBtn = e.target.closest("[data-load-filename]");
      if (loadBtn) {
        const filename = loadBtn.getAttribute("data-load-filename") || "";
        if (!filename) {
          setStatus("Load failed: empty filename");
          return;
        }
        try {
          const data = await api("history/load", {
            method: "POST",
            body: JSON.stringify({ filename })
          });
          if (!data || data.ok === false) {
            throw new Error((data && data.error) || "Load failed");
          }
          await refreshState();
          setStatus("Archive loaded.");
        } catch (err) {
          console.error("Archive load failed:", err);
          setStatus(`Load failed: ${err.message || err}`);
        }
        return;
      }

      const btn = e.target.closest("[data-delete-filename]");
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const filename = btn.getAttribute("data-delete-filename") || "";
      if (!filename) return;

      const ok = window.confirm(`Delete archive?\n\n${filename}`);
      if (!ok) return;

      btn.disabled = true;

      try {
        const res = await fetch("/api/plugin/rendezvous/history/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename })
        });
        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        state.history = Array.isArray(data.transcripts) ? data.transcripts : [];
        renderHistoryList();
        setStatus("Archive deleted.");
      } catch (err) {
        console.error("Archive delete failed:", err);
        setStatus(`Delete failed: ${err.message || err}`);
        btn.disabled = false;
      }
    };


    
    /* RV_ARCHIVE_CAPTURE_IN_SCOPE */
    if (!root.__rvArchiveCaptureBound) {
      root.__rvArchiveCaptureBound = true;

      const __rvOriginalSetStatus = setStatus;
      let __rvStatusGuardUntil = 0;

      setStatus = function (msg) {
        const now = Date.now();
        const text = String(msg || "");

        if (text === "Idle" && now < __rvStatusGuardUntil) {
          return;
        }

        if (
          text.startsWith("Creating archive") ||
          text.startsWith("Archive created") ||
          text.startsWith("Archive failed") ||
          text.startsWith("Deleting:") ||
          text.startsWith("Archive deleted") ||
          text.startsWith("Delete failed")
        ) {
          __rvStatusGuardUntil = now + 5000;
        }

        return __rvOriginalSetStatus(text);
      };

      async function __rvReloadArchives() {
        const data = await api("transcripts");
        state.history = Array.isArray(data.transcripts) ? data.transcripts : [];
        renderHistoryList();
        return data;
      }

      root.addEventListener("click", async (e) => {
        const archiveBtn = e.target.closest("#rv-archive");
        if (archiveBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          archiveBtn.disabled = true;
          try {
            setStatus("Creating archive...");
            await api("history/save", {
              method: "POST",
              body: JSON.stringify({})
            });
            await __rvReloadArchives();
            setStatus("Archive created.");
          } catch (err) {
            console.error("Archive create failed:", err);
            setStatus(`Archive failed: ${err.message || err}`);
          } finally {
            archiveBtn.disabled = false;
          }
          return;
        }

        const delBtn = e.target.closest("[data-delete-filename]");
        if (delBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const filename = delBtn.getAttribute("data-delete-filename") || "";
          if (!filename) {
            setStatus("Delete failed: empty filename");
            return;
          }

          const ok = window.confirm(`Delete archive?\n\n${filename}`);
          if (!ok) return;

          delBtn.disabled = true;
          try {
            setStatus(`Deleting: ${filename}`);
            const data = await api("history/delete", {
              method: "POST",
              body: JSON.stringify({ filename })
            });
            state.history = Array.isArray(data.transcripts) ? data.transcripts : [];
            renderHistoryList();
            setStatus("Archive deleted.");
          } catch (err) {
            console.error("Archive delete failed:", err);
            setStatus(`Delete failed: ${err.message || err}`);
          } finally {
            delBtn.disabled = false;
          }
        }
      }, true);
    }


    setStatus("Idle");

    async function loadHistory() {
    const data = await api("transcripts");
    state.history = Array.isArray(data.transcripts) ? data.transcripts : [];
    renderHistoryList();
    return data;
  }

    let rvPollTimer = null;
    let rvPollBusy = false;

    function stopRvPolling() {
      if (rvPollTimer) {
        clearInterval(rvPollTimer);
        rvPollTimer = null;
      }
    }

    let rvActionBusy = false;
    let rvCooldownUntil = 0;
    let rvCooldownTimer = null;

    function isRvCoolingDown() {
      return Date.now() < rvCooldownUntil;
    }

    function updateRvActionButtons() {
      const disabled = rvActionBusy || isRvCoolingDown();
      [
        "#rv-start",
        "#rv-continue",
        "#rv-send",
        "#rv-end",
        "#rv-clear",
        "#rv-archive"
      ].forEach((sel) => {
        const btn = root.querySelector(sel);
        if (btn) btn.disabled = disabled;
      });
    }

    function setRvBusy(value) {
      rvActionBusy = !!value;
      updateRvActionButtons();
    }

    function startRvCooldown(ms = 1500) {
      rvCooldownUntil = Date.now() + ms;
      if (rvCooldownTimer) {
        clearTimeout(rvCooldownTimer);
        rvCooldownTimer = null;
      }
      updateRvActionButtons();
      rvCooldownTimer = setTimeout(() => {
        rvCooldownTimer = null;
        updateRvActionButtons();
      }, ms + 50);
    }

    function handleRvActionError(err, options = {}) {
      const msg = String((err && (err.message || err)) || "");
      const fallbackStatus = options.fallbackStatus || "Error";
      const writeTranscript = options.writeTranscript !== false;

      console.error(err);

      if (/429|Too Many Requests/i.test(msg)) {
        startRvCooldown(8000);
        setStatus("Rate limit hit. Cooling down for a few seconds.");
        return;
      }

      setStatus(fallbackStatus);
      if (writeTranscript) {
        setTranscript(msg);
      }
    }

    async function refreshState() {
      const data = await api("session/state");
      const s = data.state || {};
      const wasActive = !!state.sessionActive;
      state.sessionActive = !!s.active;
      state.viewMode = "live";
      setTranscript(s.transcript_text || "");
      const hasTranscript = !!String(s.transcript_text || "").trim();
      setStatus(s.active ? "Running..." : (hasTranscript ? "Paused" : "Idle"));

      if (wasActive && !state.sessionActive && rvAutoVoiceEnabled()) {
        setTimeout(() => rvMaybeAutoSpeakTranscript(s.transcript_text || ""), 150);
      }

      return s;
    }

    async function pollUntilSettled(timeoutMs = 45000, intervalMs = 2000) {
      stopRvPolling();
      const deadline = Date.now() + timeoutMs;

      const tick = async () => {
        if (rvPollBusy) return;
        rvPollBusy = true;
        try {
          const s = await refreshState();
          if (!s.active || Date.now() >= deadline) {
            stopRvPolling();
            if (!s.active) {
              await refreshState();
            }
          }
        } catch (err) {
          const msg = String((err && (err.message || err)) || "");
          if (/429|Too Many Requests/i.test(msg)) {
            console.warn("Rendezvous polling backoff:", msg);
            return;
          }
          console.warn("Rendezvous polling failed:", err);
          if (Date.now() >= deadline) {
            stopRvPolling();
          }
        } finally {
          rvPollBusy = false;
        }
      };

      setTimeout(tick, 1200);
      rvPollTimer = setInterval(tick, intervalMs);
    }

    window.__rvRefreshState = refreshState;
    window.__rvStopPolling = stopRvPolling;

    root.querySelector("#rv-start").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        setRvBusy(true);
        startRvCooldown(1500);
        state.viewMode = "live";
        state.sessionActive = true;
        window.__rvTtsLastAutoRaw = "";
        state.pendingDividerLabel = "New session";
        setStatus("Starting...");
        const turnsEach = root.querySelector("#rv-turns-each").value;
        const data = await api("session/start", {
          method: "POST",
          body: JSON.stringify({
            persona_1: p1.value,
            persona_2: p2.value,
            scene: root.querySelector("#rv-scene").value.trim(),
            turns_each: parseInt(turnsEach, 10),
            messages_per_batch: turnsEachToMessages(turnsEach)
          })
        });
        setTranscript(data.transcript || "");
        pollUntilSettled().catch((err) => console.warn("Rendezvous polling start failed:", err));
      } catch (err) {
        handleRvActionError(err);
      } finally {
        setRvBusy(false);
      }
    });

    root.querySelector("#rv-continue").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        setRvBusy(true);
        startRvCooldown(1500);
        state.viewMode = "live";
        state.sessionActive = true;
        window.__rvTtsLastAutoRaw = state.lastTranscript || window.__rvTtsLastAutoRaw || "";
        state.pendingDividerLabel = "Next batch";
        setStatus("Continuing...");
        const data = await api("session/continue", { method: "POST" });
        setTranscript(data.transcript || "");
        pollUntilSettled().catch((err) => console.warn("Rendezvous polling start failed:", err));
      } catch (err) {
        handleRvActionError(err);
      } finally {
        setRvBusy(false);
      }
    });

    root.querySelector("#rv-send").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        const msg = userBox.value.trim();
        if (!msg) {
          setStatus("Type a message first.");
          return;
        }
        setRvBusy(true);
        startRvCooldown(1500);
        state.viewMode = "live";
        state.sessionActive = true;
        window.__rvTtsLastAutoRaw = state.lastTranscript || window.__rvTtsLastAutoRaw || "";
        state.pendingDividerLabel = "Donna steps in";
        setStatus("Sending...");
        const data = await api("session/user_message", {
          method: "POST",
          body: JSON.stringify({ user_message: msg })
        });
        userBox.value = "";
        setTranscript(data.transcript || "");
        pollUntilSettled().catch((err) => console.warn("Rendezvous polling start failed:", err));
      } catch (err) {
        handleRvActionError(err);
      } finally {
        setRvBusy(false);
      }
    });

    root.querySelector("#rv-end").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        setRvBusy(true);
        startRvCooldown(1000);
        stopRvPolling();
        setStatus("Ending...");
        await api("session/end", { method: "POST" });
        userBox.value = "";
        await refreshState();
        await loadHistory();
      } catch (err) {
        handleRvActionError(err);
      } finally {
        setRvBusy(false);
      }
    });

    root.querySelector("#rv-clear").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        setRvBusy(true);
        startRvCooldown(1000);
        stopRvPolling();
        setStatus("Clearing...");
        try {
          await api("session/end", { method: "POST" });
        } catch (e) {}
        state.viewMode = "live";
        state.lastTranscript = "";
        state.pendingDividerLabel = "";
        userBox.value = "";
        transcript.innerHTML = "";
        setStatus("Cleared");
      } catch (err) {
        handleRvActionError(err);
      } finally {
        setRvBusy(false);
      }
    });

    root.querySelector("#rv-toggle-thoughts").addEventListener("click", () => {
      state.showInnerThoughts = !state.showInnerThoughts;
      localStorage.setItem("rvShowInnerThoughts", String(state.showInnerThoughts));
      transcript.innerHTML = renderTranscriptHtml(state.lastTranscript || "");
      polishTranscriptDom();
      updateInnerThoughtsToggle();
      transcript.scrollTop = transcript.scrollHeight;
    });

    root.querySelector("#rv-copy").addEventListener("click", async () => {
      try {
        if (!state.lastTranscript.trim()) {
          setStatus("Nothing to copy.");
          return;
        }
        await copyText(state.lastTranscript);
        setStatus("Transcript copied.");
      } catch (err) {
        setStatus("Copy failed.");
      }
    });

    root.querySelector("#rv-export").addEventListener("click", () => {
      if (!state.lastTranscript.trim()) {
        setStatus("Nothing to save.");
        return;
      }
      downloadTextFile(`rendezvous_${timestampForFilename()}.txt`, state.lastTranscript);
      setStatus("Session saved.");
    });

    root.querySelector("#rv-archive").addEventListener("click", async () => {
      if (rvActionBusy || isRvCoolingDown()) {
        setStatus(isRvCoolingDown() ? "Cooling down..." : "Working...");
        return;
      }

      try {
        setRvBusy(true);
        startRvCooldown(1000);
        setStatus("Creating archive...");
        const res = await fetch("/api/plugin/rendezvous/history/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        state.history = Array.isArray(data.transcripts) ? data.transcripts : [];
        renderHistoryList();
        setStatus("Archive created.");
      } catch (err) {
        handleRvActionError(err, { writeTranscript: false });
      } finally {
        setRvBusy(false);
      }
    });

    const oldRefreshBtn = root.querySelector("#rv-refresh-history");
    if (oldRefreshBtn) oldRefreshBtn.style.display = "none";
    root.querySelector("#rv-refresh-history").addEventListener("click", async () => {
      try {
        await loadHistory();
        setStatus("Archive refreshed");
      } catch (err) {
        setStatus("Refresh failed");
      }
    });

    (async () => {
      try {
        setStatus("Loading...");
        await loadPersonas();
        await loadHistory();
        const s = await refreshState();
        if (s && s.active) {
          pollUntilSettled().catch((err) => console.warn("Rendezvous polling start failed:", err));
        }
      } catch (err) {
        console.error(err); setStatus("Error");
        setTranscript(String(err));
      }
    })();
  }

  

window.__rvRefreshState = window.__rvRefreshState || (async () => {});

  const ROOT_ID = "rendezvous-app-root";
  let routeWatcher = null;

  function isRendezvousRoute() {
    return (window.location.hash || "").startsWith("#apps/rendezvous");
  }

  function unmount() {
    if (window.__rvStopPolling) {
      try { window.__rvStopPolling(); } catch (e) {}
    }
    if (window.__rvTtsStopSpeaking) {
      try {
        const p = window.__rvTtsStopSpeaking();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    }
    const existing = document.getElementById(ROOT_ID);
    if (existing) {
      existing.style.pointerEvents = "none";
      existing.style.opacity = "0";
      existing.style.visibility = "hidden";
      existing.remove();
    }
  }

  function mount() {
    let root = document.getElementById(ROOT_ID);
    let isNew = false;

    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      document.body.appendChild(root);
      isNew = true;
    }

    root.style.position = "fixed";
    root.style.left = "76px";
    root.style.right = "16px";
    root.style.top = "44px";
    root.style.bottom = "16px";
    root.style.overflow = "auto";
    root.style.zIndex = "1";
    root.style.pointerEvents = "auto";

    if (isNew) {
      render(root);
    }
  }

  function syncRoute() {
    if (isRendezvousRoute()) {
      mount();
    } else {
      unmount();
    }
  }

  function boot() {
    syncRoute();

    if (routeWatcher) clearInterval(routeWatcher);
    routeWatcher = setInterval(syncRoute, 120);
  }

  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("popstate", syncRoute);
  document.addEventListener("click", (e) => {
  if (
    e.target &&
    typeof e.target.closest === "function" &&
    (
      e.target.closest("#rv-archive-panel-clean") ||
      e.target.closest(".rv-archive-load-clean") ||
      e.target.closest(".rv-archive-delete-clean") ||
      e.target.closest("[data-filename]") ||
      e.target.closest("#rv-archive") ||
      e.target.closest("#rv-refresh-history") ||
      e.target.closest("#rv-archive-create-clean") ||
      e.target.closest("#rv-archive-refresh-clean")
    )
  ) return;
  setTimeout(syncRoute, 60);
}, true);

document.addEventListener("click", (e) => {
  const t = e.target;
  if (!t || typeof t.closest !== "function") return;
  if (
    t.closest("#rv-archive-panel-clean") ||
    t.closest(".rv-archive-load-clean") ||
    t.closest(".rv-archive-delete-clean") ||
    t.closest("[data-filename]") ||
    t.closest("#rv-archive") ||
    t.closest("#rv-refresh-history") ||
    t.closest("#rv-archive-create-clean") ||
    t.closest("#rv-archive-refresh-clean")
  ) {
    e.preventDefault();
  }
}, true);

document.addEventListener("submit", (e) => {
  const t = e.target;
  if (t && typeof t.closest === "function" && t.closest("#" + ROOT_ID)) {
    e.preventDefault();
  }
}, true);


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  })();


/* RV_NEW_ARCHIVE_PANEL */
(function () {
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function rvFetchJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function buildPanel() {
    const oldBtn = document.querySelector("#rv-archive");
    const oldList = document.querySelector("#rv-history, #rv-history-list");
    const archiveHeader = Array.from(document.querySelectorAll("h3")).find(el => (el.textContent || "").trim() === "Archive");

    if (!oldBtn || !archiveHeader) return false;
    if (document.querySelector("#rv-archive-panel-clean")) return true;

    oldBtn.style.display = "none";
    if (oldList) oldList.style.display = "none";

    const panel = document.createElement("div");
    panel.id = "rv-archive-panel-clean";
    panel.style.marginTop = "10px";

    panel.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px;">
        <button type="button" id="rv-archive-create-clean" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Create Archive</button>
        <button type="button" id="rv-archive-refresh-clean" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Refresh Archive</button>
        <div id="rv-archive-status-clean" style="font-size:12px; opacity:.85;"></div>
      </div>
      <div id="rv-archive-list-clean"></div>
    `;

    const container = archiveHeader.parentElement ? archiveHeader.parentElement.parentElement : null;
    if (container) {
      container.appendChild(panel);
    } else {
      archiveHeader.insertAdjacentElement("afterend", panel);
    }

    return true;
  }

  function setArchiveStatus(text) {
    const el = document.querySelector("#rv-archive-status-clean");
    if (el) el.textContent = text || "";
  }

  function renderArchives(items) {
    const list = document.querySelector("#rv-archive-list-clean");
    if (!list) return;

    if (!Array.isArray(items) || !items.length) {
      list.innerHTML = `<div style="opacity:.75;">No archived sessions yet.</div>`;
      return;
    }

    list.innerHTML = items.map((item) => {
      const speakers = Array.isArray(item && item.speakers) ? item.speakers.filter(Boolean) : [];
      const title = speakers.length ? speakers.join(" × ") : String((item && item.filename) || "Archived session");

      const metaBits = [];
      if (item && item.created_at) {
        try {
          metaBits.push(new Date(item.created_at).toLocaleString());
        } catch (e) {}
      }
      if (item && item.session_id) metaBits.push(String(item.session_id));

      const meta = metaBits.join(" • ");
      const filename = String((item && item.filename) || "");

      return `
        <div style="
          margin-bottom:10px;
          padding:10px 12px;
          border:1px solid #3b2b6b;
          border-radius:12px;
          background:rgba(24,18,44,.88);
        ">
          <div style="font-weight:700; color:#f3e8ff; margin-bottom:4px;">${escapeHtml(title)}</div>
          <div style="font-size:12px; opacity:.82; margin-bottom:6px;">${escapeHtml(meta)}</div>
          <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:8px;">
            ${filename ? `<div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;"><button type="button" class="rv-archive-load-clean" data-filename="${escapeHtml(filename)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Load</button><button type="button" class="rv-archive-delete-clean" data-filename="${escapeHtml(filename)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid rgba(239,68,68,.35); background:rgba(239,68,68,.12); color:#fecaca; font-weight:700;">Delete 🗑️</button></div>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  async function loadArchives() {
    setArchiveStatus("Loading...");
    const data = await rvFetchJson("/api/plugin/rendezvous/transcripts");
    renderArchives(Array.isArray(data.transcripts) ? data.transcripts : []);
    setArchiveStatus("Ready");
  }

  async function createArchive() {
    setArchiveStatus("Creating archive...");
    await rvFetchJson("/api/plugin/rendezvous/history/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    await loadArchives();
    setArchiveStatus("Archive created.");
  }

  async function deleteArchive(filename) {
    setArchiveStatus(`Deleting: ${filename}`);
    await rvFetchJson("/api/plugin/rendezvous/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename })
    });
    await loadArchives();
    setArchiveStatus("Archive deleted.");
  }

  async function init() {
    if (!buildPanel()) return;

    const createBtn = document.querySelector("#rv-archive-create-clean");
    const refreshBtn = document.querySelector("#rv-archive-refresh-clean");
    const list = document.querySelector("#rv-archive-list-clean");

    if (createBtn) {
      createBtn.onclick = async () => {
        try {
          createBtn.disabled = true;
          await createArchive();
        } catch (err) {
          console.error(err);
          setArchiveStatus(`Create failed: ${err.message || err}`);
        } finally {
          createBtn.disabled = false;
        }
      };
    }

    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        try {
          refreshBtn.disabled = true;
          await loadArchives();
        } catch (err) {
          console.error(err);
          setArchiveStatus(`Refresh failed: ${err.message || err}`);
        } finally {
          refreshBtn.disabled = false;
        }
      };
    }

    if (list) {
      list.onclick = async (e) => {
        const loadBtn = e.target.closest(".rv-archive-load-clean");
        if (loadBtn) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
const filename = loadBtn.getAttribute("data-filename") || "";
          if (!filename) {
            setArchiveStatus("Load failed: empty filename");
            return;
          }
          try {
            const data = await window.__rvApi("history/load", {
              method: "POST",
              body: JSON.stringify({ filename })
            });
            if (!data || data.ok === false) {
              throw new Error((data && data.error) || "Load failed");
            }
            const entry = (data && data.entry) || {};

            const syncSelect = (selector, wanted) => {
              const el = document.querySelector(selector);
              if (!el || !wanted) return;
              const target = String(wanted).trim().toLowerCase();
              const options = Array.from(el.options || []);

              let match = options.find(opt => String(opt.value || "").trim().toLowerCase() === target);
              if (!match) match = options.find(opt => String(opt.textContent || "").trim().toLowerCase() === target);
              if (!match) match = options.find(opt => {
                const txt = String(opt.textContent || "").trim().toLowerCase();
                return txt.startsWith(target + " —") || txt.startsWith(target + " -") || txt.startsWith(target + " ");
              });

              if (match) {
                el.value = match.value;
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
            };

            const syncField = (selector, value) => {
              const el = document.querySelector(selector);
              if (!el || value == null || value === "") return;
              el.value = String(value);
              el.dispatchEvent(new Event("change", { bubbles: true }));
            };

            if (typeof window.__rvRefreshState === "function") {
              await window.__rvRefreshState();
            }

            syncSelect("#rv-persona-1", entry.persona_1);
            syncSelect("#rv-persona-2", entry.persona_2);
            syncField("#rv-scene", entry.scene);

            const turnsEachEl = document.querySelector("#rv-turns-each");
            if (turnsEachEl && entry.messages_per_batch) {
              const turnsEach = String(Math.max(1, Math.round(Number(entry.messages_per_batch) / 2)));
              if (Array.from(turnsEachEl.options || []).some(opt => String(opt.value) === turnsEach)) {
                turnsEachEl.value = turnsEach;
                turnsEachEl.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }

            const pair = [entry.persona_1, entry.persona_2].filter(Boolean).join(" × ");
            setArchiveStatus(pair ? `Archive loaded: ${pair}` : "Archive loaded.");
          } catch (err) {
            console.error("Archive load failed:", err);
            setArchiveStatus(`Load failed: ${err.message || err}`);
          }
          return;
        }

        const btn = e.target.closest(".rv-archive-delete-clean");
        if (!btn) return;

        const filename = btn.getAttribute("data-filename") || "";
        if (!filename) return;

        const ok = window.confirm(`Delete archive?\n\n${filename}`);
        if (!ok) return;

        try {
          btn.disabled = true;
          await deleteArchive(filename);
        } catch (err) {
          console.error(err);
          setArchiveStatus(`Delete failed: ${err.message || err}`);
        } finally {
          btn.disabled = false;
        }
      };
    }

    try {
      await loadArchives();
    } catch (err) {
      console.error(err);
      setArchiveStatus(`Initial load failed: ${err.message || err}`);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

/* RV_LAST_USED_PATCH */
(() => {
  if (window.__RV_LAST_USED_PATCH__) return;
  window.__RV_LAST_USED_PATCH__ = true;

  const KEY = "rendezvous:lastUsedSetup";

  function low(v) {
    return String(v || "").trim().toLowerCase();
  }

  function onRendezvousPage() {
    const hash = low(location.hash);
    if (hash.includes("/apps/rendezvous")) return true;
    return Array.from(document.querySelectorAll("h1,h2,h3,h4"))
      .some(el => low(el.textContent).includes("rendezvous"));
  }

  function findLabel(text) {
    const want = low(text);
    const nodes = Array.from(document.querySelectorAll("label, div, span, p, strong, h1, h2, h3, h4"));
    return nodes.find(el => low(el.textContent) === want);
  }

  function nextControlAfter(labelText) {
    const label = findLabel(labelText);
    if (!label) return null;

    let n = label.nextElementSibling;
    while (n) {
      if (n.matches && n.matches("select, textarea, input")) return n;
      if (n.querySelector) {
        const found = n.querySelector("select, textarea, input");
        if (found) return found;
      }
      n = n.nextElementSibling;
    }
    return null;
  }

  function controls() {
    return {
      p1: nextControlAfter("Persona 1"),
      p2: nextControlAfter("Persona 2"),
      scene: nextControlAfter("Scene seed"),
      tempo: nextControlAfter("Tempo")
    };
  }

  function fireChange(el) {
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectByToken(select, token) {
    if (!select || !token) return false;
    const want = low(token);

    for (const opt of Array.from(select.options || [])) {
      const hay = low((opt.value || "") + " " + (opt.textContent || ""));
      if (hay.includes(want)) {
        select.value = opt.value;
        fireChange(select);
        return true;
      }
    }
    return false;
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveState() {
    if (!onRendezvousPage()) return;

    const { p1, p2, scene, tempo } = controls();
    const state = {
      persona1: p1 ? (p1.value || "") : "",
      persona2: p2 ? (p2.value || "") : "",
      scene: scene ? (scene.value || "") : "",
      tempo: tempo ? (tempo.value || "") : ""
    };

    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function applyState(state) {
    if (!state || !onRendezvousPage()) return;

    const { p1, p2, scene, tempo } = controls();

    if (p1 && state.persona1) {
      if (!setSelectByToken(p1, state.persona1)) {
        p1.value = state.persona1;
        fireChange(p1);
      }
    }

    if (p2 && state.persona2) {
      if (!setSelectByToken(p2, state.persona2)) {
        p2.value = state.persona2;
        fireChange(p2);
      }
    }

    if (scene && state.scene && !String(scene.value || "").trim()) {
      scene.value = state.scene;
      fireChange(scene);
    }

    if (tempo && state.tempo) {
      if (!setSelectByToken(tempo, state.tempo)) {
        tempo.value = state.tempo;
        fireChange(tempo);
      }
    }
  }

  function shouldRestore(state) {
    const { p1, p2, scene } = controls();
    if (!p1 || !p2) return false;

    const p1LooksDefault = low(p1.value).includes("dawn");
    const p2LooksDefault = low(p2.value).includes("fox");
    const sceneEmpty = scene ? !String(scene.value || "").trim() : true;

    return !!(
      state &&
      (state.persona1 || state.persona2 || state.scene || state.tempo) &&
      (p1LooksDefault || p2LooksDefault || sceneEmpty)
    );
  }

  function bindControls() {
    const { p1, p2, scene, tempo } = controls();
    [p1, p2, scene, tempo].forEach(el => {
      if (!el || el.dataset.rvLastUsedBound === "1") return;
      el.addEventListener("change", saveState);
      el.addEventListener("input", saveState);
      el.dataset.rvLastUsedBound = "1";
    });
  }

  function restoreIfNeeded() {
    if (!onRendezvousPage()) return;
    bindControls();

    const state = loadState();
    if (shouldRestore(state)) {
      applyState(state);
    }
  }

  function rememberArchivePairFromLoadButton(btn) {
    const card = btn.closest("div");
    if (!card) return;

    const pairNode = Array.from(card.querySelectorAll("*")).find(el => {
      const t = String(el.textContent || "").trim();
      return /^[^\n]+\s+x\s+[^\n]+$/i.test(t);
    });

    if (!pairNode) return;

    const m = String(pairNode.textContent || "").trim().match(/^(.+?)\s+x\s+(.+)$/i);
    if (!m) return;

    const state = loadState();
    state.persona1 = m[1].trim();
    state.persona2 = m[2].trim();
    localStorage.setItem(KEY, JSON.stringify(state));

    setTimeout(() => applyState(state), 50);
    setTimeout(() => applyState(state), 300);
    setTimeout(saveState, 500);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn || !onRendezvousPage()) return;

    const t = low(btn.textContent);

    if (t === "load") {
      rememberArchivePairFromLoadButton(btn);
    }

    if (
      t.includes("start rendezvous") ||
      t.includes("continue") ||
      t.includes("clear session") ||
      t.includes("save session") ||
      t.includes("create archive")
    ) {
      setTimeout(saveState, 50);
      setTimeout(saveState, 300);
    }
  });

  window.addEventListener("hashchange", () => {
    setTimeout(restoreIfNeeded, 50);
    setTimeout(restoreIfNeeded, 300);
  });

  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(restoreIfNeeded, 50);
    setTimeout(restoreIfNeeded, 300);
  });

  setInterval(() => {
    if (!onRendezvousPage()) return;
    bindControls();
    restoreIfNeeded();
  }, 800);
})();

/* RV_LOAD_SYNC_PATCH */
(() => {
  if (window.__RV_LOAD_SYNC_PATCH__) return;
  window.__RV_LOAD_SYNC_PATCH__ = true;

  const KEY = "rendezvous:lastUsedSetup";

  function low(v) {
    return String(v || "").trim().toLowerCase();
  }

  function findLabel(text) {
    const want = low(text);
    const nodes = Array.from(document.querySelectorAll("label, div, span, p, strong, h1, h2, h3, h4"));
    return nodes.find(el => low(el.textContent) === want);
  }

  function nextControlAfter(labelText) {
    const label = findLabel(labelText);
    if (!label) return null;

    let n = label.nextElementSibling;
    while (n) {
      if (n.matches && n.matches("select, textarea, input")) return n;
      if (n.querySelector) {
        const found = n.querySelector("select, textarea, input");
        if (found) return found;
      }
      n = n.nextElementSibling;
    }
    return null;
  }

  function controls() {
    return {
      p1: nextControlAfter("Persona 1"),
      p2: nextControlAfter("Persona 2"),
      scene: nextControlAfter("Scene seed"),
      tempo: nextControlAfter("Tempo")
    };
  }

  function fireChange(el) {
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setSelectByToken(select, token) {
    if (!select || !token) return false;
    const want = low(token);

    for (const opt of Array.from(select.options || [])) {
      const hay = low((opt.value || "") + " " + (opt.textContent || ""));
      if (hay.includes(want)) {
        select.value = opt.value;
        fireChange(select);
        return true;
      }
    }
    return false;
  }

  function loadStored() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveStored(state) {
    const merged = { ...loadStored(), ...state };
    localStorage.setItem(KEY, JSON.stringify(merged));
    return merged;
  }

  function applyState(state) {
    if (!state) return;

    const tries = [0, 50, 150, 300, 700, 1200, 2000];

    for (const ms of tries) {
      setTimeout(() => {
        const { p1, p2, scene, tempo } = controls();

        if (p1 && state.persona1) {
          if (!setSelectByToken(p1, state.persona1)) {
            p1.value = state.persona1;
            fireChange(p1);
          }
        }

        if (p2 && state.persona2) {
          if (!setSelectByToken(p2, state.persona2)) {
            p2.value = state.persona2;
            fireChange(p2);
          }
        }

        if (scene && state.scene) {
          scene.value = state.scene;
          fireChange(scene);
        }

        if (tempo && state.tempo !== undefined && state.tempo !== null && String(state.tempo) !== "") {
          if (!setSelectByToken(tempo, String(state.tempo))) {
            tempo.value = String(state.tempo);
            fireChange(tempo);
          }
        }
      }, ms);
    }
  }

  function extractState(payload, depth = 0) {
    if (!payload || typeof payload !== "object" || depth > 5) return null;

    const p1 = payload.persona_1 ?? payload.persona1 ?? payload.personaOne;
    const p2 = payload.persona_2 ?? payload.persona2 ?? payload.personaTwo;
    const scene = payload.scene ?? payload.scene_seed ?? payload.seed ?? "";
    const rawTempo = payload.messages_per_batch ?? payload.tempo ?? payload.batch_size ?? "";

    let tempo = "";
    if (rawTempo !== "") {
      const n = Number(rawTempo);
      tempo = Number.isFinite(n) && n > 0
        ? String(Math.max(1, Math.round(n / 2)))
        : String(rawTempo);
    }

    if (p1 || p2 || scene || tempo) {
      return {
        persona1: p1 ? String(p1) : "",
        persona2: p2 ? String(p2) : "",
        scene: scene ? String(scene) : "",
        tempo
      };
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const found = extractState(item, depth + 1);
        if (found) return found;
      }
      return null;
    }

    for (const key of Object.keys(payload)) {
      const found = extractState(payload[key], depth + 1);
      if (found) return found;
    }

    return null;
  }

  function rememberFromPayload(payload) {
    const found = extractState(payload);
    if (!found) return;

    const merged = saveStored(found);
    applyState(merged);
  }

  function rememberFromCard(btn) {
    const card = btn.closest("div");
    if (!card) return;

    const text = String(card.textContent || "");
    const pair = text.match(/([A-Za-z0-9 _-]+)\s+x\s+([A-Za-z0-9 _-]+)/i);
    if (!pair) return;

    const merged = saveStored({
      persona1: pair[1].trim(),
      persona2: pair[2].trim()
    });

    applyState(merged);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = String((args[0] && args[0].url) || args[0] || "");
        if (/history\/load|\/load\b|latest|open|pick/i.test(url)) {
          const clone = res.clone();
          clone.json().then(rememberFromPayload).catch(() => {});
        }
      } catch {}
      return res;
    };
  }

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__rv_url = url;
    return xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", () => {
      try {
        const url = String(this.__rv_url || "");
        if (/history\/load|\/load\b|latest|open|pick/i.test(url)) {
          try {
            rememberFromPayload(JSON.parse(this.responseText));
          } catch {}
        }
      } catch {}
    });
    return xhrSend.apply(this, args);
  };

  document.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!btn) return;

    const t = low(btn.textContent);
    if (t === "load") {
      rememberFromCard(btn);
    }
  });
})();

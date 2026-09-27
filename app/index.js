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

  function rvClearSpeakingTurnHighlight() {
    document.querySelectorAll('[data-rv-speaking-turn="true"]').forEach((node) => {
      node.removeAttribute("data-rv-speaking-turn");
      node.style.outline = "";
      node.style.boxShadow = "";
      node.style.backgroundColor = "";
    });
  }

  function rvFindTranscriptNodeForSpeech(text) {
    const transcriptEl = document.getElementById("rv-transcript");
    if (!transcriptEl) return null;

    const target = rvCleanText(text).slice(0, 180);
    if (!target) return null;

    const nodes = Array.from(transcriptEl.querySelectorAll("div"));
    return nodes.find((node) => {
      const hay = rvCleanText(node.textContent || "");
      return hay.includes(target);
    }) || null;
  }

  function rvScrollSpeechIntoView(text) {
    const node = rvFindTranscriptNodeForSpeech(text);
    if (!node) return;

    rvClearSpeakingTurnHighlight();

    node.setAttribute("data-rv-speaking-turn", "true");
    node.style.outline = "2px solid rgba(196, 181, 253, 0.75)";
    node.style.boxShadow = "0 0 18px rgba(124, 58, 237, 0.28)";
    node.style.backgroundColor = "rgba(76, 29, 149, 0.16)";

    try {
      node.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    } catch (err) {
      node.scrollIntoView();
    }
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

      rvScrollSpeechIntoView(item.text);

      const rvTranscript = document.querySelector("#rv-transcript");

      if (rvTranscript) {
        const bubbles = Array.from(
          rvTranscript.querySelectorAll(".rv-speaker-bubble")
        );

        bubbles.forEach(el => {
          el.classList.remove("rv-speaking-active");
        });

        const wantedText = rvNormText(item.text || "");
        const wantedSpeaker = rvNormText(speaker || "");

        const reversed = bubbles.slice().reverse();

        let activeBubble = reversed.find(el => {
          const bodyEl = el.lastElementChild;
          const speakerEl = el.querySelector("span");

          const bodyText = rvNormText(
            bodyEl ? bodyEl.textContent || "" : ""
          );

          const bubbleSpeaker = rvNormText(
            speakerEl ? speakerEl.textContent || "" : ""
          );

          const speakerMatches =
            !wantedSpeaker ||
            bubbleSpeaker === wantedSpeaker;

          const textMatches =
            !wantedText ||
            bodyText.includes(wantedText) ||
            wantedText.includes(bodyText);

          return speakerMatches && textMatches;
        });

        if (!activeBubble && wantedSpeaker) {
          activeBubble = reversed.find(el => {
            const speakerEl = el.querySelector("span");
            return rvNormText(
              speakerEl ? speakerEl.textContent || "" : ""
            ) === wantedSpeaker;
          });
        }

        if (activeBubble) {
          activeBubble.classList.add("rv-speaking-active");

          requestAnimationFrame(() => {
            const panelRect = rvTranscript.getBoundingClientRect();
            const bubbleRect = activeBubble.getBoundingClientRect();

            const delta =
              (bubbleRect.top + bubbleRect.height / 2) -
              (panelRect.top + panelRect.height / 2);

            rvTranscript.scrollTo({
              top: Math.max(0, rvTranscript.scrollTop + delta),
              behavior: "smooth"
            });
          });
        }
      }

      await rvSpeakText(
        item.text,
        speaker ? `Reading ${speaker}` : "Reading turn",
        voice
      );

      if (window.__rvTtsQueueToken !== token) return;
    }

    document
      .querySelectorAll("#rv-transcript .rv-speaker-bubble")
      .forEach(el => el.classList.remove("rv-speaking-active"));

    rvClearSpeakingTurnHighlight();
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


  // RENDEZVOUS_GENERIC_AVATARS_V1
  function rvPersonaRecord(token) {
    const key = String(token || "").trim().toLowerCase();
    return (state.personas || []).find(p => {
      const pk = String(p.key || "").trim().toLowerCase();
      const pn = String(p.name || "").trim().toLowerCase();
      return key === pk || key === pn;
    }) || null;
  }

  function rvAvatarUrl(name) {
    return `/api/personas/${encodeURIComponent(name)}/avatar`;
  }

  function rvAvatarFallback(name, color) {
    const initial = String(name || "?").trim().charAt(0).toUpperCase() || "?";
    const c = color || "#888888";
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
      `<circle cx="50" cy="50" r="47" fill="${c}18" stroke="${c}" stroke-width="3"/>` +
      `<text x="50" y="54" text-anchor="middle" dominant-baseline="middle"` +
      ` font-family="system-ui,sans-serif" font-size="44" font-weight="700" fill="${c}">` +
      `${initial}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
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


  // RENDEZVOUS_INLINE_BUBBLE_AVATARS_V1
  function rvSpeakerMeta(name) {
    const key = rvNormText(name || "");
    const rec = rvPersonaRecord(key) || rvPersonaRecord(name);
    const label = rvCleanText((rec && (rec.name || rec.key)) || name || "");
    const color = speakerColor(label || name || "");
    const token = rvCleanText((rec && (rec.key || rec.name)) || name || "");
    const src = (rec && rec.avatar)
      ? rvAvatarUrl(token)
      : rvAvatarFallback(label || token || "?", color);

    return { rec, label, color, src };
  }

  function rvSpeakerIsRight(name) {
    const key = rvNormText(name || "");
    const right = rvNormText(state.persona2 || "");
    return !!key && !!right && key === right;
  }

  function rvTightenRendezvousChrome(root) {
    if (!root) return;

    const stagePanel =
      root.querySelector(".rv-stage-panel") ||
      (document.querySelector("#rv-transcript")
        ? document.querySelector("#rv-transcript").closest("section")
        : null);

    const controlPanel = root.querySelector(".rv-control-panel");

    if (stagePanel) {
      Array.from(stagePanel.querySelectorAll("h3")).forEach((el) => {
        const t = rvNormText(el.textContent || "");
        if (t === "transcript") el.remove();
      });

      Array.from(stagePanel.children).forEach((el) => {
        if (!(el instanceof HTMLElement)) return;
        const t = rvNormText(el.textContent || "");
        if (!t) return;

        if (
          el.querySelector("img") &&
          t.includes("persona 1") &&
          t.includes("persona 2")
        ) {
          el.remove();
        }
      });
    }

    if (controlPanel) {
      Array.from(controlPanel.children).forEach((el) => {
        if (
          el instanceof HTMLElement &&
          el.tagName === "H3" &&
          rvNormText(el.textContent || "") === "controls"
        ) {
          el.remove();
        }
      });
    }
  }

  function rvInlineAvatarsBesideBubbles(root, transcriptEl) {
    if (!transcriptEl) return;

    rvTightenRendezvousChrome(root);

    Array.from(transcriptEl.querySelectorAll(".rv-turn-row")).forEach((row) => {
      const bubble = row.querySelector(".rv-speaker-bubble");
      if (bubble && row.parentNode === transcriptEl) {
        transcriptEl.insertBefore(bubble, row);
      }
      row.remove();
    });

    const bubbles = Array.from(
      transcriptEl.querySelectorAll(".rv-speaker-bubble")
    );

    bubbles.forEach((bubble) => {
      const speakerEl = bubble.querySelector("span");
      const speaker = rvCleanText(speakerEl ? (speakerEl.textContent || "") : "");
      if (!speaker || rvNormText(speaker) === "scene") return;

      const meta = rvSpeakerMeta(speaker);

      // RENDEZVOUS_AVATAR_SIDE_FIX_V1
      // The bubble already knows which selected persona it belongs to.
      // Use that instead of trying to rediscover the speaker from state.
      const p2Select = document.querySelector("#rv-persona-2");
      const p2Token = p2Select ? String(p2Select.value || "") : "";
      const p2Record = rvPersonaRecord(p2Token);

      const speakerKey = rvNormText(speaker || "");
      const p2Names = [
        p2Token,
        p2Record && p2Record.key,
        p2Record && p2Record.name
      ]
        .filter(Boolean)
        .map(v => rvNormText(v));

      const isRight = p2Names.includes(speakerKey);

      bubble.setAttribute("data-rv-side", isRight ? "right" : "left");

      const row = document.createElement("div");
      row.className = "rv-turn-row " + (isRight ? "rv-turn-row-right" : "rv-turn-row-left");

      bubble.parentNode.insertBefore(row, bubble);

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "rv-turn-avatar-wrap";

      const avatar = document.createElement("img");
      avatar.className = "rv-turn-avatar";
      avatar.alt = meta.label || speaker;
      avatar.loading = "lazy";
      avatar.src = meta.src;

      if (meta.rec && meta.rec.avatar) {
        avatar.onerror = () => {
          avatar.onerror = null;
          avatar.src = rvAvatarFallback(meta.label || speaker, meta.color);
        };
      }

      avatarWrap.appendChild(avatar);

      bubble.style.margin = "0";
      bubble.style.flex = "0 1 84%";
      bubble.style.maxWidth = "84%";

      if (isRight) {
        row.appendChild(bubble);
        row.appendChild(avatarWrap);
      } else {
        row.appendChild(avatarWrap);
        row.appendChild(bubble);
      }
    });
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
        `<div class="rv-scene-card" style="
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

      const speakerKey = String(entry.speaker || "").trim().toLowerCase();

      const p1Record = rvPersonaRecord(state.persona1 || "");
      const p2Record = rvPersonaRecord(state.persona2 || "");

      const p1Names = [
        state.persona1,
        p1Record && p1Record.key,
        p1Record && p1Record.name
      ].filter(Boolean).map(v => String(v).trim().toLowerCase());

      const p2Names = [
        state.persona2,
        p2Record && p2Record.key,
        p2Record && p2Record.name
      ].filter(Boolean).map(v => String(v).trim().toLowerCase());

      const side =
        p2Names.includes(speakerKey) ? "right" :
        p1Names.includes(speakerKey) ? "left" :
        "center";

      html.push(
        `<div class="rv-speaker-bubble" data-rv-side="${side}" style="--speaker-color:${color};
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
      <style>
        /* RENDEZVOUS_FACELIFT_V1 */
        .rv-shell {
          max-width: 1700px !important;
          margin: 0 auto;
          padding: 18px 22px 28px !important;
          color: #f7f3ff;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
        }
        .rv-hero {
          padding: 16px 18px;
          margin-bottom: 16px !important;
          border: 1px solid rgba(167,139,250,.22);
          border-radius: 18px;
          background:
            radial-gradient(circle at 18% 0%, rgba(124,58,237,.18), transparent 34%),
            linear-gradient(135deg, rgba(35,25,55,.78), rgba(17,15,28,.90));
          box-shadow: 0 18px 45px rgba(0,0,0,.22);
        }
        .rv-hero h2 {
          font-size: 25px;
          letter-spacing: -.02em;
        }
        #rv-status {
          padding: 7px 11px;
          border-radius: 999px;
          background: rgba(124,58,237,.12);
          border: 1px solid rgba(167,139,250,.22);
          color: #ddd6fe;
          font-size: 13px;
        }
        .rv-shell-grid {
          grid-template-columns: 240px minmax(560px, 1fr) 240px !important;
          gap: 16px !important;
        }
        .rv-panel {
          border: 1px solid rgba(167,139,250,.22) !important;
          border-radius: 18px !important;
          background:
            linear-gradient(180deg, rgba(38,31,52,.72), rgba(20,18,30,.72));
          box-shadow: 0 18px 45px rgba(0,0,0,.20);
        }
        .rv-setup-panel,
        .rv-control-panel {
          position: sticky;
          top: 18px;
        }
        .rv-stage-panel {
          min-height: 650px !important;
          max-height: calc(100vh - 126px) !important;
          padding: 14px 16px 16px !important;
          background:
            radial-gradient(circle at 50% 0%, rgba(124,58,237,.09), transparent 32%),
            linear-gradient(180deg, rgba(24,22,34,.92), rgba(15,14,22,.94));
        }
        .rv-toolbar {
          margin: -2px -2px 8px !important;
          padding: 6px 2px 12px !important;
          background: rgba(18,16,28,.88) !important;
          border-bottom: 1px solid rgba(167,139,250,.16);
          backdrop-filter: blur(12px);
        }
        .rv-toolbar h3 {
          font-size: 18px;
          letter-spacing: .01em;
        }
        .rv-shell button,
        .rv-shell select,
        .rv-shell textarea,
        .rv-shell input {
          font-family: inherit;
        }
        .rv-shell button {
          transition: transform .14s ease, filter .14s ease, box-shadow .14s ease;
        }
        .rv-shell button:hover {
          transform: translateY(-1px);
          filter: brightness(1.09);
          box-shadow: 0 8px 20px rgba(0,0,0,.18);
        }
        .rv-shell select,
        .rv-shell textarea {
          background: rgba(11,10,18,.72);
          color: #f4f0ff;
          border: 1px solid rgba(167,139,250,.22);
          outline: none;
        }
        .rv-shell select:focus,
        .rv-shell textarea:focus {
          border-color: rgba(167,139,250,.68);
          box-shadow: 0 0 0 3px rgba(124,58,237,.12);
        }
        #rv-transcript {
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
          line-height: 1.58 !important;
          min-height: 420px !important;
          max-height: calc(100vh - 245px) !important;
          padding: 10px 4px 24px !important;
          scroll-behavior: smooth;
        }
        #rv-transcript > div {
          margin: 10px 0 !important;
          padding: 14px 16px !important;
          border-radius: 16px !important;
          border: 1px solid rgba(167,139,250,.14) !important;
          background: rgba(255,255,255,.035) !important;
          box-shadow: 0 8px 22px rgba(0,0,0,.13);
        }
        #rv-transcript > div:nth-child(odd) {
          margin-right: 4% !important;
        }
        #rv-transcript > div:nth-child(even) {
          margin-left: 4% !important;
        }
        #rv-user-message {
          min-height: 122px;
          resize: vertical;
          line-height: 1.45;
        }
        #rv-history-list {
          background: rgba(9,8,15,.38) !important;
          border-color: rgba(167,139,250,.16) !important;
        }
        .rv-panel h3 {
          color: #f2ecff;
        }
        .rv-panel label > div {
          color: #d8d0e8;
          font-size: 13px;
          font-weight: 700;
          letter-spacing: .01em;
        }
        @media (max-width: 1180px) {
          .rv-shell-grid {
            grid-template-columns: 220px minmax(0,1fr) !important;
          }
          .rv-control-panel {
            position: static;
            grid-column: 1 / -1;
          }
        }
        @media (max-width: 820px) {
          .rv-shell {
            padding: 12px !important;
          }
          .rv-shell-grid {
            grid-template-columns: 1fr !important;
          }
          .rv-setup-panel,
          .rv-control-panel {
            position: static;
          }
          .rv-stage-panel {
            min-height: 560px !important;
            max-height: none !important;
          }
        }
      </style>

<style>
/* RENDEZVOUS_BURGUNDY_GOLD_V1 */

.rv-shell{
  color:#f3e8da !important;
}

.rv-hero{
  background:
    radial-gradient(circle at 18% 0%, rgba(255,214,120,.10), transparent 34%),
    linear-gradient(135deg, rgba(58,16,27,.97), rgba(23,16,22,.98)) !important;
  border:1px solid rgba(198,156,84,.34) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,235,190,.08),
    0 12px 30px rgba(0,0,0,.22) !important;
}

.rv-panel{
  background:
    linear-gradient(180deg, rgba(40,14,24,.94), rgba(18,16,22,.97)) !important;
  border:1px solid rgba(171,126,58,.22) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,235,190,.04),
    0 10px 24px rgba(0,0,0,.18) !important;
}

.rv-stage-panel{
  background:
    radial-gradient(circle at 50% 0%, rgba(255,217,133,.05), transparent 28%),
    linear-gradient(180deg, rgba(29,18,27,.98), rgba(14,15,20,.99)) !important;
}

.rv-toolbar{
  background:rgba(28,18,24,.96) !important;
  border-bottom:1px solid rgba(186,140,70,.18) !important;
}

.rv-shell h2,
.rv-shell h3{
  color:#f6ead6 !important;
}

.rv-shell label > div{
  color:#d9c2a0 !important;
}

.rv-shell select,
.rv-shell textarea{
  background:linear-gradient(180deg, rgba(18,12,17,.95), rgba(10,11,14,.98)) !important;
  color:#f4e8dc !important;
  border:1px solid rgba(160,117,58,.28) !important;
  box-shadow: inset 0 1px 0 rgba(255,235,190,.03) !important;
}

.rv-shell select:focus,
.rv-shell textarea:focus{
  border-color:rgba(214,171,97,.68) !important;
  box-shadow:
    0 0 0 3px rgba(201,154,73,.10),
    inset 0 1px 0 rgba(255,235,190,.06) !important;
}

#rv-status{
  color:#f2dfbf !important;
  background:linear-gradient(180deg, rgba(83,31,44,.60), rgba(46,19,27,.70)) !important;
  border:1px solid rgba(192,149,79,.32) !important;
  box-shadow: inset 0 1px 0 rgba(255,233,186,.08) !important;
  padding:8px 16px !important;
  border-radius:999px !important;
}

/* Metallic gold buttons */
#rv-start,
#rv-continue,
#rv-copy,
#rv-toggle-thoughts,
#rv-export,
#rv-archive,
#rv-send,
#rv-refresh-history{
  background:
    linear-gradient(180deg,
      rgba(246,220,158,.95) 0%,
      rgba(211,171,95,.92) 44%,
      rgba(145,102,40,.92) 100%) !important;
  color:#2a160a !important;
  border:1px solid #d8b06a !important;
  box-shadow:
    inset 0 1px 0 rgba(255,245,214,.72),
    inset 0 -1px 0 rgba(102,63,18,.42),
    0 3px 10px rgba(0,0,0,.22) !important;
  text-shadow:0 1px 0 rgba(255,245,214,.35) !important;
  font-weight:800 !important;
}

/* Green-ish live control can stay muted but elegant */
#rv-tts-auto{
  background:
    linear-gradient(180deg,
      rgba(148,164,124,.92) 0%,
      rgba(107,120,87,.92) 50%,
      rgba(70,79,56,.92) 100%) !important;
  color:#eef2e3 !important;
  border:1px solid #99a57f !important;
  box-shadow:
    inset 0 1px 0 rgba(240,247,227,.28),
    0 3px 10px rgba(0,0,0,.20) !important;
  font-weight:800 !important;
}

#rv-end,
#rv-tts-stop{
  background:
    linear-gradient(180deg,
      rgba(138,58,71,.94) 0%,
      rgba(105,35,48,.94) 50%,
      rgba(67,20,30,.96) 100%) !important;
  color:#f3d6d6 !important;
  border:1px solid #b16a76 !important;
  box-shadow:
    inset 0 1px 0 rgba(255,214,214,.14),
    0 3px 10px rgba(0,0,0,.22) !important;
  font-weight:800 !important;
}

#rv-clear{
  background:
    linear-gradient(180deg,
      rgba(197,155,88,.88) 0%,
      rgba(149,111,54,.90) 52%,
      rgba(101,70,31,.94) 100%) !important;
  color:#251509 !important;
  border:1px solid #d0a761 !important;
  box-shadow:
    inset 0 1px 0 rgba(255,241,205,.55),
    0 3px 10px rgba(0,0,0,.20) !important;
  font-weight:800 !important;
}

#rv-transcript{
  color:#f3e6d9 !important;
}

#rv-transcript > div{
  background:
    linear-gradient(145deg, rgba(56,18,31,.76), rgba(20,18,24,.88)) !important;
  border:1px solid rgba(174,128,60,.20) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,235,190,.03),
    0 10px 28px rgba(0,0,0,.20) !important;
}

#rv-history-list{
  background:rgba(13,10,14,.52) !important;
  border:1px solid rgba(168,124,58,.20) !important;
}

#rv-tts-status{
  color:#d8c29b !important;
}
</style>

<style>
/* RENDEZVOUS_OPTION_A_V1 */

/* ---------- Transcript becomes the room ---------- */

#rv-transcript {
  padding:18px 10px 32px !important;
}

/* Empty booth */
#rv-transcript:empty::before {
  content:"The booth is quiet. Start the rendezvous when you’re ready.";
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:330px;
  margin:10px 4px;
  padding:30px;
  text-align:center;
  color:#bfa77d;
  font-size:15px;
  font-style:italic;
  letter-spacing:.02em;
  border:1px solid rgba(187,143,72,.13);
  border-radius:18px;
  background:
    radial-gradient(circle at 50% 30%, rgba(120,42,55,.12), transparent 42%),
    rgba(255,255,255,.012);
  box-shadow:inset 0 1px 0 rgba(255,230,175,.025);
}

/* Conversation cards */
#rv-transcript > div {
  max-width:88% !important;
  width:auto !important;
  margin-top:14px !important;
  margin-bottom:14px !important;
  padding:17px 19px !important;
  border-radius:18px !important;
  background:
    linear-gradient(145deg,
      rgba(65,21,35,.80),
      rgba(24,18,24,.94)) !important;
  border-top:1px solid rgba(211,166,91,.17) !important;
  border-right:1px solid rgba(152,108,50,.12) !important;
  border-bottom:1px solid rgba(91,57,35,.22) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,235,190,.035),
    0 10px 26px rgba(0,0,0,.19) !important;
}

/* Give the exchange a gentle across-the-table rhythm */
#rv-transcript > div:nth-child(odd) {
  margin-right:8% !important;
}

#rv-transcript > div:nth-child(even) {
  margin-left:8% !important;
}

/* Scene/opening plaque */
#rv-transcript > div:first-child {
  max-width:96% !important;
  margin-left:auto !important;
  margin-right:auto !important;
  background:
    linear-gradient(180deg,
      rgba(94,61,28,.20),
      rgba(41,19,27,.44)) !important;
  border:1px solid rgba(204,158,79,.20) !important;
  box-shadow:
    inset 0 1px 0 rgba(255,229,168,.05),
    0 7px 20px rgba(0,0,0,.16) !important;
}

/* Speaker name treatment */
#rv-transcript > div span {
  letter-spacing:.045em !important;
  text-transform:none;
}

/* ---------- Make toolbar feel composed instead of crowded ---------- */

.rv-toolbar {
  padding-bottom:14px !important;
}

.rv-toolbar > div {
  width:100%;
  display:flex !important;
  align-items:center !important;
  gap:8px !important;
  row-gap:10px !important;
}

/* Conversation buttons */
#rv-copy,
#rv-toggle-thoughts,
#rv-tts-auto,
#rv-tts-stop {
  order:1;
}

/* Voice section */
.rv-toolbar label {
  order:2;
}

.rv-toolbar label:first-of-type {
  margin-left:6px !important;
  padding-left:14px !important;
  border-left:1px solid rgba(197,153,80,.22);
}

/* Voice status belongs with the voice controls */
#rv-tts-status {
  order:2;
  padding:5px 8px;
  border-radius:8px;
  background:rgba(255,255,255,.025);
}

/* Session/file actions form their own little cluster */
#rv-export {
  order:3;
  margin-left:auto !important;
}

#rv-archive {
  order:3;
}

/* Make top controls a bit less bulky */
.rv-toolbar button {
  min-height:38px;
}

.rv-tts-voice-select {
  background:rgba(13,11,14,.88) !important;
  border-color:rgba(176,131,65,.26) !important;
}

/* ---------- Small finishing touches ---------- */

.rv-stage-panel {
  box-shadow:
    inset 0 1px 0 rgba(255,233,187,.025),
    0 16px 38px rgba(0,0,0,.18) !important;
}

#rv-user-message {
  background:
    linear-gradient(180deg,
      rgba(26,13,19,.94),
      rgba(12,12,15,.98)) !important;
}

/* END_RENDEZVOUS_OPTION_A_V1 */
</style>

<style>
/* RENDEZVOUS_CLEAN_ROWS_PERSONA_COLORS_V1 */

/* ---------- TWO CLEAN TOOLBAR ROWS ---------- */

.rv-toolbar > div {
  display:grid !important;
  grid-template-columns:repeat(12,minmax(0,1fr)) !important;
  gap:9px 8px !important;
  align-items:center !important;
  width:100% !important;
}

/* Row 1: actions */
#rv-copy {
  grid-row:1;
  grid-column:1 / 3;
}

#rv-toggle-thoughts {
  grid-row:1;
  grid-column:3 / 6;
}

#rv-tts-auto {
  grid-row:1;
  grid-column:6 / 8;
}

#rv-tts-stop {
  grid-row:1;
  grid-column:8 / 10;
}

#rv-archive {
  grid-row:1;
  grid-column:10 / 13;
}

/* Archive replaces Save Session */
#rv-export {
  display:none !important;
}

/* Row 2: all voices together */
.rv-toolbar label:has(select[data-rv-tts-slot="one"]) {
  grid-row:2;
  grid-column:1 / 4;
  margin:0 !important;
  padding:0 !important;
  border:0 !important;
}

.rv-toolbar label:has(select[data-rv-tts-slot="two"]) {
  grid-row:2;
  grid-column:4 / 7;
  margin:0 !important;
}

.rv-toolbar label:has(select[data-rv-tts-slot="user"]) {
  grid-row:2;
  grid-column:7 / 10;
  margin:0 !important;
}

.rv-toolbar label:has(#rv-tts-rate) {
  grid-row:2;
  grid-column:10 / 12;
  margin:0 !important;
}

#rv-tts-status {
  grid-row:2;
  grid-column:12 / 13;
  margin:0 !important;
  padding:4px 5px !important;
  font-size:11px !important;
  text-align:center;
}

.rv-toolbar button {
  width:100% !important;
  min-width:0 !important;
  white-space:nowrap;
  padding-left:8px !important;
  padding-right:8px !important;
  font-size:13px !important;
}

.rv-toolbar label {
  min-width:0 !important;
  white-space:nowrap;
}

.rv-toolbar .rv-tts-voice-select {
  min-width:0 !important;
  max-width:none !important;
  width:100% !important;
}

/* ---------- PERSONA-COLORED CONVERSATION ---------- */

#rv-transcript > .rv-speaker-bubble {
  background:
    linear-gradient(
      145deg,
      color-mix(in srgb, var(--speaker-color) 18%, #1a1117 82%),
      color-mix(in srgb, var(--speaker-color) 7%, #0e0e12 93%)
    ) !important;

  border:
    1px solid
    color-mix(in srgb, var(--speaker-color) 46%, transparent) !important;

  border-left:
    4px solid
    color-mix(in srgb, var(--speaker-color) 78%, #d6a85d 22%) !important;

  box-shadow:
    inset 0 1px 0
      color-mix(in srgb, var(--speaker-color) 14%, transparent),
    0 10px 25px rgba(0,0,0,.20) !important;
}

/* Persona name uses exactly that persona's native color */
.rv-speaker-bubble span {
  color:var(--speaker-color) !important;
  text-shadow:
    0 0 12px
    color-mix(in srgb, var(--speaker-color) 25%, transparent);
}

/* Keep body text warm and readable */
.rv-speaker-bubble > div:last-child {
  color:#f1e8dc !important;
}

/* Scene is a plaque, not one of the speakers */
#rv-transcript > .rv-scene-card {
  position:relative !important;
  top:auto !important;
  z-index:1 !important;

  max-width:70% !important;
  margin:4px auto 18px !important;

  background:
    linear-gradient(
      180deg,
      rgba(102,72,32,.28),
      rgba(49,22,29,.62)
    ) !important;

  border:1px solid rgba(207,162,84,.30) !important;
  color:#dbc18e !important;
  text-align:center;
}

/* Undo the generic odd/even rule for the scene */
#rv-transcript > .rv-scene-card:nth-child(odd),
#rv-transcript > .rv-scene-card:nth-child(even) {
  margin-left:auto !important;
  margin-right:auto !important;
}

/* Responsive fallback */
@media (max-width:1100px) {
  .rv-toolbar > div {
    grid-template-columns:repeat(6,minmax(0,1fr)) !important;
  }

  #rv-copy { grid-row:1; grid-column:1 / 3; }
  #rv-toggle-thoughts { grid-row:1; grid-column:3 / 5; }
  #rv-tts-auto { grid-row:1; grid-column:5 / 7; }
  #rv-tts-stop { grid-row:2; grid-column:1 / 3; }
  #rv-archive { grid-row:2; grid-column:3 / 7; }

  .rv-toolbar label:has(select[data-rv-tts-slot="one"]) {
    grid-row:3; grid-column:1 / 3;
  }
  .rv-toolbar label:has(select[data-rv-tts-slot="two"]) {
    grid-row:3; grid-column:3 / 5;
  }
  .rv-toolbar label:has(select[data-rv-tts-slot="user"]) {
    grid-row:3; grid-column:5 / 7;
  }
  .rv-toolbar label:has(#rv-tts-rate) {
    grid-row:4; grid-column:1 / 4;
  }
  #rv-tts-status {
    grid-row:4; grid-column:4 / 7;
  }
}
</style>

<style>
/* RENDEZVOUS_GENERIC_AVATARS_V1 */

.rv-persona-strip {
  display:grid;
  grid-template-columns:minmax(0,1fr) 42px minmax(0,1fr);
  align-items:center;
  gap:14px;
  margin:4px 4px 14px;
  padding:10px 12px;
  border-top:1px solid rgba(197,153,80,.13);
  border-bottom:1px solid rgba(197,153,80,.13);
  background:
    linear-gradient(
      90deg,
      rgba(255,255,255,.01),
      rgba(116,32,48,.08),
      rgba(255,255,255,.01)
    );
}

.rv-persona-card {
  --persona-color:#b58a52;

  display:flex;
  align-items:center;
  gap:13px;
  min-width:0;
  padding:9px 12px;
  border-radius:16px;

  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--persona-color) 12%, #1a1117 88%),
      rgba(13,13,17,.86)
    );

  border:1px solid
    color-mix(in srgb, var(--persona-color) 30%, transparent);

  box-shadow:
    inset 0 1px 0 rgba(255,240,205,.025),
    0 7px 20px rgba(0,0,0,.15);
}

.rv-persona-card-right {
  justify-content:flex-end;
  text-align:right;
}

.rv-persona-avatar {
  width:62px;
  height:62px;
  flex:0 0 62px;
  object-fit:cover;
  border-radius:50%;

  border:3px solid var(--persona-color);

  box-shadow:
    0 0 0 2px rgba(221,178,100,.15),
    0 0 18px
      color-mix(in srgb, var(--persona-color) 34%, transparent),
    inset 0 1px 0 rgba(255,255,255,.10);

  background:#111217;
}

.rv-persona-card-text {
  min-width:0;
}

.rv-persona-slot {
  color:#a89577;
  font-size:10px;
  font-weight:800;
  letter-spacing:.12em;
  text-transform:uppercase;
  margin-bottom:3px;
}

.rv-persona-name {
  font-size:18px;
  line-height:1.1;
  font-weight:850;
  letter-spacing:.01em;
  text-shadow:
    0 0 14px
    color-mix(in srgb, currentColor 28%, transparent);
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.rv-table-mark {
  color:#b88a49;
  opacity:.72;
  text-align:center;
  font-size:13px;
  text-shadow:0 0 12px rgba(202,157,82,.35);
}

@media (max-width:820px) {
  .rv-persona-strip {
    grid-template-columns:1fr;
  }

  .rv-table-mark {
    display:none;
  }

  .rv-persona-card-right {
    flex-direction:row-reverse;
    justify-content:flex-start;
    text-align:left;
  }
}

/* RENDEZVOUS_SPEAKER_STAGE_V1 */

/* Bubble itself grows naturally with its contents */
#rv-transcript > .rv-speaker-bubble {
  width:fit-content !important;
  min-width:0 !important;
  max-width:88% !important;
  height:auto !important;
  flex:0 0 auto !important;
  box-sizing:border-box !important;
  overflow:visible !important;
}

/* Persona 1 */
#rv-transcript > .rv-speaker-bubble[data-rv-side="left"] {
  align-self:flex-start !important;
  margin-left:0 !important;
  margin-right:auto !important;

  border-left:
    4px solid
    color-mix(in srgb, var(--speaker-color) 82%, #d6a85d 18%)
    !important;

  border-right:
    1px solid
    color-mix(in srgb, var(--speaker-color) 42%, transparent)
    !important;
}

/* Persona 2 */
#rv-transcript > .rv-speaker-bubble[data-rv-side="right"] {
  align-self:flex-end !important;
  margin-left:auto !important;
  margin-right:0 !important;

  border-right:
    4px solid
    color-mix(in srgb, var(--speaker-color) 82%, #d6a85d 18%)
    !important;

  border-left:
    1px solid
    color-mix(in srgb, var(--speaker-color) 42%, transparent)
    !important;
}

/* Human / anything that is not one of the two selected personas */
#rv-transcript > .rv-speaker-bubble[data-rv-side="center"] {
  align-self:center !important;
  margin-left:auto !important;
  margin-right:auto !important;
  max-width:92% !important;
}

/* The person currently speaking */
#rv-transcript > .rv-speaker-bubble.rv-speaking-active {
  position:relative !important;
  z-index:20 !important;

  outline:
    2px solid
    color-mix(in srgb, var(--speaker-color) 75%, #f2d391 25%)
    !important;

  outline-offset:3px !important;

  box-shadow:
    0 0 0 1px
      color-mix(in srgb, var(--speaker-color) 60%, transparent)
      inset,
    0 0 18px
      color-mix(in srgb, var(--speaker-color) 50%, transparent),
    0 12px 32px rgba(0,0,0,.40)
    !important;

  filter:brightness(1.14) !important;
  transform:scale(1.012) !important;
}


/* RENDEZVOUS_STAGE_GROW_FIX_V1
   Let the outer Transcript panel grow around its contents. */
.rv-stage-panel {
  max-height:none !important;
  height:auto !important;
  overflow:visible !important;
}


/* RENDEZVOUS_INLINE_BUBBLE_AVATARS_V1 */
.rv-stage-panel{
  padding-top:8px !important;
}

.rv-stage-panel .rv-toolbar{
  margin-top:0 !important;
  padding-top:0 !important;
}

#rv-transcript{
  padding-top:4px !important;
}

.rv-turn-row{
  display:flex;
  align-items:flex-start;
  gap:12px;
  width:100%;
  margin:10px 0;
}

.rv-turn-row-left{
  justify-content:flex-start;
}

.rv-turn-row-right{
  justify-content:flex-end;
}

.rv-turn-row .rv-speaker-bubble{
  margin:0 !important;
}

.rv-turn-avatar-wrap{
  flex:0 0 46px;
  width:46px;
  display:flex;
  align-items:flex-start;
  justify-content:center;
  padding-top:8px;
}

.rv-turn-avatar{
  width:42px;
  height:42px;
  border-radius:999px;
  object-fit:cover;
  background:#110d10;
  border:2px solid rgba(214,171,97,.66);
  box-shadow:0 4px 14px rgba(0,0,0,.28);
}

.rv-turn-row-right .rv-turn-avatar-wrap{
  order:2;
}

.rv-turn-row-right .rv-speaker-bubble{
  order:1;
}

</style>





      <div class="rv-shell" style="max-width: 1580px; margin: 0 auto; padding: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;">
        <div class="rv-hero" style="display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:20px;">
          <div>
            <h2 style="margin:0;">🍺 Rendezvous</h2>
            <div style="opacity:.75; margin-top:6px;">A separate stage for two personas to meet, talk, and pause.</div>
          </div>
          <div id="rv-status" style="opacity:.8; font-weight:700;"></div>
        </div>

        <div class="rv-shell-grid" style="display:grid; grid-template-columns: 290px minmax(0, 1.75fr) 290px; gap:20px; align-items:start;">
          <section class="rv-panel rv-setup-panel" style="border:1px solid #555; border-radius:12px; padding:16px;">
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

          <section class="rv-panel rv-stage-panel" style="border:1px solid #555; border-radius:12px; padding:16px; min-height:520px; max-height:calc(100vh - 170px); display:flex; flex-direction:column;">
            <div class="rv-toolbar" style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px; flex-wrap:wrap; position:sticky; top:0; z-index:2; background:rgba(24,24,32,.96); padding-bottom:10px;">
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


            <div class="rv-persona-strip">
              <div class="rv-persona-card" id="rv-persona-card-one">
                <img id="rv-avatar-one" class="rv-persona-avatar" alt="">
                <div class="rv-persona-card-text">
                  <div class="rv-persona-slot">Persona 1</div>
                  <div id="rv-persona-name-one" class="rv-persona-name">—</div>
                </div>
              </div>

              <div class="rv-table-mark">◆</div>

              <div class="rv-persona-card rv-persona-card-right" id="rv-persona-card-two">
                <div class="rv-persona-card-text">
                  <div class="rv-persona-slot">Persona 2</div>
                  <div id="rv-persona-name-two" class="rv-persona-name">—</div>
                </div>
                <img id="rv-avatar-two" class="rv-persona-avatar" alt="">
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

          <section class="rv-panel rv-control-panel" style="border:1px solid #555; border-radius:12px; padding:16px;">
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

    function updatePersonaStage() {
      const slots = [
        {
          select: p1,
          card: root.querySelector("#rv-persona-card-one"),
          avatar: root.querySelector("#rv-avatar-one"),
          name: root.querySelector("#rv-persona-name-one")
        },
        {
          select: p2,
          card: root.querySelector("#rv-persona-card-two"),
          avatar: root.querySelector("#rv-avatar-two"),
          name: root.querySelector("#rv-persona-name-two")
        }
      ];

      for (const slot of slots) {
        if (!slot.select || !slot.card || !slot.avatar || !slot.name) continue;

        const token = slot.select.value || "";
        const persona = rvPersonaRecord(token);

        const displayName =
          String((persona && persona.name) || token || "Persona").trim();

        const trim =
          String((persona && persona.trim_color) || speakerColor(displayName) || "#b58a52");

        slot.name.textContent = displayName;
        slot.name.style.color = trim;
        slot.card.style.setProperty("--persona-color", trim);

        const fallback = rvAvatarFallback(displayName, trim);

        slot.avatar.onerror = () => {
          slot.avatar.onerror = null;
          slot.avatar.src = fallback;
        };

        if (persona && persona.avatar) {
          slot.avatar.src = rvAvatarUrl(displayName);
        } else {
          slot.avatar.src = fallback;
        }

        slot.avatar.alt = `${displayName} avatar`;
      }
    }

    if (p1) p1.addEventListener("change", updatePersonaStage);
    if (p2) p2.addEventListener("change", updatePersonaStage);

    setTimeout(updatePersonaStage, 0);
    setTimeout(() => rvTightenRendezvousChrome(root), 0);
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
      const previousScrollTop = transcript.scrollTop || 0;
      const previousScrollHeight = transcript.scrollHeight || 0;
      const previousClientHeight = transcript.clientHeight || 0;
      const wasNearBottom = previousScrollHeight - previousScrollTop - previousClientHeight < 80;

      transcript.innerHTML = renderTranscriptHtml(text || "");
      polishTranscriptDom();
      rvInlineAvatarsBesideBubbles(root, transcript);

      requestAnimationFrame(() => {
        if (rvAutoVoiceEnabled()) {
          transcript.scrollTop = previousScrollTop;
        } else if (wasNearBottom) {
          transcript.scrollTop = transcript.scrollHeight;
        } else {
          const newScrollHeight = transcript.scrollHeight || 0;
          const heightDelta = newScrollHeight - previousScrollHeight;
          transcript.scrollTop = Math.max(
            0,
            previousScrollTop + Math.max(0, heightDelta)
          );
        }
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
      setTimeout(() => {
        if (typeof updatePersonaStage === "function") updatePersonaStage();
      }, 0);
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
      rvInlineAvatarsBesideBubbles(root, transcript);
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

(function () {
  const state = {
    personas: [],
    history: [],
    lastTranscript: "",
    pendingDividerLabel: "",
    showInnerThoughts: localStorage.getItem("rvShowInnerThoughts") === "true",
    viewMode: "live"
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
            <h2 style="margin:0;">Rendezvous</h2>
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
              <textarea id="rv-scene" rows="4" style="width:100%; padding:10px; border-radius:8px;">meeting for coffee in a quiet diner at dusk</textarea>
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
                <button id="rv-export" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Save Session</button>
                <button id="rv-archive" style="padding:9px 12px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Archive Session</button>
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
      if (!state.history.length) {
        historyList.innerHTML = `<div style="opacity:.75;">No archived sessions yet.</div>`;
        return;
      }

      historyList.innerHTML = state.history.map(item => {
        const when = item.created_at ? new Date(item.created_at).toLocaleString() : "";
        const scene = item.scene ? item.scene : "";
        return `
          <div style="
            margin-bottom:10px;
            padding:10px;
            border:1px solid rgba(120,120,140,.28);
            border-radius:10px;
            background: rgba(255,255,255,.02);
          ">
            <div style="font-weight:700; color:#f3e8ff; margin-bottom:4px;">${escapeHtml(item.title || "Archived session")}</div>
            <div style="font-size:12px; opacity:.8; margin-bottom:4px;">${escapeHtml(when)}</div>
            <div style="font-size:12px; opacity:.8; margin-bottom:8px;">${escapeHtml(scene)}</div>
            <div style="display:flex; gap:8px;">
              <button data-load-id="${escapeHtml(item.id)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Load</button>
              <button data-delete-id="${escapeHtml(item.id)}" style="padding:7px 10px; border-radius:10px; cursor:pointer; border:1px solid #7c3aed; background:rgba(76, 29, 149, .18); color:#e9d5ff; font-weight:700;">Delete</button>
            </div>
          </div>
        `;
      }).join("");

      historyList.querySelectorAll("[data-load-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            const id = btn.getAttribute("data-load-id");
            const data = await api("history/load", {
              method: "POST",
              body: JSON.stringify({ id })
            });

            const entry = data.entry || {};
            state.viewMode = "archive";
            state.pendingDividerLabel = "";
            setTranscript(entry.transcript_text || "");
            setStatus("Archive loaded");

            if (entry.persona_1) p1.value = entry.persona_1;
            if (entry.persona_2) p2.value = entry.persona_2;
            if (entry.scene) root.querySelector("#rv-scene").value = entry.scene;
          } catch (err) {
            setStatus("Archive load failed");
          }
        });
      });

      historyList.querySelectorAll("[data-delete-id]").forEach(btn => {
        btn.addEventListener("click", async () => {
          try {
            const id = btn.getAttribute("data-delete-id");
            const data = await api("history/delete", {
              method: "POST",
              body: JSON.stringify({ id })
            });
            state.history = data.history || [];
            renderHistoryList();
            setStatus("Archive deleted");
          } catch (err) {
            setStatus("Delete failed");
          }
        });
      });
    }

    async function loadPersonas() {
      const data = await api("personas");
      state.personas = data.personas || [];
      fillPersonas(state.personas);
    }

    setStatus("Idle");

    async function loadHistory() {
      const data = await api("history");
      state.history = data.history || [];
      renderHistoryList();
    }

    async function refreshState() {
      const data = await api("session/state");
      const s = data.state || {};
      state.viewMode = "live";
      setTranscript(s.transcript_text || "");
      setStatus(s.active ? "Paused" : "Idle");
    }

    root.querySelector("#rv-start").addEventListener("click", async () => {
      try {
        state.viewMode = "live";
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
        console.error(err); setStatus("Error");
        setTranscript(String(err));
      }
    });

    root.querySelector("#rv-continue").addEventListener("click", async () => {
      try {
        state.viewMode = "live";
        state.pendingDividerLabel = "Next batch";
        setStatus("Continuing...");
        const data = await api("session/continue", { method: "POST" });
        setTranscript(data.transcript || "");
        pollUntilSettled().catch((err) => console.warn("Rendezvous polling start failed:", err));
      } catch (err) {
        console.error(err); setStatus("Error");
        setTranscript(String(err));
      }
    });

    root.querySelector("#rv-send").addEventListener("click", async () => {
      try {
        const msg = userBox.value.trim();
        if (!msg) {
          setStatus("Type a message first.");
          return;
        }
        state.viewMode = "live";
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
        console.error(err); setStatus("Error");
        setTranscript(String(err));
      }
    });

    root.querySelector("#rv-end").addEventListener("click", async () => {
      try {
        stopRvPolling();
        setStatus("Ending...");
        await api("session/end", { method: "POST" });
        userBox.value = "";
        await refreshState();
      } catch (err) {
        console.error(err); setStatus("Error");
        setTranscript(String(err));
      }
    });

    root.querySelector("#rv-clear").addEventListener("click", async () => {
      try {
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
        console.error(err); setStatus("Error");
        setTranscript(String(err));
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
      try {
        if (!state.lastTranscript.trim()) {
          setStatus("Nothing to archive.");
          return;
        }
        const data = await api("history/save", {
          method: "POST",
          body: JSON.stringify({})
        });
        state.history = data.history || [];
        renderHistoryList();
        setStatus("Session archived.");
      } catch (err) {
        setStatus("Archive failed");
      }
    });

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

  const ROOT_ID = "rendezvous-app-root";
  let routeWatcher = null;

  function isRendezvousRoute() {
    return (window.location.hash || "").startsWith("#apps/rendezvous");
  }

  function unmount() {
    if (window.__rvStopPolling) {
      try { window.__rvStopPolling(); } catch (e) {}
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
    root.style.top = "92px";
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
  document.addEventListener("click", () => setTimeout(syncRoute, 60), true);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

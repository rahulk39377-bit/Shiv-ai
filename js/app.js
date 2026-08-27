/* ==========================================================================
   SHIV AI — app.js
   Vanilla JS, no build step. Talks to a Cloudflare Worker proxy that wraps
   the Claude API. Everything else (chat history, mood, memory, settings,
   stats) lives in localStorage — nothing leaves the device except the
   message text sent to the AI backend.
   ========================================================================== */

(() => {
  "use strict";

  /* ---------------- Config ---------------- */
  const CONFIG = {
    // Same Cloudflare Worker proxy used across Rahul's other SHIV AI builds.
    // Update this if the worker is redeployed under a new subdomain.
    AI_ENDPOINT: "https://shiv-proxy.rahulk39377.workers.dev",
    PASSPHRASE_VARIANTS: [
      "shiv main hoon rahul",
      "shiv mai hoon rahul",
      "shiv main hu rahul",
      "शिव मैं हूं राहुल",
      "शिव मैं हूँ राहुल"
    ],
    FUZZY_THRESHOLD: 0.78, // similarity ratio (0-1) required to unlock
    SPEECH_LANG: "hi-IN",
    STORAGE_PREFIX: "shivai_"
  };

  const LS = {
    chats: CONFIG.STORAGE_PREFIX + "chats",
    stats: CONFIG.STORAGE_PREFIX + "stats",
    settings: CONFIG.STORAGE_PREFIX + "settings",
    memory: CONFIG.STORAGE_PREFIX + "memory",
    unlocked: CONFIG.STORAGE_PREFIX + "unlocked_session"
  };

  /* ---------------- Utilities ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $all = (sel) => Array.from(document.querySelectorAll(sel));

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("SHIV AI: storage full or unavailable", e);
    }
  }

  function normalize(str) {
    return str
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Levenshtein distance -> similarity ratio in [0,1]
  function similarity(a, b) {
    a = normalize(a);
    b = normalize(b);
    if (!a.length && !b.length) return 1;
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    const dist = dp[m][n];
    const maxLen = Math.max(m, n) || 1;
    return 1 - dist / maxLen;
  }

  function bestPassphraseMatch(input) {
    let best = 0;
    for (const variant of CONFIG.PASSPHRASE_VARIANTS) {
      best = Math.max(best, similarity(input, variant));
    }
    return best;
  }

  function toast(msg, ms = 2200) {
    let el = $(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  function escapeHTML(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  /* ---------------- State ---------------- */
  const state = {
    chats: loadJSON(LS.chats, []), // [{role, text, mood, time}]
    stats: loadJSON(LS.stats, { chats: 0, messages: 0, voice: 0 }),
    settings: loadJSON(LS.settings, {
      voice: true,
      lang: "hinglish",
      autoListen: false,
      save: true
    }),
    memory: loadJSON(LS.memory, { facts: [] }), // lightweight rolling memory
    attachments: [],
    recognizing: false,
    currentView: "chat"
  };

  function persistChats() {
    if (state.settings.save) saveJSON(LS.chats, state.chats.slice(-200));
  }
  function persistStats() {
    saveJSON(LS.stats, state.stats);
  }
  function persistSettings() {
    saveJSON(LS.settings, state.settings);
  }
  function persistMemory() {
    saveJSON(LS.memory, state.memory);
  }

  /* ---------------- Mood engine ---------------- */
  // Very lightweight keyword scan — good enough to color SHIV's tone,
  // not meant to be a real sentiment model.
  const MOOD_LEXICON = {
    happy: ["khushi", "badhiya", "achha", "great", "thanks", "dhanyavad", "mast", "shukriya", "😊", "😄"],
    stressed: ["pareshan", "tension", "problem", "issue", "urgent", "jaldi", "help", "dikkat"],
    sad: ["udaas", "sad", "dukhi", "bura", "😢"],
    curious: ["kaise", "kyun", "kya", "how", "why", "what", "explain", "samjhao"]
  };
  function detectMood(text) {
    const t = text.toLowerCase();
    for (const [mood, words] of Object.entries(MOOD_LEXICON)) {
      if (words.some((w) => t.includes(w))) return mood;
    }
    return "neutral";
  }
  const MOOD_EMOJI = { happy: "😊", stressed: "😰", sad: "🙁", curious: "🤔", neutral: "" };

  /* ---------------- Rolling memory ---------------- */
  // Pulls short "remember this" style facts out of user messages so later
  // replies can reference them. Purely local — never sent anywhere except
  // back to the AI as extra context for this session.
  function maybeExtractMemory(text) {
    const triggers = ["yaad rakho", "yaad rakhna", "remember", "mera naam"];
    const lower = text.toLowerCase();
    if (triggers.some((t) => lower.includes(t))) {
      state.memory.facts.push({ text, time: Date.now() });
      state.memory.facts = state.memory.facts.slice(-20);
      persistMemory();
    }
  }
  function memoryContext() {
    if (!state.memory.facts.length) return "";
    return (
      "Known context about the user (from earlier in conversation): " +
      state.memory.facts.map((f) => f.text).join("; ")
    );
  }

  /* ==========================================================================
     Boot sequence: splash -> lock -> app
     ========================================================================== */
  document.addEventListener("DOMContentLoaded", () => {
    injectLockScreen();
    setTimeout(runBootSequence, 1200);
    wireStaticUI();
    applySettingsToUI();
    renderStats();
    renderHistory();
  });

  function injectLockScreen() {
    const lock = document.createElement("div");
    lock.id = "lock-screen";
    lock.className = "lock-screen hidden";
    lock.innerHTML = `
      <div class="lock-card">
        <span class="om-symbol">ॐ</span>
        <h2>SHIV AI Locked</h2>
        <p>Apna passphrase bolo ya type karo:<br><strong>"Shiv main hoon Rahul"</strong></p>
        <input type="text" id="lock-input" class="lock-input" placeholder="Passphrase type karo..." autocomplete="off" />
        <div class="lock-actions">
          <button id="lock-mic" class="lock-btn mic" aria-label="Voice unlock">🎤</button>
          <button id="lock-submit" class="lock-btn primary">Unlock</button>
        </div>
        <div id="lock-error" class="lock-error"></div>
      </div>
    `;
    document.body.appendChild(lock);
  }

  function runBootSequence() {
    const splash = $("#splash");
    const app = $("#app");
    const lock = $("#lock-screen");
    if (splash) splash.style.opacity = "0";
    setTimeout(() => {
      if (splash) splash.classList.add("hidden");
      const alreadyUnlocked = sessionStorage.getItem(LS.unlocked) === "1";
      if (alreadyUnlocked) {
        app.classList.remove("hidden");
      } else {
        lock.classList.remove("hidden");
        $("#lock-input").focus();
      }
    }, 480);
    wireLockScreen();
  }

  function wireLockScreen() {
    const input = $("#lock-input");
    const submitBtn = $("#lock-submit");
    const micBtn = $("#lock-mic");
    const errorEl = $("#lock-error");

    function attemptUnlock() {
      const val = input.value.trim();
      if (!val) return;
      const score = bestPassphraseMatch(val);
      if (score >= CONFIG.FUZZY_THRESHOLD) {
        sessionStorage.setItem(LS.unlocked, "1");
        $("#lock-screen").classList.add("hidden");
        $("#app").classList.remove("hidden");
        toast("🙏 Namaste Rahul, SHIV AI ready hai");
      } else {
        errorEl.textContent = "Passphrase match nahi hua, dobara try karo.";
        input.value = "";
        input.focus();
      }
    }

    submitBtn.addEventListener("click", attemptUnlock);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") attemptUnlock();
    });

    micBtn.addEventListener("click", () => {
      const rec = createRecognizer();
      if (!rec) {
        toast("Voice input is supported nahi hai is browser mein");
        return;
      }
      micBtn.classList.add("recording");
      rec.onresult = (e) => {
        input.value = e.results[0][0].transcript;
        attemptUnlock();
      };
      rec.onend = () => micBtn.classList.remove("recording");
      rec.onerror = () => micBtn.classList.remove("recording");
      rec.start();
    });
  }

  /* ==========================================================================
     Static UI wiring: sidebar, topbar, views, settings, file assistant
     ========================================================================== */
  function wireStaticUI() {
    // Sidebar drawer (mobile)
    $("#menu-btn")?.addEventListener("click", () => {
      $("#sidebar").classList.add("open");
      $("#overlay").classList.add("show");
    });
    $("#close-sidebar")?.addEventListener("click", closeDrawer);
    $("#overlay")?.addEventListener("click", closeDrawer);
    function closeDrawer() {
      $("#sidebar").classList.remove("open");
      $("#overlay").classList.remove("show");
    }

    // Nav items + tool cards + back-to-chat buttons all switch views
    $all("[data-view]").forEach((el) => {
      el.addEventListener("click", () => {
        switchView(el.dataset.view);
        closeDrawer();
      });
    });

    // Mode-specific prompt buttons and quick actions fill + send
    $all(".qa-btn, .mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const prompt = btn.dataset.prompt || "";
        switchView("chat");
        $("#user-input").value = prompt;
        autoGrow($("#user-input"));
        if (prompt.trim().endsWith(":")) {
          $("#user-input").focus(); // code-explain style: let user append text
        } else {
          sendMessage();
        }
      });
    });

    // New chat
    $("#new-chat")?.addEventListener("click", () => {
      if (!confirm("Naya chat start karein? Purani conversation dashboard mein rahegi.")) return;
      state.chats = [];
      persistChats();
      $("#chat-messages").innerHTML = "";
      renderWelcome();
    });

    // Voice reply toggle
    const voiceToggle = $("#voice-toggle");
    voiceToggle?.addEventListener("click", () => {
      state.settings.voice = !state.settings.voice;
      persistSettings();
      applySettingsToUI();
      toast(state.settings.voice ? "🔊 Voice reply ON" : "🔇 Voice reply OFF");
      window.speechSynthesis?.cancel();
    });

    // Mic button (chat)
    $("#mic-btn")?.addEventListener("click", toggleDictation);

    // Send button + Enter to send
    $("#send-btn")?.addEventListener("click", sendMessage);
    $("#user-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $("#user-input")?.addEventListener("input", (e) => autoGrow(e.target));

    // Attach files
    $("#attach-btn")?.addEventListener("click", () => $("#chat-file-input").click());
    $("#chat-file-input")?.addEventListener("change", (e) => handleAttachments(e.target.files));

    // File assistant view
    const uploadBox = $("#upload-box");
    const fileInput = $("#file-input");
    uploadBox?.addEventListener("click", () => fileInput.click());
    uploadBox?.addEventListener("dragover", (e) => { e.preventDefault(); uploadBox.classList.add("drag-over"); });
    uploadBox?.addEventListener("dragleave", () => uploadBox.classList.remove("drag-over"));
    uploadBox?.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadBox.classList.remove("drag-over");
      if (e.dataTransfer.files.length) describeUploadedFile(e.dataTransfer.files[0]);
    });
    fileInput?.addEventListener("change", (e) => {
      if (e.target.files.length) describeUploadedFile(e.target.files[0]);
    });

    // Settings
    $("#setting-voice")?.addEventListener("change", (e) => {
      state.settings.voice = e.target.checked;
      persistSettings();
    });
    $("#setting-lang")?.addEventListener("change", (e) => {
      state.settings.lang = e.target.value;
      persistSettings();
    });
    $("#setting-auto-listen")?.addEventListener("change", (e) => {
      state.settings.autoListen = e.target.checked;
      persistSettings();
    });
    $("#setting-save")?.addEventListener("change", (e) => {
      state.settings.save = e.target.checked;
      persistSettings();
      if (!e.target.checked) toast("Chat history ab save nahi hogi");
    });
    $("#clear-data")?.addEventListener("click", () => {
      if (!confirm("Sab local data (chats, memory, stats) delete ho jayega. Pakka?")) return;
      Object.values(LS).forEach((k) => localStorage.removeItem(k));
      sessionStorage.removeItem(LS.unlocked);
      state.chats = [];
      state.stats = { chats: 0, messages: 0, voice: 0 };
      state.memory = { facts: [] };
      renderStats();
      $("#chat-messages").innerHTML = "";
      renderWelcome();
      toast("🗑️ Sab data clear ho gaya");
    });
  }

  function autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  }

  function switchView(view) {
    $all(".view").forEach((v) => v.classList.remove("active"));
    $(`#view-${view}`)?.classList.add("active");
    $all(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.view === view));
    state.currentView = view;

    const titles = {
      chat: "💬 Smart Chat",
      dashboard: "📊 Dashboard",
      business: "💼 Business Mode",
      developer: "🛠️ Developer Mode",
      creative: "🎨 Creative Mode",
      files: "📂 File Assistant",
      settings: "🔐 Settings"
    };
    const titleEl = $("#current-mode");
    if (titleEl) titleEl.textContent = titles[view] || "SHIV AI";

    if (view === "dashboard") renderStats();
  }

  function applySettingsToUI() {
    const s = state.settings;
    const voiceToggle = $("#voice-toggle");
    if (voiceToggle) {
      voiceToggle.classList.toggle("on", s.voice);
      voiceToggle.textContent = s.voice ? "🔊" : "🔇";
    }
    if ($("#setting-voice")) $("#setting-voice").checked = s.voice;
    if ($("#setting-lang")) $("#setting-lang").value = s.lang;
    if ($("#setting-auto-listen")) $("#setting-auto-listen").checked = s.autoListen;
    if ($("#setting-save")) $("#setting-save").checked = s.save;
  }

  /* ==========================================================================
     Chat rendering + history
     ========================================================================== */
  function renderWelcome() {
    appendBubble("ai", `
      <p>🙏 Namaste! Main <strong>SHIV AI</strong> hoon.</p>
      <p>Hindi, English ya Hinglish mein baat karo. Voice se bhi command de sakte ho.</p>
      <p>Quick actions try karo ya mode change karo (Business / Developer / Creative).</p>
    `, { raw: true });
  }

  function renderHistory() {
    const box = $("#chat-messages");
    if (!box) return;
    if (!state.chats.length) {
      renderWelcome();
      return;
    }
    box.innerHTML = "";
    state.chats.forEach((m) => {
      appendBubble(m.role, escapeHTML(m.text).replace(/\n/g, "<br>"), {
        raw: true,
        mood: m.mood,
        skipSave: true
      });
    });
  }

  function appendBubble(role, html, opts = {}) {
    const box = $("#chat-messages");
    if (!box) return null;
    const wrap = document.createElement("div");
    wrap.className = `message ${role}`;
    const avatar = document.createElement("div");
    avatar.className = "avatar om-avatar";
    avatar.textContent = role === "ai" ? "ॐ" : "🧑";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.innerHTML = opts.raw ? html : `<p>${escapeHTML(html)}</p>`;
    if (opts.mood && MOOD_EMOJI[opts.mood]) {
      const tag = document.createElement("span");
      tag.className = "mood-tag";
      tag.textContent = MOOD_EMOJI[opts.mood];
      bubble.appendChild(tag);
    }
    wrap.appendChild(avatar);
    wrap.appendChild(bubble);
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
    return bubble;
  }

  function appendThinking() {
    const box = $("#chat-messages");
    const wrap = document.createElement("div");
    wrap.className = "message ai";
    wrap.id = "thinking-bubble";
    wrap.innerHTML = `
      <div class="avatar om-avatar">ॐ</div>
      <div class="bubble thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
    `;
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }
  function removeThinking() {
    $("#thinking-bubble")?.remove();
  }

  /* ==========================================================================
     Sending messages + AI backend call
     ========================================================================== */
  async function sendMessage() {
    const input = $("#user-input");
    const text = input.value.trim();
    if (!text && !state.attachments.length) return;

    const mood = detectMood(text);
    appendBubble("user", escapeHTML(text).replace(/\n/g, "<br>") || "(attachment)", { raw: true });
    renderAttachmentChips("user-last");
    maybeExtractMemory(text);

    state.chats.push({ role: "user", text, mood, time: Date.now() });
    state.stats.messages += 1;
    if (state.chats.filter((m) => m.role === "user").length === 1) state.stats.chats += 1;
    persistChats();
    persistStats();
    renderStats();

    input.value = "";
    autoGrow(input);
    const attachmentsSent = state.attachments;
    state.attachments = [];
    renderMediaPreview();

    appendThinking();
    $("#send-btn").disabled = true;

    try {
      const reply = await callShivBackend(text, mood, attachmentsSent);
      removeThinking();
      appendBubble("ai", escapeHTML(reply).replace(/\n/g, "<br>"), { raw: true });
      state.chats.push({ role: "ai", text: reply, mood: "neutral", time: Date.now() });
      persistChats();
      if (state.settings.voice) speak(reply);
    } catch (err) {
      removeThinking();
      const fallback = "⚠️ Abhi SHIV AI backend se connect nahi ho paaya. Thodi der me try karo, ya apna Cloudflare Worker endpoint check karo.";
      appendBubble("ai", fallback, { raw: true });
      console.error("SHIV AI backend error:", err);
    } finally {
      $("#send-btn").disabled = false;
    }

    if (state.settings.autoListen) setTimeout(toggleDictation, 400);
  }

  async function callShivBackend(text, mood, attachments) {
    const langHint = {
      hinglish: "Reply in natural Hinglish (Roman script mixing Hindi + English).",
      hindi: "Reply in Hindi (Devanagari script).",
      english: "Reply in English."
    }[state.settings.lang] || "Reply in Hinglish.";

    const modeContext = {
      business: "User is in Business Mode — focus on LADLA GROUP business, pricing, marketing, growth.",
      developer: "User is in Developer Mode — focus on HTML/CSS/JS code help.",
      creative: "User is in Creative Mode — focus on posters, taglines, reels, marketing creative.",
      files: "User is in File Assistant — help interpret an uploaded file.",
      chat: ""
    }[state.currentView] || "";

    const payload = {
      message: text,
      mood,
      language: state.settings.lang,
      system_hint: [langHint, modeContext, memoryContext()].filter(Boolean).join(" "),
      history: state.chats.slice(-10).map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })),
      attachments: (attachments || []).map((a) => ({ name: a.name, type: a.type }))
    };

    const res = await fetch(CONFIG.AI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`Worker responded ${res.status}`);
    const data = await res.json();
    // Accept a couple of common response shapes from the worker.
    return data.reply || data.text || data.message || "🤔 Reply samajh nahi aaya, dobara try karo.";
  }

  /* ==========================================================================
     Voice: dictation (input) + speech synthesis (reply)
     ========================================================================== */
  function createRecognizer() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const rec = new SR();
    rec.lang = CONFIG.SPEECH_LANG;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    return rec;
  }

  let activeRecognizer = null;
  function toggleDictation() {
    const micBtn = $("#mic-btn");
    if (state.recognizing) {
      activeRecognizer?.stop();
      return;
    }
    const rec = createRecognizer();
    if (!rec) {
      toast("Is browser mein voice input support nahi hai");
      return;
    }
    activeRecognizer = rec;
    state.recognizing = true;
    micBtn.classList.add("recording");

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      const input = $("#user-input");
      input.value = (input.value ? input.value + " " : "") + transcript;
      autoGrow(input);
      state.stats.voice += 1;
      persistStats();
      renderStats();
    };
    rec.onerror = () => toast("Voice input mein error aaya");
    rec.onend = () => {
      state.recognizing = false;
      micBtn.classList.remove("recording");
    };
    rec.start();
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const clean = text.replace(/[*_#`]/g, "");
    const utter = new SpeechSynthesisUtterance(clean);
    utter.lang = state.settings.lang === "english" ? "en-IN" : "hi-IN";
    utter.rate = 1;
    window.speechSynthesis.speak(utter);
  }

  /* ==========================================================================
     Attachments (chat) + File Assistant view
     ========================================================================== */
  function handleAttachments(fileList) {
    Array.from(fileList).forEach((file) => {
      if (state.attachments.length >= 4) return;
      state.attachments.push(file);
    });
    renderMediaPreview();
  }

  function renderMediaPreview() {
    const strip = $("#media-preview");
    if (!strip) return;
    if (!state.attachments.length) {
      strip.classList.add("hidden");
      strip.innerHTML = "";
      return;
    }
    strip.classList.remove("hidden");
    strip.innerHTML = "";
    state.attachments.forEach((file, i) => {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      const isImg = file.type.startsWith("image/");
      chip.innerHTML = `
        ${isImg ? `<img src="${URL.createObjectURL(file)}" alt="${escapeHTML(file.name)}" />` : "📎"}
        <span>${escapeHTML(file.name.slice(0, 18))}</span>
        <button class="chip-remove" aria-label="Remove">✕</button>
      `;
      chip.querySelector(".chip-remove").addEventListener("click", () => {
        state.attachments.splice(i, 1);
        renderMediaPreview();
      });
      strip.appendChild(chip);
    });
  }

  function renderAttachmentChips() {
    // Attachments are shown in the input preview strip before sending;
    // nothing extra needed once the message bubble is posted.
  }

  function describeUploadedFile(file) {
    const info = $("#file-info");
    if (!info) return;
    info.classList.remove("hidden");
    const sizeKB = (file.size / 1024).toFixed(1);
    info.innerHTML = `
      <strong>${escapeHTML(file.name)}</strong><br>
      Type: ${escapeHTML(file.type || "unknown")}<br>
      Size: ${sizeKB} KB<br>
      <small>Is demo mein file sirf preview hoti hai — chat mein bhejne ke liye 📎 button use karo.</small>
    `;
  }

  /* ==========================================================================
     Dashboard stats
     ========================================================================== */
  function renderStats() {
    if ($("#stat-chats")) $("#stat-chats").textContent = state.stats.chats;
    if ($("#stat-messages")) $("#stat-messages").textContent = state.stats.messages;
    if ($("#stat-voice")) $("#stat-voice").textContent = state.stats.voice;

    const list = $("#recent-list");
    if (!list) return;
    const recentUserMsgs = state.chats.filter((m) => m.role === "user").slice(-5).reverse();
    if (!recentUserMsgs.length) {
      list.innerHTML = "<li>No recent activity yet. Start chatting!</li>";
      return;
    }
    list.innerHTML = recentUserMsgs
      .map((m) => `<li>${escapeHTML(m.text.slice(0, 60))}${m.text.length > 60 ? "…" : ""}</li>`)
      .join("");
  }
})();

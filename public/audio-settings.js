(() => {
  "use strict";
  const section = document.createElement("section"); section.className = "settings-section audio-settings";
  const heading = document.createElement("h3"); heading.textContent = "Speech-to-text";
  const help = document.createElement("button"); help.type = "button"; help.className = "search-help"; help.textContent = "?";
  help.setAttribute("aria-label", "About speech-to-text");
  help.dataset.tooltip = "Uses an OpenAI-compatible source from Agent settings. Hosted sources receive your recording and may charge for transcription.";
  help.setAttribute("aria-description", help.dataset.tooltip); heading.append(" ", help); section.append(heading);
  const status = document.createElement("p"); status.className = "settings-hint"; status.setAttribute("role", "status");
  function row(label, name, type) {
    const line = document.createElement("div"); line.className = "setting-row";
    const text = document.createElement("label"); text.textContent = label; text.id = `audio-${name}-label`;
    const input = document.createElement(type === "select" ? "select" : type === "switch" ? "button" : "input");
    input.id = `audio-${name}`; text.htmlFor = input.id;
    input.setAttribute("aria-label", label);
    if (type === "switch") {
      input.type = "button"; input.className = "pill-toggle";
      input.setAttribute("role", "switch"); input.setAttribute("aria-checked", "false");
      input.addEventListener("click", () => {
        input.setAttribute("aria-checked", String(input.getAttribute("aria-checked") !== "true"));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } else if (type !== "select") {
      input.type = type; input.className = "ag-input audio-control";
    }
    line.append(text, input); section.append(line);
    if (type === "select") {
      window.createSelect(input).classList.add("audio-control");
      text.htmlFor = `${input.id}-button`;
    }
    return input;
  }
  const source = row("Source", "source", "select");
  const model = row("Model", "model", "text"); model.placeholder = "whisper-1";
  const language = row("Language", "language", "text"); language.placeholder = "Auto";
  const send = row("Send after dictation", "send", "switch");
  const push = row("Push-to-talk (Ctrl+Shift+Space)", "push", "switch");
  const mic = row("Microphone", "mic", "select");
  const actions = document.createElement("div"); actions.className = "settings-actions";
  const test = document.createElement("button"); test.type = "button"; test.textContent = "Test";
  actions.append(test); section.append(actions);
  const option = (select, value, text) => { const node = document.createElement("option"); node.value = value; node.textContent = text; select.append(node); };
  async function devices() {
    mic.replaceChildren(); option(mic, "", "Default microphone");
    try { const list = await navigator.mediaDevices?.enumerateDevices() || [];
      list.filter(d => d.kind === "audioinput").forEach((d, i) => option(mic, d.deviceId, d.label || `Microphone ${i + 1}`));
      const id = window.scribeAudio.device();
      if (id && ![...mic.options].some(o => o.value === id)) option(mic, id, "Saved microphone (unavailable)");
      mic.value = id;
    } catch { /* default device remains available */ }
    mic.parentElement.syncSelect();
  }
  async function refresh() {
    try {
      const view = await window.scribeAudio.refresh();
      source.replaceChildren(); option(source, "", "Choose source…");
      view.sources.forEach(s => option(source, s.id, s.name)); source.value = view.stt.source || "";
      source.parentElement.syncSelect();
      model.value = view.stt.model; language.value = view.stt.language || "";
      send.setAttribute("aria-checked", String(view.input.sendAfterDictation));
      push.setAttribute("aria-checked", String(view.input.pushToTalk));
      status.textContent = view.sources.length ? "" : "Add an OpenAI-compatible source in Agent settings first.";
      await devices();
    } catch (err) { status.textContent = err.message; }
  }
  let saving = Promise.resolve();
  function save() {
    const body = { stt: { source: source.value, model: model.value, language: language.value }, input: { sendAfterDictation: send.getAttribute("aria-checked") === "true", pushToTalk: push.getAttribute("aria-checked") === "true" } };
    saving = saving.then(async () => {
      const res = await fetch("/api/audio/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error);
      await window.scribeAudio.refresh(); status.textContent = "";
    }).catch(err => { status.textContent = err.message; });
    return saving;
  }
  [source, model, language, send, push].forEach(input => input.addEventListener("change", save));
  mic.addEventListener("change", () => window.scribeAudio.setDevice(mic.value));
  navigator.mediaDevices?.addEventListener("devicechange", devices);
  test.addEventListener("click", async () => {
    test.disabled = true; status.textContent = "Testing…";
    try {
      await saving;
      const res = await fetch("/api/audio/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const result = await res.json(); status.textContent = result.ok ? `Transcript: ${result.text || "(empty)"}` : result.message || result.error;
    } catch { status.textContent = "Cannot reach speech-to-text."; }
    finally { test.disabled = false; }
  });
  section.append(status);
  window.scribeAudioSettings = { sections: [section], refresh };
})();

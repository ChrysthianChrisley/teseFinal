/* Android APK bridge. The native foreground service owns BLE and the SQLite
 * journal; this page is a view of that journal and may be suspended safely. */
'use strict';

window.NativeMonitor = (() => {
  const capacitor = window.Capacitor;
  const enabled = !!capacitor && (capacitor.isNativePlatform?.() || capacitor.getPlatform?.() === 'android');
  const plugin = enabled
    ? (capacitor.registerPlugin ? capacitor.registerPlugin('MonitorNative') : capacitor.Plugins?.MonitorNative)
    : null;
  const MAX_CACHE_SAMPLES = 864000; // At most 24 hours at 10 Hz, never the CSV source.
  let timer = null;
  let running = false;
  let started = false;
  let cursor = 0;
  let sessions = [];
  let status = {};
  let sessionId = null;
  let historical = false;
  let totalSamples = 0;
  let lastHistoryRefresh = 0;
  let lastError = '';
  let cleared = false;
  let connectionAction = false;
  const offlineKeys = new Set();
  let lastDeviceMillis = null;
  let lastLiveSeq = null;

  const element = id => document.getElementById(id);
  const setText = (id, value) => { const el = element(id); if (el) el.textContent = value; };
  const errorText = err => err?.message || String(err);
  const metadata = () => sessions.find(s => s.id === sessionId) || {};

  function showError(err) {
    const message = errorText(err);
    if (message !== lastError) {
      lastError = message;
      recordAlertEvent('warn', `Android: ${message}`);
    }
    setText('native-service-status', message);
  }

  function resetView(id, meta = {}) {
    sessionId = id || null;
    cursor = 0;
    offlineKeys.clear();
    lastDeviceMillis = null;
    lastLiveSeq = null;
    totalSamples = 0;
    cleared = false;
    batteryTrial.sessionId = sessionId;
    batteryTrial.samples = [];
    batteryTrial.startTime = Number(meta.startTime) || null;
    batteryTrial.endTime = Number(meta.endTime) || null;
    batteryTrial.isRecording = !historical && !!status.active && id === status.sessionId;
    batteryTrial.isFinished = !batteryTrial.isRecording && !!sessionId;
    batteryTrial.peakM1 = 0;
    batteryTrial.peakM5 = 0;
    batteryTrial.peakCalc = 0;
    batteryTrial.lastSeq = null;
    batteryTrial.lastTimestamp = null;
    rollingHistorySamples = [];
    telemetryHistory.length = 0;
    state.lastData = null;
    state.environment = { temp: null, umid: null };
    state.autoTaredOnce = false;
    resetTare();
  }

  function appendSample(data, packet, source) {
    const now = Number(packet.receivedAt) || Date.now();
    if (!batteryTrial.startTime) batteryTrial.startTime = now;
    const sample = {
      timestamp: now,
      t_ms: Math.max(0, now - batteryTrial.startTime),
      device_t_ms: data.t_ms != null ? Number(data.t_ms) : null,
      source,
      packetId: Number(packet.id),
      seq: data.seq != null ? Number(data.seq) : totalSamples + 1,
      m1: Math.round(Number(data.meta1) || 0),
      m5: Math.round(Number(data.meta5) || 0),
      calc: Math.round(Number(data.calcaneo) || 0),
      temp: data.temp != null && Number.isFinite(Number(data.temp)) ? Number(data.temp).toFixed(1) : '',
      umid: data.umid != null && Number.isFinite(Number(data.umid)) ? Number(data.umid).toFixed(1) : '',
      timeStr: new Date(now).toLocaleTimeString('pt-BR')
    };
    totalSamples++;
    batteryTrial.samples.push(sample);
    batteryTrial.lastSeq = sample.seq;
    batteryTrial.lastTimestamp = sample.timeStr;
    batteryTrial.peakM1 = Math.max(batteryTrial.peakM1, sample.m1);
    batteryTrial.peakM5 = Math.max(batteryTrial.peakM5, sample.m5);
    batteryTrial.peakCalc = Math.max(batteryTrial.peakCalc, sample.calc);
    if (source === 'live') {
      if (data.temp != null && Number.isFinite(Number(data.temp))) state.environment.temp = Number(data.temp);
      if (data.umid != null && Number.isFinite(Number(data.umid))) state.environment.umid = Number(data.umid);
    }
    // Retain a bounded view. Full records remain in SQLite for every export.
    if (batteryTrial.samples.length > MAX_CACHE_SAMPLES) batteryTrial.samples.splice(0, 1000);
    const cutoff = now - MAX_ROLLING_HISTORY_MS;
    if (totalSamples % 1000 === 0) {
      let expired = 0;
      while (expired < batteryTrial.samples.length && batteryTrial.samples[expired].timestamp < cutoff) expired++;
      if (expired) batteryTrial.samples.splice(0, expired);
    }
    return source === 'live' ? {
      calcaneo: sample.calc, meta1: sample.m1, meta5: sample.m5,
      temp: state.environment.temp, umid: state.environment.umid, seq: sample.seq,
      nativeTimestamp: now, device_t_ms: sample.device_t_ms
    } : null;
  }

  function consumePacket(packet) {
    const parsed = JSON.parse(packet.raw);
    if (parsed.tipo === 'sync_batch') {
      for (const item of parsed.d || []) {
        if (!Array.isArray(item) || item.length < 4) continue;
        const key = JSON.stringify(item.slice(0, 4));
        if (offlineKeys.has(key)) continue; // Interrupted retries resend the same flash rows.
        offlineKeys.add(key);
        appendSample({ t_ms: item[0], meta1: item[1], meta5: item[2], calcaneo: item[3] }, packet, 'offline');
      }
      return null;
    }
    if (parsed.tipo === 'purge_ok') { offlineKeys.clear(); return null; }
    if (parsed.tipo) return null; // Native service owns sync acknowledgements.
    if (parsed.meta1 == null && parsed.meta5 == null && parsed.calcaneo == null) return null;
    const deviceMillis = parsed.t_ms == null ? null : Number(parsed.t_ms);
    const liveSeq = parsed.seq == null ? null : Number(parsed.seq);
    // Firmware has no boot ID. A backwards uptime/sequence indicates a new boot
    // (or counter rollover), so a later offline transfer starts a new generation.
    if ((deviceMillis != null && lastDeviceMillis != null && deviceMillis < lastDeviceMillis)
      || (liveSeq != null && lastLiveSeq != null && liveSeq < lastLiveSeq)) offlineKeys.clear();
    if (deviceMillis != null && Number.isFinite(deviceMillis)) lastDeviceMillis = deviceMillis;
    if (liveSeq != null && Number.isFinite(liveSeq)) lastLiveSeq = liveSeq;
    return appendSample(parsed, packet, 'live');
  }

  async function readAvailable(id) {
    let latest = null;
    let pages = 0;
    while (id && id === sessionId) {
      const result = await plugin.readPackets({ sessionId: id, after: cursor, limit: 1000 });
      const packets = result.packets || [];
      for (const packet of packets) {
        const packetId = Number(packet.id);
        if (!Number.isFinite(packetId) || packetId <= cursor) continue;
        try { latest = consumePacket(packet) || latest; }
        catch (err) { console.warn('Pacote nativo inválido preservado no banco Android:', err); }
        // Commit the UI cursor only after consuming the packet, never before.
        cursor = packetId;
      }
      const next = Number(result.nextId);
      if (Number.isFinite(next) && next > cursor && !packets.length) cursor = next;
      if (!packets.length) break;
      pages++;
      if (pages % 5 === 0) {
        setText('native-service-status', `Atualizando tela: ${totalSamples.toLocaleString('pt-BR')} amostras recuperadas…`);
        updateMetrics();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      // Avoid chasing a live journal forever. Resume next poll at the cursor.
      if (!historical && status.active && pages >= 30) break;
    }
    if (latest) {
      state.environment.temp = latest.temp ?? null;
      state.environment.umid = latest.umid ?? null;
      render(latest); // Rendering only the latest live sample avoids replaying old alerts.
      setText('footer-meta', `Amostra: #${latest.seq} · Recebida: ${new Date(latest.nativeTimestamp).toLocaleString('pt-BR')}`);
    }
    rollingHistorySamples = batteryTrial.samples;
    if (state.heatmapWindow !== 'realtime' && batteryTrial.samples.length) selectHeatmapWindow(state.heatmapWindow);
  }

  function applyStatus() {
    state.connectionType = status.connected || status.active ? 'ble' : 'none';
    state.isConnected = !!status.connected;
    document.body.classList.toggle('is-connected', !!status.connected);
    element('conn-pill')?.classList.toggle('connected', !!status.connected);
    element('btn-ble')?.classList.toggle('active-connected', !!status.active);
    setText('conn-label', status.connected ? 'BLE Conectado' : status.active ? 'Reconectando BLE' : 'Desconectado');
    setText('btn-ble-text', status.active ? 'Desconectar BLE' : 'Conectar BLE');
    batteryTrial.isRecording = !historical && !!status.active && sessionId === status.sessionId;
    batteryTrial.isFinished = !!sessionId && !batteryTrial.isRecording;
    if (!historical && sessionId === status.sessionId) {
      batteryTrial.startTime = Number(status.startTime) || batteryTrial.startTime;
      if (status.active) batteryTrial.endTime = null;
      else batteryTrial.endTime = Number(metadata().endTime) || batteryTrial.endTime || Date.now();
    }
    const hero = element('card-hero-status');
    if (hero) hero.style.display = status.connected ? 'none' : '';
    element('badge-wakelock')?.classList.toggle('active', !!status.active);
    setText('badge-wakelock', status.active ? '🔔 Serviço ativo' : '🔔 Serviço parado');
    const note = historical && status.active
      ? 'Visualizando histórico. A coleta atual continua em segundo plano.'
      : status.connected
        ? 'Recebendo e salvando no Android, mesmo com a tela apagada. A notificação indica o serviço ativo.'
        : status.active
          ? 'Serviço ativo, aguardando reconexão à palmilha. A coleta retoma quando o BLE reconectar.'
          : 'Conecte a palmilha para iniciar. Desconectar encerra o serviço e mantém os dados salvos.';
    setText('native-service-status', status.error || note);
    if (status.error) showError(new Error(status.error));
    updateBatteryTrialUI();
    const toggle = element('btn-battery-toggle');
    if (toggle) toggle.disabled = true;
    setText('btn-battery-toggle-text', 'Gravação automática pelo Android');
    setText('battery-timer-sub', historical ? 'Sessão do histórico' : 'Sessão atual no Android');
    setText('battery-storage-status', 'SQLite Android · CSV completo preservado');
    const clear = element('btn-battery-clear');
    if (clear) clear.disabled = !!status.active;
    // An unloaded/cleared view still has an exportable native journal.
    for (const id of ['btn-battery-download', 'btn-battery-share', 'btn-battery-email']) {
      if (element(id)) element(id).disabled = !sessionId || (!totalSamples && !(metadata().count > 0));
    }
  }

  function updateMetrics() {
    setText('battery-samples-count', totalSamples.toLocaleString('pt-BR'));
    const end = batteryTrial.endTime || Date.now();
    const seconds = Math.max(1, (end - (batteryTrial.startTime || end)) / 1000);
    setText('battery-rate-hz', `${(totalSamples / seconds).toFixed(1)} Hz recebidos`);
    setText('battery-storage-size', `~${(totalSamples * 55 / 1024).toFixed(1)} KB`);
    setText('battery-peaks-summary', `M1: ${batteryTrial.peakM1} | M5: ${batteryTrial.peakM5} | C: ${batteryTrial.peakCalc}`);
    setText('battery-last-seq', `Seq: ${batteryTrial.lastSeq ?? '--'} (${batteryTrial.lastTimestamp ?? ''})`);
  }

  function renderHistory() {
    const container = element('saved-sessions-list');
    if (!container) return;
    container.replaceChildren();
    setText('sessions-count-label', sessions.length);
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'session-item-empty';
      empty.textContent = 'Nenhuma sessão no armazenamento Android.';
      container.append(empty);
      return;
    }
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'session-item';
      const info = document.createElement('div');
      info.className = 'session-item-info';
      const title = document.createElement('strong');
      title.className = 'session-item-date';
      title.textContent = new Date(Number(session.startTime)).toLocaleString('pt-BR');
      const details = document.createElement('span');
      details.className = 'session-item-meta';
      details.textContent = `${session.name || 'Palmilha'} · ${(Number(session.count) || 0).toLocaleString('pt-BR')} pacotes · ${session.endTime ? 'Finalizada' : 'Em andamento'}`;
      info.append(title, details);
      const actions = document.createElement('div');
      actions.className = 'session-item-actions';
      for (const [label, callback] of [
        ['🗺️ Ver no Mapa', () => loadSession(session.id)],
        ['📥 CSV', () => exportSession(session.id, false)],
        ['↗ Compartilhar', () => exportSession(session.id, true)]
      ]) {
        const button = document.createElement('button');
        button.className = 'btn-tiny';
        button.textContent = label;
        button.addEventListener('click', () => callback().catch(showError));
        actions.append(button);
      }
      item.append(info, actions);
      container.append(item);
    }
  }

  async function refreshHistory() {
    const result = await plugin.listSessions();
    sessions = result.sessions || [];
    lastHistoryRefresh = Date.now();
    renderHistory();
  }

  async function tick() {
    if (!enabled || !started || running || document.visibilityState === 'hidden') return;
    running = true;
    try {
      status = await plugin.getStatus();
      if (Date.now() - lastHistoryRefresh > 5000) await refreshHistory();
      if (!historical && status.sessionId && status.sessionId !== sessionId) {
        resetView(status.sessionId, { ...metadata(), ...status });
      }
      if (!sessionId && sessions.length && !cleared) resetView(sessions[0].id, sessions[0]);
      if (!cleared && sessionId) await readAvailable(sessionId);
      applyStatus();
      lastError = status.error || '';
    } catch (err) { showError(err); }
    finally {
      running = false;
      clearTimeout(timer);
      if (started) timer = setTimeout(tick, 1000);
    }
  }

  async function initialize() {
    if (!enabled) return;
    if (!plugin) throw new Error('A ponte Android MonitorNative não está disponível.');
    started = true;
    const serial = element('btn-serial');
    if (serial) serial.hidden = true;
    await refreshHistory();
    status = await plugin.getStatus();
    const id = status.sessionId || sessions[0]?.id;
    if (id) resetView(id, sessions.find(s => s.id === id) || status);
    await tick();
    batteryTrial.timerInterval = setInterval(updateBatteryTimerDisplay, 1000);
    // Returning from the chooser or share sheet may not issue visibilitychange.
    window.addEventListener('focus', () => { if (!running) tick(); });
  }

  async function connect() {
    if (connectionAction) return;
    connectionAction = true;
    const button = element('btn-ble');
    if (button) button.disabled = true;
    try {
      if (status.active) {
        await plugin.disconnect();
        status = await plugin.getStatus();
        applyStatus();
      } else {
        const device = await plugin.scan();
        if (!device?.address) return;
        historical = false;
        cleared = false;
        status = await plugin.connect({ address: device.address, name: device.name || 'Palmilha' });
        setText('native-service-status', 'Conectando à palmilha. Aguarde a notificação do serviço Android.');
      }
      lastHistoryRefresh = 0;
      await tick();
    } catch (err) {
      if (!/cancel/i.test(errorText(err))) { showError(err); alert(`Não foi possível conectar: ${errorText(err)}`); }
    } finally {
      connectionAction = false;
      if (button) button.disabled = false;
    }
  }

  async function disconnect() {
    await plugin.disconnect();
    lastHistoryRefresh = 0;
    await tick();
  }

  async function loadSession(id) {
    if (running) {
      showError(new Error('Aguarde a atualização das amostras e tente novamente.'));
      return;
    }
    running = true;
    try {
      historical = id !== status.sessionId || !status.active;
      resetView(id, sessions.find(s => s.id === id) || {});
      await readAvailable(id);
      applyStatus();
      selectHeatmapWindow('1h');
      recordAlertEvent('ok', `Sessão de ${new Date(batteryTrial.startTime).toLocaleString('pt-BR')} carregada do Android.`);
    } finally {
      running = false;
      clearTimeout(timer);
      timer = setTimeout(tick, 1000);
    }
  }

  async function exportSession(id = sessionId, share = false) {
    if (!id) { alert('Nenhuma sessão Android disponível para exportação.'); return; }
    try {
      await plugin.exportSession({ sessionId: id, share });
    } catch (err) {
      if (!/cancel/i.test(errorText(err))) { showError(err); alert(`Não foi possível exportar o CSV: ${errorText(err)}`); }
    }
  }

  function clearView() {
    if (status.active) return;
    batteryTrial.samples = [];
    rollingHistorySamples = [];
    telemetryHistory.length = 0;
    totalSamples = 0;
    batteryTrial.peakM1 = 0;
    batteryTrial.peakM5 = 0;
    batteryTrial.peakCalc = 0;
    batteryTrial.lastSeq = null;
    batteryTrial.lastTimestamp = null;
    state.lastData = null;
    footHeatmap.render(0, 0, 0);
    cleared = true;
    updateBatteryTrialUI();
    applyStatus();
    recordAlertEvent('ok', 'A visualização foi limpa. A sessão completa continua no histórico Android.');
  }

  return {
    enabled, initialize, connect, disconnect, resume: tick,
    updateMetrics, renderHistory, loadSession, clearView,
    exportCurrent: share => exportSession(sessionId, !!share),
    exportSession,
    write: command => plugin.write({ command }),
    getStatus: () => status,
    getSessionId: () => sessionId
  };
})();

/* ==========================================================================
   Monitor Plantar Inteligente — Lógica da Aplicação (app.js)
   Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)
   Comunicação BLE (Web Bluetooth) + Cabo USB (Web Serial) + Modo Simulação
   ========================================================================== */

'use strict';

// ── METADADOS E VERSIONAMENTO DA APLICAÇÃO ────────────────────────────────
const APP_VERSION    = 'v2.1';
const APP_BUILD_TIME = '09/10/2026 às 14:35';

// ── UUIDs PADRÃO DO FIRMWARE BLE ──────────────────────────────────────────
const BLE_SVC_UUID  = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHAR_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

// ── ESTADO DA APLICAÇÃO ───────────────────────────────────────────────────
const state = {
  connectionType: 'none', // 'none' | 'ble' | 'serial'
  bleDevice: null,
  bleChar: null,
  serialPort: null,
  serialReader: null,
  serialBuffer: '',
  demoTimer: null,
  demoStepCount: 0,
  lastRenderTime: 0,
  recentAlertCooldowns: {},
  environment: {
    temp: null,
    umid: null
  },
  tare: {
    m1: 0,
    m5: 0,
    calc: 0
  },
  lastRaw: {
    m1: 0,
    m5: 0,
    calc: 0
  },
  lastData: null,
  tareActive: false,
  autoTaredOnce: false,
  heatmapWindow: 'realtime' // 'realtime' | '1h' | '3h' | '6h' | '8h' | '12h'
};

// ── FUNÇÕES DE GESTÃO DA TARA (LINHA DE BASE DE REPOUSO) ──────────────────
function applyTare() {
  state.tare.m1 = state.lastRaw.m1 || 0;
  state.tare.m5 = state.lastRaw.m5 || 0;
  state.tare.calc = state.lastRaw.calc || 0;
  state.tareActive = (state.tare.calc > 0 || state.tare.m1 > 0 || state.tare.m5 > 0);
  updateTareUI();
  if (state.lastData) {
    render(state.lastData);
  }
}

function resetTare() {
  state.tare.m1 = 0;
  state.tare.m5 = 0;
  state.tare.calc = 0;
  state.tareActive = false;
  updateTareUI();
  if (state.lastData) {
    render(state.lastData);
  }
}

function updateTareUI() {
  const badgeTare = document.getElementById('badge-tare');
  const btnTareText = document.getElementById('btn-tare-text');
  const btnTare = document.getElementById('btn-tare');
  if (state.tareActive) {
    if (badgeTare) {
      badgeTare.style.display = 'inline-flex';
      badgeTare.textContent = `⚖️ Tara Ativa (Calc: ${state.tare.calc} ADC)`;
    }
    if (btnTareText) {
      btnTareText.textContent = 'Retirar Tara';
    }
    if (btnTare) {
      btnTare.classList.add('active-connected');
    }
  } else {
    if (badgeTare) {
      badgeTare.style.display = 'none';
    }
    if (btnTareText) {
      btnTareText.textContent = 'Zerar Tara';
    }
    if (btnTare) {
      btnTare.classList.remove('active-connected');
    }
  }
}

// ── OBTENÇÃO DINÂMICA DOS LIMIARES CONFIGURADOS ───────────────────────────
function getThresholds() {
  return {
    pressWarn:   parseInt(document.getElementById('thresh-press-warn').value, 10)   || 2400,
    pressDanger: parseInt(document.getElementById('thresh-press-danger').value, 10) || 3200,
    tempMax:     parseFloat(document.getElementById('thresh-temp').value)           || 34.5,
    umidMax:     parseFloat(document.getElementById('thresh-umid').value)           || 75.0,
  };
}

// ── DETERMINAÇÃO DO NÍVEL DE RISCO (OK / WARN / DANGER) ───────────────────
function getRiskLevel(value, warnThresh, dangerThresh) {
  if (value >= dangerThresh) return 'danger';
  if (value >= warnThresh)   return 'warn';
  return 'ok';
}

// ── ATUALIZAÇÃO VISUAL COMPLETA DA INTERFACE (RENDER) ─────────────────────
function render(data) {
  state.lastData = data;
  state.lastRaw = {
    m1: data.meta1 ?? 0,
    m5: data.meta5 ?? 0,
    calc: data.calcaneo ?? 0
  };

  // Se o calcanhar começar com valor residual alto (> 2000 ADC) e metatarsos em repouso (< 500 ADC),
  // aplica auto-tara inicial automaticamente para calibrar a linha de base
  if (!state.autoTaredOnce && state.isConnected) {
    state.autoTaredOnce = true;
    if (state.lastRaw.calc > 2000 && state.lastRaw.m1 < 500 && state.lastRaw.m5 < 500) {
      state.tare.calc = state.lastRaw.calc;
      state.tare.m1 = state.lastRaw.m1;
      state.tare.m5 = state.lastRaw.m5;
      state.tareActive = true;
      updateTareUI();
      console.log(`[Auto-Tara] Linha de base de repouso compensada no Calcanhar: ${state.tare.calc} ADC`);
    }
  }

  const thresh = getThresholds();
  let globalWorstLevel = 'ok';
  const activeAlerts = [];

  // 1. PROCESSAMENTO DAS ZONAS DE PRESSÃO (FSR)
  // Ordem anatômica: m1 (1º Metatarso), m5 (5º Metatarso), calc (Calcâneo)
  const zones = [
    { id: 'm1',   label: '1º Metatarso', pin: 'GPIO 33', raw: data.meta1 ?? 0 },
    { id: 'm5',   label: '5º Metatarso', pin: 'GPIO 39 (VN)', raw: data.meta5 ?? 0 },
    { id: 'calc', label: 'Calcâneo',     pin: 'GPIO 36 (VP)', raw: data.calcaneo ?? 0 },
  ];

  zones.forEach(z => {
    const rawVal = Math.max(0, Math.min(4095, Math.round(z.raw)));
    const tareVal = state.tare[z.id] || 0;
    
    // Valor líquido efetivo (descontando o repouso tarado)
    const netVal = Math.max(0, rawVal - tareVal);
    const dynamicSpan = Math.max(200, 4095 - tareVal);
    const pct = Math.min(100, Math.round((netVal / dynamicSpan) * 100));

    // Limiares escalonados pela faixa dinâmica útil restante
    const relWarn = Math.round((thresh.pressWarn / 4095) * dynamicSpan);
    const relDanger = Math.round((thresh.pressDanger / 4095) * dynamicSpan);
    const lv = getRiskLevel(netVal, relWarn, relDanger);

    if (lv === 'danger') globalWorstLevel = 'danger';
    else if (lv === 'warn' && globalWorstLevel !== 'danger') globalWorstLevel = 'warn';

    if (lv !== 'ok') {
      activeAlerts.push({
        type: 'pressure',
        zone: z.label,
        level: lv,
        msg: `${z.label}: Sobrecarga detectada (${netVal} ADC líq. · ${pct}%)`
      });
    }

    // Atualiza elementos do Card de Pressão
    const meter = document.getElementById(`meter-${z.id}`);
    const badge = document.getElementById(`val-badge-${z.id}`);
    const intensity = document.getElementById(`intensity-${z.id}`);
    const cardEl = document.getElementById(`card-pz-${z.id}`);
    const metaRaw = document.getElementById(`meta-raw-${z.id}`);

    if (meter) {
      meter.style.width = `${pct}%`;
      meter.className = `meter-bar-fill fill-${lv}`;
    }

    if (badge) {
      if (tareVal > 0) {
        badge.innerHTML = `${netVal} ADC <span style="font-size:0.75rem; font-weight:normal; opacity:0.8;">(${rawVal} bruto)</span>`;
      } else {
        badge.textContent = `${rawVal} ADC`;
      }
      badge.style.color = lv === 'ok' ? 'var(--text-main)' : (lv === 'warn' ? 'var(--status-warn)' : 'var(--status-danger)');
    }

    if (intensity) {
      const desc = lv === 'ok' ? 'Carga baixa/adequada' : (lv === 'warn' ? 'Carga pontual moderada' : 'Sobrecarga de pressão');
      intensity.textContent = `${desc} (~${pct}%)`;
    }

    if (metaRaw && tareVal > 0) {
      metaRaw.textContent = `Pino: ${z.pin} · Tara: ${tareVal} ADC`;
    } else if (metaRaw) {
      metaRaw.textContent = `Pino: ${z.pin}`;
    }

    if (cardEl) {
      cardEl.classList.remove('zone-warn', 'zone-danger');
      if (lv !== 'ok') cardEl.classList.add(`zone-${lv}`);
    }

    // Atualiza Heat Zone no Mapa do Pé
    const heatZone = document.getElementById(`zone-${z.id}`);
    const tooltip = document.getElementById(`tip-${z.id}`);
    if (heatZone) {
      heatZone.className = `heat-zone ${lv}`;
    }
    if (tooltip) {
      tooltip.textContent = tareVal > 0 ? `${netVal} ADC (${pct}%) [bruto: ${rawVal}]` : `${rawVal} ADC (${pct}%)`;
    }
  });

  // 1.1 ATUALIZAÇÃO DO MAPA TÉRMICO CONTÍNUO (CANVAS 2D) E TELEMETRIA CONTÍNUA
  const netM1 = Math.max(0, (data.meta1 ?? 0) - (state.tare.m1 || 0));
  const netM5 = Math.max(0, (data.meta5 ?? 0) - (state.tare.m5 || 0));
  const netCalc = Math.max(0, (data.calcaneo ?? 0) - (state.tare.calc || 0));

  recordContinuousTelemetry({
    meta1: netM1,
    meta5: netM5,
    calcaneo: netCalc,
    temp: data.temp,
    umid: data.umid
  });

  if (state.heatmapWindow === 'realtime') {
    footHeatmap.render(netM1, netM5, netCalc);
  }

  // 2. PROCESSAMENTO DO MICROCLIMA (AHT10)
  // Temperatura
  if (data.temp != null && !isNaN(data.temp)) {
    const tempVal = parseFloat(data.temp);
    state.environment.temp = tempVal;
    const tempLv = tempVal >= thresh.tempMax ? 'danger' : (tempVal >= thresh.tempMax - 1.5 ? 'warn' : 'ok');

    if (tempLv === 'danger') globalWorstLevel = 'danger';
    else if (tempLv === 'warn' && globalWorstLevel !== 'danger') globalWorstLevel = 'warn';

    const valEl = document.getElementById('val-temp');
    const txtEl = document.getElementById('txt-temp');
    const fillEl = document.getElementById('fill-temp');

    if (valEl) valEl.textContent = tempVal.toFixed(1);
    if (txtEl) {
      txtEl.textContent = tempLv === 'ok' ? 'Temperatura confortável e segura' : (tempLv === 'warn' ? 'Temperatura em elevação' : 'Atenção: Hipertermia plantar detectada');
      txtEl.style.color = tempLv === 'ok' ? 'var(--text-muted)' : (tempLv === 'warn' ? 'var(--status-warn)' : 'var(--status-danger)');
    }
    if (fillEl) {
      // Escala visual de 20°C a 42°C
      const tempPct = Math.max(0, Math.min(100, ((tempVal - 20) / (42 - 20)) * 100));
      fillEl.style.width = `${tempPct}%`;
      fillEl.style.backgroundColor = tempLv === 'ok' ? 'var(--accent)' : (tempLv === 'warn' ? 'var(--status-warn)' : 'var(--status-danger)');
    }

    if (tempLv !== 'ok') {
      activeAlerts.push({
        type: 'temp',
        level: tempLv,
        msg: `Temperatura plantar elevada: ${tempVal.toFixed(1)}°C (limite: ${thresh.tempMax}°C)`
      });
    }
  } else {
    const valEl = document.getElementById('val-temp');
    const txtEl = document.getElementById('txt-temp');
    const fillEl = document.getElementById('fill-temp');
    if (valEl) valEl.textContent = '--';
    if (txtEl) {
      txtEl.textContent = 'Sensor desativado / Opcional';
      txtEl.style.color = 'var(--text-muted)';
    }
    if (fillEl) fillEl.style.width = '0%';
  }

  // Umidade
  if (data.umid != null && !isNaN(data.umid)) {
    const umidVal = parseFloat(data.umid);
    state.environment.umid = umidVal;
    const umidLv = umidVal >= thresh.umidMax ? 'danger' : (umidVal >= thresh.umidMax - 10 ? 'warn' : 'ok');

    if (umidLv === 'danger') globalWorstLevel = 'danger';
    else if (umidLv === 'warn' && globalWorstLevel !== 'danger') globalWorstLevel = 'warn';

    const valEl = document.getElementById('val-umid');
    const txtEl = document.getElementById('txt-umid');
    const fillEl = document.getElementById('fill-umid');

    if (valEl) valEl.textContent = Math.round(umidVal);
    if (txtEl) {
      txtEl.textContent = umidLv === 'ok' ? 'Umidade interna normal' : (umidLv === 'warn' ? 'Ambiente úmido' : 'Risco de maceração da pele');
      txtEl.style.color = umidLv === 'ok' ? 'var(--text-muted)' : (umidLv === 'warn' ? 'var(--status-warn)' : 'var(--status-danger)');
    }
    if (fillEl) {
      const umidPct = Math.max(0, Math.min(100, umidVal));
      fillEl.style.width = `${umidPct}%`;
      fillEl.style.backgroundColor = umidLv === 'ok' ? 'var(--primary)' : (umidLv === 'warn' ? 'var(--status-warn)' : 'var(--status-danger)');
    }

    if (umidLv !== 'ok') {
      activeAlerts.push({
        type: 'umid',
        level: umidLv,
        msg: `Umidade excessiva no calçado: ${Math.round(umidVal)}% (limite: ${thresh.umidMax}%)`
      });
    }
  } else {
    const valEl = document.getElementById('val-umid');
    const txtEl = document.getElementById('txt-umid');
    const fillEl = document.getElementById('fill-umid');
    if (valEl) valEl.textContent = '--';
    if (txtEl) {
      txtEl.textContent = 'Sensor desativado / Opcional';
      txtEl.style.color = 'var(--text-muted)';
    }
    if (fillEl) fillEl.style.width = '0%';
  }

  // 3. ATUALIZAÇÃO DO STATUS GERAL DO PACIENTE (HERO STATUS)
  if (state.isConnected) {
    updateHeroStatus(globalWorstLevel, activeAlerts);
  }

  // 4. REGISTRO DE EVENTOS NO HISTÓRICO
  activeAlerts.forEach(a => recordAlertEvent(a.level, a.msg));

  // 5. ATUALIZAÇÃO DO RODAPÉ (METADADOS DE TRANSMISSÃO)
  const metaEl = document.getElementById('footer-meta');
  if (metaEl) {
    const seqStr = data.seq != null ? `Amostra: #${data.seq} · ` : '';
    const nowStr = new Date().toLocaleTimeString('pt-BR');
    metaEl.textContent = `${seqStr}Última atualização: ${nowStr}`;
  }
}

// ── ATUALIZAÇÃO DO CARD HERO (COMUNICAÇÃO COM O PACIENTE) ─────────────────
function updateHeroStatus(level, alerts) {
  const card = document.getElementById('card-hero-status');
  const icon = document.getElementById('hero-status-icon');
  const tag = document.getElementById('hero-status-tag');
  const title = document.getElementById('hero-status-title');
  const desc = document.getElementById('hero-status-desc');
  const guidePressureTxt = document.getElementById('guide-pressure-txt');
  const guideClimateTxt = document.getElementById('guide-climate-txt');

  if (!card) return;

  card.className = `card card-hero-status status-${level}`;

  if (level === 'ok') {
    icon.textContent = '🛡️';
    tag.textContent = 'Condição Geral Segura';
    title.textContent = 'Seus pés estão protegidos e confortáveis';
    desc.textContent = 'Nenhuma sobrecarga ou calor excessivo foi detectado na sola do pé. Você pode prosseguir com suas tarefas com tranquilidade.';
    if (guidePressureTxt) guidePressureTxt.textContent = 'Mantenha sua rotina normal, sem esquecer de fazer pequenas pausas se for caminhar por longos períodos.';
    if (guideClimateTxt) guideClimateTxt.textContent = 'O calçado está com boa aeração e a umidade está controlada.';
  } else if (level === 'warn') {
    icon.textContent = '⚠️';
    tag.textContent = 'Atenção Necessária';
    title.textContent = 'Ponto de pressão ou calor em elevação';
    desc.textContent = alerts.length > 0 
      ? alerts.map(a => a.msg).join(' • ') 
      : 'Identificamos aumento de esforço em regiões específicas do pé. É recomendável alternar o apoio ou sentar alguns instantes.';
    if (guidePressureTxt) guidePressureTxt.textContent = 'Procure sentar ou aliviar o peso no pé direito para evitar acúmulo contínuo de pressão.';
  } else {
    icon.textContent = '🚨';
    tag.textContent = 'Alerta de Sobrecarga';
    title.textContent = 'Atenção: Sobrecarga excessiva detectada!';
    desc.textContent = alerts.length > 0 
      ? alerts.map(a => a.msg).join(' • ') 
      : 'Pressão intensa ou temperatura crítica detectada na planta do pé. Risco iminente de trauma cutâneo.';
    if (guidePressureTxt) guidePressureTxt.textContent = 'Recomendação imediata: Sente-se imediatamente por 15 minutos para descarregar todo o peso do pé.';
    if (guideClimateTxt) guideClimateTxt.textContent = 'Verifique se há suor excessivo e considere trocar meias de algodão.';
  }
}

// ── REGISTRO DE ALERTAS COM COOLDOWN (ANTI-SPAM) ──────────────────────────
function recordAlertEvent(level, message) {
  const now = Date.now();
  const cooldownKey = `${level}:${message}`;
  
  // Cooldown de 15 segundos para o mesmo alerta
  if (now - (state.recentAlertCooldowns[cooldownKey] || 0) < 15000) {
    return;
  }
  state.recentAlertCooldowns[cooldownKey] = now;

  const list = document.getElementById('event-list');
  if (!list) return;

  const emptyMsg = list.querySelector('.event-empty');
  if (emptyMsg) emptyMsg.remove();

  const item = document.createElement('div');
  item.className = `event-item ${level}`;
  const timeStr = new Date().toLocaleTimeString('pt-BR');

  item.innerHTML = `
    <span>${message}</span>
    <span class="event-time">${timeStr}</span>
  `;

  list.prepend(item);

  // Mantém no máximo 25 alertas recentes
  while (list.children.length > 25) {
    list.removeChild(list.lastChild);
  }
}

// Limpar alertas
document.getElementById('btn-clear-alerts')?.addEventListener('click', () => {
  const list = document.getElementById('event-list');
  if (list) {
    list.innerHTML = '<div class="event-empty">Nenhum evento crítico registrado nesta sessão.</div>';
  }
  state.recentAlertCooldowns = {};
});

// ── CONEXÃO BLUETOOTH LOW ENERGY (WEB BLUETOOTH API) ──────────────────────
const btnBle = document.getElementById('btn-ble');
btnBle?.addEventListener('click', async () => {
  if (window.NativeMonitor?.enabled) {
    await NativeMonitor.connect();
    return;
  }
  if (state.connectionType === 'ble' && state.bleDevice?.gatt?.connected) {
    disconnectAll();
    return;
  }

  if (!navigator.bluetooth) {
    alert('A API Web Bluetooth não está disponível neste navegador. Por favor, utilize o Google Chrome ou Microsoft Edge no desktop ou Android.');
    return;
  }

  disconnectAll();

  btnBle.disabled = true;
  document.getElementById('btn-ble-text').textContent = 'Buscando...';

  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [
        { name: 'Palmilha_v5.0' },
        { namePrefix: 'Palmilha' },
        { name: 'MonitorPlantar' }
      ],
      optionalServices: [BLE_SVC_UUID]
    });

    state.bleDevice = device;
    device.addEventListener('gattserverdisconnected', onDeviceDisconnected);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SVC_UUID);
    const characteristic = await service.getCharacteristic(BLE_CHAR_UUID);
    state.bleChar = characteristic;

    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', onBleDataReceived);

    setConnectionState('ble', true);

  } catch (err) {
    console.warn('Erro na conexão BLE:', err);
    if (err.name !== 'NotFoundError') {
      alert(`Não foi possível conectar ao dispositivo BLE: ${err.message}`);
    }
    setConnectionState('none', false);
  } finally {
    btnBle.disabled = false;
  }
});

async function sendBleCommand(cmdStr) {
  if (window.NativeMonitor?.enabled) {
    // The native service handles synchronization and acknowledges only durable data.
    if (cmdStr === 'SYNC_START' || cmdStr === 'PURGE') return;
    await NativeMonitor.write(cmdStr);
    return;
  }
  if (!state.bleChar) return;
  try {
    const encoder = new TextEncoder();
    await state.bleChar.writeValue(encoder.encode(cmdStr));
    console.log('[BLE TX] Comando enviado para palmilha:', cmdStr);
  } catch (err) {
    console.warn('Erro ao enviar comando BLE:', err);
  }
}

let syncBatchBuffer = [];

function onBleDataReceived(event) {
  try {
    const rawString = new TextDecoder('utf-8').decode(event.target.value);
    const parsed = JSON.parse(rawString);

    // 1. PROTOCOLO SYNC & PURGE (SINCRONIZAÇÃO AUTOMÁTICA DA MEMÓRIA FLASH DA PALMILHA)
    if (parsed.tipo === 'offline_status') {
      const total = parsed.total || 0;
      if (total > 0) {
        console.log(`[Sync & Purge] Palmilha possui ${total} amostras offline (${parsed.kb} KB). Solicitando download...`);
        recordAlertEvent('warn', `📥 Detectadas ${total} amostras gravadas offline na palmilha. Baixando para o celular...`);
        syncBatchBuffer = [];
        sendBleCommand('SYNC_START');
      }
      return;
    }

    if (parsed.tipo === 'sync_batch') {
      const items = parsed.d || [];
      for (const item of items) {
        // Formato compacto recebido: [t_ms, m1, m5, calc]
        const sample = {
          calcaneo: item[3],
          meta1: item[1],
          meta5: item[2],
          t_ms: item[0],
          seq: batteryTrial.samples.length + 1
        };
        syncBatchBuffer.push(sample);
        recordBatterySample(sample);
      }
      return;
    }

    if (parsed.tipo === 'sync_fim') {
      const total = parsed.total || syncBatchBuffer.length;
      console.log(`[Sync & Purge] Sincronização concluída (${total} amostras). Arquivando e liberando Flash da palmilha...`);
      persistBatteryData();
      archiveCurrentSession();
      // Envia confirmação para o ESP32 purgar e liberar a memória Flash
      sendBleCommand('PURGE');
      recordAlertEvent('ok', `✅ ${total} amostras offline mescladas com sucesso! Memória da palmilha liberada (100% livre).`);
      syncBatchBuffer = [];
      return;
    }

    if (parsed.tipo === 'purge_ok') {
      console.log('[Sync & Purge] Confirmação da palmilha: memória Flash purgada com sucesso.');
      return;
    }

    // 2. PACOTE NORMAL DE TELEMETRIA EM TEMPO REAL
    const data = {
      calcaneo: parsed.calcaneo != null ? parseInt(parsed.calcaneo, 10) : 0,
      meta1:    parsed.meta1 != null ? parseInt(parsed.meta1, 10) : 0,
      meta5:    parsed.meta5 != null ? parseInt(parsed.meta5, 10) : 0,
      temp:     parsed.temp != null ? parseFloat(parsed.temp) : state.environment.temp,
      umid:     parsed.umid != null ? parseFloat(parsed.umid) : state.environment.umid,
      seq:      parsed.seq != null ? parseInt(parsed.seq, 10) : null
    };

    render(data);

    // Gravação contínua no celular para ensaio de autonomia de bateria
    if (batteryTrial.isRecording) {
      recordBatterySample(data);
    }
  } catch (e) {
    console.warn('Falha no parsing do pacote BLE:', e);
  }
}

// ── CONEXÃO CABO USB SERIAL (WEB SERIAL API) ──────────────────────────────
const btnSerial = document.getElementById('btn-serial');
btnSerial?.addEventListener('click', async () => {
  if (state.connectionType === 'serial' && state.serialPort) {
    disconnectAll();
    return;
  }

  if (!navigator.serial) {
    alert('A API Web Serial não está disponível neste navegador. Por favor, utilize o Google Chrome ou Microsoft Edge em computadores desktop.');
    return;
  }

  disconnectAll();

  btnSerial.disabled = true;
  document.getElementById('btn-serial-text').textContent = 'Conectando...';

  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    state.serialPort = port;

    setConnectionState('serial', true);


    readSerialStream(port);
  } catch (err) {
    console.warn('Erro ao abrir porta Serial:', err);
    if (err.name !== 'NotFoundError') {
      alert(`Não foi possível conectar à porta serial USB: ${err.message}`);
    }
    setConnectionState('none', false);
  } finally {
    btnSerial.disabled = false;
  }
});

async function readSerialStream(port) {
  const textDecoder = new TextDecoderStream();
  const readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();
  state.serialReader = reader;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        processSerialText(value);
      }
    }
  } catch (err) {
    console.warn('Leitura serial interrompida:', err);
  } finally {
    reader.releaseLock();
  }
}

// Processamento linha a linha do CSV transmitido pelo firmware da bancada:
// t_ms,dt_ms,seq,calc_raw,calc_media,calc_mV,m1_raw,m1_media,m1_mV,m5_raw,m5_media,m5_mV,aht_ok,temp_C,umid_pct,aht_erro
function processSerialText(chunk) {
  state.serialBuffer += chunk;
  const lines = state.serialBuffer.split('\n');
  state.serialBuffer = lines.pop(); // Guarda pedaço incompleto da última linha

  for (const line of lines) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;

    const parts = clean.split(',');
    // Linha válida tem 16 campos
    if (parts.length >= 15 && !isNaN(parts[0])) {
      const seqVal    = parseInt(parts[2], 10);
      const calcMedia = parseInt(parts[4], 10) || parseInt(parts[3], 10);
      const m1Media   = parseInt(parts[7], 10) || parseInt(parts[6], 10);
      const m5Media   = parseInt(parts[10], 10) || parseInt(parts[9], 10);
      const tempVal   = parts[13] !== 'NA' ? parseFloat(parts[13]) : state.environment.temp;
      const umidVal   = parts[14] !== 'NA' ? parseFloat(parts[14]) : state.environment.umid;

      const serialPayload = {
        calcaneo: calcMedia,
        meta1: m1Media,
        meta5: m5Media,
        temp: tempVal,
        umid: umidVal,
        seq: seqVal
      };
      render(serialPayload);

      if (batteryTrial.isRecording) {
        recordBatterySample(serialPayload);
      }
    }
  }
}

// ── BOTÃO TARAR / ZERAR LINHA DE BASE ─────────────────────────────────────
const btnTare = document.getElementById('btn-tare');
btnTare?.addEventListener('click', () => {
  if (state.tareActive) {
    resetTare();
  } else {
    applyTare();
  }
});

// ── GERENCIAMENTO DE ESTADO DE CONEXÃO E BOTÕES ───────────────────────────
function setConnectionState(type, isConnected) {
  state.connectionType = isConnected ? type : 'none';
  state.isConnected = isConnected;
  document.body.classList.toggle('is-connected', isConnected);

  const pill = document.getElementById('conn-pill');
  const label = document.getElementById('conn-label');
  const btnBleText = document.getElementById('btn-ble-text');

  if (isConnected) {
    pill.classList.add('connected');
    label.textContent = type === 'serial' ? 'USB Conectado' : 'BLE Conectado';
    btnBle.classList.add('active-connected');
    btnBleText.textContent = 'Desconectar BLE';

    // Assim que a conexão for estabelecida, oculta a mensagem de espera inicial
    const card = document.getElementById('card-hero-status');
    if (card) card.style.display = 'none';

    // Inicia automaticamente a gravação contínua de telemetria no celular
    startAutoRecordingSession(type);
  } else {
    pill.classList.remove('connected');
    label.textContent = 'Desconectado';
    btnBle.classList.remove('active-connected');
    btnBle.disabled = false;
    btnBleText.textContent = 'Conectar BLE';

    // Reabilita mensagem de aguardando dispositivo
    const card = document.getElementById('card-hero-status');
    if (card) card.style.display = '';
    renderInitialState();

    // Finaliza e arquiva automaticamente a sessão no celular
    if (batteryTrial.isRecording) {
      stopAutoRecordingSession();
    }
  }
}

function onDeviceDisconnected() {
  const hadSamples = batteryTrial.samples && batteryTrial.samples.length > 0;
  setConnectionState('none', false);
  if (hadSamples) {
    recordAlertEvent('warn', 'Dispositivo BLE desconectado. Sessão salva no histórico local!');
  } else {
    recordAlertEvent('warn', 'Dispositivo BLE desconectado antes de receber amostras.');
  }
}

async function disconnectAll() {
  if (window.NativeMonitor?.enabled) { await NativeMonitor.disconnect(); return; }
  if (state.bleDevice && state.bleDevice.gatt.connected) {
    state.bleDevice.gatt.disconnect();
  }
  state.bleDevice = null;
  state.bleChar = null;

  if (state.serialReader) {
    try { await state.serialReader.cancel(); } catch (e) {}
    state.serialReader = null;
  }
  if (state.serialPort) {
    try { await state.serialPort.close(); } catch (e) {}
    state.serialPort = null;
  }

  setConnectionState('none', false);
}

// ── INICIALIZAÇÃO DA INTERFACE (AGUARDANDO DADOS REAIS) ────────────────────
function renderInitialState() {
  state.isConnected = false;

  const card = document.getElementById('card-hero-status');
  const icon = document.getElementById('hero-status-icon');
  const tag = document.getElementById('hero-status-tag');
  const title = document.getElementById('hero-status-title');
  const desc = document.getElementById('hero-status-desc');

  if (card) card.className = 'card card-hero-status status-waiting';
  if (icon) {
    icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 7 10 10-5 5V2l5 5L7 17"/></svg>`;
  }
  if (tag) tag.textContent = 'Aguardando Dispositivo';
  if (title) title.textContent = 'Pronto para monitoramento';
  if (desc) desc.textContent = 'Conecte a palmilha via Bluetooth (BLE) acima para iniciar a leitura dos sensores em tempo real.';
}

// ── CONTROLE INTELIGENTE DE ROLAGEM NO CELULAR (AUTO-OCULTAR TÍTULO / MODAL) ─
let lastScrollY = window.scrollY;
let scrollTicking = false;

function updateMobileScrollState() {
  const currentScrollY = window.scrollY;
  const isMobile = window.innerWidth <= 850;

  if (isMobile) {
    if (currentScrollY > 25 && currentScrollY > lastScrollY) {
      // Arrastando / rolando para BAIXO: esconde cabeçalho, aviso e modal de título
      document.body.classList.add('mobile-scrolled');
    } else if (currentScrollY < lastScrollY - 20 || currentScrollY <= 15) {
      // Rolando para CIMA ou retornando ao topo: restaura suavemente
      document.body.classList.remove('mobile-scrolled');
    }
  } else {
    document.body.classList.remove('mobile-scrolled');
  }

  lastScrollY = currentScrollY;
}

window.addEventListener('scroll', () => {
  if (!scrollTicking) {
    window.requestAnimationFrame(() => {
      updateMobileScrollState();
      scrollTicking = false;
    });
    scrollTicking = true;
  }
}, { passive: true });

// Suporte a gesto de toque para resposta imediata ao arrastar no celular
let touchStartY = 0;
window.addEventListener('touchstart', (e) => {
  if (e.touches && e.touches[0]) {
    touchStartY = e.touches[0].clientY;
  }
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (window.innerWidth <= 850 && e.touches && e.touches[0]) {
    const touchY = e.touches[0].clientY;
    const deltaY = touchStartY - touchY; // Positivo = arrastando para cima / descendo página
    if (deltaY > 15 && window.scrollY > 20) {
      document.body.classList.add('mobile-scrolled');
    } else if (deltaY < -25 && window.scrollY <= 20) {
      document.body.classList.remove('mobile-scrolled');
    }
  }
}, { passive: true });

window.addEventListener('DOMContentLoaded', async () => {
  console.log(`[Monitor Plantar] Aplicação iniciada — Versão ${APP_VERSION} (${APP_BUILD_TIME})`);
  renderInitialState();
  await initBatteryTrial();
  await footHeatmap.init();
  initHeatmapToolbar();
  if (window.NativeMonitor?.enabled) {
    try { await NativeMonitor.initialize(); }
    catch (err) { alert(`Falha ao iniciar o serviço Android: ${err.message}`); }
  }
});

// ==========================================================================
// GRAVAÇÃO CONTÍNUA AUTOMÁTICA & ARQUIVAMENTO RESILIENTE NO CELULAR
// Armazenamento contínuo em IndexedDB + Cache local + Histórico 12h
// Exportação direta em CSV, envio por e-mail e compartilhamento nativo móvel
// ==========================================================================

let rollingHistorySamples = [];
const MAX_ROLLING_HISTORY_MS = 24 * 3600 * 1000; // Mantém até 24 horas no histórico circular

const batteryTrial = {
  isRecording: false,
  isFinished: false,
  sessionId: null,
  startTime: null,
  endTime: null,
  timerInterval: null,
  samples: [],
  db: null,
  wakeLock: null,
  lastSeq: null,
  lastTimestamp: null,
  peakM1: 0,
  peakM5: 0,
  peakCalc: 0,
  storageKey: 'palmilha_battery_trial_samples_v1',
  metaKey: 'palmilha_battery_trial_meta_v1',
  sessionsListKey: 'palmilha_saved_sessions_list_v1'
};

// ── BANCO DE DADOS INDEXEDDB LOCAL DO CELULAR ─────────────────────────────
function openBatteryDB() {
  if (window.NativeMonitor?.enabled) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB não suportado neste navegador. Usando localStorage.');
      resolve(null);
      return;
    }
    const request = indexedDB.open('InsoleBatteryDB', 2);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions');
      }
    };
    request.onsuccess = (e) => {
      batteryTrial.db = e.target.result;
      resolve(batteryTrial.db);
    };
    request.onerror = (err) => {
      console.warn('Erro ao abrir IndexedDB:', err);
      resolve(null);
    };
  });
}

function persistBatteryData() {
  // SQLite is the source of truth in the APK. The web view is rebuilt on opening.
  if (window.NativeMonitor?.enabled) return;
  const meta = {
    sessionId: batteryTrial.sessionId,
    isRecording: batteryTrial.isRecording,
    isFinished: batteryTrial.isFinished,
    startTime: batteryTrial.startTime,
    endTime: batteryTrial.endTime,
    sampleCount: batteryTrial.samples.length,
    peakM1: batteryTrial.peakM1,
    peakM5: batteryTrial.peakM5,
    peakCalc: batteryTrial.peakCalc,
    lastSeq: batteryTrial.lastSeq,
    lastTimestamp: batteryTrial.lastTimestamp,
    updatedAt: new Date().toISOString()
  };

  try {
    localStorage.setItem(batteryTrial.metaKey, JSON.stringify(meta));
  } catch (e) {
    console.warn('Falha ao gravar meta no localStorage:', e);
  }

  // Persiste array de amostras no IndexedDB (capacidade para centenas de milhares de amostras)
  if (batteryTrial.db) {
    try {
      const tx = batteryTrial.db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      store.put(batteryTrial.samples, 'current_battery_trial');
      if (batteryTrial.sessionId) {
        store.put({
          id: batteryTrial.sessionId,
          sessionId: batteryTrial.sessionId,
          startTime: batteryTrial.startTime,
          endTime: batteryTrial.endTime,
          durationMs: (batteryTrial.endTime || Date.now()) - (batteryTrial.startTime || Date.now()),
          formattedDuration: formatTimer((batteryTrial.endTime || Date.now()) - (batteryTrial.startTime || Date.now())),
          sampleCount: batteryTrial.samples.length,
          peakM1: batteryTrial.peakM1,
          peakM5: batteryTrial.peakM5,
          peakCalc: batteryTrial.peakCalc,
          dateStr: new Date(batteryTrial.startTime || Date.now()).toLocaleString('pt-BR'),
          samples: batteryTrial.samples
        }, batteryTrial.sessionId);
      }
    } catch (e) {
      console.warn('Erro ao gravar no IndexedDB:', e);
    }
  } else {
    try {
      if (batteryTrial.samples.length <= 10000) {
        localStorage.setItem(batteryTrial.storageKey, JSON.stringify(batteryTrial.samples));
      }
    } catch (e) {}
  }
}

function archiveCurrentSession() {
  if (window.NativeMonitor?.enabled) return;
  if (!batteryTrial.samples || batteryTrial.samples.length === 0) {
    console.log('[Sessão] Nenhuma amostra recebida nesta conexão para arquivar.');
    return;
  }

  const start = batteryTrial.startTime || Date.now();
  const end = batteryTrial.endTime || Date.now();
  const durationMs = Math.max(0, end - start);
  const sessionId = batteryTrial.sessionId || ('sessao_' + new Date(start).toISOString().slice(0, 19).replace(/[-:T]/g, '_'));

  const sessionRecord = {
    id: sessionId,
    sessionId: sessionId,
    startTime: start,
    endTime: end,
    durationMs: durationMs,
    formattedDuration: formatTimer(durationMs),
    sampleCount: batteryTrial.samples.length,
    peakM1: batteryTrial.peakM1,
    peakM5: batteryTrial.peakM5,
    peakCalc: batteryTrial.peakCalc,
    dateStr: new Date(start).toLocaleString('pt-BR'),
    samples: batteryTrial.samples
  };

  // Salva no IndexedDB
  if (batteryTrial.db) {
    try {
      const tx = batteryTrial.db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      store.put(sessionRecord, sessionId);
    } catch (e) {
      console.warn('Erro ao arquivar sessão no IndexedDB:', e);
    }
  }

  // Atualiza metadados no localStorage
  try {
    const listStr = localStorage.getItem(batteryTrial.sessionsListKey);
    let list = listStr ? JSON.parse(listStr) : [];
    list = list.filter(s => s.id !== sessionId);
    list.unshift({
      id: sessionId,
      sessionId: sessionId,
      startTime: start,
      endTime: end,
      durationMs: durationMs,
      formattedDuration: sessionRecord.formattedDuration,
      sampleCount: sessionRecord.sampleCount,
      peakM1: sessionRecord.peakM1,
      peakM5: sessionRecord.peakM5,
      peakCalc: sessionRecord.peakCalc,
      dateStr: sessionRecord.dateStr
    });
    if (list.length > 30) list = list.slice(0, 30);
    localStorage.setItem(batteryTrial.sessionsListKey, JSON.stringify(list));
    renderSavedSessionsUI();
  } catch (e) {
    console.warn('Erro ao salvar metadados da sessão:', e);
  }
}

function showRecoveryAlert(sampleCount) {
  const banner = document.getElementById('battery-alert-banner');
  const alertTitle = document.getElementById('battery-alert-title');
  const alertDesc = document.getElementById('battery-alert-desc');
  if (banner && alertTitle && alertDesc) {
    banner.style.display = 'flex';
    alertTitle.textContent = '💾 Sessão Anterior Recuperada com Sucesso!';
    alertDesc.textContent = `A página foi recarregada durante o ensaio anterior. Todas as ${sampleCount.toLocaleString('pt-BR')} amostras coletadas antes do recarregamento foram salvas com segurança no histórico deste aparelho.`;
  }
  recordAlertEvent('ok', `Sessão anterior recuperada com sucesso (${sampleCount.toLocaleString('pt-BR')} amostras preservadas pós-recarregamento).`);
}

async function restorePreviousBatterySession() {
  if (window.NativeMonitor?.enabled) return;
  try {
    const metaStr = localStorage.getItem(batteryTrial.metaKey);
    if (!metaStr) return;
    const meta = JSON.parse(metaStr);
    if (!meta || !meta.sampleCount) return;

    const wasInterrupted = meta.isRecording === true;

    batteryTrial.sessionId = meta.sessionId || null;
    batteryTrial.startTime = meta.startTime;
    batteryTrial.endTime = meta.endTime || Date.now();
    batteryTrial.isFinished = true; // Se a página foi fechada/recarregada, a sessão anterior está finalizada
    batteryTrial.isRecording = false;
    batteryTrial.peakM1 = meta.peakM1 ?? 0;
    batteryTrial.peakM5 = meta.peakM5 ?? 0;
    batteryTrial.peakCalc = meta.peakCalc ?? 0;
    batteryTrial.lastSeq = meta.lastSeq ?? null;
    batteryTrial.lastTimestamp = meta.lastTimestamp ?? null;

    if (batteryTrial.db) {
      const tx = batteryTrial.db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const req = store.get('current_battery_trial');
      req.onsuccess = () => {
        if (req.result && Array.isArray(req.result)) {
          batteryTrial.samples = req.result;
          if (wasInterrupted) {
            archiveCurrentSession();
            showRecoveryAlert(batteryTrial.samples.length);
          }
        }
        updateBatteryTrialUI();
      };
      req.onerror = () => updateBatteryTrialUI();
    } else {
      const cached = localStorage.getItem(batteryTrial.storageKey);
      if (cached) {
        batteryTrial.samples = JSON.parse(cached);
        if (wasInterrupted) {
          archiveCurrentSession();
          showRecoveryAlert(batteryTrial.samples.length);
        }
      }
      updateBatteryTrialUI();
    }
  } catch (err) {
    console.warn('Erro ao restaurar sessão anterior:', err);
  }
}

async function loadRecentHistoryFromDB() {
  if (window.NativeMonitor?.enabled) return;
  if (!batteryTrial.db) return;
  return new Promise((resolve) => {
    try {
      const tx = batteryTrial.db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const req = store.openCursor(null, 'prev');
      const allSamples = [];

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          if (Array.isArray(val)) {
            allSamples.push(...val);
          } else if (val && val.samples && Array.isArray(val.samples)) {
            allSamples.push(...val.samples);
          }
          cursor.continue();
        } else {
          allSamples.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
          const cutoff = Date.now() - MAX_ROLLING_HISTORY_MS;
          rollingHistorySamples = allSamples.filter(s => (s.timestamp || 0) >= cutoff);
          if (rollingHistorySamples.length === 0 && allSamples.length > 0) {
            const lastT = allSamples[allSamples.length - 1].timestamp || 0;
            const fallbackCutoff = lastT - (12 * 3600 * 1000);
            rollingHistorySamples = allSamples.filter(s => (s.timestamp || 0) >= fallbackCutoff);
          }
          console.log(`[Histórico] Restauradas ${rollingHistorySamples.length} amostras para janelas temporais.`);
          resolve();
        }
      };
      req.onerror = () => resolve();
    } catch (e) {
      resolve();
    }
  });
}

function addSampleToRollingHistory(sample) {
  rollingHistorySamples.push({
    timestamp: sample.timestamp,
    t_ms: sample.t_ms,
    seq: sample.seq,
    m1: sample.m1,
    m5: sample.m5,
    calc: sample.calc,
    temp: sample.temp,
    umid: sample.umid,
    timeStr: sample.timeStr
  });
  const cutoff = Date.now() - MAX_ROLLING_HISTORY_MS;
  while (rollingHistorySamples.length > 0 && (rollingHistorySamples[0].timestamp || 0) < cutoff) {
    rollingHistorySamples.shift();
  }
}

// ── GESTÃO DO SCREEN WAKE LOCK (TELA SEMPRE ACESA NO CELULAR) ──────────────
async function requestWakeLock() {
  if (window.NativeMonitor?.enabled) return;
  const badgeWake = document.getElementById('badge-wakelock');
  if ('wakeLock' in navigator) {
    try {
      batteryTrial.wakeLock = await navigator.wakeLock.request('screen');
      if (badgeWake) badgeWake.classList.add('active');
      batteryTrial.wakeLock.addEventListener('release', () => {
        if (badgeWake) badgeWake.classList.remove('active');
      });
    } catch (err) {
      console.warn('Wake Lock não autorizado ou indisponível:', err);
      if (badgeWake) badgeWake.classList.remove('active');
    }
  }
}

function releaseWakeLock() {
  const badgeWake = document.getElementById('badge-wakelock');
  if (batteryTrial.wakeLock) {
    try { batteryTrial.wakeLock.release(); } catch (e) {}
    batteryTrial.wakeLock = null;
  }
  if (badgeWake) badgeWake.classList.remove('active');
}

// ── GESTÃO DE SEGUNDO PLANO (VISIBILITY CHANGE - ANDROID / MOBILE) ──────────
document.addEventListener('visibilitychange', async () => {
  if (window.NativeMonitor?.enabled) {
    if (document.visibilityState === 'visible') await NativeMonitor.resume();
    return;
  }
  if (document.visibilityState === 'hidden') {
    // Usuário trocou de aplicativo (WhatsApp, etc.) ou tela apagou
    console.log('[Segundo Plano] Aplicação minimizada. Persistindo amostras imediatamente no IndexedDB...');
    if (batteryTrial.isRecording && batteryTrial.samples.length > 0) {
      persistBatteryData();
    }
  } else if (document.visibilityState === 'visible') {
    // Retornou para o aplicativo
    console.log('[Primeiro Plano] Retornou ao aplicativo.');
    if (state.connectionType === 'ble' && state.bleDevice?.gatt?.connected) {
      await requestWakeLock();
    } else if (batteryTrial.isFinished && batteryTrial.samples.length > 0) {
      recordAlertEvent('warn', 'O Android suspendeu a conexão Bluetooth ao alternar de tela. Os dados foram salvos no aparelho!');
    }
  }
});

// ── SALVAMENTO EMERGENCIAL E PROTEÇÃO CONTRA FECHAMENTO / RECARREGAMENTO ────
function emergencySaveSession() {
  if (window.NativeMonitor?.enabled) return;
  if (!batteryTrial.samples || batteryTrial.samples.length === 0) return;

  const now = Date.now();
  batteryTrial.isRecording = false;
  batteryTrial.isFinished = true;
  if (!batteryTrial.endTime) {
    batteryTrial.endTime = now;
  }

  // 1. Grava metadados de forma síncrona imediata no localStorage
  persistBatteryData();

  // 2. Arquiva formalmente no catálogo de sessões salvas
  archiveCurrentSession();
}

// Intercepta tentativa de recarregar ou fechar página (aviso nativo + salvamento prévio)
window.addEventListener('beforeunload', (e) => {
  if (window.NativeMonitor?.enabled) return;
  if (batteryTrial.isRecording && batteryTrial.samples.length > 0) {
    emergencySaveSession();
    e.preventDefault();
    e.returnValue = 'Um ensaio da palmilha está em andamento. Os dados foram salvos com segurança, mas a conexão BLE será interrompida.';
    return e.returnValue;
  }
});

// Garante salvamento no descarregamento da página (Lifecycle API do navegador)
window.addEventListener('pagehide', () => {
  if (window.NativeMonitor?.enabled) return;
  if (batteryTrial.isRecording && batteryTrial.samples.length > 0) {
    emergencySaveSession();
  }
});

// ── REGISTRO DE CADA AMOSTRA RECEBIDA ──────────────────────────────────────
function recordBatterySample(data) {
  if (window.NativeMonitor?.enabled) return; // NativeMonitor replays the durable journal.
  if (!batteryTrial.isRecording) return;

  const now = Date.now();
  const elapsedMs = batteryTrial.startTime ? (now - batteryTrial.startTime) : 0;

  const m1 = Math.round(data.meta1 ?? 0);
  const m5 = Math.round(data.meta5 ?? 0);
  const calc = Math.round(data.calcaneo ?? 0);

  const sample = {
    timestamp: now,
    t_ms: elapsedMs,
    seq: data.seq ?? (batteryTrial.samples.length + 1),
    calc: calc,
    m1: m1,
    m5: m5,
    temp: (data.temp != null && !isNaN(data.temp)) ? Number(data.temp).toFixed(1) : '',
    umid: (data.umid != null && !isNaN(data.umid)) ? Number(data.umid).toFixed(1) : '',
    timeStr: new Date(now).toLocaleTimeString('pt-BR')
  };

  batteryTrial.samples.push(sample);
  batteryTrial.lastSeq = sample.seq;
  batteryTrial.lastTimestamp = sample.timeStr;

  if (m1 > batteryTrial.peakM1) batteryTrial.peakM1 = m1;
  if (m5 > batteryTrial.peakM5) batteryTrial.peakM5 = m5;
  if (calc > batteryTrial.peakCalc) batteryTrial.peakCalc = calc;

  // Adiciona ao buffer contínuo em memória para o mapa térmico de 1h a 12h
  addSampleToRollingHistory(sample);

  // Persiste a cada 20 amostras (~2 segundos a 10 Hz) e na 1ª amostra
  if (batteryTrial.samples.length === 1 || batteryTrial.samples.length % 20 === 0) {
    persistBatteryData();
  }

  // Atualização em tempo real das métricas da barra
  updateBatteryTrialLiveMetrics();
}

function updateBatteryTrialLiveMetrics() {
  if (window.NativeMonitor?.enabled) { NativeMonitor.updateMetrics(); return; }
  const countEl = document.getElementById('battery-samples-count');
  const rateEl = document.getElementById('battery-rate-hz');
  const sizeEl = document.getElementById('battery-storage-size');
  const peaksEl = document.getElementById('battery-peaks-summary');
  const lastSeqEl = document.getElementById('battery-last-seq');

  const total = batteryTrial.samples.length;
  if (countEl) countEl.textContent = total.toLocaleString('pt-BR');

  if (batteryTrial.startTime) {
    const elapsedSec = Math.max(1, (Date.now() - batteryTrial.startTime) / 1000);
    const hz = (total / elapsedSec).toFixed(1);
    if (rateEl) rateEl.textContent = `${hz} Hz`;
  }

  const estimatedKb = ((total * 55) / 1024).toFixed(1);
  if (sizeEl) sizeEl.textContent = `${estimatedKb} KB`;

  if (peaksEl) {
    peaksEl.textContent = `M1: ${batteryTrial.peakM1} | M5: ${batteryTrial.peakM5} | C: ${batteryTrial.peakCalc}`;
  }

  if (lastSeqEl) {
    lastSeqEl.textContent = `Seq: ${batteryTrial.lastSeq ?? '--'} (${batteryTrial.lastTimestamp ?? ''})`;
  }
}

// ── CRONÔMETRO DIGITAL ────────────────────────────────────────────────────
function formatTimer(ms) {
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].join(':');
}

function updateBatteryTimerDisplay() {
  const timerEl = document.getElementById('battery-timer');
  if (!timerEl) return;
  if (!batteryTrial.startTime) {
    timerEl.textContent = '00:00:00';
    return;
  }
  const end = batteryTrial.endTime || Date.now();
  const elapsed = Math.max(0, end - batteryTrial.startTime);
  timerEl.textContent = formatTimer(elapsed);
}

// ── CONTROLE AUTOMÁTICO DE GRAVAÇÃO (INÍCIO E PARADA POR CONEXÃO) ─────────
async function startAutoRecordingSession(type = 'ble') {
  if (window.NativeMonitor?.enabled) return;
  if (batteryTrial.isRecording) return;

  // Se havia sessão anterior finalizada com dados, arquiva no histórico antes de iniciar
  if (batteryTrial.samples && batteryTrial.samples.length > 0 && batteryTrial.isFinished) {
    archiveCurrentSession();
  }

  const now = Date.now();
  const dateTag = new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '_');
  batteryTrial.sessionId = 'sessao_' + dateTag;
  batteryTrial.isRecording = true;
  batteryTrial.isFinished = false;
  batteryTrial.startTime = now;
  batteryTrial.endTime = null;
  batteryTrial.samples = [];
  batteryTrial.peakM1 = 0;
  batteryTrial.peakM5 = 0;
  batteryTrial.peakCalc = 0;
  batteryTrial.lastSeq = null;

  const banner = document.getElementById('battery-alert-banner');
  if (banner) banner.style.display = 'none';

  await requestWakeLock();

  if (batteryTrial.timerInterval) clearInterval(batteryTrial.timerInterval);
  batteryTrial.timerInterval = setInterval(() => {
    updateBatteryTimerDisplay();
  }, 1000);

  persistBatteryData();
  updateBatteryTrialUI();

  recordAlertEvent('ok', `Gravação contínua iniciada automaticamente (${type.toUpperCase()})! Dados sendo salvos.`);
}

function stopAutoRecordingSession() {
  if (window.NativeMonitor?.enabled) return;
  if (!batteryTrial.isRecording) return;

  batteryTrial.isRecording = false;
  batteryTrial.isFinished = true;
  batteryTrial.endTime = Date.now();

  if (batteryTrial.timerInterval) {
    clearInterval(batteryTrial.timerInterval);
    batteryTrial.timerInterval = null;
  }

  updateBatteryTimerDisplay();
  releaseWakeLock();
  persistBatteryData();
  archiveCurrentSession();
  updateBatteryTrialUI();

  if (navigator.vibrate) {
    try { navigator.vibrate([200, 100, 200]); } catch (e) {}
  }

  const summary = getBatteryTrialSummary();
  const banner = document.getElementById('battery-alert-banner');
  const alertTitle = document.getElementById('battery-alert-title');
  const alertDesc = document.getElementById('battery-alert-desc');
  if (banner && alertTitle && alertDesc) {
    banner.style.display = 'flex';
    alertTitle.textContent = `💾 Sessão Salva com Sucesso! (${summary.formattedDuration})`;
    alertDesc.textContent = `Foram gravadas ${summary.totalSamples.toLocaleString('pt-BR')} amostras com segurança no armazenamento local deste telefone (${summary.avgHz} Hz). Baixe o CSV ou envie por e-mail abaixo.`;
  }
}

// ── CONTROLE MANUAL PELO BOTÃO NA INTERFACE ──────────────────────────────
async function startBatteryTrial() {
  await startAutoRecordingSession(state.connectionType || 'manual');
}

function stopBatteryTrialManual() {
  stopAutoRecordingSession();
  recordAlertEvent('warn', 'Gravação pausada manualmente pelo usuário.');
}

function finishBatteryTrialDueToDischarge() {
  stopAutoRecordingSession();
  recordAlertEvent('danger', 'Desconexão do dispositivo: dados da sessão preservados com segurança no celular.');
}

function clearBatterySession() {
  if (window.NativeMonitor?.enabled) { NativeMonitor.clearView(); return; }
  if (batteryTrial.isRecording) {
    if (!confirm('A gravação está em andamento. Deseja realmente interromper e limpar os dados da sessão atual?')) {
      return;
    }
    stopAutoRecordingSession();
  } else if (batteryTrial.samples.length > 0) {
    if (!confirm('Deseja realmente limpar a sessão atual da tela? O histórico de sessões anteriores será mantido.')) {
      return;
    }
  }

  batteryTrial.samples = [];
  batteryTrial.startTime = null;
  batteryTrial.endTime = null;
  batteryTrial.isFinished = false;
  batteryTrial.peakM1 = 0;
  batteryTrial.peakM5 = 0;
  batteryTrial.peakCalc = 0;
  batteryTrial.lastSeq = null;

  try {
    localStorage.removeItem(batteryTrial.metaKey);
    localStorage.removeItem(batteryTrial.storageKey);
    if (batteryTrial.db) {
      const tx = batteryTrial.db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').delete('current_battery_trial');
    }
  } catch (e) {}

  const banner = document.getElementById('battery-alert-banner');
  if (banner) banner.style.display = 'none';

  updateBatteryTimerDisplay();
  updateBatteryTrialUI();
}

// ── ATUALIZAÇÃO GERAL DA UI DO ENSAIO DE BATERIA ───────────────────────────
function updateBatteryTrialUI() {
  const card = document.getElementById('card-battery-trial');
  const badgeStatus = document.getElementById('badge-battery-status');
  const btnToggle = document.getElementById('btn-battery-toggle');
  const btnToggleText = document.getElementById('btn-battery-toggle-text');
  const btnDownload = document.getElementById('btn-battery-download');
  const btnShare = document.getElementById('btn-battery-share');
  const btnEmail = document.getElementById('btn-battery-email');
  const storageStatus = document.getElementById('battery-storage-status');

  const hasSamples = batteryTrial.samples.length > 0;

  if (btnDownload) btnDownload.disabled = !hasSamples;
  if (btnShare) btnShare.disabled = !hasSamples;
  if (btnEmail) btnEmail.disabled = !hasSamples;

  updateBatteryTimerDisplay();
  updateBatteryTrialLiveMetrics();

  if (storageStatus) {
    storageStatus.textContent = batteryTrial.db ? 'IndexedDB ativo (Seguro)' : 'Armazenamento local';
  }

  if (batteryTrial.isRecording) {
    if (card) {
      card.classList.add('is-recording');
      card.classList.remove('is-finished');
    }
    if (badgeStatus) {
      badgeStatus.className = 'badge-battery-status status-recording';
      badgeStatus.textContent = '🔴 Gravando Automaticamente';
    }
    if (btnToggle) {
      btnToggle.classList.add('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Pausar Gravação';
    }
  } else if (batteryTrial.isFinished && hasSamples) {
    if (card) {
      card.classList.remove('is-recording');
      card.classList.add('is-finished');
    }
    if (badgeStatus) {
      badgeStatus.className = 'badge-battery-status status-finished';
      badgeStatus.textContent = '💾 Sessão Salva no Aparelho';
    }
    if (btnToggle) {
      btnToggle.classList.remove('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Iniciar Nova Gravação';
    }
  } else {
    if (card) {
      card.classList.remove('is-recording');
      card.classList.remove('is-finished');
    }
    if (badgeStatus) {
      badgeStatus.className = 'badge-battery-status status-idle';
      badgeStatus.textContent = '⚪ Pronto para Conectar';
    }
    if (btnToggle) {
      btnToggle.classList.remove('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Iniciar Gravação Manual';
    }
  }
}

// ── ESTATÍSTICAS E RESUMO DO ENSAIO ───────────────────────────────────────
function getBatteryTrialSummary(customSamples = null, customStart = null, customEnd = null) {
  const samplesArr = customSamples || batteryTrial.samples;
  const total = samplesArr.length;
  const start = customStart ? new Date(customStart) : (batteryTrial.startTime ? new Date(batteryTrial.startTime) : new Date());
  const end = customEnd ? new Date(customEnd) : (batteryTrial.endTime ? new Date(batteryTrial.endTime) : new Date());
  const elapsedMs = Math.max(0, end.getTime() - start.getTime());
  const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
  const hz = total > 0 ? (total / elapsedSec).toFixed(1) : '0.0';

  let peakM1 = 0, peakM5 = 0, peakCalc = 0;
  for (let i = 0; i < total; i++) {
    const s = samplesArr[i];
    if ((s.m1 ?? 0) > peakM1) peakM1 = s.m1;
    if ((s.m5 ?? 0) > peakM5) peakM5 = s.m5;
    if ((s.calc ?? 0) > peakCalc) peakCalc = s.calc;
  }

  const d = start;
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '') + '_' + 
                  String(d.getHours()).padStart(2, '0') + 
                  String(d.getMinutes()).padStart(2, '0');
  const filename = `ensaio_palmilha_${dateStr}.csv`;

  return {
    startedAt: start.toLocaleString('pt-BR'),
    endedAt: end.toLocaleString('pt-BR'),
    durationSeconds: elapsedSec,
    formattedDuration: formatTimer(elapsedMs),
    totalSamples: total,
    avgHz: hz,
    peakM1: peakM1,
    peakM5: peakM5,
    peakCalc: peakCalc,
    statusText: batteryTrial.isFinished ? 'Finalizado / Salvo no Celular' : 'Em andamento',
    filename: filename
  };
}

// ── GERAÇÃO DO ARQUIVO CSV PADRÃO CIENTÍFICO ──────────────────────────────
function generateCsvContent(customSamples = null, customStart = null, customEnd = null) {
  const samplesArr = customSamples || batteryTrial.samples;
  const meta = getBatteryTrialSummary(samplesArr, customStart, customEnd);
  let csv = `# ====================================================================\n`;
  csv += `# TELEMETRIA E PRESSÃO PLANTAR - PALMILHA INSTRUMENTADA (UERJ)\n`;
  csv += `# Projeto: Monitor Plantar Preventivo de Úlceras no Pé Diabético\n`;
  csv += `# Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)\n`;
  csv += `# Versão do Aplicativo Web: ${APP_VERSION} (Build: ${APP_BUILD_TIME})\n`;
  csv += `# Data e Hora de Início: ${meta.startedAt}\n`;
  csv += `# Data e Hora de Término: ${meta.endedAt}\n`;
  csv += `# Duração Total Registrada: ${meta.formattedDuration} (${meta.durationSeconds} segundos)\n`;
  csv += `# Total de Amostras Gravadas no Celular: ${meta.totalSamples}\n`;
  csv += `# Frequência Média de Transmissão: ${meta.avgHz} Hz\n`;
  csv += `# Carga Máxima (M1 - 1º Metatarso): ${meta.peakM1} ADC\n`;
  csv += `# Carga Máxima (M5 - 5º Metatarso): ${meta.peakM5} ADC\n`;
  csv += `# Carga Máxima (Calcâneo): ${meta.peakCalc} ADC\n`;
  csv += `# ====================================================================\n`;
  csv += `t_ms,dt_ms,seq,timestamp_epoch,timestamp_local,m1_adc,m5_adc,calcaneo_adc,temp_c,umid_pct\n`;

  let prevTime = 0;
  for (let i = 0; i < samplesArr.length; i++) {
    const s = samplesArr[i];
    const dt = (i === 0) ? 0 : (s.t_ms - prevTime);
    prevTime = s.t_ms;
    const epoch = s.timestamp || (batteryTrial.startTime ? (batteryTrial.startTime + s.t_ms) : '');
    csv += `${s.t_ms},${dt},${s.seq},${epoch},"${s.timeStr}",${s.m1},${s.m5},${s.calc},${s.temp},${s.umid}\n`;
  }
  return csv;
}

// ── 1. BAIXAR ARQUIVO CSV NO CELULAR (DOWNLOAD DIRETO) ────────────────────
function downloadBatteryCsv() {
  if (window.NativeMonitor?.enabled) return NativeMonitor.exportCurrent(false);
  if (batteryTrial.samples.length === 0) {
    alert('Nenhum dado registrado para exportação.');
    return;
  }
  const summary = getBatteryTrialSummary();
  const csv = generateCsvContent();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = summary.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function downloadSessionCsv(sessionId) {
  if (window.NativeMonitor?.enabled) return NativeMonitor.exportSession(sessionId, false);
  if (!batteryTrial.db) {
    downloadBatteryCsv();
    return;
  }
  const session = await loadSessionFromDB(sessionId);
  if (!session || !session.samples || session.samples.length === 0) {
    alert('Dados da sessão não encontrados no banco local.');
    return;
  }
  const csv = generateCsvContent(session.samples, session.startTime, session.endTime);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sessionId}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function loadSessionIntoHeatmap(sessionId) {
  if (window.NativeMonitor?.enabled) return NativeMonitor.loadSession(sessionId);
  const session = await loadSessionFromDB(sessionId);
  if (!session || !session.samples || session.samples.length === 0) {
    alert('Não foi possível carregar os dados desta sessão.');
    return;
  }

  batteryTrial.sessionId = session.id;
  batteryTrial.samples = session.samples;
  batteryTrial.startTime = session.startTime;
  batteryTrial.endTime = session.endTime;
  batteryTrial.isFinished = true;
  batteryTrial.isRecording = false;
  batteryTrial.peakM1 = session.peakM1 || 0;
  batteryTrial.peakM5 = session.peakM5 || 0;
  batteryTrial.peakCalc = session.peakCalc || 0;

  updateBatteryTrialUI();

  // Aciona visualização no mapa térmico
  selectHeatmapWindow('1h');
  recordAlertEvent('ok', `Sessão ${session.dateStr} carregada no mapa térmico!`);
}

function loadSessionFromDB(sessionId) {
  return new Promise((resolve) => {
    if (!batteryTrial.db) {
      resolve(null);
      return;
    }
    try {
      const tx = batteryTrial.db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const req = store.get(sessionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

// ── 2. COMPARTILHAR DADOS VIA WEB SHARE (WHATSAPP, DRIVE, ARQUIVO) ────────
async function shareBatteryData() {
  if (window.NativeMonitor?.enabled) return NativeMonitor.exportCurrent(true);
  if (batteryTrial.samples.length === 0) {
    alert('Nenhum dado registrado para compartilhar.');
    return;
  }

  const summary = getBatteryTrialSummary();
  const csv = generateCsvContent();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const file = new File([blob], summary.filename, { type: 'text/csv' });

  const shareText = `Palmilha Inteligente (UERJ) - Dados de Telemetria\n` +
                    `Duração: ${summary.formattedDuration}\n` +
                    `Amostras: ${summary.totalSamples.toLocaleString('pt-BR')} (${summary.avgHz} Hz)\n` +
                    `Picos: M1=${summary.peakM1} | M5=${summary.peakM5} | Calc=${summary.peakCalc} ADC`;

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'Dados da Palmilha Inteligente',
        text: shareText,
        files: [file]
      });
      return;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Erro ao compartilhar via Web Share:', err);
      } else {
        return;
      }
    }
  }

  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Dados da Palmilha Inteligente',
        text: shareText
      });
      downloadBatteryCsv();
      return;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Erro ao compartilhar texto:', err);
      }
    }
  }

  downloadBatteryCsv();
}

// ── 3. ENVIAR POR E-MAIL COM RELATÓRIO EXECUTIVO COMPLETO ─────────────────
function sendBatteryEmail() {
  if (window.NativeMonitor?.enabled) return NativeMonitor.exportCurrent(true);
  if (batteryTrial.samples.length === 0) {
    alert('Nenhum dado registrado para enviar por e-mail.');
    return;
  }

  const summary = getBatteryTrialSummary();
  downloadBatteryCsv();

  const subject = encodeURIComponent(`[Palmilha UERJ] Relatório de Monitoramento Plantar - Duração: ${summary.formattedDuration}`);
  const bodyText = `RELATÓRIO DE MONITORAMENTO PLANTAR
Projeto: Palmilha Instrumentada para Monitoramento e Prevenção do Pé Diabético
Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)

--------------------------------------------------
RESUMO DA SESSÃO
--------------------------------------------------
• Status: ${summary.statusText}
• Início do Teste: ${summary.startedAt}
• Término / Desligamento: ${summary.endedAt}
• Duração Registrada: ${summary.formattedDuration} (${summary.durationSeconds} segundos)
• Total de Amostras Coletadas: ${summary.totalSamples.toLocaleString('pt-BR')}
• Frequência Média de Transmissão: ${summary.avgHz} Hz
• Carga Máxima (M1 - 1º Metatarso): ${summary.peakM1} ADC
• Carga Máxima (M5 - 5º Metatarso): ${summary.peakM5} ADC
• Carga Máxima (Calcâneo): ${summary.peakCalc} ADC

--------------------------------------------------
DADOS BRUTOS EM CSV
--------------------------------------------------
O arquivo completo de telemetria ("${summary.filename}") com todas as ${summary.totalSamples.toLocaleString('pt-BR')} amostras foi salvo e baixado com sucesso na pasta de Downloads deste celular.

Dispositivo: ESP32 BLE (Palmilha_v5.0)
Gerado automaticamente pelo aplicativo Monitor Plantar Inteligente.`;

  const body = encodeURIComponent(bodyText);
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

// ── RENDERIZAÇÃO DA LISTA DE SESSÕES SALVAS NO CELULAR ───────────────────
function renderSavedSessionsUI() {
  if (window.NativeMonitor?.enabled) { NativeMonitor.renderHistory(); return; }
  const container = document.getElementById('saved-sessions-list');
  const countLabel = document.getElementById('sessions-count-label');
  if (!container) return;

  const listStr = localStorage.getItem(batteryTrial.sessionsListKey);
  const list = listStr ? JSON.parse(listStr) : [];

  if (countLabel) countLabel.textContent = list.length;

  if (list.length === 0) {
    container.innerHTML = '<div class="session-item-empty">Nenhuma sessão gravada no histórico deste aparelho.</div>';
    return;
  }

  container.innerHTML = list.map(s => `
    <div class="session-item" data-session-id="${s.id}">
      <div class="session-item-info">
        <strong class="session-item-date">${s.dateStr || 'Sessão'}</strong>
        <span class="session-item-meta">⏱️ ${s.formattedDuration || '00:00:00'} · 📊 ${s.sampleCount.toLocaleString('pt-BR')} amostras · Picos: M1:${s.peakM1} M5:${s.peakM5} C:${s.peakCalc}</span>
      </div>
      <div class="session-item-actions">
        <button class="btn-tiny btn-load-session" data-id="${s.id}" title="Carregar dados desta sessão no mapa">🗺️ Ver no Mapa</button>
        <button class="btn-tiny btn-download-session" data-id="${s.id}" title="Baixar arquivo CSV desta sessão">📥 CSV</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.btn-load-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await loadSessionIntoHeatmap(id);
    });
  });

  container.querySelectorAll('.btn-download-session').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      await downloadSessionCsv(id);
    });
  });
}

// ── INICIALIZAÇÃO DOS BOTÕES E EVENTOS DO TESTE DE BATERIA ────────────────
async function initBatteryTrial() {
  await openBatteryDB();
  await restorePreviousBatterySession();
  await loadRecentHistoryFromDB();
  renderSavedSessionsUI();

  const btnToggleHistory = document.getElementById('btn-toggle-sessions-list');
  const sessionsList = document.getElementById('saved-sessions-list');
  btnToggleHistory?.addEventListener('click', () => {
    if (!sessionsList) return;
    const isHidden = sessionsList.style.display === 'none';
    sessionsList.style.display = isHidden ? 'flex' : 'none';
    btnToggleHistory.textContent = isHidden ? 'Ocultar Histórico' : 'Ver Histórico';
  });

  const btnToggle = document.getElementById('btn-battery-toggle');
  btnToggle?.addEventListener('click', () => {
    if (batteryTrial.isRecording) {
      stopBatteryTrialManual();
    } else {
      startBatteryTrial();
    }
  });

  const btnClear = document.getElementById('btn-battery-clear');
  btnClear?.addEventListener('click', () => {
    clearBatterySession();
  });

  const btnDownload = document.getElementById('btn-battery-download');
  btnDownload?.addEventListener('click', () => {
    downloadBatteryCsv();
  });

  const btnShare = document.getElementById('btn-battery-share');
  btnShare?.addEventListener('click', () => {
    shareBatteryData();
  });

  const btnEmail = document.getElementById('btn-battery-email');
  btnEmail?.addEventListener('click', () => {
    sendBatteryEmail();
  });
}


// ==========================================================================
// MAPA TÉRMICO PLANTAR 2D CONTÍNUO & ANÁLISE TEMPORAL (MESTRADO PPGTS)
// Difusão Gaussiana e Gradiente Clínico (Ciano -> Verde -> Amarelo -> Laranja -> Vermelho)
// Alternância Temporal: [ Tempo Real | 1h | 3h | 6h | 8h | 12h ]
// ==========================================================================

const telemetryHistory = [];
const MAX_TELEMETRY_HISTORY = 45000; // ~1.25 horas a 10 Hz em buffer circular

function recordContinuousTelemetry(data) {
  const sample = {
    t: Date.now(),
    m1: Math.round(data.meta1 ?? 0),
    m5: Math.round(data.meta5 ?? 0),
    calc: Math.round(data.calcaneo ?? 0)
  };
  telemetryHistory.push(sample);
  if (telemetryHistory.length > MAX_TELEMETRY_HISTORY) {
    telemetryHistory.shift();
  }
}

const footHeatmap = {
  canvas: null,
  ctx: null,
  offCanvas: null,
  offCtx: null,
  width: 160,
  height: 240,
  isReady: false,
  footMask: null,
  kM1: null,
  kM5: null,
  kCalc: null,
  lut: null,
  lastM1: 0,
  lastM5: 0,
  lastCalc: 0,

  async init() {
    this.canvas = document.getElementById('foot-heat-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');

    // Canvas interno de computação rápida (160x240)
    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = this.width;
    this.offCanvas.height = this.height;
    this.offCtx = this.offCanvas.getContext('2d');

    // Gera LUT térmico médico (256 cores)
    this.generateLut();

    // Carrega a imagem anatômica e extrai máscara do contorno do pé
    await this.loadFootMask();

    // Pré-computa difusão Gaussiana para os 3 sensores anatômicos
    this.precomputeGaussians();

    this.isReady = true;

    // Renderiza quadro inicial limpo
    this.render(0, 0, 0);
  },

  generateLut() {
    this.lut = new Uint8Array(256 * 3);
    const stops = [
      { pos: 0.00, r: 0,   g: 229, b: 255 }, // Ciano médico
      { pos: 0.25, r: 0,   g: 230, b: 118 }, // Verde claro
      { pos: 0.50, r: 255, g: 234, b: 0   }, // Amarelo
      { pos: 0.75, r: 255, g: 109, b: 0   }, // Laranja
      { pos: 1.00, r: 213, g: 0,   b: 0   }  // Vermelho sobrecarga
    ];
    for (let i = 0; i < 256; i++) {
      const v = i / 255.0;
      let r = stops[0].r, g = stops[0].g, b = stops[0].b;
      for (let s = 0; s < stops.length - 1; s++) {
        if (v >= stops[s].pos && v <= stops[s + 1].pos) {
          const f = (v - stops[s].pos) / (stops[s + 1].pos - stops[s].pos);
          r = Math.round(stops[s].r + f * (stops[s + 1].r - stops[s].r));
          g = Math.round(stops[s].g + f * (stops[s + 1].g - stops[s].g));
          b = Math.round(stops[s].b + f * (stops[s + 1].b - stops[s].b));
          break;
        }
      }
      this.lut[i * 3]     = r;
      this.lut[i * 3 + 1] = g;
      this.lut[i * 3 + 2] = b;
    }
  },

  loadFootMask() {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const maskCanvas = document.createElement('canvas');
          maskCanvas.width = this.width;
          maskCanvas.height = this.height;
          const maskCtx = maskCanvas.getContext('2d');
          maskCtx.drawImage(img, 0, 0, this.width, this.height);
          const imgData = maskCtx.getImageData(0, 0, this.width, this.height);
          const total = this.width * this.height;
          this.footMask = new Uint8Array(total);
          for (let i = 0; i < total; i++) {
            this.footMask[i] = (imgData.data[i * 4 + 3] > 30) ? 1 : 0;
          }
        } catch (e) {
          this.footMask = new Uint8Array(this.width * this.height).fill(1);
        }
        resolve();
      };
      img.onerror = () => {
        this.footMask = new Uint8Array(this.width * this.height).fill(1);
        resolve();
      };
      img.src = 'clean_foot_transparent.png';
    });
  },

  precomputeGaussians() {
    const W = this.width;
    const H = this.height;
    const total = W * H;

    this.kM1   = new Float32Array(total);
    this.kM5   = new Float32Array(total);
    this.kCalc = new Float32Array(total);

    const posM1   = { x: Math.round(0.34 * W), y: Math.round(0.34 * H) };
    const posM5   = { x: Math.round(0.66 * W), y: Math.round(0.39 * H) };
    const posCalc = { x: Math.round(0.51 * W), y: Math.round(0.82 * H) };

    const sM1   = 2 * (0.11 * W) * (0.11 * W);
    const sM5   = 2 * (0.10 * W) * (0.10 * W);
    const sCalc = 2 * (0.125 * W) * (0.125 * W);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const dM1   = (x - posM1.x) ** 2 + (y - posM1.y) ** 2;
        const dM5   = (x - posM5.x) ** 2 + (y - posM5.y) ** 2;
        const dCalc = (x - posCalc.x) ** 2 + (y - posCalc.y) ** 2;

        this.kM1[i]   = Math.exp(-dM1 / sM1);
        this.kM5[i]   = Math.exp(-dM5 / sM5);
        this.kCalc[i] = Math.exp(-dCalc / sCalc);
      }
    }
  },

  render(m1Val, m5Val, calcVal) {
    if (!this.isReady || !this.ctx) return;
    this.lastM1 = m1Val;
    this.lastM5 = m5Val;
    this.lastCalc = calcVal;

    const W = this.width;
    const H = this.height;
    const total = W * H;
    const imgData = this.offCtx.createImageData(W, H);
    const d = imgData.data;

    const maxAdc = 650.0;
    const mask = this.footMask;
    const k1 = this.kM1, k5 = this.kM5, kc = this.kCalc;
    const lut = this.lut;

    for (let i = 0; i < total; i++) {
      if (mask && !mask[i]) continue;

      const field = m1Val * k1[i] + m5Val * k5[i] + calcVal * kc[i];
      if (field < 18) continue; // Repouso sem aquecimento visível

      const norm = Math.min(1.0, field / maxAdc);
      const lutIdx = Math.min(255, Math.floor(norm * 255));
      const li = lutIdx * 3;

      // Curva de opacidade térmica médica suave
      const alpha = Math.min(0.88, Math.pow((norm - 0.02) / 0.98, 0.65) * 0.92);

      const p = i * 4;
      d[p]     = lut[li];
      d[p + 1] = lut[li + 1];
      d[p + 2] = lut[li + 2];
      d[p + 3] = Math.round(alpha * 255);
    }

    this.offCtx.putImageData(imgData, 0, 0);

    // Limpa e projeta suavemente no canvas de exibição (400x600)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(this.offCanvas, 0, 0, this.canvas.width, this.canvas.height);

    // Centro de Pressão (CoP)
    const sum = m1Val + m5Val + calcVal;
    const copEl = document.getElementById('cop-marker');
    if (copEl) {
      if (sum > 40) {
        const copX = ((0.34 * m1Val + 0.66 * m5Val + 0.51 * calcVal) / sum) * 100;
        const copY = ((0.34 * m1Val + 0.39 * m5Val + 0.82 * calcVal) / sum) * 100;
        copEl.style.display = 'block';
        copEl.style.left = `${copX.toFixed(1)}%`;
        copEl.style.top = `${copY.toFixed(1)}%`;
      } else {
        copEl.style.display = 'none';
      }
    }
  }
};

// ── GERENCIADOR DA BARRA DE ALTERNÂNCIA TEMPORAL ─────────────────────────
function initHeatmapToolbar() {
  const pillBtns = document.querySelectorAll('.pill-btn');
  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const windowKey = btn.dataset.window;
      selectHeatmapWindow(windowKey);
    });
  });
}

function selectHeatmapWindow(windowKey) {
  state.heatmapWindow = windowKey;

  // Atualiza botões
  document.querySelectorAll('.pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.window === windowKey);
  });

  const dot = document.getElementById('window-status-dot');
  const label = document.getElementById('window-status-label');
  const meta = document.getElementById('window-status-meta');

  if (windowKey === 'realtime') {
    if (dot) dot.className = 'window-dot-indicator live';
    if (label) label.textContent = 'Modo Ativo: Tempo Real (10.0 Hz)';
    if (meta) meta.textContent = 'Picos dinâmicos instantâneos';

    // Restaura leituras instantâneas atuais
    if (state.lastData) {
      render(state.lastData);
    } else {
      footHeatmap.render(0, 0, 0);
    }
    return;
  }

  // Janelas históricas acumuladas
  if (dot) dot.className = 'window-dot-indicator history';

  const hoursMap = { '1h': 1, '3h': 3, '6h': 6, '8h': 8, '12h': 12 };
  const targetHours = hoursMap[windowKey] || 1;
  const targetMs = targetHours * 3600 * 1000;

  // Coleta amostras reais disponíveis no celular
  const samples = getHistoricalSamplesForWindow(targetMs);

  if (!samples || samples.length === 0) {
    if (label) label.textContent = `Janela ${windowKey}: Nenhuma sessão gravada no celular`;
    if (meta) meta.textContent = 'Conecte a palmilha via BLE para iniciar a gravação automática';
    footHeatmap.render(0, 0, 0);
    return;
  }

  // Computa médias e picos das amostras reais
  let sumM1 = 0, sumM5 = 0, sumCalc = 0;
  let maxM1 = 0, maxM5 = 0, maxCalc = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const m1 = s.m1 ?? 0;
    const m5 = s.m5 ?? 0;
    const calc = s.calc ?? 0;

    sumM1 += m1;
    sumM5 += m5;
    sumCalc += calc;

    if (m1 > maxM1) maxM1 = m1;
    if (m5 > maxM5) maxM5 = m5;
    if (calc > maxCalc) maxCalc = calc;
  }

  const n = samples.length;
  const avgM1 = Math.round(sumM1 / n);
  const avgM5 = Math.round(sumM5 / n);
  const avgCalc = Math.round(sumCalc / n);

  // Renderiza mapa de calor com base nas intensidades médias reais da janela
  footHeatmap.render(avgM1, avgM5, avgCalc);

  // Determina área com maior carga acumulada
  const highest = Math.max(avgM1, avgM5, avgCalc);
  let highestName = 'Equilibrada';
  if (highest === avgCalc) highestName = 'Calcâneo';
  else if (highest === avgM1) highestName = '1º Metatarso (M1)';
  else if (highest === avgM5) highestName = '5º Metatarso (M5)';

  const durationSec = Math.max(1, Math.round(n / 10));
  const durationStr = formatTimer(durationSec * 1000);

  if (label) {
    label.textContent = `Dose Acumulada: ${windowKey} (${n.toLocaleString('pt-BR')} amostras · ${durationStr} gravados)`;
  }
  if (meta) {
    meta.textContent = `Maior sobrecarga: ${highestName} (Média ${highest} ADC | Pico ${Math.max(maxM1, maxM5, maxCalc)} ADC)`;
  }

  // Atualiza as barras de leitura e tooltips
  displayWindowAveragesInReadings({ avgM1, avgM5, avgCalc, maxM1, maxM5, maxCalc });
}

function getHistoricalSamplesForWindow(targetMs) {
  // 1. Reúne todo o acervo de amostras reais registradas no celular
  let pool = [];
  if (rollingHistorySamples && rollingHistorySamples.length > 0) {
    pool = rollingHistorySamples;
  } else if (batteryTrial.samples && batteryTrial.samples.length > 0) {
    pool = batteryTrial.samples;
  }

  if (pool.length > 0) {
    const lastSample = pool[pool.length - 1];
    const lastTime = lastSample.timestamp || (batteryTrial.startTime ? (batteryTrial.startTime + (lastSample.t_ms || 0)) : Date.now());
    const cutoffTime = lastTime - targetMs;

    const filtered = pool.filter(s => {
      const sTime = s.timestamp || (batteryTrial.startTime ? (batteryTrial.startTime + (s.t_ms || 0)) : 0);
      return sTime >= cutoffTime;
    });

    if (filtered.length > 0) {
      return filtered;
    }
    // Se todo o histórico gravado for menor que a janela solicitada (ex: gravou 1h e clicou 12h),
    // retorna todas as amostras reais registradas!
    return pool;
  }

  // Sem registros
  return [];
}

function displayWindowAveragesInReadings({ avgM1, avgM5, avgCalc, maxM1, maxM5, maxCalc }) {
  const zones = [
    { id: 'm1', avg: avgM1, max: maxM1, label: '1º Metatarso' },
    { id: 'm5', avg: avgM5, max: maxM5, label: '5º Metatarso' },
    { id: 'calc', avg: avgCalc, max: maxCalc, label: 'Calcâneo' }
  ];

  zones.forEach(z => {
    const pct = Math.min(100, Math.round((z.avg / 650) * 100));
    const badge = document.getElementById(`val-badge-${z.id}`);
    const meter = document.getElementById(`meter-${z.id}`);
    const intensity = document.getElementById(`intensity-${z.id}`);
    const tooltip = document.getElementById(`tip-${z.id}`);

    if (badge) {
      badge.innerHTML = `Média: ${z.avg} ADC <span style="font-size:0.75rem; font-weight:normal; opacity:0.8;">(Pico: ${z.max})</span>`;
    }
    if (meter) {
      meter.style.width = `${pct}%`;
      meter.className = `meter-bar-fill fill-${pct > 65 ? 'danger' : (pct > 35 ? 'warn' : 'ok')}`;
    }
    if (intensity) {
      intensity.textContent = `Dose média acumulada (~${pct}%)`;
    }
    if (tooltip) {
      tooltip.textContent = `Média: ${z.avg} ADC · Pico: ${z.max} ADC`;
    }
  });
}

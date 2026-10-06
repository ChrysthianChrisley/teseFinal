/* ==========================================================================
   Monitor Plantar Inteligente — Lógica da Aplicação (app.js)
   Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)
   Comunicação BLE (Web Bluetooth) + Cabo USB (Web Serial) + Modo Simulação
   ========================================================================== */

'use strict';

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
  autoTaredOnce: false
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

function onBleDataReceived(event) {
  try {
    const rawString = new TextDecoder('utf-8').decode(event.target.value);
    const parsed = JSON.parse(rawString);

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
    label.textContent = 'BLE Conectado';
    btnBle.classList.add('active-connected');
    btnBleText.textContent = 'Desconectar BLE';

    // Assim que a conexão for estabelecida, oculta a mensagem de espera inicial
    const card = document.getElementById('card-hero-status');
    if (card) card.style.display = 'none';
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
  }
}

function onDeviceDisconnected() {
  setConnectionState('none', false);
  recordAlertEvent('warn', 'Dispositivo BLE desconectado.');

  // Se o ensaio de autonomia da bateria estava ativo, o desligamento do ESP32 indica esgotamento da bateria!
  if (batteryTrial.isRecording) {
    finishBatteryTrialDueToDischarge();
  }
}

async function disconnectAll() {
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
  renderInitialState();
  await initBatteryTrial();
});

// ==========================================================================
// ENSAIO DE AUTONOMIA DA BATERIA & GRAVAÇÃO LOCAL NO CELULAR (MESTRADO PPGTS)
// Armazenamento resiliente na memória local (IndexedDB + Cache localStorage)
// Exportação direta em CSV, envio por e-mail e compartilhamento nativo móvel
// ==========================================================================

const batteryTrial = {
  isRecording: false,
  isFinished: false,
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
  metaKey: 'palmilha_battery_trial_meta_v1'
};

// ── BANCO DE DADOS INDEXEDDB LOCAL DO CELULAR ─────────────────────────────
function openBatteryDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB não suportado neste navegador. Usando localStorage.');
      resolve(null);
      return;
    }
    const request = indexedDB.open('InsoleBatteryDB', 1);
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
  const meta = {
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
    } catch (e) {
      console.warn('Erro ao gravar no IndexedDB:', e);
    }
  } else {
    // Fallback: se não tiver IndexedDB, tenta salvar até 10.000 amostras no localStorage
    try {
      if (batteryTrial.samples.length <= 10000) {
        localStorage.setItem(batteryTrial.storageKey, JSON.stringify(batteryTrial.samples));
      }
    } catch (e) {}
  }
}

async function restorePreviousBatterySession() {
  try {
    const metaStr = localStorage.getItem(batteryTrial.metaKey);
    if (!metaStr) return;
    const meta = JSON.parse(metaStr);
    if (!meta || !meta.sampleCount) return;

    batteryTrial.startTime = meta.startTime;
    batteryTrial.endTime = meta.endTime;
    batteryTrial.isFinished = meta.isFinished ?? true;
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
        }
        updateBatteryTrialUI();
      };
      req.onerror = () => updateBatteryTrialUI();
    } else {
      const cached = localStorage.getItem(batteryTrial.storageKey);
      if (cached) {
        batteryTrial.samples = JSON.parse(cached);
      }
      updateBatteryTrialUI();
    }
  } catch (err) {
    console.warn('Erro ao restaurar sessão anterior:', err);
  }
}

// ── GESTÃO DO SCREEN WAKE LOCK (TELA SEMPRE ACESA NO CELULAR) ──────────────
async function requestWakeLock() {
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

// ── REGISTRO DE CADA AMOSTRA RECEBIDA ──────────────────────────────────────
function recordBatterySample(data) {
  if (!batteryTrial.isRecording) return;

  const now = Date.now();
  const elapsedMs = batteryTrial.startTime ? (now - batteryTrial.startTime) : 0;

  const m1 = Math.round(data.meta1 ?? 0);
  const m5 = Math.round(data.meta5 ?? 0);
  const calc = Math.round(data.calcaneo ?? 0);

  const sample = {
    t_ms: elapsedMs,
    seq: data.seq ?? (batteryTrial.samples.length + 1),
    calc: calc,
    m1: m1,
    m5: m5,
    temp: (data.temp != null && !isNaN(data.temp)) ? Number(data.temp).toFixed(1) : '',
    umid: (data.umid != null && !isNaN(data.umid)) ? Number(data.umid).toFixed(1) : '',
    timeStr: new Date().toLocaleTimeString('pt-BR')
  };

  batteryTrial.samples.push(sample);
  batteryTrial.lastSeq = sample.seq;
  batteryTrial.lastTimestamp = sample.timeStr;

  if (m1 > batteryTrial.peakM1) batteryTrial.peakM1 = m1;
  if (m5 > batteryTrial.peakM5) batteryTrial.peakM5 = m5;
  if (calc > batteryTrial.peakCalc) batteryTrial.peakCalc = calc;

  // Persiste a cada 50 amostras (~5 segundos a 10 Hz) no armazenamento do telefone
  if (batteryTrial.samples.length % 50 === 0) {
    persistBatteryData();
  }

  // Atualização em tempo real das métricas da barra
  updateBatteryTrialLiveMetrics();
}

function updateBatteryTrialLiveMetrics() {
  const countEl = document.getElementById('battery-samples-count');
  const rateEl = document.getElementById('battery-rate-hz');
  const sizeEl = document.getElementById('battery-storage-size');
  const peaksEl = document.getElementById('battery-peaks-summary');
  const lastSeqEl = document.getElementById('battery-last-seq');

  const total = batteryTrial.samples.length;
  if (countEl) countEl.textContent = total.toLocaleString('pt-BR');

  // Cálculo da frequência instantânea média em Hz
  if (batteryTrial.startTime) {
    const elapsedSec = Math.max(1, (Date.now() - batteryTrial.startTime) / 1000);
    const hz = (total / elapsedSec).toFixed(1);
    if (rateEl) rateEl.textContent = `${hz} Hz`;
  }

  // Estimativa do tamanho de memória ocupada no celular
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

// ── INÍCIO, PARADA E FINALIZAÇÃO DO ENSAIO ─────────────────────────────────
async function startBatteryTrial() {
  if (!state.isConnected) {
    const proceed = confirm('A palmilha ainda não está conectada via BLE. Deseja iniciar o cronômetro do ensaio agora mesmo?');
    if (!proceed) return;
  }

  batteryTrial.isRecording = true;
  batteryTrial.isFinished = false;
  batteryTrial.startTime = Date.now();
  batteryTrial.endTime = null;
  batteryTrial.samples = [];
  batteryTrial.peakM1 = 0;
  batteryTrial.peakM5 = 0;
  batteryTrial.peakCalc = 0;
  batteryTrial.lastSeq = null;

  // Limpa alerta anterior
  const banner = document.getElementById('battery-alert-banner');
  if (banner) banner.style.display = 'none';

  // Aciona tela sempre ativa (Wake Lock) no celular
  await requestWakeLock();

  // Inicia tick do cronômetro a cada 1 segundo
  if (batteryTrial.timerInterval) clearInterval(batteryTrial.timerInterval);
  batteryTrial.timerInterval = setInterval(() => {
    updateBatteryTimerDisplay();
  }, 1000);

  persistBatteryData();
  updateBatteryTrialUI();

  recordAlertEvent('ok', 'Ensaio de autonomia da bateria iniciado! Gravando dados...');
}

function stopBatteryTrialManual() {
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
  updateBatteryTrialUI();

  recordAlertEvent('warn', 'Ensaio de bateria interrompido manualmente pelo usuário.');
}

// QUANDO O ESP32 DESLIGA POR FALTA DE BATERIA (EVENTO GATTSERVERDISCONNECTED)
function finishBatteryTrialDueToDischarge() {
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
  updateBatteryTrialUI();

  // Vibração de alerta no celular (se suportado pelo hardware móvel)
  if (navigator.vibrate) {
    try { navigator.vibrate([300, 150, 300, 150, 600]); } catch (e) {}
  }

  // Exibe banner especial de ensaio concluído por esgotamento de bateria
  const banner = document.getElementById('battery-alert-banner');
  const alertTitle = document.getElementById('battery-alert-title');
  const alertDesc = document.getElementById('battery-alert-desc');
  const summary = getBatteryTrialSummary();

  if (banner && alertTitle && alertDesc) {
    banner.style.display = 'flex';
    alertTitle.textContent = `🔋 Bateria Esgotada! Autonomia Total: ${summary.formattedDuration}`;
    alertDesc.textContent = `O ESP32 desconectou por corte de tensão da bateria. Foram gravadas ${summary.totalSamples.toLocaleString('pt-BR')} amostras com segurança no armazenamento local deste telefone (${summary.avgHz} Hz). Baixe o CSV ou envie por e-mail abaixo.`;
  }

  recordAlertEvent('danger', `Ensaio de bateria concluído! Autonomia comprovada: ${summary.formattedDuration}.`);
}

function clearBatterySession() {
  if (batteryTrial.isRecording) {
    if (!confirm('O teste de bateria está em andamento. Deseja realmente interromper e limpar os dados?')) {
      return;
    }
    stopBatteryTrialManual();
  } else if (batteryTrial.samples.length > 0) {
    if (!confirm('Deseja realmente apagar os dados deste ensaio? Certifique-se de ter baixado o CSV antes.')) {
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
      tx.objectStore('sessions').clear();
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

  // Botões de exportação habilitados se houver amostras salvas
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
      badgeStatus.textContent = '🔴 Gravando (Bateria em uso)';
    }
    if (btnToggle) {
      btnToggle.classList.add('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Parar Gravação';
    }
  } else if (batteryTrial.isFinished && hasSamples) {
    if (card) {
      card.classList.remove('is-recording');
      card.classList.add('is-finished');
    }
    if (badgeStatus) {
      badgeStatus.className = 'badge-battery-status status-finished';
      badgeStatus.textContent = '🔋 Bateria Esgotada / Concluído';
    }
    if (btnToggle) {
      btnToggle.classList.remove('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Iniciar Novo Teste';
    }
  } else {
    if (card) {
      card.classList.remove('is-recording');
      card.classList.remove('is-finished');
    }
    if (badgeStatus) {
      badgeStatus.className = 'badge-battery-status status-idle';
      badgeStatus.textContent = '⚪ Pronto para Iniciar';
    }
    if (btnToggle) {
      btnToggle.classList.remove('is-recording');
    }
    if (btnToggleText) {
      btnToggleText.textContent = 'Iniciar Teste de Bateria';
    }
  }
}

// ── ESTATÍSTICAS E RESUMO DO ENSAIO ───────────────────────────────────────
function getBatteryTrialSummary() {
  const total = batteryTrial.samples.length;
  const start = batteryTrial.startTime ? new Date(batteryTrial.startTime) : new Date();
  const end = batteryTrial.endTime ? new Date(batteryTrial.endTime) : new Date();
  const elapsedMs = Math.max(0, end.getTime() - start.getTime());
  const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
  const hz = total > 0 ? (total / elapsedSec).toFixed(1) : '0.0';

  const d = start;
  const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '') + '_' + 
                  String(d.getHours()).padStart(2, '0') + 
                  String(d.getMinutes()).padStart(2, '0');
  const filename = `ensaio_bateria_palmilha_${dateStr}.csv`;

  return {
    startedAt: start.toLocaleString('pt-BR'),
    endedAt: end.toLocaleString('pt-BR'),
    durationSeconds: elapsedSec,
    formattedDuration: formatTimer(elapsedMs),
    totalSamples: total,
    avgHz: hz,
    peakM1: batteryTrial.peakM1,
    peakM5: batteryTrial.peakM5,
    peakCalc: batteryTrial.peakCalc,
    statusText: batteryTrial.isFinished ? 'Finalizado (Esgotamento da Bateria)' : 'Em andamento',
    filename: filename
  };
}

// ── GERAÇÃO DO ARQUIVO CSV PADRÃO CIENTÍFICO ──────────────────────────────
function generateCsvContent() {
  const meta = getBatteryTrialSummary();
  let csv = `# ====================================================================\n`;
  csv += `# ENSAIO DE AUTONOMIA DA BATERIA - PALMILHA INSTRUMENTADA (UERJ)\n`;
  csv += `# Projeto: Monitor Plantar Preventivo de Úlceras no Pé Diabético\n`;
  csv += `# Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)\n`;
  csv += `# Data e Hora de Início: ${meta.startedAt}\n`;
  csv += `# Data e Hora de Término: ${meta.endedAt}\n`;
  csv += `# Autonomia Total Comprovada: ${meta.formattedDuration} (${meta.durationSeconds} segundos)\n`;
  csv += `# Total de Amostras Gravadas no Celular: ${meta.totalSamples}\n`;
  csv += `# Frequência Média de Transmissão BLE: ${meta.avgHz} Hz\n`;
  csv += `# Carga Máxima (M1 - 1º Metatarso): ${meta.peakM1} ADC\n`;
  csv += `# Carga Máxima (M5 - 5º Metatarso): ${meta.peakM5} ADC\n`;
  csv += `# Carga Máxima (Calcâneo): ${meta.peakCalc} ADC\n`;
  csv += `# ====================================================================\n`;
  csv += `t_ms,dt_ms,seq,timestamp_local,m1_adc,m5_adc,calcaneo_adc,temp_c,umid_pct\n`;

  let prevTime = 0;
  for (let i = 0; i < batteryTrial.samples.length; i++) {
    const s = batteryTrial.samples[i];
    const dt = (i === 0) ? 0 : (s.t_ms - prevTime);
    prevTime = s.t_ms;
    csv += `${s.t_ms},${dt},${s.seq},"${s.timeStr}",${s.m1},${s.m5},${s.calc},${s.temp},${s.umid}\n`;
  }
  return csv;
}

// ── 1. BAIXAR ARQUIVO CSV NO CELULAR (DOWNLOAD DIRETO) ────────────────────
function downloadBatteryCsv() {
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

// ── 2. COMPARTILHAR DADOS VIA WEB SHARE (WHATSAPP, DRIVE, ARQUIVO) ────────
async function shareBatteryData() {
  if (batteryTrial.samples.length === 0) {
    alert('Nenhum dado registrado para compartilhar.');
    return;
  }

  const summary = getBatteryTrialSummary();
  const csv = generateCsvContent();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const file = new File([blob], summary.filename, { type: 'text/csv' });

  const shareText = `Ensaio de Autonomia da Bateria - Palmilha Inteligente (UERJ)\n` +
                    `Autonomia: ${summary.formattedDuration}\n` +
                    `Amostras: ${summary.totalSamples.toLocaleString('pt-BR')} (${summary.avgHz} Hz)\n` +
                    `Picos: M1=${summary.peakM1} | M5=${summary.peakM5} | Calc=${summary.peakCalc} ADC`;

  // Se o navegador móvel suporta compartilhamento direto de arquivos (Android Chrome / iOS Safari)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        title: 'Ensaio de Bateria - Palmilha Inteligente',
        text: shareText,
        files: [file]
      });
      return;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('Erro ao compartilhar via Web Share:', err);
      } else {
        return; // Usuário fechou gaveta de compartilhamento
      }
    }
  }

  // Fallback: compartilha resumo em texto e dispara download do CSV
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Ensaio de Bateria - Palmilha Inteligente',
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

  // Fallback padrão para navegadores desktop
  downloadBatteryCsv();
}

// ── 3. ENVIAR POR E-MAIL COM RELATÓRIO EXECUTIVO COMPLETO ─────────────────
function sendBatteryEmail() {
  if (batteryTrial.samples.length === 0) {
    alert('Nenhum dado registrado para enviar por e-mail.');
    return;
  }

  const summary = getBatteryTrialSummary();

  // Garante que o arquivo CSV completo seja baixado na pasta Downloads do celular
  downloadBatteryCsv();

  const subject = encodeURIComponent(`[Palmilha UERJ] Relatório de Teste de Bateria - Autonomia: ${summary.formattedDuration}`);
  const bodyText = `RELATÓRIO DE ENSAIO DE AUTONOMIA DA BATERIA
Projeto: Palmilha Instrumentada para Monitoramento e Prevenção do Pé Diabético
Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)

--------------------------------------------------
RESUMO EXECUTIVO DO ENSAIO
--------------------------------------------------
• Status: ${summary.statusText}
• Início do Teste: ${summary.startedAt}
• Término / Desligamento: ${summary.endedAt}
• Autonomia Total da Bateria: ${summary.formattedDuration} (${summary.durationSeconds} segundos)
• Total de Amostras Coletadas: ${summary.totalSamples.toLocaleString('pt-BR')}
• Frequência Média de Transmissão: ${summary.avgHz} Hz
• Carga Máxima (M1 - 1º Metatarso): ${summary.peakM1} ADC
• Carga Máxima (M5 - 5º Metatarso): ${summary.peakM5} ADC
• Carga Máxima (Calcâneo): ${summary.peakCalc} ADC

--------------------------------------------------
DADOS BRUTOS EM CSV
--------------------------------------------------
O arquivo completo de telemetria ("${summary.filename}") com todas as ${summary.totalSamples.toLocaleString('pt-BR')} amostras foi baixado com sucesso na pasta de Downloads deste celular.
Para incluir no banco de dados da dissertação ou gerar gráficos de descarga, anexe o arquivo baixado a este e-mail.

Dispositivo: ESP32 BLE (Palmilha_v5.0)
Gerado automaticamente pelo aplicativo Monitor Plantar Inteligente.`;

  const body = encodeURIComponent(bodyText);
  window.location.href = `mailto:?subject=${subject}&body=${body}`;
}

// ── INICIALIZAÇÃO DOS BOTÕES E EVENTOS DO TESTE DE BATERIA ────────────────
async function initBatteryTrial() {
  await openBatteryDB();
  await restorePreviousBatterySession();

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

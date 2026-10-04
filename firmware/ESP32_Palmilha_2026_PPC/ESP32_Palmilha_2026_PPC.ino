/*
  Palmilha Instrumentada - Monitoramento Plantar Preventivo (2026)
  Mestrado Profissional em Telessaude e Saude Digital (PPGTS / UERJ)
  
  Mapeamento de Hardware Atualizado:
    - Calcaneo (FSR1): GPIO 36 (Sensor VP) -> Pino 2 do conector de 8 vias
    - 1º Metatarso / M1 (FSR2): GPIO 33   -> Pino 4 do conector de 8 vias
    - 5º Metatarso / M5 (FSR3): GPIO 39 (Sensor VN) -> Pino 3 conectado no Pino 4
    - Sensor AHT10: REMOVIDO do circuito fisico.
    - LED Status / Bateria: GPIO 5 (Heartbeat quando desconectado; fixo ao conectar BLE)
    - ADC: Canais 36, 33 e 39 pertencem ao ADC1 (100% compativel com RF BLE)
    - Compensacao PGA Digital: Ganho configuravel por canal para calibracao com pesos padrao.
*/

#include <Arduino.h>
#include <math.h>

#ifndef HABILITAR_BLE
#define HABILITAR_BLE 1
#endif

#if HABILITAR_BLE
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

BLEServer *servidorBLE = nullptr;
BLECharacteristic *caracteristicaBLE = nullptr;
const char *UUID_SERVICO = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const char *UUID_DADOS   = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
uint32_t ultimoAvisoMTU  = 0;
#endif

// ── MAPEAMENTO DOS PINOS FSR (TODOS NO ADC1) ─────────────────────────────────
// [0]=Calcaneo (VP/GPIO 36), [1]=M1 (GPIO 33), [2]=M5 (VN/GPIO 39)
const uint8_t PINOS_FSR[3] = {36, 33, 39};

// ── FATORES DE CALIBRACAO E GANHO (PGA DIGITAL) ─────────────────────────────
// Permite equiparar a resposta dos 3 sensores com o mesmo peso de teste.
// [0] = Calcaneo (GPIO 36) | [1] = M1 (GPIO 33) | [2] = M5 (GPIO 39)
float GANHOS_FSR[3] = {10.0f, 1.0f, 1.0f};

// ── INDICADOR DE STATUS / ALIMENTACAO (BATERIA) ──────────────────────────────
const uint8_t PINO_LED_STATUS = 5; // LED onboard LOLIN32 V1.0.0 (GPIO 5) / ou externo
const uint8_t LED_ON  = LOW;       // Ativo em LOW na LOLIN32 (ou HIGH p/ LED externo com resistor ao GND)
const uint8_t LED_OFF = HIGH;

// ── PARAMETROS DO FILTRO E AMOSTRAGEM ────────────────────────────────────────
const uint8_t NUM_AMOSTRAS = 10;
const uint32_t PERIODO_FSR_MS = 100;

int adcBruto[3]       = {0, 0, 0};
int adcMedia[3]       = {0, 0, 0};
uint32_t milivolts[3] = {0, 0, 0};
int historico[3][NUM_AMOSTRAS] = {};
uint32_t somas[3]     = {0, 0, 0};
uint8_t indiceFiltro  = 0;
uint8_t quantidadeFiltro = 0;
uint32_t ultimaAmostra = 0;
uint32_t sequencia    = 0;

// ── CALIBRACAO AUTOMATICA NO BOOT (TARA DE REPOUSO) ──────────────────────────
int adcTara[3]        = {0, 0, 0};
int adcLiquido[3]     = {0, 0, 0};
bool taraConcluida    = false;

void atualizarLedStatus() {
  static uint32_t ultimoPisca = 0;
  static bool ligado = false;
  uint32_t agora = millis();

#if HABILITAR_BLE
  bool conectado = (servidorBLE && servidorBLE->getConnectedCount() > 0);
  if (conectado) {
    digitalWrite(PINO_LED_STATUS, LED_ON); // Conectado via BLE: aceso fixo
    return;
  }
#endif

  // Desconectado (ligado na bateria e aguardando conexao BLE):
  // Heartbeat intermitente: 100ms aceso a cada 1s (indica ligado economizando bateria)
  uint32_t intervalo = ligado ? 100 : 900;
  if (uint32_t(agora - ultimoPisca) >= intervalo) {
    ultimoPisca = agora;
    ligado = !ligado;
    digitalWrite(PINO_LED_STATUS, ligado ? LED_ON : LED_OFF);
  }
}

void lerFSRs() {
  if (quantidadeFiltro < NUM_AMOSTRAS) ++quantidadeFiltro;
  for (uint8_t i = 0; i < 3; ++i) {
    adcBruto[i] = analogRead(PINOS_FSR[i]);
    milivolts[i] = analogReadMilliVolts(PINOS_FSR[i]);
    
    // Filtro de media movel (10 amostras)
    somas[i] -= historico[i][indiceFiltro];
    historico[i][indiceFiltro] = adcBruto[i];
    somas[i] += adcBruto[i];
    adcMedia[i] = somas[i] / quantidadeFiltro;

    // Calculo do sinal liquido com desconto da pre-carga/repouso e ganho PGA
    if (taraConcluida) {
      int liq = adcMedia[i] - adcTara[i];
      if (liq < 0) liq = 0;
      
      // Aplica o fator de calibracao / equiparacao
      float liqEscalado = (float)liq * GANHOS_FSR[i];
      adcLiquido[i] = (int)constrain(liqEscalado, 0.0f, 4095.0f);
    } else {
      adcLiquido[i] = adcMedia[i];
    }
  }
  indiceFiltro = (indiceFiltro + 1) % NUM_AMOSTRAS;
}

void imprimirCSV(uint32_t agora, uint32_t intervalo) {
  Serial.print(agora);
  Serial.print(',');
  Serial.print(intervalo);
  Serial.print(',');
  Serial.print(sequencia);
  for (uint8_t i = 0; i < 3; ++i) {
    Serial.print(','); Serial.print(adcBruto[i]);
    Serial.print(','); Serial.print(adcMedia[i]);
    Serial.print(','); Serial.print(adcLiquido[i]);
    Serial.print(','); Serial.print(milivolts[i]);
  }
  Serial.println();
}

#if HABILITAR_BLE
void inicializarBLE() {
  BLEDevice::init("Palmilha_v5.0");
  BLEDevice::setMTU(185);
  servidorBLE = BLEDevice::createServer();
  servidorBLE->advertiseOnDisconnect(true);

  BLEService *servico = servidorBLE->createService(UUID_SERVICO);
  caracteristicaBLE = servico->createCharacteristic(
      UUID_DADOS, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  caracteristicaBLE->addDescriptor(new BLE2902());
  servico->start();

  BLEAdvertising *anuncio = BLEDevice::getAdvertising();
  anuncio->addServiceUUID(UUID_SERVICO);
  anuncio->setScanResponse(true);
  anuncio->setMinPreferred(0x06);
  anuncio->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

void publicarBLE(uint32_t agora) {
  String pacote = "{\"calcaneo\":" + String(adcLiquido[0]) +
                  ",\"meta1\":" + String(adcLiquido[1]) +
                  ",\"meta5\":" + String(adcLiquido[2]) +
                  ",\"calc_raw\":" + String(adcMedia[0]) +
                  ",\"tara_calc\":" + String(adcTara[0]) +
                  ",\"temp\":null,\"umid\":null" +
                  ",\"seq\":" + String(sequencia) + ",\"t_ms\":" + String(agora) + "}";

  caracteristicaBLE->setValue(pacote.c_str());
  if (servidorBLE->getConnectedCount() != 1) return;
  uint16_t mtu = servidorBLE->getPeerMTU(servidorBLE->getConnId());
  if (mtu < 3 || pacote.length() > size_t(mtu - 3)) {
    if (uint32_t(agora - ultimoAvisoMTU) >= 5000) {
      Serial.println("# BLE: MTU do cliente insuficiente; notificacao nao enviada.");
      ultimoAvisoMTU = agora;
    }
    return;
  }
  caracteristicaBLE->notify();
}
#endif

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("# =========================================================");
  Serial.println("# Palmilha Instrumentada - Calibracao & Equiparacao 2026");
  Serial.println("# Mapeamento FSR:");
  Serial.println("#   - Calcaneo: GPIO 36 (VP)  -> Atenuacao: ADC_0db (Alta Sensibilidade)");
  Serial.println("#   - M1:       GPIO 33       -> Atenuacao: ADC_11db");
  Serial.println("#   - M5:       GPIO 39 (VN)  -> Atenuacao: ADC_11db");
  Serial.print("# Ganhos de Calibracao: Calcaneo=");
  Serial.print(GANHOS_FSR[0], 1);
  Serial.print("x | M1=");
  Serial.print(GANHOS_FSR[1], 1);
  Serial.print("x | M5=");
  Serial.print(GANHOS_FSR[2], 1);
  Serial.println("x");
  Serial.println("# =========================================================");

  analogReadResolution(12);

  // Calcaneo (GPIO 36): Atenuacao 0 dB (escala 0-1.1V) para amplificar sinais fracos
  pinMode(PINOS_FSR[0], INPUT);
  analogSetPinAttenuation(PINOS_FSR[0], ADC_0db);

  // M1 (GPIO 33): Atenuacao 11 dB (escala normal 0-3.3V)
  pinMode(PINOS_FSR[1], INPUT);
  analogSetPinAttenuation(PINOS_FSR[1], ADC_11db);

  // M5 (GPIO 39): Atenuacao 11 dB (escala normal 0-3.3V)
  pinMode(PINOS_FSR[2], INPUT);
  analogSetPinAttenuation(PINOS_FSR[2], ADC_11db);

  // Inicializa LED indicador de bateria
  pinMode(PINO_LED_STATUS, OUTPUT);
  digitalWrite(PINO_LED_STATUS, LED_ON);

  // Calibracao automatica de repouso (tara)
  Serial.println("# [BOOT] Calibrando tara automatica de repouso... Palmilha descarregada.");
  delay(300);
  for (int amostra = 0; amostra < 30; ++amostra) {
    lerFSRs();
    delay(25);
  }
  for (uint8_t i = 0; i < 3; ++i) {
    adcTara[i] = adcMedia[i];
  }
  taraConcluida = true;
  Serial.print("# [BOOT CALIBRADO] Linha de base -> Calcaneo: ");
  Serial.print(adcTara[0]);
  Serial.print(" ADC | M1: ");
  Serial.print(adcTara[1]);
  Serial.print(" ADC | M5: ");
  Serial.print(adcTara[2]);
  Serial.println(" ADC");

#if HABILITAR_BLE
  inicializarBLE();
  Serial.println("# BLE pronto: Palmilha_v5.0 aguardando conexao...");
#else
  Serial.println("# Modo Serial ativado (BLE desabilitado).");
#endif

  ultimaAmostra = millis();
  Serial.println("t_ms,dt_ms,seq,calc_raw,calc_media,calc_liq,calc_mV,m1_raw,m1_media,m1_liq,m1_mV,m5_raw,m5_media,m5_liq,m5_mV");
}

void loop() {
  atualizarLedStatus();

  uint32_t agora = millis();
  uint32_t intervalo = uint32_t(agora - ultimaAmostra);
  if (intervalo >= PERIODO_FSR_MS) {
    ultimaAmostra = agora;
    ++sequencia;
    lerFSRs();
    imprimirCSV(agora, intervalo);
#if HABILITAR_BLE
    publicarBLE(agora);
#endif
  }
  delay(1);
}

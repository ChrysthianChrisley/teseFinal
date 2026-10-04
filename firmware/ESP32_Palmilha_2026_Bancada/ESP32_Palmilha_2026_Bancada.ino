/*
  Palmilha Instrumentada - Monitoramento Plantar Preventivo (2026)
  Mestrado Profissional em Telessaude e Saude Digital (PPGTS / UERJ)
  
  Mapeamento de Hardware:
    - Calcaneo (FSR1): GPIO 36 (Sensor VP) -> Atenuacao ADC_0db
    - 1º Metatarso / M1 (FSR2): GPIO 33   -> Atenuacao ADC_11db
    - 5º Metatarso / M5 (FSR3): GPIO 39 (Sensor VN) -> Atenuacao ADC_11db
    - Saida Serial amigavel a cada 500ms para facilitar a leitura humana.
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
const uint8_t PINOS_FSR[3] = {36, 33, 39};

// ── FATORES DE CALIBRACAO E GANHO (PGA DIGITAL) ─────────────────────────────
float GANHOS_FSR[3] = {10.0f, 1.0f, 1.0f};

// ── INDICADOR DE STATUS / ALIMENTACAO (BATERIA) ──────────────────────────────
const uint8_t PINO_LED_STATUS = 5;
const uint8_t LED_ON  = LOW;
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
    digitalWrite(PINO_LED_STATUS, LED_ON);
    return;
  }
#endif

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
    
    somas[i] -= historico[i][indiceFiltro];
    historico[i][indiceFiltro] = adcBruto[i];
    somas[i] += adcBruto[i];
    adcMedia[i] = somas[i] / quantidadeFiltro;

    if (taraConcluida) {
      int liq = adcMedia[i] - adcTara[i];
      if (liq < 0) liq = 0;
      
      float liqEscalado = (float)liq * GANHOS_FSR[i];
      adcLiquido[i] = (int)constrain(liqEscalado, 0.0f, 4095.0f);
    } else {
      adcLiquido[i] = adcMedia[i];
    }
  }
  indiceFiltro = (indiceFiltro + 1) % NUM_AMOSTRAS;
}

// Imprime formato legivel e calmo a cada 500ms para facilitar a visao humana
void imprimirSerialAmigavel() {
  Serial.print("[PAINEL] CALCANEO -> Liq: ");
  Serial.print(adcLiquido[0]);
  Serial.print(" | Bruto: ");
  Serial.print(adcMedia[0]);
  Serial.print(" | Tara: ");
  Serial.print(adcTara[0]);

  Serial.print("  ||  M1 -> Liq: ");
  Serial.print(adcLiquido[1]);
  Serial.print(" (Bruto: ");
  Serial.print(adcMedia[1]);
  Serial.print(")");

  Serial.print("  ||  M5 -> Liq: ");
  Serial.print(adcLiquido[2]);
  Serial.print(" (Bruto: ");
  Serial.print(adcMedia[2]);
  Serial.println(")");
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
  if (mtu < 3 || pacote.length() > size_t(mtu - 3)) return;
  caracteristicaBLE->notify();
}
#endif

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n# =========================================================");
  Serial.println("# Monitor Plantar 2026 - Modo Visual Amigavel");
  Serial.println("# A impressao abaixo ocorre 2x por segundo para facil leitura");
  Serial.println("# =========================================================");

  analogReadResolution(12);

  pinMode(PINOS_FSR[0], INPUT);
  analogSetPinAttenuation(PINOS_FSR[0], ADC_0db);

  pinMode(PINOS_FSR[1], INPUT);
  analogSetPinAttenuation(PINOS_FSR[1], ADC_11db);

  pinMode(PINOS_FSR[2], INPUT);
  analogSetPinAttenuation(PINOS_FSR[2], ADC_11db);

  pinMode(PINO_LED_STATUS, OUTPUT);
  digitalWrite(PINO_LED_STATUS, LED_ON);

  Serial.println("# [BOOT] Calibrando tara em repouso... Mantenha a palmilha descarregada.");
  delay(300);
  for (int amostra = 0; amostra < 30; ++amostra) {
    lerFSRs();
    delay(25);
  }
  for (uint8_t i = 0; i < 3; ++i) {
    adcTara[i] = adcMedia[i];
  }
  taraConcluida = true;
  Serial.print("# [BOOT CONCLUIDO] Taras iniciais -> Calc: ");
  Serial.print(adcTara[0]);
  Serial.print(" | M1: ");
  Serial.print(adcTara[1]);
  Serial.print(" | M5: ");
  Serial.print(adcTara[2]);
  Serial.println("\n");

#if HABILITAR_BLE
  inicializarBLE();
#endif

  ultimaAmostra = millis();
}

void loop() {
  atualizarLedStatus();

  uint32_t agora = millis();
  uint32_t intervalo = uint32_t(agora - ultimaAmostra);
  if (intervalo >= PERIODO_FSR_MS) {
    ultimaAmostra = agora;
    ++sequencia;
    lerFSRs();
#if HABILITAR_BLE
    publicarBLE(agora);
#endif

    // Imprime na Serial com calma a cada 500 ms (2 linhas por segundo)
    static uint32_t ultimoPrint = 0;
    if (uint32_t(agora - ultimoPrint) >= 500) {
      ultimoPrint = agora;
      imprimirSerialAmigavel();
    }
  }
  delay(1);
}

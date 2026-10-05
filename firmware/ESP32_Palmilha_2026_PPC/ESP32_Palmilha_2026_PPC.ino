/*
  Palmilha - bancada eletrica, 04/10/2026.
  Hardware: LOLIN32 V1.0.0.
  
  Mapeamento de Pinos FSR (ADC1):
    - Calcaneo (FSR1): GPIO 36 (Sensor VP) -> ADC1_CH0
    - M1 (1º Metatarso, FSR2): GPIO 33    -> ADC1_CH5
    - M5 (5º Metatarso, FSR3): GPIO 39 (Sensor VN) -> ADC1_CH3
    
  Equiparacao dos Sensores (Regra de 3 com base nas medidas reais de bancada):
    - Medidas de referencia (mesma pressao manual):
        * Calcaneo (novo): 80 a 90  -> Media = 85 ADC
        * M1:              400 a 500 -> Media = 450 ADC
        * M5:              600 a 700 -> Media = 650 ADC (Referencia base)
    - Fatores de Ganho Calculados (Alvo = 650):
        * Calcaneo: 650 / 85  = 7.647x
        * M1:       650 / 450 = 1.444x
        * M5:       650 / 650 = 1.000x
        
    - Sensores de temperatura e umidade removidos conforme solicitado.
    - LED Status: GPIO 5 (Heartbeat quando desconectado; Aceso fixo quando conectado via BLE).
    - BLE v5.0 ativo (JSON compativel com a interface web).
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

// ── MAPEAMENTO DOS PINOS FSR (Calcaneo=36, M1=33, M5=39) ────────────────────
const uint8_t PINOS_FSR[3] = {36, 33, 39}; // [0]=Calcaneo, [1]=M1, [2]=M5

// ── FATORES DE EQUIPARACAO (REGRA DE 3) ──────────────────────────────────────
// Alvo de normalizacao = M5 (~650 ADC)
const float FATORES_EQUIPARACAO[3] = {
  7.647f, // Calcaneo: 650 / 85  = 7.647x
  1.444f, // M1:       650 / 450 = 1.444x
  1.000f  // M5:       650 / 650 = 1.000x (base)
};

// ── INDICADOR DE STATUS / ALIMENTACAO (BATERIA) ──────────────────────────────
const uint8_t PINO_LED_STATUS = 5; // LED onboard LOLIN32 V1.0.0 (GPIO 5)
const uint8_t LED_ON  = LOW;       // LOLIN32 ativo em LOW
const uint8_t LED_OFF = HIGH;

// ── PARAMETROS DO FILTRO E AMOSTRAGEM ────────────────────────────────────────
const uint8_t NUM_AMOSTRAS = 10;
const uint32_t PERIODO_FSR_MS = 100;

int adcBruto[3]       = {0, 0, 0};
int adcMedia[3]       = {0, 0, 0};
int adcEquiparado[3]  = {0, 0, 0};
uint32_t milivolts[3] = {0, 0, 0};
int historico[3][NUM_AMOSTRAS] = {};
uint32_t somas[3]     = {0, 0, 0};
uint8_t indiceFiltro  = 0;
uint8_t quantidadeFiltro = 0;
uint32_t ultimaAmostra = 0;
uint32_t sequencia    = 0;

// ── TARA DE REPOUSO / COMPENSACAO DE PRE-CARGA MECANICA ──
#ifndef HABILITAR_TARA
#define HABILITAR_TARA 1
#endif
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

  // Desconectado: pulso heartbeat de 100ms a cada 1s (economiza bateria)
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

#if HABILITAR_TARA
    int liq = 0;
    if (taraConcluida) {
      liq = adcMedia[i] - adcTara[i];
      if (liq < 0) liq = 0;
    } else {
      liq = adcMedia[i];
    }
    adcLiquido[i] = liq;
#else
    adcLiquido[i] = adcMedia[i];
#endif

    // Aplica o fator de equiparacao sobre o valor liquido (após tara)
    int eq = (int)round(adcLiquido[i] * FATORES_EQUIPARACAO[i]);
    if (eq > 4095) eq = 4095; // Limita ao teto maximo de 12 bits
    adcEquiparado[i] = eq;
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
    Serial.print(','); Serial.print(adcEquiparado[i]); // Valor equalizado final
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
  // Envia valores equalizados para a interface web
  String pacote = "{\"calcaneo\":" + String(adcEquiparado[0]) +
                  ",\"meta1\":" + String(adcEquiparado[1]) +
                  ",\"meta5\":" + String(adcEquiparado[2]) +
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
  Serial.println("# ========================================================");
  Serial.println("# Palmilha bancada - LOLIN32 V1.0.0");
  Serial.println("# Mapeamento FSR: Calcaneo=GPIO 36 (VP) | M1=GPIO 33 | M5=GPIO 39 (VN)");
  Serial.println("# Equiparacao ativa: Calcaneo x7.647 | M1 x1.444 | M5 x1.000");
  Serial.println("# Sensores AHT10 desativados/removidos");
  Serial.println("# ========================================================");
  
  analogReadResolution(12);
  for (uint8_t i = 0; i < 3; ++i) {
    pinMode(PINOS_FSR[i], INPUT);
    analogSetPinAttenuation(PINOS_FSR[i], ADC_11db);
  }

  // Inicializa LED indicador de alimentacao / conexao
  pinMode(PINO_LED_STATUS, OUTPUT);
  digitalWrite(PINO_LED_STATUS, LED_ON);

#if HABILITAR_TARA
  Serial.println("# [BOOT] Calibrando linha de base automatica em repouso... Mantenha a palmilha sem carga.");
  delay(250);
  for (int amostra = 0; amostra < 30; ++amostra) {
    lerFSRs();
    delay(30);
  }
  for (uint8_t i = 0; i < 3; ++i) {
    adcTara[i] = adcMedia[i];
  }
  taraConcluida = true;
  Serial.print("# [BOOT CALIBRADO] Linha de base automatica fixada -> Calcaneo: ");
  Serial.print(adcTara[0]);
  Serial.print(" ADC | M1: ");
  Serial.print(adcTara[1]);
  Serial.print(" ADC | M5: ");
  Serial.print(adcTara[2]);
  Serial.println(" ADC");
#endif

#if HABILITAR_BLE
  inicializarBLE();
  Serial.println("# BLE habilitado: Palmilha_v5.0");
#else
  Serial.println("# BLE desligado para bancada.");
#endif

  ultimaAmostra = millis();
  Serial.println("t_ms,dt_ms,seq,calc_raw,calc_eq,calc_mV,m1_raw,m1_eq,m1_mV,m5_raw,m5_eq,m5_mV");
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

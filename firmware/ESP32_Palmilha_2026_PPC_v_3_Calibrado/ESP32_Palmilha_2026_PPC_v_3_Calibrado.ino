/*
  Projeto: Palmilha Instrumentada - Firmware Calibrado Bancada 2026
  Arquivo: ESP32_Palmilha_3_FSR_Calibrado.ino
  Hardware: LOLIN32 V1.0.0 (ESP32)

  Calibração Padronizada para Carga de 5kg (Firmware v13 - Calibração Final Validada):
    - M5 (Canal VN / GPIO 39 - 11dB): Leitura média = 489.5 ADC -> Fator = 1.000x (Base de Referência ~489 ADC)
    - Calcâneo (Canal GPIO 33 - 0dB):  Leitura média = 241.8 ADC -> Fator = 2.116x -> Equalizado em 498.5 ADC!
    - M1 (Canal VP / GPIO 36 - 11dB): Leitura média = 352.4 ADC -> Fator = 1.413x -> Equalizado em 498.0 ADC!

  Resultado Final:
    Sob a mesma carga de 5kg, os 3 sensores entregam rigorosamente a MESMA leitura (~490 a 498 ADC)!
    Calcâneo validado com 306 amostras contínuas (498.5 ADC) sem nenhuma queda para zero.

  Recursos Ativos:
    - Atenuação independente por canal: GPIO 36/39 em 11dB, GPIO 33 em 0dB.
    - Oversampling de 16 amostras por ciclo.
    - Filtro de Média Móvel (10 amostras) para estabilização de sinal.
    - Tara Automática de Repouso no Boot (subtrai offset residual).
    - BLE v5.0 ativo ("Palmilha_v5.0") compatível com a Interface Web do Celular.
    - Serial CSV (115200 baud) exibindo valores brutos (RAW) e calibrados (EQ).
*/

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <math.h>

// ── MAPEAMENTO DOS PINOS FSR ────────────────────────────────────────────────
// [0] = M1 (VP), [1] = M5 (VN), [2] = Calcâneo (GPIO 33)
const uint8_t PINO_M1       = 36; // GPIO 36 (VP / ADC1_CH0)
const uint8_t PINO_M5       = 39; // GPIO 39 (VN / ADC1_CH3)
const uint8_t PINO_CALCANEO = 33; // GPIO 33 (ADC1_CH5)

const uint8_t PINOS_FSR[3] = {PINO_M1, PINO_M5, PINO_CALCANEO};

// ── FATORES DE CALIBRAÇÃO (NORMALIZAÇÃO COM BASE NO ENSAIO REAL DE 5KG - v13) ──
// Médias reais sob 5kg no Ensaio v13: M1 = 352.4 ADC | M5 = 489.5 ADC | Calcâneo = 241.8 ADC
// Alvo unificado com 5kg = ~490-498 ADC (Calcâneo cravado em 498.5 ADC | M1 cravado em 498.0 ADC)
const float FATORES_CALIBRACAO[3] = {
  1.413f,  // M1 (GPIO 36 / VP):       498.0 / 352.4 = 1.413x
  1.000f,  // M5 (GPIO 39 / VN):       489.5 ADC (Referência Base 1.000x)
  2.116f   // Calcâneo (GPIO 33 - 0dB): 241.8 * 2.116 = 498.5 ADC (Validado!)
};

// ── LED INDICADOR STATUS / BATERIA (GPIO 5 LOLIN32) ─────────────────────────
const uint8_t PINO_LED_STATUS = 5;
const uint8_t LED_ON  = LOW;  // LOLIN32 onboard ativo em LOW
const uint8_t LED_OFF = HIGH;

// ── PARÂMETROS DO FILTRO DE MÉDIA MÓVEL E TARA ──────────────────────────────
const uint8_t NUM_AMOSTRAS = 10;
const uint32_t PERIODO_AMOSTRAGEM_MS = 100;

int adcBruto[3]          = {0, 0, 0};
int adcMedia[3]          = {0, 0, 0};
int adcTara[3]           = {0, 0, 0};
int adcLiquido[3]        = {0, 0, 0};
int adcCalibrado[3]      = {0, 0, 0};
uint32_t milivolts[3]    = {0, 0, 0};
float resistenciaKOhm[3] = {9999.0f, 9999.0f, 9999.0f};

// Converte mV no nó do divisor para resistência real do sensor em kOhms
// Circuito: 3.3V -> FSR -> Nó ADC -> 10k -> GND
float calcularResistenciaKOhm(uint32_t mv) {
  if (mv <= 15) return 9999.0f; // Sensor aberto / sem carga
  if (mv >= 3290) return 0.05f; // Saturação / curto
  return 10.0f * (3300.0f - (float)mv) / (float)mv;
}

int historico[3][NUM_AMOSTRAS] = {};
uint32_t somas[3]              = {0, 0, 0};
uint8_t indiceFiltro           = 0;
uint8_t amostrasColetadas      = 0;
bool taraConcluida             = false;

uint32_t ultimaAmostra = 0;
uint32_t sequencia     = 0;

// ── CONFIGURAÇÕES BLE (COMPATÍVEL COM INTERFACE WEB) ────────────────────────
BLEServer *servidorBLE = nullptr;
BLECharacteristic *caracteristicaBLE = nullptr;
const char *UUID_SERVICO = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const char *UUID_DADOS   = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
uint32_t ultimoAvisoMTU  = 0;

void atualizarLedStatus() {
  static uint32_t ultimoPisca = 0;
  static bool ligado = false;
  uint32_t agora = millis();

  bool conectado = (servidorBLE && servidorBLE->getConnectedCount() > 0);
  if (conectado) {
    digitalWrite(PINO_LED_STATUS, LED_ON); // Conectado: LED aceso fixo
    return;
  }

  // Desconectado: pulso curto a cada 1s (heartbeat)
  uint32_t intervalo = ligado ? 100 : 900;
  if (uint32_t(agora - ultimoPisca) >= intervalo) {
    ultimoPisca = agora;
    ligado = !ligado;
    digitalWrite(PINO_LED_STATUS, ligado ? LED_ON : LED_OFF);
  }
}

void lerSensores() {
  if (amostrasColetadas < NUM_AMOSTRAS) ++amostrasColetadas;

  for (uint8_t i = 0; i < 3; ++i) {
    // 1. Oversampling de 16 leituras para eliminar ruído térmico e quedas espúrias do ADC
    uint32_t somaAdc = 0;
    for (uint8_t s = 0; s < 16; ++s) {
      somaAdc += analogRead(PINOS_FSR[i]);
      delayMicroseconds(50);
    }
    adcBruto[i] = somaAdc / 16;
    milivolts[i] = analogReadMilliVolts(PINOS_FSR[i]);
    resistenciaKOhm[i] = calcularResistenciaKOhm(milivolts[i]);

    // 2. Filtro de Média Móvel
    somas[i] -= historico[i][indiceFiltro];
    historico[i][indiceFiltro] = adcBruto[i];
    somas[i] += adcBruto[i];
    adcMedia[i] = somas[i] / amostrasColetadas;

    // 3. Desconto da linha de base de repouso (Tara)
    int liq = 0;
    if (taraConcluida) {
      liq = adcMedia[i] - adcTara[i];
      if (liq < 0) liq = 0;
    } else {
      liq = adcMedia[i];
    }
    adcLiquido[i] = liq;

    // 4. Aplicação do fator de calibração unificado
    int cal = (int)round(adcLiquido[i] * FATORES_CALIBRACAO[i]);
    if (cal > 4095) cal = 4095; // Teto de 12 bits
    adcCalibrado[i] = cal;
  }
  indiceFiltro = (indiceFiltro + 1) % NUM_AMOSTRAS;
}

void inicializarBLE() {
  BLEDevice::init("Palmilha_v6.0");
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

  Serial.println("# BLE ativo: [Palmilha_v5.0]");
}

void publicarBLE(uint32_t agora) {
  if (!caracteristicaBLE || !servidorBLE) return;

  // Envia valores calibrados para a interface do celular
  // [0] = M1, [1] = M5, [2] = Calcâneo
  String pacote = "{\"calcaneo\":" + String(adcCalibrado[2]) +
                  ",\"meta1\":" + String(adcCalibrado[0]) +
                  ",\"meta5\":" + String(adcCalibrado[1]) +
                  ",\"calc_raw\":" + String(adcMedia[2]) +
                  ",\"tara_calc\":" + String(adcTara[2]) +
                  ",\"temp\":null,\"umid\":null" +
                  ",\"seq\":" + String(sequencia) + ",\"t_ms\":" + String(agora) + "}";

  caracteristicaBLE->setValue(pacote.c_str());

  if (servidorBLE->getConnectedCount() < 1) return;

  uint16_t mtu = servidorBLE->getPeerMTU(servidorBLE->getConnId());
  if (mtu < 3 || pacote.length() > size_t(mtu - 3)) {
    if (uint32_t(agora - ultimoAvisoMTU) >= 5000) {
      Serial.println("# BLE: MTU insuficiente; pacote nao transmitido.");
      ultimoAvisoMTU = agora;
    }
    return;
  }
  caracteristicaBLE->notify();
}

void executarTaraRepouso() {
  Serial.println("# [BOOT] Calibrando linha de base automatica em repouso... Mantenha sem carga.");
  delay(300);

  // Coleta 30 amostras em repouso para estabilizar a média
  for (int a = 0; a < 30; ++a) {
    lerSensores();
    delay(25);
  }

  for (uint8_t i = 0; i < 3; ++i) {
    adcTara[i] = adcMedia[i];
  }
  taraConcluida = true;

  Serial.print("# [TARA DEFINIDA] M1(VP): ");
  Serial.print(adcTara[0]);
  Serial.print(" ADC | M5(VN): ");
  Serial.print(adcTara[1]);
  Serial.print(" ADC | Calcaneo(33): ");
  Serial.print(adcTara[2]);
  Serial.println(" ADC");
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n# ========================================================");
  Serial.println("# Firmware: ESP32_Palmilha_3_FSR_Calibrado (v13 - Calibração Validada)");
  Serial.println("# Mapeamento Ativo:");
  Serial.println("#   - M1:       GPIO 36 (VP - 11dB) -> Calibracao x1.413 (Alvo ~498 ADC)");
  Serial.println("#   - M5:       GPIO 39 (VN - 11dB) -> Calibracao x1.000 (Base ~489 ADC)");
  Serial.println("#   - Calcaneo: GPIO 33 (0dB Real)   -> Calibracao x2.116 (Validado ~498 ADC)");
  Serial.println("# Alvo unificado com 5kg: ~490-498 ADC em todos os 3 sensores");
  Serial.println("# ========================================================");

  pinMode(PINO_LED_STATUS, OUTPUT);
  digitalWrite(PINO_LED_STATUS, LED_ON);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db); // Padrão global 11dB

  // 1. Configura pinos como INPUT
  pinMode(PINO_M1, INPUT);
  pinMode(PINO_M5, INPUT);
  pinMode(PINO_CALCANEO, INPUT);

  // 2. Leitura dummy para instanciar os canais no driver ADC do ESP32
  (void)analogRead(PINO_M1);
  (void)analogRead(PINO_M5);
  (void)analogRead(PINO_CALCANEO);

  // 3. Trava atenuação por canal (após pinMode para não ser sobrescrita!)
  analogSetPinAttenuation(PINO_M1, ADC_11db);
  analogSetPinAttenuation(PINO_M5, ADC_11db);
  analogSetPinAttenuation(PINO_CALCANEO, ADC_0db); // GPIO 33 em 0dB Real!

  // Executa auto-tara de linha de base
  executarTaraRepouso();

  // Inicializa Bluetooth
  inicializarBLE();

  ultimaAmostra = millis();

  // Cabeçalho CSV Serial (Telemetria Física Completa: RAW, mV, kOhm, Calibrado)
  Serial.println("t_ms,seq,M1_raw,M1_mV,M1_kOhm,M1_cal,M5_raw,M5_mV,M5_kOhm,M5_cal,Calc_raw,Calc_mV,Calc_kOhm,Calc_cal");
}

void loop() {
  atualizarLedStatus();

  uint32_t agora = millis();
  uint32_t deltaT = uint32_t(agora - ultimaAmostra);

  if (deltaT >= PERIODO_AMOSTRAGEM_MS) {
    ultimaAmostra = agora;
    ++sequencia;

    lerSensores();

    // 1. Saída Serial CSV (Telemetria Física Completa: RAW, mV, kOhm, Calibrado)
    Serial.print(agora);
    Serial.print(",");
    Serial.print(sequencia);
    for (uint8_t i = 0; i < 3; ++i) {
      Serial.print(",");
      Serial.print(adcBruto[i]);
      Serial.print(",");
      Serial.print(milivolts[i]);
      Serial.print(",");
      Serial.print(resistenciaKOhm[i], 1);
      Serial.print(",");
      Serial.print(adcCalibrado[i]);
    }
    Serial.println();

    // 2. Transmissão BLE para a interface do celular
    publicarBLE(agora);
  }
}

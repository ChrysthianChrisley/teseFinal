/*
  ==============================================================================
  PALMILHA INSTRUMENTADA 2026 - VERSÃO 1.0 OFICIAL (3 SENSORES FSR)
  Mestrado Profissional em Telessaúde e Saúde Digital (PPGTS / UERJ)
  Autor: Chrysthian Chrisley
  Hardware: ESP32 (WEMOS LOLIN32 V1.0.0)
  ==============================================================================
  
  RECURSOS E CARACTERÍSTICAS DESTA VERSÃO 1.0:
    - 3 Canais de Pressão Plantar FSR 402 com calibração e ganhos oficiais:
        * Calcâneo (Retropé):      GPIO 36 (VP / ADC1_CH0) -> Atenuação ADC_0db  (Ganho 30.0x)
        * 1º Metatarso (M1 Medial): GPIO 33 (ADC1_CH5)      -> Atenuação ADC_11db (Ganho 1.0x)
        * 5º Metatarso (M5 Lateral): GPIO 39 (VN / ADC1_CH3) -> Atenuação ADC_11db (Ganho 1.0x)
    - Frequência de Amostragem FSR: 10 Hz (Período: 100 ms)
    - Filtro de Média Móvel (10 amostras) + Tara de Repouso no boot
    - Comunicação sem fio BLE 4.2 ativa: Nome "Palmilha_v5.0" (JSON em tempo real para o Web App)
    - Saída Serial amigável a cada 500 ms (2x por segundo) para fácil leitura humana
    - Gerenciamento Inteligente de Energia (Deep Sleep):
        * DESLIGAR: Auto-desligamento após 3 minutos sem conexão BLE (segurança contra ortostatismo).
        * RELIGAR (DUAL):
            1. Pelo botão físico de Reset (RST/EN) da placa;
            2. Automaticamente ao PISAR ou APERTAR o sensor M1 (GPIO 33 - RTC Wake-up).
  ==============================================================================
*/

#include <Arduino.h>
#include <math.h>
#include "esp_sleep.h"

// ── CONFIGURAÇÃO DO BLUETOOTH LOW ENERGY (BLE) ───────────────────────────────
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

// ── MAPEAMENTO DOS PINOS FSR (ADC1 DO ESP32) ─────────────────────────────────
// [0]=Calcâneo (GPIO 36), [1]=M1 (GPIO 33), [2]=M5 (GPIO 39)
const uint8_t PINOS_FSR[3] = {36, 33, 39};

// ── FATORES DE CALIBRAÇÃO E GANHO DIGITAL ────────────────────────────────────
// [0]=Calcâneo (30x para equiparar a M1/M5 com atenuação 0dB) | [1]=M1 (1x) | [2]=M5 (1x)
const float GANHOS_FSR[3] = {30.0f, 1.0f, 1.0f};

// ── INDICADOR DE STATUS / ALIMENTAÇÃO (LED AZUL ONBOARD) ─────────────────────
const uint8_t PINO_LED_STATUS = 5; // LED onboard LOLIN32 V1.0.0 (GPIO 5)
const uint8_t LED_ON  = LOW;       // Nível baixo acende o LED na LOLIN32
const uint8_t LED_OFF = HIGH;

// ── PARÂMETROS DO FILTRO E AMOSTRAGEM TEMPORAL ───────────────────────────────
const uint8_t NUM_AMOSTRAS = 10;
const uint32_t PERIODO_FSR_MS = 100; // 10 Hz (100 ms)

int adcBruto[3]       = {0, 0, 0};
int adcMedia[3]       = {0, 0, 0};
uint32_t milivolts[3] = {0, 0, 0};
int historico[3][NUM_AMOSTRAS] = {};
uint32_t somas[3]     = {0, 0, 0};
uint8_t indiceFiltro  = 0;
uint8_t quantidadeFiltro = 0;
uint32_t ultimaAmostra = 0;
uint32_t sequencia    = 0;

// ── TARA DE REPOUSO (COMPENSAÇÃO AUTOMÁTICA DE PRÉ-CARGA) ────────────────────
int adcTara[3]        = {0, 0, 0};
int adcLiquido[3]     = {0, 0, 0};
bool taraConcluida    = false;

// ── GERENCIAMENTO DE ENERGIA E AUTO-DESLIGAMENTO (DEEP SLEEP) ────────────────
const uint32_t TEMPO_LIMITE_INATIVO_MS = 180000; // 3 minutos sem conexão BLE
uint32_t inicioSemConexao = 0;

void entrarDeepSleep(const char *motivo) {
  Serial.println("\n# =========================================================");
  Serial.print("# [ENERGIA] Desligando palmilha (Deep Sleep)... Motivo: ");
  Serial.println(motivo);
  Serial.println("# [ENERGIA] Consumo reduzido para ~10 uA. Bateria 100% protegida.");
  Serial.println("# [ENERGIA] Modos de religar:");
  Serial.println("#   -> Modo 1: Pressionar o botao físico de Reset (RST/EN) no case;");
  Serial.println("#   -> Modo 2: Apenas PISAR ou APERTAR o sensor M1 (GPIO 33).");
  Serial.println("# =========================================================\n");

  // Sinalização visual: 3 piscadas rápidas confirmando que está desligando
  for (uint8_t i = 0; i < 3; ++i) {
    digitalWrite(PINO_LED_STATUS, LED_ON);
    delay(100);
    digitalWrite(PINO_LED_STATUS, LED_OFF);
    delay(100);
  }
  digitalWrite(PINO_LED_STATUS, LED_OFF);

  // Armar o sensor M1 (GPIO 33 - RTC_IO8) para acordar a placa quando receber nível HIGH (>1.4V):
  // Ou seja, ao pisar no chão ou apertar com o dedo, o ESP32 acorda na hora!
  esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, 1);

#if HABILITAR_BLE
  if (servidorBLE) {
    BLEDevice::deinit(true);
  }
#endif

  delay(50);
  esp_deep_sleep_start();
}

// ── PISCA DO LED CONFORME ESTADO DA CONEXÃO ──────────────────────────────────
void atualizarLedStatus() {
  static uint32_t ultimoPisca = 0;
  static bool ligado = false;
  uint32_t agora = millis();

#if HABILITAR_BLE
  bool conectado = (servidorBLE && servidorBLE->getConnectedCount() > 0);
  if (conectado) {
    digitalWrite(PINO_LED_STATUS, LED_ON); // Conectado via BLE: LED azul fixo
    return;
  }
#endif

  // Desconectado: pisca pulso curto de 100ms a cada 1s para sinalizar espera e poupar carga
  uint32_t intervalo = ligado ? 100 : 900;
  if (uint32_t(agora - ultimoPisca) >= intervalo) {
    ultimoPisca = agora;
    ligado = !ligado;
    digitalWrite(PINO_LED_STATUS, ligado ? LED_ON : LED_OFF);
  }
}

// ── LEITURA, FILTRAGEM E CALIBRAÇÃO DOS 3 FSRs ──────────────────────────────
void lerFSRs() {
  if (quantidadeFiltro < NUM_AMOSTRAS) ++quantidadeFiltro;

  for (uint8_t i = 0; i < 3; ++i) {
    adcBruto[i] = analogRead(PINOS_FSR[i]);
    milivolts[i] = analogReadMilliVolts(PINOS_FSR[i]);
    
    // Filtro de Média Móvel
    somas[i] -= historico[i][indiceFiltro];
    historico[i][indiceFiltro] = adcBruto[i];
    somas[i] += adcBruto[i];
    adcMedia[i] = somas[i] / quantidadeFiltro;

    if (taraConcluida) {
      int liq = adcMedia[i] - adcTara[i];
      if (liq < 0) liq = 0;
      
      // Aplica os fatores calibrados e limita a 12 bits (0-4095)
      float liqEscalado = (float)liq * GANHOS_FSR[i];
      adcLiquido[i] = (int)constrain(liqEscalado, 0.0f, 4095.0f);
    } else {
      adcLiquido[i] = adcMedia[i];
    }
  }
  indiceFiltro = (indiceFiltro + 1) % NUM_AMOSTRAS;
}

// ── IMPRESSÃO SERIAL FORMATADA A CADA 500 MS ─────────────────────────────────
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

// ── ROTINAS DE BLUETOOTH LOW ENERGY (BLE 4.2) ────────────────────────────────
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
  // Pacote JSON oficial perfeitamente compatível com o Web App (pe-diabetico-ia / teseFinal)
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

// ── SETUP (INICIALIZAÇÃO DO SISTEMA) ─────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n# =========================================================");
  Serial.println("# PALMILHA INSTRUMENTADA 2026 - VERSÃO 1.0 (3 SENSORES FSR)");
  Serial.println("# Suporte Oficial a Wake-up por Pisada e Botao Reset");
  Serial.println("# =========================================================");

  analogReadResolution(12);

  // Configuração individual de atenuação ADC
  pinMode(PINOS_FSR[0], INPUT);
  analogSetPinAttenuation(PINOS_FSR[0], ADC_0db);  // Calcâneo (Sensibilidade 3x maior)

  pinMode(PINOS_FSR[1], INPUT);
  analogSetPinAttenuation(PINOS_FSR[1], ADC_11db); // M1

  pinMode(PINOS_FSR[2], INPUT);
  analogSetPinAttenuation(PINOS_FSR[2], ADC_11db); // M5

  pinMode(PINO_LED_STATUS, OUTPUT);
  digitalWrite(PINO_LED_STATUS, LED_ON);

  // ── DETECÇÃO DO MOTIVO DE INICIALIZAÇÃO ────────────────────────────────────
  esp_sleep_wakeup_cause_t motivoWakeup = esp_sleep_get_wakeup_cause();
  
  if (motivoWakeup == ESP_SLEEP_WAKEUP_EXT0) {
    // Caso 1: A placa foi ACORDADA por pisada ou pressão no sensor M1 (GPIO 33)
    Serial.println("# [BOOT] ACORDADO POR PRESSÃO/PISADA NO SENSOR M1 (GPIO 33)!");
    
    // Sinalização de boas-vindas: 2 piscadas longas (250 ms)
    for (uint8_t i = 0; i < 2; ++i) {
      digitalWrite(PINO_LED_STATUS, LED_ON);
      delay(250);
      digitalWrite(PINO_LED_STATUS, LED_OFF);
      delay(150);
    }
    digitalWrite(PINO_LED_STATUS, LED_ON);

    // Como o paciente acabou de pisar na palmilha para ligar, aplicamos taras nominais
    // de repouso pré-definidas para NÃO calibrar o peso do corpo como 'zero':
    adcTara[0] = 50;
    adcTara[1] = 50;
    adcTara[2] = 50;
    taraConcluida = true;
    Serial.println("# [BOOT] Taras de repouso nominais aplicadas (pisada ativa detectada).");
  } else {
    // Caso 2: Inicialização por Botão Físico Reset (RST/EN) ou Cabo USB
    Serial.println("# [BOOT] Calibrando tara automatica de repouso... Mantenha sem carga.");
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
  }

#if HABILITAR_BLE
  inicializarBLE();
  Serial.println("# [BLE] Servico anunciado como: 'Palmilha_v5.0'");
#endif

  ultimaAmostra = millis();
}

// ── LOOP PRINCIPAL ───────────────────────────────────────────────────────────
void loop() {
  atualizarLedStatus();

  uint32_t agora = millis();

  // ── GESTÃO INTELIGENTE DE ENERGIA (AUTO-DESLIGAMENTO POR INATIVIDADE) ─────
  // A palmilha NUNCA desliga enquanto estiver conectada ao celular/app, mesmo
  // que o paciente fique em pé parado (ortostatismo) por muito tempo.
  // Ela desliga automaticamente apenas se ficar 3 minutos sem conexão BLE.
#if HABILITAR_BLE
  bool conectado = (servidorBLE && servidorBLE->getConnectedCount() > 0);
  if (!conectado) {
    if (inicioSemConexao == 0) inicioSemConexao = agora;
    // Se ficar mais de 3 minutos desconectado do Bluetooth, desliga para poupar a bateria
    if (uint32_t(agora - inicioSemConexao) >= TEMPO_LIMITE_INATIVO_MS) {
      entrarDeepSleep("Inatividade (3 minutos desconectado do BLE)");
    }
  } else {
    inicioSemConexao = 0; // Reinicia o cronômetro enquanto houver conexão ativa
  }
#endif

  // ── AQUISIÇÃO TEMPORAL A 10 HZ (A CADA 100 MS) ─────────────────────────────
  uint32_t intervalo = uint32_t(agora - ultimaAmostra);
  if (intervalo >= PERIODO_FSR_MS) {
    ultimaAmostra = agora;
    ++sequencia;
    
    lerFSRs();

#if HABILITAR_BLE
    publicarBLE(agora);
#endif

    // Imprime no Serial Monitor com calma a cada 500 ms (2x por segundo)
    static uint32_t ultimoPrint = 0;
    if (uint32_t(agora - ultimoPrint) >= 500) {
      ultimoPrint = agora;
      imprimirSerialAmigavel();
    }
  }

  delay(1);
}

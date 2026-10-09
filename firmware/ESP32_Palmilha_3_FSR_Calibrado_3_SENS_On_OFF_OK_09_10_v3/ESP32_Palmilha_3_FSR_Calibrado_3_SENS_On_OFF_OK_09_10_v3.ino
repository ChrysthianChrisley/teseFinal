/*
  Projeto: Palmilha Instrumentada - Firmware Calibrado Bancada 2026
  Arquivo: ESP32_Palmilha_3_FSR_Calibrado_3_SENSORES_On_OFF.ino
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
    - BLE v5.0 ativo ("Palmilha_v6.0") compatível com a Interface Web do Celular.
    - Serial CSV (115200 baud) exibindo valores brutos (RAW) e calibrados (EQ).
    - Gerenciamento Inteligente de Energia (Deep Sleep):
        * DESLIGAR: Auto-desligamento automático após 3 minutos sem conexão BLE (poupa 100% da bateria).
        * RELIGAR (DUAL):
            1. Pelo botão físico de Reset (RST/EN) da placa;
            2. Ao PISAR ou APERTAR o sensor (GPIO 33 - RTC Wake-up).
*/

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <math.h>
#include "esp_sleep.h"
#include "FS.h"
#include "LittleFS.h"

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

// ── GERENCIAMENTO DE ENERGIA E AUTO-DESLIGAMENTO (DEEP SLEEP) ────────────────
const uint32_t TEMPO_LIMITE_INATIVO_MS = 180000; // 3 minutos sem conexão BLE (evita desligar durante pausas no teste)
uint32_t inicioSemConexao = 0;
bool dispositivoConectado = false;
uint32_t tempoInicioConexao = 0;
uint32_t totalConexoesRealizadas = 0;
uint32_t totalDesconexoes = 0;
uint32_t pacotesEnviadosBLE = 0;

// ── ESTRUTURA COMPACTA PARA GRAVAÇÃO OFFLINE NA FLASH (10 BYTES POR AMOSTRA) ─
struct __attribute__((packed)) AmostraOffline {
  uint32_t t_ms;
  uint16_t m1;
  uint16_t m5;
  uint16_t calc;
};

const char *ARQUIVO_OFFLINE = "/offline_log.bin";
const uint32_t MAX_BYTES_OFFLINE = 1400000; // ~1.4 MB (capacidade para ~140.000 amostras = quase 4 horas contínuas)
bool littleFsPronto = false;
uint32_t amostrasGravadasOffline = 0;
bool sincronizacaoEmAndamento = false;

void notificarStatusOffline();
void iniciarSincronizacaoOffline();
void purgarMemoriaFlash();

void inicializarLittleFS() {
  if (!LittleFS.begin(true)) {
    Serial.println("# [LITTLEFS] Falha ao montar sistema de arquivos na Flash!");
    littleFsPronto = false;
    return;
  }
  littleFsPronto = true;
  if (LittleFS.exists(ARQUIVO_OFFLINE)) {
    File f = LittleFS.open(ARQUIVO_OFFLINE, "r");
    if (f) {
      size_t tam = f.size();
      amostrasGravadasOffline = tam / sizeof(AmostraOffline);
      f.close();
      Serial.print("# [LITTLEFS] Arquivo offline detectado: ");
      Serial.print(amostrasGravadasOffline);
      Serial.print(" amostras acumuladas (");
      Serial.print(tam / 1024);
      Serial.println(" KB)");
    }
  } else {
    Serial.println("# [LITTLEFS] Sistema pronto. Nenhum registro offline pendente.");
  }
}

void gravarAmostraOffline(uint32_t t_ms, uint16_t m1, uint16_t m5, uint16_t calc) {
  if (!littleFsPronto || sincronizacaoEmAndamento) return;

  File f = LittleFS.open(ARQUIVO_OFFLINE, "a");
  if (!f) return;

  if (f.size() >= MAX_BYTES_OFFLINE) {
    f.close();
    return;
  }

  AmostraOffline reg;
  reg.t_ms = t_ms;
  reg.m1 = m1;
  reg.m5 = m5;
  reg.calc = calc;
  f.write((const uint8_t *)&reg, sizeof(AmostraOffline));
  f.close();
  amostrasGravadasOffline++;
}

void purgarMemoriaFlash() {
  if (!littleFsPronto) return;
  if (LittleFS.exists(ARQUIVO_OFFLINE)) {
    LittleFS.remove(ARQUIVO_OFFLINE);
  }
  amostrasGravadasOffline = 0;
  sincronizacaoEmAndamento = false;
  Serial.println("\n# =========================================================");
  Serial.println("# [SYNC & PURGE] MEMORIA FLASH PURGADA COM SUCESSO!");
  Serial.println("# [SYNC & PURGE] 100% do espaco interno liberado para novos testes.");
  Serial.println("# =========================================================\n");
}

// ── DIAGNÓSTICO DO MOTIVO DE REINICIALIZAÇÃO (HARDWARE / SOFTWARE / ENERGIA) ─
void diagnosticarMotivoReset() {
  esp_reset_reason_t motivo = esp_reset_reason();
  Serial.println("\n# =========================================================");
  Serial.println("# [DIAGNOSTICO HARDWARE] ANALISE DO HISTORICO DE ENERGIA/BOOT:");
  Serial.print("# [DIAGNOSTICO HARDWARE] Motivo do Ultimo Reset: ");
  switch (motivo) {
    case ESP_RST_POWERON:
      Serial.println("ESP_RST_POWERON (Alimentacao conectada / Chave Liga-Desliga acionada)");
      break;
    case ESP_RST_EXT:
      Serial.println("ESP_RST_EXT (Botao fisico RST/EN da placa pressionado manualmente)");
      break;
    case ESP_RST_SW:
      Serial.println("ESP_RST_SW (Reinicializacao solicitada por software)");
      break;
    case ESP_RST_PANIC:
      Serial.println("ESP_RST_PANIC [ERRO DE SOFTWARE] (Travamento por excecao/Kernel Panic)");
      break;
    case ESP_RST_INT_WDT:
      Serial.println("ESP_RST_INT_WDT (Watchdog de Interrupcao estourou)");
      break;
    case ESP_RST_TASK_WDT:
      Serial.println("ESP_RST_TASK_WDT (Task Watchdog estourou - processador travado)");
      break;
    case ESP_RST_DEEPSLEEP:
      Serial.println("ESP_RST_DEEPSLEEP (Acordou do modo de economia Deep Sleep)");
      break;
    case ESP_RST_BROWNOUT:
      Serial.println("ESP_RST_BROWNOUT [ALERTA DE BATERIA]");
      Serial.println("#   -> ATENCAO: A tensao da bateria caiu abaixo de 2.7V!");
      Serial.println("#   -> Causa: Bateria LiPo descarregada, mau contato ou pico de corrente do BLE.");
      break;
    case ESP_RST_SDIO:
      Serial.println("ESP_RST_SDIO (Reset via SDIO)");
      break;
    default:
      Serial.printf("Codigo desconhecido: %d\n", (int)motivo);
      break;
  }

  esp_sleep_wakeup_cause_t motivoWake = esp_sleep_get_wakeup_cause();
  Serial.print("# [DIAGNOSTICO HARDWARE] Causa do Wake-up: ");
  switch (motivoWake) {
    case ESP_SLEEP_WAKEUP_EXT0:
      Serial.println("EXT0 (Pressao/Pisada detectada no sensor do calcaneo GPIO 33)");
      break;
    case ESP_SLEEP_WAKEUP_TIMER:
      Serial.println("TIMER (Temporizador interno)");
      break;
    default:
      Serial.println("Inicializacao a frio (Cold Boot) ou Reset convencional");
      break;
  }
  Serial.print("# [DIAGNOSTICO HARDWARE] Memoria Heap Livre: ");
  Serial.print(esp_get_free_heap_size() / 1024);
  Serial.println(" KB");
  Serial.println("# =========================================================\n");
}

// ── CALLBACKS OFICIAIS DO SERVIDOR BLE (DIAGNÓSTICO EM TEMPO REAL) ─────────
class CallbackServidorBLE : public BLEServerCallbacks {
  void onConnect(BLEServer *pServer) override {
    dispositivoConectado = true;
    inicioSemConexao = 0;
    tempoInicioConexao = millis();
    totalConexoesRealizadas++;
    Serial.println("\n# =========================================================");
    Serial.print("# [BLE STATUS] CELULAR CONECTADO COM SUCESSO! (Sessao #");
    Serial.print(totalConexoesRealizadas);
    Serial.println(")");
    Serial.print("# [BLE STATUS] Clientes ativos: ");
    Serial.println(pServer->getConnectedCount());
    Serial.print("# [BLE STATUS] Memoria Heap livre: ");
    Serial.print(esp_get_free_heap_size() / 1024);
    Serial.println(" KB");
    Serial.println("# =========================================================\n");

    // Notifica o celular se houver dados offline acumulados na memória Flash
    notificarStatusOffline();
  }

  void onDisconnect(BLEServer *pServer) override {
    dispositivoConectado = false;
    totalDesconexoes++;
    uint32_t duracaoSessaoSeg = (millis() - tempoInicioConexao) / 1000;
    inicioSemConexao = millis();
    Serial.println("\n# =========================================================");
    Serial.println("# [BLE ALERTA] CELULAR DESCONECTOU DO BLUETOOTH!");
    Serial.print("# [BLE ALERTA] Duracao da conexao: ");
    Serial.print(duracaoSessaoSeg);
    Serial.println(" segundos");
    Serial.print("# [BLE ALERTA] Pacotes transmitidos nesta sessao: ");
    Serial.println(pacotesEnviadosBLE);
    Serial.print("# [BLE ALERTA] Total de desconexoes acumuladas: ");
    Serial.println(totalDesconexoes);
    Serial.println("# [BLE ALERTA] Diagnostico da Desconexao:");
    Serial.println("#   1. O aplicativo do celular perdeu foco (trocou para WhatsApp/SMS);");
    Serial.println("#   2. A tela do celular apagou (Android suspende Web Bluetooth);");
    Serial.println("#   3. Caso ocorra reinicio do ESP32, verifique o motivo Brownout.");
    Serial.println("# [BLE ALERTA] Reiniciando anuncio BLE imediatamente para reconexao...");
    Serial.println("# =========================================================\n");

    // Reinicia o anúncio imediatamente para permitir reconexão sem travar
    pServer->getAdvertising()->start();
  }
};

void entrarDeepSleep(const char *motivo) {
  Serial.println("\n# =========================================================");
  Serial.print("# [ENERGIA] Desligando palmilha (Deep Sleep)... Motivo: ");
  Serial.println(motivo);
  Serial.println("# [ENERGIA] Consumo reduzido para ~10 uA. Bateria 100% protegida.");
  Serial.println("# [ENERGIA] Modos de religar:");
  Serial.println("#   -> Modo 1: Pressionar o botao físico de Reset (RST/EN) da placa;");
  Serial.println("#   -> Modo 2: Apenas PISAR ou APERTAR o sensor (GPIO 33 - RTC Wake-up).");
  Serial.println("# =========================================================\n");

  // Sinalização visual: 5 piscadas rápidas confirmando que está desligando
  for (uint8_t i = 0; i < 5; ++i) {
    digitalWrite(PINO_LED_STATUS, LED_ON);
    delay(80);
    digitalWrite(PINO_LED_STATUS, LED_OFF);
    delay(80);
  }
  digitalWrite(PINO_LED_STATUS, LED_OFF);

  esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, 1);

  if (servidorBLE) {
    BLEDevice::deinit(true);
  }

  delay(50);
  esp_deep_sleep_start();
}

void atualizarLedStatus() {
  static uint32_t ultimoPisca = 0;
  static bool ligado = false;
  uint32_t agora = millis();

  bool conectado = (dispositivoConectado || (servidorBLE && servidorBLE->getConnectedCount() > 0));
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

void notificarStatusOffline() {
  if (!caracteristicaBLE) return;
  size_t bytesTotal = 0;
  if (littleFsPronto && LittleFS.exists(ARQUIVO_OFFLINE)) {
    File f = LittleFS.open(ARQUIVO_OFFLINE, "r");
    if (f) {
      bytesTotal = f.size();
      amostrasGravadasOffline = bytesTotal / sizeof(AmostraOffline);
      f.close();
    }
  }
  if (amostrasGravadasOffline > 0) {
    String pkg = "{\"tipo\":\"offline_status\",\"total\":" + String(amostrasGravadasOffline) +
                 ",\"kb\":" + String(bytesTotal / 1024) + "}";
    caracteristicaBLE->setValue(pkg.c_str());
    caracteristicaBLE->notify();
    Serial.print("# [SYNC] Notificado ao celular: ");
    Serial.print(amostrasGravadasOffline);
    Serial.println(" amostras offline pendentes.");
  }
}

void iniciarSincronizacaoOffline() {
  if (!littleFsPronto || !LittleFS.exists(ARQUIVO_OFFLINE) || !caracteristicaBLE) {
    String msg = "{\"tipo\":\"sync_vazio\",\"total\":0}";
    caracteristicaBLE->setValue(msg.c_str());
    caracteristicaBLE->notify();
    return;
  }

  sincronizacaoEmAndamento = true;
  File f = LittleFS.open(ARQUIVO_OFFLINE, "r");
  if (!f) {
    sincronizacaoEmAndamento = false;
    return;
  }

  uint32_t total = f.size() / sizeof(AmostraOffline);
  Serial.print("# [SYNC] Descarregando ");
  Serial.print(total);
  Serial.println(" amostras offline para o celular...");

  AmostraOffline buffer[4];
  uint32_t enviadas = 0;

  while (f.available() >= sizeof(AmostraOffline)) {
    size_t lidas = f.read((uint8_t *)buffer, sizeof(buffer));
    size_t n = lidas / sizeof(AmostraOffline);
    if (n == 0) break;

    String pkg = "{\"tipo\":\"sync_batch\",\"d\":[";
    for (size_t i = 0; i < n; ++i) {
      if (i > 0) pkg += ",";
      pkg += "[" + String(buffer[i].t_ms) + "," + 
                   String(buffer[i].m1) + "," + 
                   String(buffer[i].m5) + "," + 
                   String(buffer[i].calc) + "]";
    }
    enviadas += n;
    uint32_t restantes = (total > enviadas) ? (total - enviadas) : 0;
    pkg += "],\"rem\":" + String(restantes) + "}";

    caracteristicaBLE->setValue(pkg.c_str());
    caracteristicaBLE->notify();
    delay(20);
  }

  f.close();
  sincronizacaoEmAndamento = false;

  String fim = "{\"tipo\":\"sync_fim\",\"total\":" + String(enviadas) + "}";
  caracteristicaBLE->setValue(fim.c_str());
  caracteristicaBLE->notify();
  Serial.println("# [SYNC] Descarregamento concluido! Aguardando ACK do celular para Purge.");
}

class CallbackCaracteristicaBLE : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *pChar) override {
    String cmd = String(pChar->getValue().c_str());
    cmd.trim();
    if (cmd.length() == 0) return;
    Serial.print("# [BLE COMANDO RECEBIDO] ");
    Serial.println(cmd);


    if (cmd.indexOf("SYNC_START") >= 0) {
      iniciarSincronizacaoOffline();
    } else if (cmd.indexOf("PURGE") >= 0) {
      purgarMemoriaFlash();
      if (caracteristicaBLE) {
        String resp = "{\"tipo\":\"purge_ok\",\"msg\":\"Memoria Flash liberada com sucesso\"}";
        caracteristicaBLE->setValue(resp.c_str());
        caracteristicaBLE->notify();
      }
    } else if (cmd.indexOf("CHECK_STATUS") >= 0) {
      notificarStatusOffline();
    }
  }
};

void inicializarBLE() {
  BLEDevice::init("Palmilha_v6.0");
  BLEDevice::setMTU(185);
  servidorBLE = BLEDevice::createServer();
  servidorBLE->setCallbacks(new CallbackServidorBLE());

  BLEService *servico = servidorBLE->createService(UUID_SERVICO);
  caracteristicaBLE = servico->createCharacteristic(
      UUID_DADOS, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY | BLECharacteristic::PROPERTY_WRITE);
  caracteristicaBLE->addDescriptor(new BLE2902());
  caracteristicaBLE->setCallbacks(new CallbackCaracteristicaBLE());
  servico->start();

  BLEAdvertising *anuncio = BLEDevice::getAdvertising();
  anuncio->addServiceUUID(UUID_SERVICO);
  anuncio->setScanResponse(true);
  anuncio->setMinPreferred(0x06);
  anuncio->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("# [BLE] Servidor inicializado e anunciando como: [Palmilha_v6.0]");
}

void publicarBLE(uint32_t agora) {
  if (!caracteristicaBLE || !servidorBLE) return;

  bool conectado = (dispositivoConectado || (servidorBLE && servidorBLE->getConnectedCount() > 0));
  if (!conectado) return;

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
  caracteristicaBLE->notify();
  pacotesEnviadosBLE++;
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

void emitirDiagnosticoPeriodico(uint32_t agora) {
  static uint32_t ultimoLogDiagnostico = 0;
  // A cada 5 segundos emite status de diagnóstico no Monitor Serial
  if (uint32_t(agora - ultimoLogDiagnostico) >= 5000) {
    ultimoLogDiagnostico = agora;
    bool conectado = (dispositivoConectado || (servidorBLE && servidorBLE->getConnectedCount() > 0));
    uint32_t uptimeSeg = agora / 1000;

    Serial.print("# [DIAGNOSTICO ");
    Serial.print(uptimeSeg);
    Serial.print("s] Estado: ");
    if (conectado) {
      uint32_t duracao = (agora - tempoInicioConexao) / 1000;
      Serial.print("CONECTADO (Duracao: ");
      Serial.print(duracao);
      Serial.print("s) | Pacotes BLE: ");
      Serial.print(pacotesEnviadosBLE);
    } else {
      uint32_t segDesconectado = (inicioSemConexao > 0) ? ((agora - inicioSemConexao) / 1000) : 0;
      uint32_t segAteSleep = (TEMPO_LIMITE_INATIVO_MS > (agora - inicioSemConexao)) ?
                             ((TEMPO_LIMITE_INATIVO_MS - (agora - inicioSemConexao)) / 1000) : 0;
      Serial.print("DESCONECTADO (Ha ");
      Serial.print(segDesconectado);
      Serial.print("s) | Auto-Sleep em: ");
      Serial.print(segAteSleep);
      Serial.print("s");
    }
    Serial.print(" | Desconexoes: ");
    Serial.print(totalDesconexoes);
    Serial.print(" | Heap: ");
    Serial.print(esp_get_free_heap_size() / 1024);
    Serial.println(" KB");
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n# ========================================================");
  Serial.println("# Firmware: ESP32_Palmilha_3_FSR_Calibrado_3_SENSORES_On_OFF");
  Serial.println("# Mapeamento Ativo:");
  Serial.println("#   - M1:       GPIO 36 (VP - 11dB) -> Calibracao x1.413 (Alvo ~498 ADC)");
  Serial.println("#   - M5:       GPIO 39 (VN - 11dB) -> Calibracao x1.000 (Base ~489 ADC)");
  Serial.println("#   - Calcaneo: GPIO 33 (0dB Real)   -> Calibracao x2.116 (Validado ~498 ADC)");
  Serial.println("# Alvo unificado com 5kg: ~490-498 ADC em todos os 3 sensores");
  Serial.println("# Suporte a Wake-up por Pisada e Botao de Reset Fisico");
  Serial.println("# ========================================================");

  // Emite relatório detalhado sobre por que o microcontrolador reiniciou
  diagnosticarMotivoReset();

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

  // ── DETECÇÃO DO MOTIVO DE INICIALIZAÇÃO ────────────────────────────────────
  esp_sleep_wakeup_cause_t motivoWakeup = esp_sleep_get_wakeup_cause();
  if (motivoWakeup == ESP_SLEEP_WAKEUP_EXT0) {
    // Acordado por pisada ou compressão no sensor (GPIO 33)
    Serial.println("# [BOOT] ACORDADO POR PRESSAO/PISADA NO SENSOR (GPIO 33)!");
    for (uint8_t i = 0; i < 2; ++i) {
      digitalWrite(PINO_LED_STATUS, LED_ON);
      delay(250);
      digitalWrite(PINO_LED_STATUS, LED_OFF);
      delay(150);
    }
    digitalWrite(PINO_LED_STATUS, LED_ON);

    // Como o paciente pisou para ligar, aplica taras nominais de repouso seguras
    adcTara[0] = 50;
    adcTara[1] = 50;
    adcTara[2] = 50;
    taraConcluida = true;
    Serial.println("# [BOOT] Taras nominais aplicadas (pisada ativa detectada).");
  } else {
    // Inicialização normal (botão Reset ou cabo USB): calibra tara em repouso
    executarTaraRepouso();
  }

  // Inicializa sistema de arquivos Flash LittleFS para Datalogger Autônomo
  inicializarLittleFS();

  // Inicializa Bluetooth
  inicializarBLE();

  ultimaAmostra = millis();

  // Cabeçalho CSV Serial (Telemetria Física Completa: RAW, mV, kOhm, Calibrado)
  Serial.println("t_ms,seq,M1_raw,M1_mV,M1_kOhm,M1_cal,M5_raw,M5_mV,M5_kOhm,M5_cal,Calc_raw,Calc_mV,Calc_kOhm,Calc_cal");
}

void loop() {
  atualizarLedStatus();

  uint32_t agora = millis();

  // Emite batimento cardíaco com status a cada 5s no Monitor Serial
  emitirDiagnosticoPeriodico(agora);

  // ── GESTÃO INTELIGENTE DE ENERGIA (AUTO-DESLIGAMENTO POR INATIVIDADE) ─────
  bool conectado = (servidorBLE && servidorBLE->getConnectedCount() > 0);
  if (!conectado) {
    if (inicioSemConexao == 0) inicioSemConexao = agora;
    // Se ficar mais de 15 minutos desconectado do Bluetooth, desliga a palmilha
    if (uint32_t(agora - inicioSemConexao) >= TEMPO_LIMITE_INATIVO_MS) {
      entrarDeepSleep("Inatividade (15 minutos desconectado do BLE)");
    }
  } else {
    inicioSemConexao = 0; // Reinicia o cronômetro enquanto houver conexão ativa
  }

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

    // 2. Transmissão BLE se estiver conectado OU gravação na memória Flash LittleFS se desconectado
    if (conectado) {
      publicarBLE(agora);
    } else {
      gravarAmostraOffline(agora, adcCalibrado[0], adcCalibrado[1], adcCalibrado[2]);
    }
  }
}

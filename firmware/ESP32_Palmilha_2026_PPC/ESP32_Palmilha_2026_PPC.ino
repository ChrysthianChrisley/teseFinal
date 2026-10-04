/*
  Palmilha - bancada eletrica, 04/10/2026.
  Derivado de ESP32_Palmilha_2026.ino; o arquivo recebido permanece intacto.
  Hardware fotografado: LOLIN32 V1.0.0, e nao D32.
  R1 nominal 10k -> VP/36/calcaneo; R2 -> VN/39/M1; R3 -> 33/M5.
  AHT10: SDA21, SCL22, endereco 0x38.
  GPIO35 NAO tem divisor interno de bateria nesta LOLIN32.
  VBAT e percentual de carga nao sao medidos por este sketch.
  Os numeros dos FSRs sao ADC/mV, nao pressao ou forca calibrada.
  As conversoes raw e mV sao amostras separadas, feitas em sequencia.
  Periodo alvo FSR: 100ms. Verifique t_ms e dt_ms no registro real.
  AHT10: conversao em etapas, a cada 2s, sem delay(80) no loop.
  BLE opcional: desligado por padrao para o primeiro teste via Serial.
*/
#include <Arduino.h>
#include <Wire.h>
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
const char *UUID_DADOS = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
uint32_t ultimoAvisoMTU = 0;
#endif

const uint8_t PINOS_FSR[3] = {36, 39, 33}; // Calcaneo, M1, M5
const uint8_t PINO_SDA = 21;
const uint8_t PINO_SCL = 22;
uint8_t enderecoAHT = 0x38;
const uint8_t NUM_AMOSTRAS = 10;
const uint32_t PERIODO_FSR_MS = 100;
const uint32_t PERIODO_AHT_MS = 2000;
const uint32_t CONVERSAO_AHT_MS = 80;
const uint32_t LIMITE_AHT_MS = 200;

int adcBruto[3] = {0, 0, 0};
int adcMedia[3] = {0, 0, 0};
uint32_t milivolts[3] = {0, 0, 0};
int historico[3][NUM_AMOSTRAS] = {};
uint32_t somas[3] = {0, 0, 0};
uint8_t indiceFiltro = 0;
uint8_t quantidadeFiltro = 0;
uint32_t ultimaAmostra = 0;
uint32_t sequencia = 0;

// ── TARA DE REPOUSO / COMPENSACAO DE PRE-CARGA MECANICA ──
#ifndef HABILITAR_TARA
#define HABILITAR_TARA 1
#endif
int adcTara[3] = {0, 0, 0};
int adcLiquido[3] = {0, 0, 0};
bool taraConcluida = false;

bool ahtInicializado = false;
bool ahtValido = false;
bool ahtConvertendo = false;
float temperaturaC = NAN;
float umidadeRH = NAN;
uint8_t erroAHT = 1;
uint32_t ultimoDisparoAHT = 0;
uint32_t ultimaConsultaAHT = 0;

// erroAHT: 0=sem erro/aguardando; 1=init; 2=I2C; 3=bytes;
//          4=ocupado alem do prazo; 5=calibracao nao habilitada.
// ahtValido distingue leitura valida de espera inicial ou erro.
void invalidarAHT(uint8_t erro) {
  erroAHT = erro;
  ahtValido = false;
  ahtConvertendo = false;
  temperaturaC = NAN;
  umidadeRH = NAN;
}

void escanearBarramentoI2C() {
  Serial.println("# --- Varredura do Barramento I2C (SDA=21, SCL=22) ---");
  uint8_t encontrados = 0;
  for (uint8_t endereco = 1; endereco < 127; ++endereco) {
    Wire.beginTransmission(endereco);
    uint8_t erro = Wire.endTransmission();
    if (erro == 0) {
      Serial.print("# [OK] Dispositivo I2C encontrado no endereco 0x");
      if (endereco < 16) Serial.print('0');
      Serial.print(endereco, HEX);
      if (endereco == 0x38 || endereco == 0x39) {
        Serial.println(" -> Sensor AHT10/AHT20 detectado!");
        enderecoAHT = endereco;
      } else if (endereco == 0x3C || endereco == 0x3D) {
        Serial.println(" -> Display OLED detectado!");
      } else {
        Serial.println();
      }
      ++encontrados;
    }
  }
  if (encontrados == 0) {
    Serial.println("# [ALERTA] Nenhum dispositivo I2C respondeu no barramento!");
    Serial.println("# Possiveis causas fisicas:");
    Serial.println("# 1) Fios SDA (GPIO 21) e SCL (GPIO 22) invertidos no modulo AHT10.");
    Serial.println("# 2) Falta de alimentacao no sensor (conferir pinos VCC 3.3V e GND).");
    Serial.println("# 3) Mau contato ou fios partidos no chicote de 4 vias.");
  }
  Serial.println("# ----------------------------------------------------");
}

bool inicializarAHT10() {
  pinMode(PINO_SDA, INPUT_PULLUP);
  pinMode(PINO_SCL, INPUT_PULLUP);
  Wire.begin(PINO_SDA, PINO_SCL, 100000);
  Wire.setTimeOut(50);
  delay(40);

  // Testa endereco 0x38 e 0x39
  Wire.beginTransmission(enderecoAHT);
  if (Wire.endTransmission() != 0) {
    Wire.beginTransmission(0x39);
    if (Wire.endTransmission() == 0) {
      enderecoAHT = 0x39;
    } else {
      Wire.beginTransmission(0x38);
      if (Wire.endTransmission() == 0) {
        enderecoAHT = 0x38;
      } else {
        return false; // Nao respondeu nem em 0x38 nem em 0x39
      }
    }
  }

  // Soft Reset (0xBA)
  Wire.beginTransmission(enderecoAHT);
  Wire.write(0xBA);
  Wire.endTransmission();
  delay(30);

  // Inicializacao/Calibracao compativel com AHT10 (0xE1) e AHT20 (0xBE)
  Wire.beginTransmission(enderecoAHT);
  Wire.write(0xE1);
  Wire.write(0x08);
  Wire.write(0x00);
  Wire.endTransmission();
  delay(20);

  Wire.beginTransmission(enderecoAHT);
  Wire.write(0xBE);
  Wire.write(0x08);
  Wire.write(0x00);
  Wire.endTransmission();
  delay(30);

  // Aguarda sensor sair de ocupado (bit 7 = 0)
  uint32_t inicio = millis();
  while (uint32_t(millis() - inicio) < LIMITE_AHT_MS) {
    if (Wire.requestFrom(enderecoAHT, size_t(1)) == 1) {
      uint8_t status = uint8_t(Wire.read());
      if (!(status & 0x80)) {
        return true;
      }
    }
    delay(10);
  }
  return true;
}

void atualizarAHT10() {
  uint32_t agora = millis();

  // Auto-recuperacao: tenta reconectar a cada 3s se nao detectado inicialmente
  if (!ahtInicializado) {
    if (uint32_t(agora - ultimoDisparoAHT) >= 3000) {
      ultimoDisparoAHT = agora;
      ahtInicializado = inicializarAHT10();
      if (ahtInicializado) {
        erroAHT = 0;
        Serial.println("# AHT10/AHT20: Conexao estabelecida com sucesso!");
      }
    }
    return;
  }

  if (!ahtConvertendo) {
    if (uint32_t(agora - ultimoDisparoAHT) < PERIODO_AHT_MS) return;
    ultimoDisparoAHT = agora;
    Wire.beginTransmission(enderecoAHT);
    Wire.write(0xAC);
    Wire.write(0x33);
    Wire.write(0x00);
    if (Wire.endTransmission() != 0) {
      invalidarAHT(2);
      ahtInicializado = false; // Se desconectou, reativa busca automatica
      return;
    }
    ahtConvertendo = true;
    ultimaConsultaAHT = agora;
    return;
  }

  uint32_t espera = uint32_t(agora - ultimoDisparoAHT);
  if (espera < CONVERSAO_AHT_MS || uint32_t(agora - ultimaConsultaAHT) < 10) return;
  ultimaConsultaAHT = agora;

  if (Wire.requestFrom(enderecoAHT, size_t(6)) != 6) {
    invalidarAHT(3);
    return;
  }

  uint8_t dados[6];
  for (uint8_t i = 0; i < 6; ++i) dados[i] = uint8_t(Wire.read());

  // Se o chip ainda sinalizar ocupado, aguarda a proxima consulta
  if (dados[0] & 0x80) {
    if (espera >= LIMITE_AHT_MS) invalidarAHT(4);
    return;
  }

  uint32_t rawRH = (uint32_t(dados[1]) << 12) |
                   (uint32_t(dados[2]) << 4) | (uint32_t(dados[3]) >> 4);
  uint32_t rawT = (uint32_t(dados[3] & 0x0F) << 16) |
                  (uint32_t(dados[4]) << 8) | uint32_t(dados[5]);

  float hum = float(rawRH) * 100.0f / 1048576.0f;
  float temp = float(rawT) * 200.0f / 1048576.0f - 50.0f;

  if (hum >= 0.0f && hum <= 100.0f && temp >= -20.0f && temp <= 85.0f) {
    umidadeRH = hum;
    temperaturaC = temp;
    ahtValido = true;
    erroAHT = 0;
    ahtConvertendo = false;
  } else {
    invalidarAHT(5);
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
    if (taraConcluida) {
      int liq = adcMedia[i] - adcTara[i];
      adcLiquido[i] = (liq > 0) ? liq : 0;
    } else {
      adcLiquido[i] = adcMedia[i];
    }
#else
    adcLiquido[i] = adcMedia[i];
#endif
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
    Serial.print(','); Serial.print(milivolts[i]);
  }
  Serial.print(','); Serial.print(ahtValido ? 1 : 0);
  Serial.print(',');
  if (ahtValido) Serial.print(temperaturaC, 2); else Serial.print("NA");
  Serial.print(',');
  if (ahtValido) Serial.print(umidadeRH, 2); else Serial.print("NA");
  Serial.print(','); Serial.println(erroAHT);
}

#if HABILITAR_BLE
void inicializarBLE() {
  // Nome formatado conforme versionamento semantico (v5.0).
  BLEDevice::init("Palmilha_v5.0");
  BLEDevice::setMTU(185); // MTU local; nao garante negociacao pelo cliente.
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
  anuncio->setMinPreferred(0x06); // Ajuda na descoberta por smartphones Android/iOS
  anuncio->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
}

void publicarBLE(uint32_t agora) {
  String pacote = "{\"calcaneo\":" + String(adcLiquido[0]) +
                  ",\"meta1\":" + String(adcLiquido[1]) +
                  ",\"meta5\":" + String(adcLiquido[2]) +
                  ",\"calc_raw\":" + String(adcMedia[0]) +
                  ",\"tara_calc\":" + String(adcTara[0]) +
                  ",\"temp\":" + (ahtValido ? String(temperaturaC, 1) : String("null")) +
                  ",\"umid\":" + (ahtValido ? String(umidadeRH, 1) : String("null")) +
                  ",\"seq\":" + String(sequencia) + ",\"t_ms\":" + String(agora) + "}";
  caracteristicaBLE->setValue(pacote.c_str()); // READ disponivel mesmo antes de negociar MTU.
  if (servidorBLE->getConnectedCount() != 1) return; // Bancada: um cliente por vez.
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
  Serial.println("# Palmilha bancada - LOLIN32 V1.0.0");
  Serial.println("# Calcaneo=VP/36; M1=VN/39; M5=33; AHT10 SDA21/SCL22");
  Serial.println("# VBAT indisponivel: placa sem divisor interno em GPIO35.");
  Serial.println("# ADC raw e mV sao conversoes separadas; conferir mV com multimetro.");
  Serial.println("# Media de ate 10 amostras; raw/mV permanecem sem corte de ruido.");
  analogReadResolution(12);
  for (uint8_t i = 0; i < 3; ++i) {
    pinMode(PINOS_FSR[i], INPUT);
    analogSetPinAttenuation(PINOS_FSR[i], ADC_11db);
  }

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

  escanearBarramentoI2C();
  ahtInicializado = inicializarAHT10();
  if (ahtInicializado) {
    erroAHT = 0;
    Serial.print("# AHT10/AHT20: Calibrado com sucesso no endereco 0x");
    Serial.println(enderecoAHT, HEX);
  } else {
    invalidarAHT(1);
    Serial.println("# AHT10/AHT20: Falha no boot; ambiente=NA. O firmware tentara reconectar automaticamente a cada 3s.");
  }
#if HABILITAR_BLE
  inicializarBLE();
  Serial.println("# BLE habilitado: Palmilha_v5.0, JSON; exige MTU negociada suficiente.");
#else
  Serial.println("# BLE desligado para bancada. HABILITAR_BLE=1 habilita modo opcional.");
#endif
  ultimoDisparoAHT = millis() - PERIODO_AHT_MS; // Primeira conversao imediatamente.
  ultimaAmostra = millis();
  Serial.println("t_ms,dt_ms,seq,calc_raw,calc_media,calc_mV,m1_raw,m1_media,m1_mV,m5_raw,m5_media,m5_mV,aht_ok,temp_C,umid_pct,aht_erro");
}

void loop() {
  atualizarAHT10();
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

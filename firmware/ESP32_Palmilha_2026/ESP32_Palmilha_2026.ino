/*
  ====================================================================================
  PROJETO: Palmilha Instrumentada para Monitoramento Preventivo do Pé Diabético
  MESTRADO PROFISSIONAL EM TELESSAÚDE (PPGTS / UERJ) - 2026
  Autor: Chrysthian Chrisley
  Orientadora: Prof.ª Dr.ª Rosa Maria Esteves Moreira da Costa

  HARDWARE OFICIAL (VALIDADO VIA SCHEMATIC E PINOUT WEMOS LOLIN32 V1.0.0):
  - Documentação de Referência:
      * Datasheets/schematic_wemos_lolin32_v1.0.0.pdf (Header P2 e P3)
      * Datasheets/ESP32-WeMos-LOLIN32-pinout-mischianti.png
  
  MAPEAMENTO EXATO DOS PINOS (CABEÇALHO ESQUERDO P2):
  - Furo 1: 3.3V (Alimentação VCC)
  - Furo 2: EN (Reset)
  - Furo 3: VP / GPIO 36 (ADC1_CH0)  -> Resistor 1 (R1: 9.24k) -> Calcâneo (Retropé)
  - Furo 4: VN / GPIO 39 (ADC1_CH3)  -> Resistor 2 (R2: 9.30k) -> 1º Metatarso / M1 (Antepé Medial)
  - Furo 5: GPIO 32                  -> Vazio (pulado no layout da PCB)
  - Furo 6: IO33 / GPIO 33 (ADC1_CH5)-> Resistor 3 (R3: 9.62k) -> 5º Metatarso / M5 (Antepé Lateral)

  SENSOR DIGITAL DE TEMPERATURA E UMIDADE (AHT10 NO BARRAMENTO I2C):
  - SDA: GPIO 21 (Header P3 Pino 6)
  - SCL: GPIO 22 (Header P3 Pino 5)

  NOTA SOBRE A BATERIA (LOLIN32 V1.0.0):
  - Conforme o esquemático oficial Rev 1.0.0, a placa NÃO possui divisor resistivo interno
    no GPIO 35 (o pino BAT do TP4054 vai direto para o conector JST PH-2). Portanto,
    a leitura analógica interna de bateria foi desativada no modo de bancada.
  ====================================================================================
*/

#include <Wire.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ----------------------------------------------------------------------------------
// CONFIGURAÇÃO DOS PINOS EXATOS (WEMOS LOLIN32 V1.0.0)
// ----------------------------------------------------------------------------------
const int pinFSR_Calcaneo = 36; // 3º Furo: VP (ADC1_CH0)   - Resistor 1 (Calcâneo)
const int pinFSR_M1       = 39; // 4º Furo: VN (ADC1_CH3)   - Resistor 2 (1º Metatarso)
const int pinFSR_M5       = 33; // 6º Furo: IO33 (ADC1_CH5) - Resistor 3 (5º Metatarso)

// Barramento I2C para sensor digital AHT10
const int pinI2C_SDA      = 21; // Barramento I2C Dados
const int pinI2C_SCL      = 22; // Barramento I2C Clock

#define AHT10_I2C_ADDR 0x38

// ----------------------------------------------------------------------------------
// CONFIGURAÇÃO DO FILTRO DE MÉDIA MÓVEL (SENSORES DE PRESSÃO)
// ----------------------------------------------------------------------------------
const int NUM_AMOSTRAS = 10;
int leiturasCalcaneo[NUM_AMOSTRAS];
int leiturasM1[NUM_AMOSTRAS];
int leiturasM5[NUM_AMOSTRAS];
int idxFiltro = 0;
long somaCalcaneo = 0;
long somaM1 = 0;
long somaM5 = 0;

// ----------------------------------------------------------------------------------
// CONFIGURAÇÃO DO BLUETOOTH LOW ENERGY (BLE 4.2)
// ----------------------------------------------------------------------------------
#define SERVICE_UUID        "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

BLEServer* pServer = NULL;
BLECharacteristic* pCharacteristic = NULL;
bool deviceConnected = false;

class MyServerCallbacks: public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    deviceConnected = true;
    Serial.println("\n>>> [BLE] Dispositivo conectado com sucesso!");
  };

  void onDisconnect(BLEServer* pServer) {
    deviceConnected = false;
    Serial.println("\n<<< [BLE] Dispositivo desconectado! Reiniciando anúncio...");
    BLEDevice::startAdvertising();
  }
};

// ----------------------------------------------------------------------------------
// VARIÁVEIS GLOBAIS DE MEDIÇÃO
// ----------------------------------------------------------------------------------
int rawCalc = 0, rawM1 = 0, rawM5 = 0;
int pressaoCalcaneo = 0, pressaoM1 = 0, pressaoM5 = 0;

float tensaoCalcaneo_V = 0.0;
float tensaoM1_V       = 0.0;
float tensaoM5_V       = 0.0;

float tempC      = 0.0;
float umidRH     = 0.0;
bool ahtPresente = false;

// ----------------------------------------------------------------------------------
// DRIVER NATIVO I2C PARA O SENSOR AHT10
// ----------------------------------------------------------------------------------
bool inicializarAHT10() {
  Wire.begin(pinI2C_SDA, pinI2C_SCL);
  delay(100);
  
  Wire.beginTransmission(AHT10_I2C_ADDR);
  Wire.write(0xE1); // Inicialização / calibração
  Wire.write(0x08);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) {
    return false;
  }
  delay(50);
  return true;
}

bool lerAHT10(float &temperatura, float &umidade) {
  Wire.beginTransmission(AHT10_I2C_ADDR);
  Wire.write(0xAC);
  Wire.write(0x33);
  Wire.write(0x00);
  if (Wire.endTransmission() != 0) return false;

  delay(80);

  if (Wire.requestFrom(AHT10_I2C_ADDR, 6) != 6) {
    return false;
  }

  uint8_t buffer[6];
  for (int i = 0; i < 6; i++) {
    buffer[i] = Wire.read();
  }

  if ((buffer[0] & 0x80) != 0) return false;

  uint32_t rawUmid = (((uint32_t)buffer[1] << 12) | ((uint32_t)buffer[2] << 4) | ((uint32_t)buffer[3] >> 4));
  umidade = ((float)rawUmid * 100.0) / 1048576.0;

  uint32_t rawTemp = ((((uint32_t)buffer[3] & 0x0F) << 16) | ((uint32_t)buffer[4] << 8) | (uint32_t)buffer[5]);
  temperatura = (((float)rawTemp * 200.0) / 1048576.0) - 50.0;

  return true;
}

// ----------------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==========================================================================");
  Serial.println("  PALMILHA PREVENTIVA DE PE DIABETICO - BANCADA DE CALIBRACAO             ");
  Serial.println("  Microcontrolador: WEMOS LOLIN32 V1.0.0 (Oficial)                        ");
  Serial.println("  Mapeamento: Calcaneo=GPIO36 (P2.3) | M1=GPIO39 (P2.4) | M5=GPIO33 (P2.6)");
  Serial.println("==========================================================================");

  // Resolução do conversor AD para 12 bits (0 a 4095) com faixa completa de 3.3V
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // Inicializa I2C AHT10
  Serial.print("[I2C] Inicializando sensor AHT10 (SDA=21, SCL=22)... ");
  ahtPresente = inicializarAHT10();
  if (ahtPresente) {
    Serial.println("OK (Detectado)");
  } else {
    Serial.println("AVISO: AHT10 nao detectado no barramento I2C.");
  }

  // Preenchimento inicial do filtro de média móvel
  int initCalc = analogRead(pinFSR_Calcaneo);
  int initM1   = analogRead(pinFSR_M1);
  int initM5   = analogRead(pinFSR_M5);
  for (int i = 0; i < NUM_AMOSTRAS; i++) {
    leiturasCalcaneo[i] = initCalc;
    leiturasM1[i]       = initM1;
    leiturasM5[i]       = initM5;
    somaCalcaneo += initCalc;
    somaM1       += initM1;
    somaM5       += initM5;
  }

  // Inicialização do Servidor BLE
  Serial.print("[BLE] Inicializando Servidor BLE ('ESP32_Palmilha')... ");
  BLEDevice::init("ESP32_Palmilha");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);
  pCharacteristic = pService->createCharacteristic(
                      CHARACTERISTIC_UUID,
                      BLECharacteristic::PROPERTY_READ |
                      BLECharacteristic::PROPERTY_NOTIFY
                    );
  pCharacteristic->addDescriptor(new BLE2902());
  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();
  Serial.println("OK (Aguardando conexao BLE)");

  Serial.println("\n--- BANCADA ATIVA: Leituras formatadas para comparacao direta com Multimetro ---\n");
}

// ----------------------------------------------------------------------------------
// LOOP PRINCIPAL (Ciclo de Aquisicao a 10 Hz / 100 ms)
// ----------------------------------------------------------------------------------
void loop() {
  // 1. Leitura analógica bruta
  rawCalc = analogRead(pinFSR_Calcaneo);
  rawM1   = analogRead(pinFSR_M1);
  rawM5   = analogRead(pinFSR_M5);

  // 2. Filtro de Média Móvel
  somaCalcaneo -= leiturasCalcaneo[idxFiltro];
  somaM1       -= leiturasM1[idxFiltro];
  somaM5       -= leiturasM5[idxFiltro];

  leiturasCalcaneo[idxFiltro] = rawCalc;
  leiturasM1[idxFiltro]       = rawM1;
  leiturasM5[idxFiltro]       = rawM5;

  somaCalcaneo += rawCalc;
  somaM1       += rawM1;
  somaM5       += rawM5;

  idxFiltro = (idxFiltro + 1) % NUM_AMOSTRAS;

  pressaoCalcaneo = somaCalcaneo / NUM_AMOSTRAS;
  pressaoM1       = somaM1 / NUM_AMOSTRAS;
  pressaoM5       = somaM5 / NUM_AMOSTRAS;

  // Limiar de ruído elétrico de bancada
  if (pressaoCalcaneo < 25) pressaoCalcaneo = 0;
  if (pressaoM1 < 25) pressaoM1 = 0;
  if (pressaoM5 < 25) pressaoM5 = 0;

  // 3. Conversão Direta para Tensão Real em Volts (0.00 V a 3.30 V)
  // Permite conferir o multímetro exatamente contra o monitor serial!
  tensaoCalcaneo_V = ((float)pressaoCalcaneo / 4095.0) * 3.30;
  tensaoM1_V       = ((float)pressaoM1 / 4095.0) * 3.30;
  tensaoM5_V       = ((float)pressaoM5 / 4095.0) * 3.30;

  // 4. Leitura do AHT10 a cada 1 segundo (10 ciclos)
  static int contadorCiclos = 0;
  contadorCiclos++;
  if (contadorCiclos >= 10) {
    contadorCiclos = 0;
    if (ahtPresente) {
      lerAHT10(tempC, umidRH);
    }
  }

  // 5. Exibição no Monitor Serial com Comparativo Direto [ADC -> Volts]
  Serial.print("[CALCANHAR (P36)]: ");
  Serial.print(tensaoCalcaneo_V, 2);
  Serial.print("V (ADC: ");
  Serial.print(pressaoCalcaneo);
  Serial.print(") | [M1 (P39)]: ");
  Serial.print(tensaoM1_V, 2);
  Serial.print("V (ADC: ");
  Serial.print(pressaoM1);
  Serial.print(") | [M5 (P33)]: ");
  Serial.print(tensaoM5_V, 2);
  Serial.print("V (ADC: ");
  Serial.print(pressaoM5);
  Serial.print(") | [I2C AHT10] T: ");
  Serial.print(tempC, 1);
  Serial.print("C | U: ");
  Serial.print(umidRH, 1);
  Serial.println("%");

  // 6. Transmissão Bluetooth Low Energy
  if (deviceConnected) {
    String pacoteDados = "Calc=" + String(pressaoCalcaneo) + 
                         ",M1=" + String(pressaoM1) + 
                         ",M5=" + String(pressaoM5) + 
                         ",temp=" + String(tempC, 1) + 
                         ",umid=" + String(umidRH, 1);
    pCharacteristic->setValue(pacoteDados.c_str());
    pCharacteristic->notify();
  }

  delay(100); // 10 Hz
}

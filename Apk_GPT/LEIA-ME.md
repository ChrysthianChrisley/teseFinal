# Monitor Plantar UERJ — APK

O aplicativo incorpora a interface do site (`index.html`, JavaScript, CSS, imagens e fontes) e funciona sem carregar o GitHub Pages. O Bluetooth e o armazenamento ficam em um serviço Android nativo, independente da tela da interface. O mapa e os alertas visuais são atualizados ao retornar à tela; a notificação em segundo plano informa o estado da coleta.

## Instalar e usar

1. Copie **MonitorPlantar-GPT.apk** para o celular Android e abra o arquivo. Se solicitado, permita instalar aplicativos dessa origem.
2. Abra **Monitor Plantar UERJ**, ligue a palmilha e toque em **Conectar BLE**. Autorize Bluetooth/Dispositivos próximos e notificações; selecione a palmilha encontrada. No Android 7–11, a busca BLE também exige autorização e ativação da Localização.
3. Após conectar, a coleta começa automaticamente. Uma notificação persistente indica o serviço ativo. Pode alternar de aplicativo ou apagar a tela; o serviço continua recebendo e salvando as notificações BLE.
4. Ao voltar, a interface lê os pacotes armazenados durante o período em segundo plano. Os botões **CSV** e **Compartilhar** exportam diretamente o registro nativo completo, mesmo enquanto a interface ainda atualiza o histórico.
5. Para encerrar, use **Desconectar BLE** ou **Parar coleta** na notificação. As sessões ficam no histórico local do aplicativo.

Compatível com Android **7.0 ou superior** (API 24+), com Bluetooth Low Energy. Não é necessário acesso à internet para abrir a interface ou coletar dados.

## Conferência no celular

O APK foi compilado e inspecionado neste computador. A recepção BLE real e a autonomia precisam ser verificadas com a palmilha no seu aparelho; nenhum celular/emulador estava conectado durante a criação.

Para conferir: conecte a palmilha, anote a quantidade de amostras, apague a tela por cinco minutos e abra o aplicativo novamente. Aguarde a atualização da interface e exporte o CSV. Verifique a continuidade de `recebido_epoch_ms` e `seq` no intervalo com a tela apagada. Repita alternando para outro aplicativo. Isso também permite observar perdas por distância ou desligamento da palmilha.

Nas configurações de bateria do celular, permita o uso sem restrições para **Monitor Plantar UERJ**, se o fabricante oferecer essa opção. O serviço usa notificação e bloqueio parcial de CPU; não mantém a tela acesa. **Forçar parada**, reiniciar o aparelho, revogar Bluetooth ou encerrar o serviço pelo Android interrompe a coleta. Depois, é necessário abrir e reconectar. Os dados já salvos permanecem no aplicativo. Desinstalar o APK ou limpar seus dados remove esse armazenamento.

## Dados e CSV

Os pacotes originais ficam em SQLite privado do aplicativo (`monitor_packets.db`), separados por sessão. A gravação ocorre antes de confirmar a sincronização offline. O serviço só envia `PURGE` ao ESP32 depois de confirmar o total esperado, o total recebido e a gravação dos lotes no armazenamento nativo. Os registros offline também são preservados no celular. Se uma transferência for interrompida e repetida, a visualização e o CSV consolidam itens offline idênticos (tempo do dispositivo e três leituras) até a confirmação de limpeza da memória; os pacotes brutos continuam preservados. O firmware não fornece identificador de inicialização, então itens idênticos após um reinício sem sinal de reinício/limpeza podem ser indistinguíveis de retransmissões.

O CSV nativo contém:

| Campo | Significado |
| --- | --- |
| `origem` | `ao_vivo` ou `offline` |
| `recebido_epoch_ms`, `recebido_iso` | Horário em que o celular recebeu o pacote |
| `dispositivo_t_ms` | Contador em milissegundos informado pelo ESP32 |
| `seq` | Sequência informada pelo firmware, quando disponível |
| `meta1_adc`, `meta5_adc`, `calcaneo_adc` | Leituras dos sensores |
| `temp_c`, `umidade_pct` | Microclima, quando disponível |
| `pacote_id` | Identificador persistente do pacote no celular |

Em amostras `offline`, o horário de recebimento é o momento do download da palmilha; o instante original de coleta só está disponível como contador `dispositivo_t_ms`. Isso evita atribuir um horário civil de coleta que o firmware não fornece. O histórico informa **pacotes**; um lote offline pode conter várias amostras.

A interface mantém um cache de visualização de até 24 horas. O CSV nativo exporta a sessão completa armazenada. Limpar a sessão da tela limpa a visualização; preserva as sessões nativas. Os dados não são enviados automaticamente a servidores.

## Recompilar

O projeto está nesta pasta; os arquivos originais do site não foram alterados.

```powershell
cd C:\Users\cytch\Documents\GitHub\teseFinal\Apk_GPT
.\Compilar.ps1
```

O script atualiza os assets empacotados a partir de `web/`, compila e copia o APK e seu SHA-256 para esta pasta. Para modificar a interface do APK, edite os arquivos em `web/`. A adaptação Android está em `web/android.js` e nas classes Java em `android/app/src/main/java/br/uerj/ppgts/monitorplantar/`.

Requisitos: Node.js 22+, JDK 21+ e Android SDK com plataforma 36 e Build Tools 35.0.0. O SDK instalado durante esta criação está em `tools/android-sdk`; o script procura esse SDK e também `ANDROID_HOME`/`ANDROID_SDK_ROOT`. Neste computador, usa o JDK 22 existente. As dependências Capacitor podem ser reutilizadas de `../node_modules`. Para levar o projeto a outro computador, execute `npm ci` nesta pasta e configure o SDK/JDK.

O APK usa a assinatura de desenvolvimento local do Android, adequada à instalação direta. Atualizações precisam conservar a mesma chave de assinatura (`%USERPROFILE%\.android\debug.keystore`). Se já existir um APK do mesmo pacote assinado com outra chave, o Android pode exigir sua desinstalação; exporte os dados desse aplicativo antes de desinstalar.

O ícone usa o mesmo caminho SVG da pegada branca no cabeçalho do index, sobre fundo verde `#0f766e`, em formato vetorial/adaptativo Android.

Referências da implementação: [BLE em segundo plano](https://developer.android.com/develop/connectivity/bluetooth/ble/background) e [serviço do tipo connectedDevice](https://developer.android.com/develop/background-work/services/fgs/service-types#connected-device).

package br.uerj.ppgts.monitorplantar;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.UUID;

/** Foreground BLE owner. All GATT and database writes run on one worker, never in the Activity. */
public final class MonitorBleService extends Service {
    public static final String ACTION_CONNECT = "br.uerj.ppgts.monitorplantar.CONNECT";
    public static final String ACTION_DISCONNECT = "br.uerj.ppgts.monitorplantar.DISCONNECT";
    public static final String ACTION_WRITE = "br.uerj.ppgts.monitorplantar.WRITE";
    public static volatile MonitorBleService instance;
    private static final UUID SERVICE_UUID = UUID.fromString("4fafc201-1fb5-459e-8fcc-c5c9c331914b");
    private static final UUID CHARACTERISTIC_UUID = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a8");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private static final String CHANNEL = "monitor_ble_collection";
    private static final int NOTIFICATION_ID = 1701;
    private static final String PREFS = "monitor_ble_status";
    private static final long OP_TIMEOUT_MS = 20000;
    private volatile String statusJson = "{}";
    private HandlerThread thread;
    private Handler worker;
    private PowerManager.WakeLock wakeLock;
    private SharedPreferences preferences;
    private PacketStore store;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic characteristic;
    private BluetoothGattDescriptor cccd;
    private boolean active, connecting, connected, stopped, canWrite;
    private String address = "", name = "", sessionId = "", error = "";
    private long startTime, packetCount, lastPacketStatusAt;
    private int reconnectAttempt;
    private String operation;
    private String writingCommand;
    private Runnable operationTimeout, connectTimeout, reconnectTask, transferTimeout;
    private final ArrayDeque<String> commands = new ArrayDeque<>();
    private final HashSet<String> pendingCommands = new HashSet<>();
    private boolean syncInProgress, syncValid, purgePending, syncWriteConfirmed;
    private long syncExpected = -1, syncReceived;
    private String syncError = "";

    @Override public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        thread = new HandlerThread("MonitorBleCollection");
        thread.start();
        worker = new Handler(thread.getLooper());
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":BleCollection");
        wakeLock.setReferenceCounted(false);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Coleta Bluetooth da palmilha",
                NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Mantém a conexão e o armazenamento das amostras em segundo plano.");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
        instance = this;
        publish();
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        if (ACTION_CONNECT.equals(action)) {
            // Required immediately after startForegroundService, before asynchronous setup.
            try {
                Notification notification = notification("Iniciando conexão Bluetooth...");
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
                else startForeground(NOTIFICATION_ID, notification);
                String requestedAddress = intent.getStringExtra("address");
                String requestedName = intent.getStringExtra("name");
                worker.post(() -> begin(requestedAddress, requestedName));
            } catch (RuntimeException exception) {
                worker.post(() -> stopCollection("Não foi possível iniciar a coleta: " + message(exception)));
            }
        } else if (ACTION_DISCONNECT.equals(action)) {
            worker.post(() -> stopCollection(""));
        } else if (ACTION_WRITE.equals(action)) {
            String command = intent.getStringExtra("command");
            worker.post(() -> externalCommand(command));
        } else {
            if (!active) stopSelf();
        }
        // Explicit user connect is required after process death/force stop. Never revive a failed collection.
        return START_NOT_STICKY;
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    public JSONObject status() {
        try { return new JSONObject(statusJson); }
        catch (JSONException exception) { return new JSONObject(); }
    }

    public static JSONObject getStatus(Context context) {
        MonitorBleService current = instance;
        if (current != null) return current.status();
        JSONObject result;
        try { result = new JSONObject(context.getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString("status", "{}")); }
        catch (JSONException exception) { result = new JSONObject(); }
        boolean interrupted = result.optBoolean("active", false);
        put(result, "active", false);
        put(result, "connected", false);
        put(result, "connecting", false);
        put(result, "canWrite", false);
        if (!result.has("address")) put(result, "address", "");
        if (!result.has("name")) put(result, "name", "");
        if (!result.has("sessionId")) put(result, "sessionId", "");
        if (!result.has("startTime")) put(result, "startTime", 0);
        if (!result.has("error")) put(result, "error", "");
        if (interrupted && result.optString("error").isEmpty()) {
            put(result, "error", "A coleta foi interrompida pelo sistema. Reconecte para iniciar nova sessão.");
        }
        return result;
    }

    private void begin(String requestedAddress, String requestedName) {
        if (stopped) return;
        if (active && address.equals(requestedAddress)) { updateNotification(); return; }
        if (active) endSession();
        closeGatt();
        clearTimers();
        if (!BluetoothAdapter.checkBluetoothAddress(requestedAddress == null ? "" : requestedAddress)) {
            stopCollection("Endereço Bluetooth inválido.");
            return;
        }
        address = requestedAddress;
        name = requestedName == null || requestedName.trim().isEmpty() ? "Palmilha" : requestedName;
        startTime = System.currentTimeMillis();
        packetCount = 0;
        error = "";
        try {
            store = PacketStore.get(this);
            sessionId = store.openSession(name, address, startTime);
        } catch (RuntimeException exception) {
            stopCollection("Falha no armazenamento: " + message(exception) + ". Coleta parada; memória da palmilha preservada.");
            return;
        }
        active = true;
        connecting = true;
        connected = false;
        reconnectAttempt = 0;
        if (!wakeLock.isHeld()) wakeLock.acquire();
        publish();
        connect();
    }

    private void connect() {
        if (!active || stopped) return;
        closeGatt();
        resetTransfer();
        connecting = true;
        connected = false;
        publish();
        updateNotification();
        try {
            BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
            BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
            if (adapter == null) { stopCollection("Bluetooth não disponível neste aparelho."); return; }
            if (!adapter.isEnabled()) { retry("Bluetooth desativado. Aguardando ativação."); return; }
            BluetoothDevice device = adapter.getRemoteDevice(address);
            gatt = device.connectGatt(getApplicationContext(), false, callbacks, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) { retry("Não foi possível abrir a conexão Bluetooth."); return; }
            BluetoothGatt expectedGatt = gatt;
            connectTimeout = () -> { if (active && gatt == expectedGatt) retry("Tempo de conexão Bluetooth esgotado."); };
            worker.postDelayed(connectTimeout, 35000);
        } catch (SecurityException exception) {
            stopCollection("Permissão Bluetooth não concedida ou revogada.");
        } catch (RuntimeException exception) {
            retry("Falha na conexão Bluetooth: " + message(exception));
        }
    }

    private final BluetoothGattCallback callbacks = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt connection, int status, int newState) {
            worker.post(() -> {
                if (!current(connection)) return;
                if (status != BluetoothGatt.GATT_SUCCESS || newState == BluetoothProfile.STATE_DISCONNECTED) {
                    retry("Conexão perdida (GATT " + status + "). Reconectando...");
                } else if (newState == BluetoothProfile.STATE_CONNECTED) {
                    cancelConnectTimeout();
                    startOperation("MTU");
                    try { if (!connection.requestMtu(247)) retry("Não foi possível negociar o tamanho dos pacotes BLE."); }
                    catch (SecurityException exception) { stopCollection("Permissão Bluetooth revogada."); }
                }
            });
        }
        @Override public void onMtuChanged(BluetoothGatt connection, int mtu, int status) {
            worker.post(() -> {
                if (!current(connection) || !"MTU".equals(operation)) return;
                finishOperation();
                if (status != BluetoothGatt.GATT_SUCCESS || mtu < 185) {
                    stopCollection("A conexão BLE não negociou MTU mínimo de 185 bytes. As amostras offline foram preservadas.");
                    return;
                }
                startOperation("DISCOVER");
                try { if (!connection.discoverServices()) retry("Falha ao consultar serviços Bluetooth."); }
                catch (SecurityException exception) { stopCollection("Permissão Bluetooth revogada."); }
            });
        }
        @Override public void onServicesDiscovered(BluetoothGatt connection, int status) {
            worker.post(() -> {
                if (!current(connection) || !"DISCOVER".equals(operation)) return;
                finishOperation();
                if (status != BluetoothGatt.GATT_SUCCESS) { retry("Falha ao descobrir serviços BLE."); return; }
                BluetoothGattService service = connection.getService(SERVICE_UUID);
                characteristic = service == null ? null : service.getCharacteristic(CHARACTERISTIC_UUID);
                if (characteristic == null) { stopCollection("O dispositivo não oferece o serviço BLE da palmilha."); return; }
                cccd = characteristic.getDescriptor(CCCD_UUID);
                int properties = characteristic.getProperties();
                if (cccd == null || (properties & (BluetoothGattCharacteristic.PROPERTY_NOTIFY
                        | BluetoothGattCharacteristic.PROPERTY_INDICATE)) == 0) {
                    stopCollection("O dispositivo não oferece notificações BLE compatíveis."); return;
                }
                // Earlier MonitorPlantar firmware is notify-only. It still supports
                // live recording; only offline synchronization needs command writes.
                canWrite = (properties & (BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0;
                try {
                    if (!connection.setCharacteristicNotification(characteristic, true)) {
                        retry("Falha ao habilitar notificações BLE."); return;
                    }
                    byte[] value = (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0
                        ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE : BluetoothGattDescriptor.ENABLE_INDICATION_VALUE;
                    startOperation("CCCD");
                    boolean started;
                    if (Build.VERSION.SDK_INT >= 33) started = connection.writeDescriptor(cccd, value) == BluetoothStatusCodes.SUCCESS;
                    else { cccd.setValue(value); started = connection.writeDescriptor(cccd); }
                    if (!started) retry("Falha ao configurar notificações BLE.");
                } catch (SecurityException exception) { stopCollection("Permissão Bluetooth revogada."); }
            });
        }
        @Override public void onDescriptorWrite(BluetoothGatt connection, BluetoothGattDescriptor descriptor, int status) {
            worker.post(() -> {
                if (!current(connection) || !"CCCD".equals(operation) || !CCCD_UUID.equals(descriptor.getUuid())) return;
                finishOperation();
                if (status != BluetoothGatt.GATT_SUCCESS) { retry("A palmilha recusou a configuração de notificações."); return; }
                connected = true;
                connecting = false;
                reconnectAttempt = 0;
                error = "";
                publish();
                updateNotification();
                if (canWrite) enqueue("CHECK_STATUS");
            });
        }
        @Override public void onCharacteristicWrite(BluetoothGatt connection, BluetoothGattCharacteristic value, int status) {
            worker.post(() -> {
                if (!current(connection) || !"WRITE".equals(operation) || !CHARACTERISTIC_UUID.equals(value.getUuid())) return;
                String command = writingCommand;
                writingCommand = null;
                pendingCommands.remove(command);
                finishOperation();
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    retry("Falha na confirmação do comando BLE (GATT " + status + "). Reconectando..."); return;
                }
                if ("SYNC_START".equals(command)) syncWriteConfirmed = true;
                pump();
            });
        }
        @Override public void onCharacteristicChanged(BluetoothGatt connection, BluetoothGattCharacteristic value) {
            byte[] payload = value.getValue();
            if (payload != null && CHARACTERISTIC_UUID.equals(value.getUuid())) receive(connection, payload);
        }
        @Override public void onCharacteristicChanged(BluetoothGatt connection, BluetoothGattCharacteristic value, byte[] payload) {
            if (payload != null && CHARACTERISTIC_UUID.equals(value.getUuid())) receive(connection, payload);
        }
    };

    private void receive(BluetoothGatt connection, byte[] value) {
        byte[] copy = Arrays.copyOf(value, value.length);
        long receivedAt = System.currentTimeMillis();
        worker.post(() -> {
            if (!current(connection) || sessionId.isEmpty()) return;
            String raw = new String(copy, StandardCharsets.UTF_8);
            try { store.append(sessionId, receivedAt, raw); packetCount++; }
            catch (RuntimeException exception) {
                syncValid = false;
                stopCollection("Falha no armazenamento: " + message(exception) + ". Coleta parada; novas confirmações de PURGE bloqueadas.");
                return;
            }
            try { protocol(new JSONObject(raw)); }
            catch (JSONException exception) {
                // Keep original bytes as UTF-8 text, but refuse to purge a malformed transfer.
                if (syncInProgress && !purgePending) transferError("Pacote inválido durante a sincronização; memória da palmilha preservada.");
            }
            long now = SystemClock.elapsedRealtime();
            if (now - lastPacketStatusAt >= 1000) { lastPacketStatusAt = now; publish(false); }
        });
    }

    private void protocol(JSONObject packet) throws JSONException {
        String type = packet.optString("tipo");
        if ("offline_status".equals(type)) {
            long total = exactCount(packet, "total");
            if (connected && canWrite && total > 0 && !syncInProgress && !purgePending && syncError.isEmpty()) {
                syncExpected = total;
                syncReceived = 0;
                syncValid = true;
                syncInProgress = true;
                syncWriteConfirmed = false;
                watchTransfer(false);
                enqueue("SYNC_START");
                publish();
                updateNotification();
            }
        } else if ("sync_batch".equals(type)) {
            if (!syncInProgress || !syncValid || purgePending) return;
            JSONArray items = packet.optJSONArray("d");
            if (items == null) { transferError("Lote offline inválido; memória da palmilha preservada."); return; }
            for (int i = 0; i < items.length(); i++) {
                JSONArray item = items.optJSONArray(i);
                if (item == null || item.length() != 4) { transferError("Amostra offline inválida; memória da palmilha preservada."); return; }
                for (int j = 0; j < 4; j++) {
                    Object field = item.get(j);
                    if (!(field instanceof Number) || !Double.isFinite(((Number) field).doubleValue())) {
                        transferError("Amostra offline inválida; memória da palmilha preservada."); return;
                    }
                }
            }
            // The original batch and session counter have already committed above.
            syncReceived += items.length();
            if (syncReceived > syncExpected) transferError("Contagem offline excedeu o total esperado; PURGE bloqueado.");
            else watchTransfer(false);
            publish(false);
        } else if ("sync_fim".equals(type)) {
            if (!syncInProgress || purgePending) return;
            long confirmedTotal = exactCount(packet, "total");
            if (!syncValid || confirmedTotal < 0 || confirmedTotal != syncExpected || syncReceived != confirmedTotal) {
                transferError("Sincronização incompleta (esperado " + syncExpected + ", recebido " + syncReceived
                    + ", confirmado " + confirmedTotal + "); memória da palmilha preservada.");
                return;
            }
            // GATT's write callback may be queued after the final notification. PURGE
            // stays in the serialized queue behind SYNC_START's successful write.
            purgePending = true;
            watchTransfer(true);
            enqueue("PURGE");
            publish();
        } else if ("purge_ok".equals(type) && purgePending) {
            if (transferTimeout != null) worker.removeCallbacks(transferTimeout);
            transferTimeout = null;
            if (syncError.startsWith("Confirmação de limpeza não recebida")) { syncError = ""; error = ""; }
            syncInProgress = false;
            purgePending = false;
            syncExpected = -1;
            syncReceived = 0;
            publish();
            updateNotification();
        }
    }

    private static long exactCount(JSONObject packet, String key) {
        Object value = packet.opt(key);
        if (!(value instanceof Number)) return -1;
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > Long.MAX_VALUE || number != Math.rint(number)) return -1;
        return ((Number) value).longValue();
    }

    private void transferError(String reason) {
        if (transferTimeout != null) worker.removeCallbacks(transferTimeout);
        transferTimeout = null;
        syncValid = false;
        syncError = reason;
        error = reason;
        commands.remove("PURGE");
        pendingCommands.remove("PURGE");
        publish();
        updateNotification();
    }

    private void watchTransfer(boolean awaitingPurge) {
        if (transferTimeout != null) worker.removeCallbacks(transferTimeout);
        transferTimeout = () -> {
            if (!active || !syncInProgress) return;
            if (awaitingPurge) {
                error = "Confirmação de limpeza não recebida. As amostras transferidas já estão no aplicativo.";
                syncError = error;
                publish();
                updateNotification();
            } else {
                transferError("Sincronização offline interrompida; PURGE bloqueado e memória da palmilha preservada.");
            }
        };
        worker.postDelayed(transferTimeout, awaitingPurge ? 30000 : 60000);
    }

    private void externalCommand(String command) {
        if (command == null || !connected || !canWrite) return;
        command = command.trim();
        if (command.isEmpty() || command.length() > 100) return;
        String normalized = command.toUpperCase(Locale.ROOT);
        // These acknowledgements are exclusively controlled by durable native storage.
        if ("PURGE".equals(normalized) || "SYNC_START".equals(normalized)) return;
        enqueue(command);
    }

    private void enqueue(String command) {
        if (!active || !connected || !canWrite || !pendingCommands.add(command)) return;
        commands.add(command);
        pump();
    }

    private void pump() {
        if (!active || !connected || gatt == null || characteristic == null || operation != null || commands.isEmpty()) return;
        String command = commands.remove();
        if ("PURGE".equals(command) && (!syncValid || !purgePending || !syncWriteConfirmed)) {
            pendingCommands.remove(command);
            transferError("Confirmação nativa da sincronização ausente; PURGE bloqueado.");
            pump();
            return;
        }
        writingCommand = command;
        startOperation("WRITE");
        try {
            byte[] value = command.getBytes(StandardCharsets.UTF_8);
            int writeType = (characteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
            boolean started;
            if (Build.VERSION.SDK_INT >= 33) started = gatt.writeCharacteristic(characteristic, value, writeType) == BluetoothStatusCodes.SUCCESS;
            else { characteristic.setWriteType(writeType); characteristic.setValue(value); started = gatt.writeCharacteristic(characteristic); }
            if (!started) retry("Não foi possível enviar comando BLE. Reconectando...");
        } catch (SecurityException exception) { stopCollection("Permissão Bluetooth revogada."); }
        catch (RuntimeException exception) { retry("Falha ao enviar comando BLE: " + message(exception)); }
    }

    private void startOperation(String kind) {
        operation = kind;
        BluetoothGatt expectedGatt = gatt;
        operationTimeout = () -> { if (current(expectedGatt) && kind.equals(operation)) retry("Tempo esgotado na operação BLE " + kind + "."); };
        worker.postDelayed(operationTimeout, OP_TIMEOUT_MS);
    }

    private void finishOperation() {
        if (operationTimeout != null) worker.removeCallbacks(operationTimeout);
        operationTimeout = null;
        operation = null;
    }

    private boolean current(BluetoothGatt connection) { return active && !stopped && connection != null && connection == gatt; }

    private void retry(String reason) {
        if (!active || stopped) return;
        closeGatt();
        clearTimers();
        resetTransfer();
        error = reason;
        connected = false;
        connecting = true;
        publish();
        updateNotification();
        long delay = Math.min(30000, 3000L << Math.min(reconnectAttempt++, 4));
        reconnectTask = this::connect;
        worker.postDelayed(reconnectTask, delay);
    }

    private void resetTransfer() {
        if (transferTimeout != null) worker.removeCallbacks(transferTimeout);
        transferTimeout = null;
        commands.clear();
        pendingCommands.clear();
        writingCommand = null;
        syncInProgress = false;
        syncValid = false;
        purgePending = false;
        syncWriteConfirmed = false;
        syncExpected = -1;
        syncReceived = 0;
        syncError = "";
    }

    private void closeGatt() {
        BluetoothGatt previous = gatt;
        gatt = null;
        characteristic = null;
        cccd = null;
        canWrite = false;
        finishOperation();
        if (previous != null) {
            try { previous.disconnect(); } catch (RuntimeException ignored) { }
            try { previous.close(); } catch (RuntimeException ignored) { }
        }
    }

    private void cancelConnectTimeout() {
        if (connectTimeout != null) worker.removeCallbacks(connectTimeout);
        connectTimeout = null;
    }

    private void clearTimers() {
        cancelConnectTimeout();
        if (reconnectTask != null) worker.removeCallbacks(reconnectTask);
        reconnectTask = null;
        finishOperation();
    }

    private void endSession() {
        if (store == null || sessionId.isEmpty()) return;
        try { store.finishSession(sessionId, System.currentTimeMillis()); }
        catch (RuntimeException exception) {
            error = "Falha ao finalizar sessão no armazenamento: " + message(exception);
        }
    }

    private void stopCollection(String reason) {
        if (stopped) return;
        stopped = true;
        active = false;
        connected = false;
        connecting = false;
        clearTimers();
        closeGatt();
        resetTransfer();
        endSession();
        if (reason != null && !reason.isEmpty()) error = reason;
        if (wakeLock.isHeld()) wakeLock.release();
        publish();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void publish() {
        publish(true);
    }

    private void publish(boolean persistStatus) {
        JSONObject result = new JSONObject();
        put(result, "active", active);
        put(result, "connected", connected);
        put(result, "connecting", connecting);
        put(result, "canWrite", canWrite);
        put(result, "address", address);
        put(result, "name", name);
        put(result, "sessionId", sessionId);
        put(result, "startTime", startTime);
        put(result, "error", error);
        put(result, "packetCount", packetCount);
        put(result, "syncInProgress", syncInProgress);
        put(result, "syncExpected", syncExpected);
        put(result, "syncReceived", syncReceived);
        statusJson = result.toString();
        // Status is advisory; SQLite above is the authoritative packet store.
        if (persistStatus) preferences.edit().putString("status", statusJson).apply();
    }

    private Notification notification(String text) {
        Intent stop = new Intent(this, MonitorBleService.class).setAction(ACTION_DISCONNECT);
        PendingIntent stopIntent = PendingIntent.getService(this, 2, stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.drawable.ic_stat_foot)
            .setContentTitle("Monitor Plantar — coleta Bluetooth")
            .setContentText(text).setOngoing(true).setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,
                "Parar coleta", stopIntent).build());
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) builder.setContentIntent(PendingIntent.getActivity(this, 1, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        return builder.build();
    }

    private void updateNotification() {
        if (!active) return;
        String text;
        if (!connected) text = "Reconectando a " + name + ". A coleta continuará na mesma sessão.";
        else if (!syncError.isEmpty()) text = "Atenção na sincronização; consulte o aplicativo para ver a confirmação de armazenamento.";
        else if (syncInProgress) text = "Recebendo amostras offline de " + name + "; armazenamento nativo ativo.";
        else text = "Conectado a " + name + ". Amostras salvas mesmo com a tela bloqueada.";
        try { getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(text)); }
        catch (SecurityException ignored) { }
    }

    @Override public void onDestroy() {
        if (worker != null) {
            worker.post(() -> {
                if (!stopped) stopCollection("A coleta foi encerrada pelo sistema. Reconecte para iniciar nova sessão.");
                if (wakeLock.isHeld()) wakeLock.release();
                if (instance == this) instance = null;
                thread.quitSafely();
            });
        }
        super.onDestroy();
    }

    private static String message(Throwable exception) {
        Log.e("MonitorBleService", "Falha na coleta", exception);
        String message = exception.getMessage();
        return message == null || message.isEmpty() ? exception.getClass().getSimpleName() : message;
    }

    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); }
        catch (JSONException exception) { throw new IllegalStateException(exception); }
    }
}

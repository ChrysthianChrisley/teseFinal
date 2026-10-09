package br.uerj.ppgts.monitorplantar;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Intent;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import android.widget.ArrayAdapter;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "MonitorNative", permissions = {
    @Permission(alias = "bluetooth", strings = {Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}),
    @Permission(alias = "location", strings = {Manifest.permission.ACCESS_FINE_LOCATION}),
    @Permission(alias = "notifications", strings = {Manifest.permission.POST_NOTIFICATIONS})
})
public class MonitorNativePlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService files = Executors.newSingleThreadExecutor();
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private AlertDialog scanDialog;
    private PluginCall scanCall;
    private File pendingExport;
    private final List<String> addresses = new ArrayList<>();
    private final List<String> names = new ArrayList<>();

    @PluginMethod
    public void scan(PluginCall call) {
        String required = Build.VERSION.SDK_INT >= 31 ? "bluetooth" : "location";
        if (getPermissionState(required) != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{required}, call, "blePermissions");
            return;
        }
        requestNotificationsThenScan(call);
    }

    @PermissionCallback
    private void blePermissions(PluginCall call) {
        String required = Build.VERSION.SDK_INT >= 31 ? "bluetooth" : "location";
        if (getPermissionState(required) != PermissionState.GRANTED) {
            call.reject("Autorize Dispositivos próximos/Bluetooth para conectar a palmilha.");
            return;
        }
        requestNotificationsThenScan(call);
    }

    private void requestNotificationsThenScan(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAliases(new String[]{"notifications"}, call, "notificationPermissions");
        } else {
            main.post(() -> beginScan(call));
        }
    }

    @PermissionCallback
    private void notificationPermissions(PluginCall call) {
        main.post(() -> beginScan(call));
    }

    private void beginScan(PluginCall call) {
        if (scanCall != null) { call.reject("Uma busca Bluetooth já está aberta."); return; }
        BluetoothManager manager = getContext().getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        try {
            if (adapter == null || !adapter.isEnabled()) {
                call.reject("Ative o Bluetooth do celular e tente novamente."); return;
            }
            if (Build.VERSION.SDK_INT <= 30) {
                LocationManager location = getContext().getSystemService(LocationManager.class);
                if (location != null && !location.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    && !location.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                    call.reject("Ative a Localização do Android para a busca BLE neste aparelho."); return;
                }
            }
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) { call.reject("Bluetooth BLE indisponível."); return; }
            scanCall = call;
            addresses.clear(); names.clear();
            ArrayAdapter<String> items = new ArrayAdapter<>(getActivity(), android.R.layout.simple_list_item_1);
            scanDialog = new AlertDialog.Builder(getActivity())
                .setTitle("Buscando palmilhas próximas…")
                .setAdapter(items, (dialog, which) -> {
                    PluginCall selected = scanCall;
                    String address = addresses.get(which), name = names.get(which);
                    stopScan();
                    if (selected != null) selected.resolve(new JSObject().put("address", address).put("name", name));
                })
                .setNegativeButton("Cancelar", (dialog, which) -> cancelScan())
                .setOnCancelListener(dialog -> cancelScan()).create();
            scanCallback = new ScanCallback() {
                @Override public void onScanResult(int callbackType, ScanResult result) {
                    main.post(() -> {
                        if (scanCall == null) return;
                        try {
                            String name = result.getScanRecord() == null ? null : result.getScanRecord().getDeviceName();
                            if (name == null) name = result.getDevice().getName();
                            boolean ourService = result.getScanRecord() != null
                                && result.getScanRecord().getServiceUuids() != null
                                && result.getScanRecord().getServiceUuids().contains(
                                    android.os.ParcelUuid.fromString("4fafc201-1fb5-459e-8fcc-c5c9c331914b"));
                            if (!ourService && (name == null || (!name.startsWith("Palmilha") && !name.equals("MonitorPlantar")))) return;
                            String address = result.getDevice().getAddress();
                            if (addresses.contains(address)) return;
                            if (name == null) name = "Palmilha BLE";
                            addresses.add(address); names.add(name);
                            items.add(name + "\n" + address + " · " + result.getRssi() + " dBm");
                            scanDialog.setTitle("Selecione a palmilha");
                        } catch (SecurityException e) { cancelScan(); }
                    });
                }
                @Override public void onScanFailed(int code) {
                    main.post(() -> {
                        PluginCall failed = scanCall;
                        stopScan();
                        if (scanDialog != null) scanDialog.dismiss();
                        if (failed != null) failed.reject("Falha na busca BLE (" + code + "). Aguarde alguns segundos e tente novamente.");
                    });
                }
            };
            scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCallback);
            scanDialog.show();
            main.postDelayed(() -> {
                if (scanCall == call) {
                    stopRadioScan();
                    scanDialog.setTitle(addresses.isEmpty() ? "Nenhuma palmilha encontrada. Ligue-a e tente novamente." : "Selecione a palmilha");
                }
            }, 12000);
        } catch (Exception e) {
            stopScan(); call.reject("Não foi possível buscar dispositivos: " + e.getMessage());
        }
    }

    private void stopRadioScan() {
        if (scanner != null && scanCallback != null) {
            try { scanner.stopScan(scanCallback); } catch (SecurityException ignored) {}
        }
        scanCallback = null;
    }
    private void stopScan() { stopRadioScan(); scanCall = null; }
    private void cancelScan() {
        PluginCall cancelled = scanCall; stopScan();
        if (cancelled != null) cancelled.reject("Busca cancelada.", "CANCELLED");
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String address = call.getString("address");
        if (address == null || !BluetoothAdapter.checkBluetoothAddress(address)) {
            call.reject("Endereço Bluetooth inválido."); return;
        }
        String required = Build.VERSION.SDK_INT >= 31 ? "bluetooth" : "location";
        if (getPermissionState(required) != PermissionState.GRANTED) {
            call.reject("Permissão Bluetooth pendente. Use Conectar BLE."); return;
        }
        main.post(() -> {
            try {
                Intent intent = new Intent(getContext(), MonitorBleService.class).setAction(MonitorBleService.ACTION_CONNECT)
                    .putExtra("address", address).putExtra("name", call.getString("name", "Palmilha BLE"));
                ContextCompat.startForegroundService(getContext(), intent);
                call.resolve(new JSObject().put("connecting", true));
            } catch (Exception e) { call.reject("Não foi possível iniciar a coleta: " + e.getMessage()); }
        });
    }

    @PluginMethod public void disconnect(PluginCall call) {
        if (MonitorBleService.instance != null) {
            getContext().startService(new Intent(getContext(), MonitorBleService.class)
                .setAction(MonitorBleService.ACTION_DISCONNECT));
        }
        call.resolve();
    }
    @PluginMethod public void write(PluginCall call) {
        String command = call.getString("command", "");
        if (command.isEmpty() || command.length() > 100) { call.reject("Comando inválido."); return; }
        if (MonitorBleService.instance == null) { call.reject("Palmilha desconectada."); return; }
        if (!MonitorBleService.instance.status().optBoolean("canWrite", true)) {
            call.reject("Este firmware oferece apenas leitura BLE."); return;
        }
        // Sync/purge are intentionally owned by the service after durable storage.
        if (command.equals("SYNC_START") || command.equals("PURGE")) {
            call.reject("A sincronização é controlada pelo gravador nativo."); return;
        }
        getContext().startService(new Intent(getContext(), MonitorBleService.class)
            .setAction(MonitorBleService.ACTION_WRITE).putExtra("command", command));
        call.resolve();
    }
    @PluginMethod public void getStatus(PluginCall call) {
        try { call.resolve(JSObject.fromJSONObject(MonitorBleService.getStatus(getContext()))); }
        catch (Exception e) { call.reject("Falha ao consultar a coleta: " + e.getMessage()); }
    }
    @PluginMethod public void readPackets(PluginCall call) {
        try {
            String sessionId = call.getString("sessionId");
            long after = Math.max(0, call.getData().optLong("after", 0));
            int limit = Math.max(1, Math.min(1000, call.getInt("limit", 250)));
            JSONArray packets = PacketStore.get(getContext()).read(sessionId, after, limit);
            long next = packets.length() == 0 ? after : packets.getJSONObject(packets.length() - 1).getLong("id");
            call.resolve(new JSObject().put("packets", packets).put("nextId", next));
        } catch (Exception e) { call.reject("Falha ao ler dados nativos: " + e.getMessage()); }
    }
    @PluginMethod public void listSessions(PluginCall call) {
        try { call.resolve(new JSObject().put("sessions", PacketStore.get(getContext()).sessions())); }
        catch (Exception e) { call.reject("Falha ao ler sessões: " + e.getMessage()); }
    }

    @PluginMethod public void exportFile(PluginCall call) {
        String content = call.getString("content");
        if (content == null) { call.reject("Conteúdo vazio."); return; }
        files.execute(() -> {
            try {
                File file = exportPath(call.getString("filename", "palmilha.csv"));
                try (Writer writer = new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8)) { writer.write(content); }
                main.post(() -> deliverFile(file, call));
            } catch (Exception e) { call.reject("Falha na exportação: " + e.getMessage()); }
        });
    }

    @PluginMethod public void exportSession(PluginCall call) {
        String sessionId = call.getString("sessionId");
        if (sessionId == null || sessionId.isEmpty()) { call.reject("Escolha uma sessão para exportar."); return; }
        files.execute(() -> {
            try {
                File file = exportPath(sessionId + ".csv");
                SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
                Set<String> offlineSeen = new HashSet<>();
                long lastLiveTick = -1, lastLiveSeq = -1;
                try (Writer out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8))) {
                    out.write("\ufefforigem,recebido_epoch_ms,recebido_iso,dispositivo_t_ms,seq,meta1_adc,meta5_adc,calcaneo_adc,temp_c,umidade_pct,pacote_id\n");
                    long after = 0;
                    while (true) {
                        JSONArray packets = PacketStore.get(getContext()).read(sessionId, after, 1000);
                        if (packets.length() == 0) break;
                        for (int i = 0; i < packets.length(); i++) {
                            JSONObject packet = packets.getJSONObject(i);
                            after = packet.getLong("id");
                            JSONObject value;
                            try { value = new JSONObject(packet.getString("raw")); } catch (Exception malformed) { continue; }
                            long received = packet.getLong("receivedAt");
                            if ("purge_ok".equals(value.optString("tipo"))) {
                                offlineSeen.clear();
                            }
                            if ("sync_batch".equals(value.optString("tipo"))) {
                                JSONArray batch = value.optJSONArray("d");
                                if (batch == null) continue;
                                for (int j = 0; j < batch.length(); j++) {
                                    JSONArray row = batch.optJSONArray(j);
                                    if (row == null || row.length() < 4) continue;
                                    // Retry downloads repeat the previous partial prefix. Keep
                                    // raw packets intact; consolidate identical offline records
                                    // until the peripheral acknowledges a new flash generation.
                                    if (!offlineSeen.add(row.toString())) continue;
                                    out.write("offline," + received + "," + iso.format(new Date(received)) + "," + row.optLong(0)
                                        + ",," + row.optInt(1) + "," + row.optInt(2) + "," + row.optInt(3) + ",,," + after + "\n");
                                }
                            } else if (!value.has("tipo") && (value.has("meta1") || value.has("calcaneo"))) {
                                long tick = value.optLong("t_ms", -1), seq = value.optLong("seq", -1);
                                if ((tick >= 0 && lastLiveTick >= 0 && tick < lastLiveTick)
                                    || (seq >= 0 && lastLiveSeq >= 0 && seq < lastLiveSeq)) offlineSeen.clear();
                                if (tick >= 0) lastLiveTick = tick;
                                if (seq >= 0) lastLiveSeq = seq;
                                out.write("ao_vivo," + received + "," + iso.format(new Date(received)) + "," + number(value, "t_ms")
                                    + "," + number(value, "seq") + "," + number(value, "meta1") + "," + number(value, "meta5")
                                    + "," + number(value, "calcaneo") + "," + number(value, "temp") + "," + number(value, "umid") + "," + after + "\n");
                            }
                        }
                    }
                }
                main.post(() -> deliverFile(file, call));
            } catch (Exception e) { call.reject("Falha ao exportar a sessão: " + e.getMessage()); }
        });
    }
    private String number(JSONObject object, String key) {
        Object value = object.opt(key);
        return value instanceof Number ? value.toString() : "";
    }
    private File exportPath(String filename) throws IOException {
        File dir = new File(getContext().getCacheDir(), "exports/" + UUID.randomUUID());
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Não foi possível criar a pasta de exportação.");
        String safe = filename.replaceAll("[^a-zA-Z0-9._-]", "_");
        return new File(dir, safe.endsWith(".csv") ? safe : safe + ".csv");
    }
    private void deliverFile(File file, PluginCall call) {
        try {
            if (call.getBoolean("share", false)) {
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
                Intent share = new Intent(Intent.ACTION_SEND).setType("text/csv")
                    .putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, "Dados da Palmilha UERJ")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                share.setClipData(android.content.ClipData.newRawUri("CSV Palmilha", uri));
                getActivity().startActivity(Intent.createChooser(share, "Compartilhar CSV"));
                call.resolve(new JSObject().put("shared", true));
            } else {
                if (pendingExport != null) { call.reject("Conclua o salvamento em andamento."); return; }
                pendingExport = file;
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("text/csv").putExtra(Intent.EXTRA_TITLE, file.getName());
                startActivityForResult(call, create, "fileCreated");
            }
        } catch (Exception e) { pendingExport = null; call.reject("Não foi possível abrir a exportação: " + e.getMessage()); }
    }
    @ActivityCallback
    private void fileCreated(PluginCall call, ActivityResult result) {
        File source = pendingExport; pendingExport = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || source == null) {
            call.resolve(new JSObject().put("cancelled", true)); return;
        }
        Uri uri = result.getData().getData();
        files.execute(() -> {
            try (InputStream in = new FileInputStream(source); OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new IOException("Destino indisponível.");
                byte[] buffer = new byte[65536]; int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                call.resolve(new JSObject().put("saved", true).put("uri", uri.toString()));
            } catch (Exception e) { call.reject("Falha ao salvar CSV: " + e.getMessage()); }
        });
    }
    @Override protected void handleOnDestroy() {
        main.post(() -> { cancelScan(); if (scanDialog != null) scanDialog.dismiss(); });
        files.shutdown();
    }
}

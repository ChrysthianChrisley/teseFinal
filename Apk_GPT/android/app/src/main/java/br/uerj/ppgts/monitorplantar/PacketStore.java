package br.uerj.ppgts.monitorplantar;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.UUID;

/** Original BLE notifications, committed before acknowledging an offline transfer. */
public final class PacketStore extends SQLiteOpenHelper {
    private static volatile PacketStore singleton;

    public static PacketStore get(Context context) {
        if (singleton == null) {
            synchronized (PacketStore.class) {
                if (singleton == null) singleton = new PacketStore(context.getApplicationContext());
            }
        }
        return singleton;
    }

    private PacketStore(Context context) {
        super(context, "monitor_packets.db", null, 1);
        // Android 11+ can configure all present and future WAL connections.
        // Older Android uses a single rollback-journal connection instead.
        setWriteAheadLoggingEnabled(Build.VERSION.SDK_INT >= 30);
    }

    @Override public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
        // PRAGMA synchronous is per connection. Applying it only through execSQL
        // on a WAL pool could leave a future writer configured as NORMAL.
        if (Build.VERSION.SDK_INT >= 30) db.execPerConnectionSQL("PRAGMA synchronous=FULL", null);
        else {
            db.disableWriteAheadLogging();
            db.execSQL("PRAGMA synchronous=FULL");
        }
        requireDurableConnection(db);
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE sessions (id TEXT PRIMARY KEY, startTime INTEGER NOT NULL, "
            + "endTime INTEGER, name TEXT NOT NULL, address TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE packets (id INTEGER PRIMARY KEY AUTOINCREMENT, "
            + "sessionId TEXT NOT NULL REFERENCES sessions(id), receivedAt INTEGER NOT NULL, raw TEXT NOT NULL)");
        db.execSQL("CREATE INDEX packets_session_id ON packets(sessionId,id)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException("Versão do banco de coleta não suportada.");
    }

    public synchronized String openSession(String name, String address, long startTime) {
        SQLiteDatabase db = getWritableDatabase();
        String id = UUID.randomUUID().toString();
        db.beginTransaction();
        try {
            requireDurableConnection(db);
            // A process killed by Android leaves an unfinished session. Preserve its data
            // and close it at its last notification when the user starts a new collection.
            db.execSQL("UPDATE sessions SET endTime=COALESCE((SELECT MAX(receivedAt) FROM packets "
                + "WHERE packets.sessionId=sessions.id),startTime) WHERE endTime IS NULL");
            ContentValues row = new ContentValues();
            row.put("id", id);
            row.put("name", name == null ? "Palmilha" : name);
            row.put("address", address);
            row.put("startTime", startTime);
            db.insertOrThrow("sessions", null, row);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return id;
    }

    /** Returns only after INSERT and its session counter have committed successfully. */
    public synchronized long append(String sessionId, long receivedAt, String raw) {
        SQLiteDatabase db = getWritableDatabase();
        long id;
        db.beginTransaction();
        try {
            requireDurableConnection(db);
            ContentValues row = new ContentValues();
            row.put("sessionId", sessionId);
            row.put("receivedAt", receivedAt);
            row.put("raw", raw);
            id = db.insertOrThrow("packets", null, row);
            db.execSQL("UPDATE sessions SET count=count+1 WHERE id=?", new Object[]{sessionId});
            db.setTransactionSuccessful();
        } finally {
            // endTransaction can itself fail (disk full, I/O); propagate that failure.
            db.endTransaction();
        }
        return id;
    }

    public synchronized void finishSession(String sessionId, long endTime) {
        if (sessionId == null || sessionId.isEmpty()) return;
        ContentValues row = new ContentValues();
        row.put("endTime", endTime);
        getWritableDatabase().update("sessions", row, "id=? AND endTime IS NULL", new String[]{sessionId});
    }

    /** Global monotonically increasing IDs allow polling without losing paused-WebView data. */
    public synchronized JSONArray read(String sessionId, long after, int limit) {
        JSONArray result = new JSONArray();
        boolean oneSession = sessionId != null && !sessionId.isEmpty();
        String selection = oneSession ? "sessionId=? AND id>?" : "id>?";
        String[] args = oneSession ? new String[]{sessionId, String.valueOf(Math.max(0, after))}
            : new String[]{String.valueOf(Math.max(0, after))};
        try (Cursor cursor = getReadableDatabase().query("packets", null, selection, args, null,
                null, "id ASC", String.valueOf(Math.max(1, Math.min(10000, limit))))) {
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject();
                put(row, "id", cursor.getLong(cursor.getColumnIndexOrThrow("id")));
                put(row, "sessionId", cursor.getString(cursor.getColumnIndexOrThrow("sessionId")));
                put(row, "receivedAt", cursor.getLong(cursor.getColumnIndexOrThrow("receivedAt")));
                put(row, "raw", cursor.getString(cursor.getColumnIndexOrThrow("raw")));
                result.put(row);
            }
        }
        return result;
    }

    public synchronized JSONArray sessions() {
        JSONArray result = new JSONArray();
        try (Cursor cursor = getReadableDatabase().query("sessions", null, null, null, null, null,
                "startTime DESC")) {
            while (cursor.moveToNext()) {
                JSONObject row = new JSONObject();
                put(row, "id", cursor.getString(cursor.getColumnIndexOrThrow("id")));
                put(row, "startTime", cursor.getLong(cursor.getColumnIndexOrThrow("startTime")));
                int end = cursor.getColumnIndexOrThrow("endTime");
                put(row, "endTime", cursor.isNull(end) ? JSONObject.NULL : cursor.getLong(end));
                put(row, "name", cursor.getString(cursor.getColumnIndexOrThrow("name")));
                put(row, "address", cursor.getString(cursor.getColumnIndexOrThrow("address")));
                put(row, "count", cursor.getLong(cursor.getColumnIndexOrThrow("count")));
                result.put(row);
            }
        }
        return result;
    }

    private static void put(JSONObject object, String key, Object value) {
        try { object.put(key, value); }
        catch (JSONException e) { throw new IllegalStateException(e); }
    }

    private static void requireDurableConnection(SQLiteDatabase db) {
        try (Cursor mode = db.rawQuery("PRAGMA synchronous", null)) {
            if (!mode.moveToFirst() || mode.getInt(0) < 2) {
                throw new IllegalStateException("SQLite não confirmou o modo de gravação durável FULL.");
            }
        }
    }
}

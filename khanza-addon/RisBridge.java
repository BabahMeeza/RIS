package fungsi;

/*
 * RisBridge - pengirim order radiologi SIMRS Khanza -> RIS RSUD Hanau.
 *
 * Letakkan di src/fungsi/RisBridge.java (atau package lain, sesuaikan baris "package").
 * Konfigurasi dibaca dari setting/ris.properties:
 *     RIS_URL=http://192.168.10.118:8090
 *     RIS_KEY=<sama dengan KHANZA_API_KEY di .env RIS>
 *
 * Hanya memakai Java standar + Jackson (com.fasterxml.jackson), yang sudah dipakai Khanza
 * untuk modul BPJS/Satu Sehat/Orthanc.
 */
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Properties;

public class RisBridge {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static String risUrl = null;
    private static String risKey = null;

    private static void loadConfig() throws IOException {
        if (risUrl != null) return;
        Properties p = new Properties();
        try (FileInputStream in = new FileInputStream("setting/ris.properties")) {
            p.load(in);
        }
        risUrl = p.getProperty("RIS_URL", "http://127.0.0.1:8090").trim().replaceAll("/+$", "");
        risKey = p.getProperty("RIS_KEY", "").trim();
    }

    private static JsonNode request(String method, String path, ObjectNode body) throws IOException {
        loadConfig();
        HttpURLConnection c = (HttpURLConnection) new URL(risUrl + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(5000);
        c.setReadTimeout(20000);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("X-RIS-Key", risKey);
        if (body != null) {
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            try (OutputStream os = c.getOutputStream()) {
                os.write(MAPPER.writeValueAsBytes(body));
            }
        }
        int code = c.getResponseCode();
        try (InputStream is = code < 400 ? c.getInputStream() : c.getErrorStream()) {
            if (is == null) throw new IOException("RIS tidak memberi respons (HTTP " + code + ")");
            return MAPPER.readTree(is);
        }
    }

    /** Kirim semua item pemeriksaan pada satu noorder ke RIS -> langsung masuk worklist alat. */
    public static JsonNode kirimOrder(String noorder, String user) throws IOException {
        ObjectNode b = MAPPER.createObjectNode();
        b.put("noorder", noorder);
        b.put("user", user == null ? "" : user);
        return request("POST", "/api/khanza/order", b);
    }

    /** Batalkan order di RIS (kdJenisPrw null = seluruh noorder). Hanya yang belum diperiksa. */
    public static JsonNode batalOrder(String noorder, String kdJenisPrw, String user) throws IOException {
        ObjectNode b = MAPPER.createObjectNode();
        b.put("noorder", noorder);
        if (kdJenisPrw != null) b.put("kd_jenis_prw", kdJenisPrw);
        b.put("user", user == null ? "" : user);
        return request("POST", "/api/khanza/cancel", b);
    }

    /** Status order di RIS (accession, alat, status, jumlah gambar, status expertise). */
    public static JsonNode statusOrder(String noorder) throws IOException {
        return request("GET", "/api/khanza/order/" + java.net.URLEncoder.encode(noorder, "UTF-8"), null);
    }

    /** Rangkuman respons RIS menjadi teks untuk JOptionPane. */
    public static String ringkas(JsonNode r) {
        StringBuilder sb = new StringBuilder(r.path("message").asText(r.path("error").asText("")));
        for (JsonNode it : r.path("items")) {
            sb.append("\n- ").append(it.path("nama").asText())
              .append("  |  ACC ").append(it.path("accession").asText())
              .append("  |  ").append(it.path("station").asText())
              .append("  |  ").append(it.path("status").asText());
        }
        return sb.toString();
    }
}

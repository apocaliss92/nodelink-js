# RTSP Server CLI

Questo documento descrive come utilizzare il CLI per avviare un server RTSP da console.

## Panoramica

Il CLI permette di avviare un server RTSP che espone lo stream di una telecamera Reolink come server RTSP standard, accessibile da qualsiasi client RTSP (VLC, ffplay, OBS, ecc.).

## Installazione

Dopo aver compilato il progetto:

```bash
npm run build
```

## Utilizzo Base

```bash
node dist/cli/rtsp-server.cjs --host <IP> --username <USER> --password <PASS>
```

**Nota**: Usa il file `.cjs` per evitare problemi con ESM. Il file `.js` è disponibile ma potrebbe richiedere configurazioni aggiuntive.

### Opzioni Richieste

- `--host <ip>`: IP della telecamera
- `--username <user>` o `-u`: Username
- `--password <pass>` o `-p`: Password

### Opzioni Opzionali

- `--channel <num>`: Numero canale (default: 0)
- `--profile <profile>`: Profilo stream: `main`, `sub`, `ext` (default: `main`)
- `--port <port>`: Porta RTSP server (default: 8554)
- `--path <path>`: Path RTSP (default: `/stream/<profile>`)
- `--uid <uid>`: UID per telecamere battery (opzionale)
- `--transport <type>`: Transport: `tcp`, `udp`, `auto` (default: `auto`)
- `--help` o `-h`: Mostra messaggio di aiuto

## Esempi

### Server RTSP Base

```bash
node dist/cli/rtsp-server.cjs \
  --host 192.168.1.100 \
  --username admin \
  --password mypassword
```

Oppure usando il formato `--key=value`:

```bash
node dist/cli/rtsp-server.cjs \
  --host=192.168.1.100 \
  --user=admin \
  --password=mypassword
```

Il server sarà disponibile su: `rtsp://127.0.0.1:8554/stream/main`

### Canale Specifico con Profilo Sub

```bash
node dist/cli/rtsp-server.cjs \
  --host 192.168.1.100 \
  --username admin \
  --password mypassword \
  --channel 1 \
  --profile sub
```

### Porta Personalizzata

```bash
node dist/cli/rtsp-server.cjs \
  --host 192.168.1.100 \
  --username admin \
  --password mypassword \
  --port 8555
```

### Telecamera Battery (UDP)

```bash
node dist/cli/rtsp-server.cjs \
  --host 192.168.1.100 \
  --username admin \
  --password mypassword \
  --uid ABC123DEF456 \
  --transport udp
```

### Path Personalizzato

```bash
node dist/cli/rtsp-server.cjs \
  --host 192.168.1.100 \
  --username admin \
  --password mypassword \
  --path /camera/main
```

## Utilizzo con Client RTSP

Una volta avviato il server, puoi connetterti con qualsiasi client RTSP:

### VLC

```bash
vlc rtsp://127.0.0.1:8554/stream/main
```

### ffplay

```bash
ffplay rtsp://127.0.0.1:8554/stream/main
```

### OBS Studio

1. Apri OBS Studio
2. Aggiungi una nuova fonte "Media Source"
3. Inserisci l'URL: `rtsp://127.0.0.1:8554/stream/main`

## Output

Il CLI mostra informazioni utili durante l'esecuzione:

```
[RTSP Server] Connessione a 192.168.1.100...
[RTSP Server] Channel: 0, Profile: main
[RTSP Server] Device type: camera, Transport: tcp
[RTSP Server] Login...
[RTSP Server] Login successful
[RTSP Server] Avvio server RTSP...
[RTSP Server] Server RTSP avviato
[RTSP Server] URL: rtsp://127.0.0.1:8554/stream/main
[RTSP Server] In attesa di connessioni...
[RTSP Server] Premi Ctrl+C per fermare
[RTSP Server] Server pronto e camera attiva
[RTSP Server] RTSP client connected: 127.0.0.1:54321
```

## Shutdown Graceful

Il server gestisce correttamente il shutdown quando riceve SIGINT o SIGTERM:

```
^C
[RTSP Server] Arresto server...
[RTSP Server] Server fermato
```

## Note

- Il server si avvia immediatamente e inizia a servire lo stream quando un client si connette
- Per telecamere battery, il server attende che la telecamera si svegli prima di iniziare lo stream
- Il server supporta multiple connessioni simultanee
- Lo stream viene fermato automaticamente quando non ci sono più client connessi (per risparmiare batteria)

## Troubleshooting

1. **Errore di connessione**: Verifica che l'IP della telecamera sia corretto e raggiungibile
2. **Errore di autenticazione**: Verifica username e password
3. **Stream non parte**: Per telecamere battery, assicurati di aver fornito l'UID corretto
4. **Porta già in uso**: Usa `--port` per specificare una porta diversa
5. **Timeout**: Per telecamere battery, il server potrebbe impiegare alcuni secondi per svegliare la telecamera


# Analisi del Problema: Timeout UDP Stream (~3s)

## Descrizione del Problema
Durante lo streaming video via UDP, la connessione viene stabilita correttamente e i frame vengono ricevuti per circa 3 secondi. Successivamente, il client rileva un timeout su un comando di Ping (`cmdId=93`) e la connessione viene chiusa.

**Errore Rilevato:**
```
Error: Baichuan timeout cmdId=93 msgNum=9
```

## Contesto Tecnico
- **Protocollo**: Baichuan (Reolink proprietario)
- **Trasporto**: UDP (Handshake iniziale via TCP o UDP, poi streaming UDP)
- **Riferimento**: Implementazione Rust `neolink` (funzionante)

## Tentativi di Risoluzione e Allineamento con `neolink`

Abbiamo eseguito un'analisi comparativa rigorosa con il codice sorgente di `neolink` e applicato le seguenti correzioni, senza però risolvere il problema del timeout.

### 1. Gestione Heartbeat UDP (`BcUdpStream.ts`)
*   **Ipotesi Iniziale**: Il Transaction ID (TID) dell'Heartbeat doveva essere riutilizzato da quello del Discovery.
*   **Analisi `neolink`**: `neolink` genera un TID *casuale* per ogni sessione di Heartbeat (`udpsource.rs`).
*   **Azione**: Modificato `BcUdpStream.ts` per generare un TID casuale.
*   **Risultato**: Timeout persiste.

### 2. Destinazione Heartbeat (`BcUdpStream.ts`)
*   **Ipotesi Iniziale**: Inviare Heartbeat a tutte le porte note (Discovery 2015/2018 e Data Port).
*   **Analisi `neolink`**: Una volta connesso, `neolink` invia Heartbeat *solo* alla porta dati remota negoziata.
*   **Azione**: Rimossa la logica di broadcast alle porte di discovery durante lo streaming.
*   **Risultato**: Timeout persiste.

### 3. Payload del Ping (`BaichuanClient.ts`)
*   **Ipotesi Iniziale**: Il payload del comando Ping (`cmdId=93`) era una stringa vuota o malformata.
*   **Analisi `neolink`**: `neolink` invia un `ModernMsg` di default. La serializzazione di un `ModernMsg` vuoto potrebbe implicare un XML vuoto o specifico.
*   **Azione**: Modificato il payload XML in `<body></body>` (e testato anche stringa vuota).
*   **Risultato**: Timeout persiste.

## Analisi Corrente e Prossimi Passi

Il problema sembra risiedere nel fatto che la telecamera non riceve o non gradisce i pacchetti di "keep-alive" (sia UDP Heartbeat che TCP/Application Ping), portandola a chiudere la sessione lato server, il che causa il timeout della risposta al Ping lato client.

### Punti Aperti da Investigare

1.  **Serializzazione Esatta di `ModernMsg`**:
    *   Dobbiamo determinare con certezza byte-per-byte cosa `neolink` invia per il `cmdId=93`. Un `Default::default()` in Rust per `ModernMsg` potrebbe serializzare header specifici o un payload di lunghezza zero in modo particolare (es. `payload_offset` uguale a `body_len`).

2.  **UDP KeepAlive (`cmdId=234`)**:
    *   Oltre al Ping applicativo (93) e all'Heartbeat UDP (0x10), esiste il comando `234` (UDP KeepAlive) che la telecamera potrebbe inviare al client.
    *   Se il client non risponde con un `200 OK` a questo comando, la telecamera potrebbe terminare lo stream. Dobbiamo verificare se stiamo ricevendo e gestendo questo comando.

3.  **Logica ACK UDP**:
    *   Verificare se la gestione dei numeri di sequenza e degli ACK nel livello di trasporto UDP (`BcUdpStream.ts`) è corretta e sincronizzata con le aspettative della telecamera.

4.  **Encryption**:
    *   Verificare se il Ping (93) deve essere criptato o meno, e se l'offset di crittografia è corretto.

## Conclusioni
L'allineamento strutturale con `neolink` è avanzato, ma manca un dettaglio critico nel protocollo di mantenimento della connessione (Keep-Alive/Ping) che causa la disconnessione sistematica dopo 3 secondi.

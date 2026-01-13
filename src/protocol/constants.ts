export const BC_TCP_DEFAULT_PORT = 9000;

/** Magic header bytes: `f0 de bc 0a` */
export const BC_MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

/**
 * Some cameras sometimes send a reversed-endian magic header for certain payloads (e.g. JPEG).
 * In Rust reference this appears as 0x0fedcba0 (LE bytes: a0 cb ed 0f).
 */
export const BC_MAGIC_REV = Buffer.from([0xa0, 0xcb, 0xed, 0x0f]);

/** Reolink "BCEncrypt" XOR key for XML payloads. */
export const BC_XML_KEY = Uint8Array.from([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]);

/** Fixed IV used by Reolink for AES-CFB. */
export const BC_AES_IV = Buffer.from("0123456789abcdef", "utf8");

export const BC_CLASS_LEGACY = 0x6514;
export const BC_CLASS_MODERN_20 = 0x6614;
export const BC_CLASS_MODERN_24 = 0x6414;
export const BC_CLASS_MODERN_24_ALT = 0x0000;
// Modern (file download) message class, still uses 24-byte header with payloadOffset.
export const BC_CLASS_FILE_DOWNLOAD = 0x6482;

export function bcHeaderHasPayloadOffset(messageClass: number): boolean {
  return messageClass === BC_CLASS_MODERN_24 || messageClass === BC_CLASS_MODERN_24_ALT || messageClass === BC_CLASS_FILE_DOWNLOAD;
}

/**
 * Baichuan command IDs for video streaming.
 * 
 * Values:
 * - MSG_ID_VIDEO = 3: Video and Audio Streams messages
 * - MSG_ID_VIDEO_STOP = 4: ID used to stop the video stream
 */
export const BC_CMD_ID_VIDEO = 3; // MSG_ID_VIDEO - Video and Audio Streams messages
export const BC_CMD_ID_VIDEO_STOP = 4; // MSG_ID_VIDEO_STOP - ID used to stop the video stream

// Replay / recordings / file list
export const BC_CMD_ID_FILE_INFO_LIST_REPLAY = 5; // <FileInfoList> (replay)
export const BC_CMD_ID_FILE_INFO_LIST_STOP = 7; // <FileInfoList> (stop)
export const BC_CMD_ID_FILE_INFO_LIST_DL_VIDEO = 8; // <FileInfoList> (DL Video)
export const BC_CMD_ID_FILE_INFO_LIST_DOWNLOAD = 13; // <FileInfoList> (download)
export const BC_CMD_ID_FILE_INFO_LIST_OPEN = 14; // <FileInfoList> (open/list)
export const BC_CMD_ID_FILE_INFO_LIST_GET = 15; // <FileInfoList> (get/list page)
export const BC_CMD_ID_FILE_INFO_LIST_CLOSE = 16; // <FileInfoList> (close)

// Recording search (alarm video list)
export const BC_CMD_ID_FIND_REC_VIDEO_OPEN = 272; // <findAlarmVideo> (open)
export const BC_CMD_ID_FIND_REC_VIDEO_GET = 273; // <findAlarmVideo> (get)
export const BC_CMD_ID_FIND_REC_VIDEO_CLOSE = 274; // <findAlarmVideo> (close)

// Event log search (HomeHub/NVR event timeline)
// Observed in HomeHub PCAP:
// - 516: <findEventLog> (open)
// - 517: <findEventLog> (get page) -> <eventLogInfo>
export const BC_CMD_ID_FIND_EVENT_LOG_OPEN = 516; // <findEventLog> (open)
export const BC_CMD_ID_FIND_EVENT_LOG_GET = 517; // <findEventLog> (get)

// Playback by time (HomeHub/NVR event replay)
export const BC_CMD_ID_REPLAY_BY_TIME_V2 = 381; // <ReplayByTimeV2>

// Talk / two-way audio command IDs
export const BC_CMD_ID_TALK_ABILITY = 10; // MSG_ID_TALKABILITY - get talk ability/config
export const BC_CMD_ID_TALK_RESET = 11; // MSG_ID_TALKRESET - stop/reset talk session
export const BC_CMD_ID_TALK_CONFIG = 201; // MSG_ID_TALKCONFIG - configure talk audio format
export const BC_CMD_ID_TALK = 202; // MSG_ID_TALK - send talk binary (BcMedia ADPCM)

// PTZ Control command IDs
export const BC_CMD_ID_PTZ_CONTROL = 18; // MSG_ID_PTZ_CONTROL - Pan/tilt/zoom control
export const BC_CMD_ID_PTZ_CONTROL_PRESET = 19; // MSG_ID_PTZ_CONTROL_PRESET - Set/move to preset
export const BC_CMD_ID_GET_PTZ_PRESET = 190; // MSG_ID_GET_PTZ_PRESET - Get preset list
export const BC_CMD_ID_GET_PTZ_POSITION = 433; // Get current PTZ position

// PTZ Zoom/Focus command IDs
export const BC_CMD_ID_GET_ZOOM_FOCUS = 294; // MSG_ID_GET_ZOOM_FOCUS - Read zoom/focus min/max/current
export const BC_CMD_ID_SET_ZOOM_FOCUS = 295; // MSG_ID_SET_ZOOM_FOCUS - Write zoom/focus position

// Recording snapshot/preview (CoverPreview)
// Observed in HomeHub/NVR flows: returns a stream header "1001" followed by a single I-frame.
export const BC_CMD_ID_COVER_PREVIEW = 298; // <CoverPreview>

// Battery Info command IDs
// - 252: MSG_ID_BATTERY_INFO_LIST (camera-initiated status/event)
// - 253: MSG_ID_BATTERY_INFO (client-initiated request)
export const BC_CMD_ID_GET_BATTERY_INFO_LIST = 252; // MSG_ID_BATTERY_INFO_LIST
export const BC_CMD_ID_GET_BATTERY_INFO = 253; // MSG_ID_BATTERY_INFO

// UDP Keep Alive command ID
// Battery cameras (BCUDP) periodically send this and expect a 200 response.
export const BC_CMD_ID_UDP_KEEP_ALIVE = 234; // MSG_ID_UDP_KEEP_ALIVE

// PIR State command IDs
export const BC_CMD_ID_GET_PIR_INFO = 212; // MSG_ID_GET_PIR_ALARM - Get PIR settings
export const BC_CMD_ID_SET_PIR_INFO = 213; // MSG_ID_START_PIR_ALARM - Set PIR settings

// Motion Detection command IDs
export const BC_CMD_ID_GET_MOTION_ALARM = 46; // GetMdAlarm - Get motion detection state
export const BC_CMD_ID_SET_MOTION_ALARM = 47; // SetMdAlarm - Set motion detection

// AI Detection command IDs
export const BC_CMD_ID_GET_AI_ALARM = 342; // GetAiAlarm - Get AI detection state
export const BC_CMD_ID_SET_AI_ALARM = 343; // SetAiAlarm - Set AI detection

// Siren/Audio Alarm command IDs
export const BC_CMD_ID_GET_AUDIO_ALARM = 547; // GetAudioAlarm - Get siren status (push event)
export const BC_CMD_ID_AUDIO_ALARM_PLAY = 263; // MSG_ID_PLAY_AUDIO - Play siren/audio alarm

// White LED/Floodlight command IDs
export const BC_CMD_ID_GET_WHITE_LED = 289; // GetWhiteLed/Floodlight - Get floodlight state
export const BC_CMD_ID_SET_WHITE_LED_STATE = 288; // SetWhiteLed state
export const BC_CMD_ID_SET_WHITE_LED_TASK = 290; // SetWhiteLed task (brightness, mode, etc.)
// Floodlight status report pushed by camera
export const BC_CMD_ID_FLOODLIGHT_STATUS_LIST = 291; // MSG_ID_FLOODLIGHT_STATUS_LIST

// Ability Info command ID
export const BC_CMD_ID_ABILITY_INFO = 151; // MSG_ID_ABILITY_INFO - Get device capabilities/abilities

// Support query command ID
// Returns a <Support> XML block with ptzMode and per-channel flags (e.g. battery, ledCtrl).
export const BC_CMD_ID_SUPPORT = 199; // MSG_ID_SUPPORT

// Ping command ID
export const BC_CMD_ID_PING = 93; // MSG_ID_PING - Keep connection alive / check status

// Channel Info command IDs
export const BC_CMD_ID_CHANNEL_INFO_ALL = 145; // Get channel info for all channels in a single request


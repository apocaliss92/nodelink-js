export const BC_TCP_DEFAULT_PORT = 9000;

/** Magic header bytes: `f0 de bc 0a` */
export const BC_MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);

/**
 * Some cameras sometimes send a reversed-endian magic header for certain payloads (e.g. JPEG).
 * In Rust reference this appears as 0x0fedcba0 (LE bytes: a0 cb ed 0f).
 */
export const BC_MAGIC_REV = Buffer.from([0xa0, 0xcb, 0xed, 0x0f]);

/** Reolink "BCEncrypt" XOR key for XML payloads. */
export const BC_XML_KEY = Uint8Array.from([
  0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff,
]);

/** Fixed IV used by Reolink for AES-CFB. */
export const BC_AES_IV = Buffer.from("0123456789abcdef", "utf8");

export const BC_CLASS_LEGACY = 0x6514;
export const BC_CLASS_MODERN_20 = 0x6614;
export const BC_CLASS_MODERN_24 = 0x6414;
export const BC_CLASS_MODERN_24_ALT = 0x0000;
// Modern (file download) message class, still uses 24-byte header with payloadOffset.
export const BC_CLASS_FILE_DOWNLOAD = 0x6482;

export function bcHeaderHasPayloadOffset(messageClass: number): boolean {
  return (
    messageClass === BC_CLASS_MODERN_24 ||
    messageClass === BC_CLASS_MODERN_24_ALT ||
    messageClass === BC_CLASS_FILE_DOWNLOAD
  );
}

/**
 * Baichuan command IDs for login/logout.
 *
 * Values:
 * - MSG_ID_LOGIN = 1: Login request/response
 * - MSG_ID_LOGOUT = 2: Logout request/response
 */
export const BC_CMD_ID_LOGIN = 1; // MSG_ID_LOGIN - Login request/response
export const BC_CMD_ID_LOGOUT = 2; // MSG_ID_LOGOUT - Logout request/response (PCAP-confirmed)

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

// CoverPreview / Thumbnail commands
// cmd_id=298: CoverPreview for NVR/HomeHub (XML-based, returns I-frame)
export const BC_CMD_ID_COVER_PREVIEW = 298; // <CoverPreview> - I-frame from recording
// cmd_id=458-462: Cover/Thumbnail for standalone cameras (PCAP-observed)
// These appear to be batch/paged cover requests used by the Reolink app
export const BC_CMD_ID_COVER_STANDALONE_458 = 458; // Standalone cover request type A
export const BC_CMD_ID_COVER_STANDALONE_459 = 459; // Standalone cover request type B
export const BC_CMD_ID_COVER_STANDALONE_460 = 460; // Standalone cover request type C (main)
export const BC_CMD_ID_COVER_STANDALONE_461 = 461; // Standalone cover request type D
export const BC_CMD_ID_COVER_STANDALONE_462 = 462; // Standalone cover request type E
// Response cmd_id for cover data (observed in PCAP)
export const BC_CMD_ID_COVER_RESPONSE = 138; // Response containing cover/thumbnail data (0x8A)

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

// Alarm Event List (push from camera when alarm state changes)
export const BC_CMD_ID_ALARM_EVENT_LIST = 33; // AlarmEventList push - contains motion/AI alarm status

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

// --- PCAP-derived (settings) command IDs (not yet wrapped in helpers) ---
// These command IDs were observed in our settings PCAPs and are exported here so they can be used
// by library callers (e.g. via ReolinkBaichuanApi.sendXml({ cmdId, ... })).
// Naming is best-effort and derived from the first XML tag under <body> seen in responses.

// client->device (request/response)
export const BC_CMD_ID_GET_OSD_DATETIME = 44; // <OsdDatetime>
export const BC_CMD_ID_GET_RECORD_CFG = 54; // <RecordCfg>
export const BC_CMD_ID_GET_ABILITY_SUPPORT = 58; // <AbilitySuppport> (spelling as seen in XML)
export const BC_CMD_ID_GET_FTP_TASK = 70; // <FtpTask>
export const BC_CMD_ID_GET_RECORD = 81; // <Record>
export const BC_CMD_ID_GET_HDD_INFO_LIST = 102; // <HddInfoList>
export const BC_CMD_ID_GET_WIFI_SIGNAL = 115; // <WifiSignal>
export const BC_CMD_ID_GET_WIFI = 116; // <Wifi>
export const BC_CMD_ID_GET_ONLINE_USER_LIST = 120; // <OnlineUserList> - active user sessions
export const BC_CMD_ID_GET_DAY_RECORDS = 142; // <DayRecords>
export const BC_CMD_ID_GET_STREAM_INFO_LIST = 146; // <StreamInfoList>
export const BC_CMD_ID_GET_LED_STATE = 208; // <LedState>
export const BC_CMD_ID_GET_EMAIL_TASK = 217; // <EmailTask>
export const BC_CMD_ID_GET_AUDIO_TASK = 232; // <AudioTask>
export const BC_CMD_ID_GET_AUDIO_CFG = 264; // <audioCfg>
export const BC_CMD_ID_GET_DAY_NIGHT_THRESHOLD = 296; // <DayNightThreshold>
export const BC_CMD_ID_GET_TIMELAPSE_CFG = 319; // <timelapseCfg>
export const BC_CMD_ID_GET_AI_DENOISE = 439; // <aiDenoise>
export const BC_CMD_ID_GET_KIT_AP_CFG = 481; // <kitApCfg>
export const BC_CMD_ID_GET_REC_ENC_CFG = 507; // <RecEncCfg>
export const BC_CMD_ID_GET_ACCESS_USER_LIST = 511; // <accessUserList>
export const BC_CMD_ID_GET_SLEEP_STATE = 574; // <sleepState>

// Additional discovered command IDs from PCAP analysis (motion_alarm.pcapng)
export const BC_CMD_ID_GET_VIDEO_INPUT = 26; // <VideoInput> + <InputAdvanceCfg> - Video settings/exposure
export const BC_CMD_ID_GET_SYSTEM_GENERAL = 104; // <SystemGeneral> + <Norm> - System time/name/language
export const BC_CMD_ID_GET_SUPPORT = 199; // <Support> - Device capability flags
export const BC_CMD_ID_GET_AI_CFG = 299; // <AiCfg> - AI tracking config
export const BC_CMD_ID_SET_AI_CFG = 300; // <AiCfg> - Set AI tracking config (autotracking)
export const BC_CMD_ID_GET_SIREN_STATUS = 547; // <SirenStatusList> - Siren status

// AudioTask - Motion Alarm control (confirmed in PCAP analysis)
// cmdId=232 GET returns <AudioTask><enable>1/0</enable>...</AudioTask>
// cmdId=231 SET sends encrypted XML payload to toggle motion alarm
export const BC_CMD_ID_SET_AUDIO_TASK = 231; // SetAudioTask - Toggle motion alarm enable/disable

// Unknown / no XML samples captured in current PCAP corpus (still observed cmdIds)
export const BC_CMD_ID_CMD_123 = 123;
export const BC_CMD_ID_CMD_209 = 209;
export const BC_CMD_ID_CMD_265 = 265;
export const BC_CMD_ID_CMD_440 = 440;

// push/device->client (camera-initiated)
export const BC_CMD_ID_PUSH_VIDEO_INPUT = 78; // <VideoInput>
export const BC_CMD_ID_PUSH_SERIAL = 79; // <Serial>
export const BC_CMD_ID_PUSH_NET_INFO = 464; // <NetInfo>
export const BC_CMD_ID_PUSH_DINGDONG_LIST = 484; // <dingdongList>
export const BC_CMD_ID_PUSH_SLEEP_STATUS = 623; // <sleepStatus>
export const BC_CMD_ID_PUSH_COORDINATE_POINT_LIST = 723; // <coordinatePointList>

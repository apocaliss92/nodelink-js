export declare function xmlEscape(text: string): string;
export declare function buildLoginXml(userNameHash: string, passwordHash: string): string;
export declare function buildChannelExtensionXml(channelId: number): string;
/**
 * Build Preview XML for video stream request.
 * Based on neolink stream.rs: uses Preview element with handle and stream_type.
 *
 * Reference: https://github.com/QuantumEntangledAndy/neolink/blob/master/crates/core/src/bc_protocol/stream.rs#L108
 *
 * @param channelId - Channel ID (1-based for Baichuan protocol)
 * @param handle - Handle value: 0 for main, 256 for sub, 1024 for extern
 * @param streamType - Stream type name: "mainStream", "subStream", or "externStream"
 * @returns XML string for Preview element
 */
export declare function buildPreviewXml(channelId: number, handle: number, streamType: string): string;
/**
 * Build Preview XML for video stream stop request.
 * Based on neolink stream.rs: uses Preview element without stream_type.
 *
 * @param channelId - Channel ID (1-based for Baichuan protocol)
 * @param handle - Handle value: 0 for main, 256 for sub, 1024 for extern
 * @returns XML string for Preview element (stop)
 */
export declare function buildPreviewStopXml(channelId: number, handle: number): string;
/**
 * Very small helper for extracting simple `<tag>value</tag>` text from Baichuan XML.
 * This is intentionally dependency-free; it's enough for nonce/login flows.
 */
export declare function getXmlText(xml: string, tagName: string): string | undefined;
//# sourceMappingURL=xml.d.ts.map
/**
 * WebRTC Client for Baichuan Camera Streams
 *
 * Handles WebRTC signaling and media for low-latency video streaming
 * with optional bidirectional audio (intercom).
 *
 * Supports:
 * - H.264 via standard WebRTC media tracks
 * - H.265/HEVC via DataChannel + WebCodecs (if browser supports)
 */

class WebRTCClient {
    constructor(options = {}) {
        this.sessionId = null;
        this.peerConnection = null;
        this.videoElement = null;
        this.canvasElement = null; // For H.265 rendering
        this.audioContext = null;
        this.intercomEnabled = options.enableIntercom ?? false;
        this.dataChannel = null;
        this.videoDataChannel = null;
        this.localStream = null;
        this.onStateChange = options.onStateChange || (() => { });
        this.onError = options.onError || console.error;
        this.onStats = options.onStats || (() => { });
        this.onCodecDetected = options.onCodecDetected || (() => { });
        this.state = 'disconnected'; // disconnected, connecting, connected, failed

        // Codec info
        this.videoCodec = null;
        this.videoDecoder = null;
        this.pendingChunks = null; // For reassembling chunked frames
        this.receivedFirstKeyframe = false; // Track if we've received first H.265 keyframe

        // Stats tracking
        this.stats = {
            videoFrames: 0,
            audioFrames: 0,
            bytesReceived: 0,
            packetsLost: 0,
            jitter: 0,
            roundTripTime: 0,
            codec: null,
        };
        this.statsInterval = null;
    }

    /**
     * Check if WebCodecs is supported for H.265
     */
    static isWebCodecsSupported() {
        return typeof VideoDecoder !== 'undefined';
    }

    /**
     * Connect to a camera stream via WebRTC
     * @param {string} cameraName - Camera name (sanitized)
     * @param {string} profile - Stream profile (main, sub, ext)
     * @param {HTMLVideoElement} videoElement - Video element to display stream
     * @param {HTMLCanvasElement} canvasElement - Optional canvas for H.265 rendering
     */
    async connect(cameraName, profile, videoElement, canvasElement = null) {
        if (this.state === 'connecting' || this.state === 'connected') {
            console.warn('WebRTC already connecting or connected');
            return;
        }

        this.videoElement = videoElement;
        this.canvasElement = canvasElement;
        this.setState('connecting');

        try {
            // Step 1: Create session on server (get offer)
            const createResponse = await fetch('/api/webrtc/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cameraName,
                    profile,
                    enableIntercom: this.intercomEnabled,
                }),
            });

            if (!createResponse.ok) {
                const error = await createResponse.json();
                throw new Error(error.error || 'Failed to create session');
            }

            const { sessionId, offer } = await createResponse.json();
            this.sessionId = sessionId;

            console.debug(`[WebRTC] Session created: ${sessionId}`);

            // Step 2: Create peer connection
            this.peerConnection = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });

            // Handle incoming tracks (H.264)
            this.peerConnection.ontrack = (event) => {
                console.debug(`[WebRTC] Track received: ${event.track.kind}`);
                if (event.track.kind === 'video' && this.videoElement) {
                    this.videoElement.srcObject = event.streams[0];
                    this.videoElement.play().catch(console.error);
                }
            };

            // Handle ICE candidates
            this.peerConnection.onicecandidate = async (event) => {
                if (event.candidate) {
                    console.debug('[WebRTC] Sending ICE candidate');
                    await this.sendIceCandidate(event.candidate);
                }
            };

            // Handle connection state changes
            this.peerConnection.onconnectionstatechange = () => {
                const state = this.peerConnection.connectionState;
                console.debug(`[WebRTC] Connection state: ${state}`);
                if (state === 'connected') {
                    this.setState('connected');
                    this.startStatsCollection();
                } else if (state === 'disconnected' || state === 'failed') {
                    this.setState('failed');
                    this.disconnect();
                }
            };

            // Handle ICE connection state changes
            this.peerConnection.oniceconnectionstatechange = () => {
                console.debug(`[WebRTC] ICE state: ${this.peerConnection.iceConnectionState}`);
            };

            // Handle data channels
            this.peerConnection.ondatachannel = (event) => {
                const channel = event.channel;
                console.debug(`[WebRTC] Data channel received: ${channel.label}`);

                if (channel.label === 'video') {
                    this.videoDataChannel = channel;
                    this.setupVideoDataChannel();
                } else if (channel.label === 'intercom') {
                    this.dataChannel = channel;
                    this.setupDataChannel();
                }
            };

            // Step 3: Set remote description (server's offer)
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

            // Step 4: Create and send answer
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            // Wait for ICE gathering
            await this.waitForIceGathering();

            // Step 5: Send answer to server
            const answerResponse = await fetch(`/api/webrtc/session/${sessionId}/answer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sdp: this.peerConnection.localDescription.sdp,
                    type: 'answer',
                }),
            });

            if (!answerResponse.ok) {
                const error = await answerResponse.json();
                throw new Error(error.error || 'Failed to send answer');
            }

            console.debug('[WebRTC] Answer sent, waiting for connection...');

            // If intercom enabled, request microphone access
            if (this.intercomEnabled) {
                await this.setupIntercom();
            }

        } catch (err) {
            console.error('[WebRTC] Connection error:', err);
            this.onError(err);
            this.setState('failed');
            await this.disconnect();
        }
    }

    /**
     * Disconnect from the WebRTC session
     */
    async disconnect() {
        console.debug('[WebRTC] Disconnecting...');

        this.stopStatsCollection();

        // Close H.265 decoder
        if (this.videoDecoder) {
            try {
                this.videoDecoder.close();
            } catch (e) { }
            this.videoDecoder = null;
        }

        // Stop local media
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        // Close data channels
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }
        if (this.videoDataChannel) {
            this.videoDataChannel.close();
            this.videoDataChannel = null;
        }

        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        // Close session on server
        if (this.sessionId) {
            try {
                await fetch(`/api/webrtc/session/${this.sessionId}`, {
                    method: 'DELETE',
                });
            } catch (err) {
                console.warn('[WebRTC] Error closing server session:', err);
            }
            this.sessionId = null;
        }

        // Clear video
        if (this.videoElement) {
            this.videoElement.srcObject = null;
        }

        // Remove canvas if we created it
        if (this.canvasElement && this.canvasElement.parentElement) {
            // Show video element again if we hid it
            if (this.videoElement) {
                this.videoElement.style.display = '';
            }
        }

        this.videoCodec = null;
        this.receivedFirstKeyframe = false;
        this.pendingChunks = null;
        this.setState('disconnected');
    }

    /**
     * Start intercom (send audio to camera)
     */
    async startIntercom() {
        if (!this.intercomEnabled || !this.dataChannel) {
            console.warn('[WebRTC] Intercom not available');
            return false;
        }

        try {
            // Get microphone access
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: false,
            });

            // Set up audio processing
            this.audioContext = new AudioContext({ sampleRate: 8000 });
            const source = this.audioContext.createMediaStreamSource(this.localStream);
            const processor = this.audioContext.createScriptProcessor(1024, 1, 1);

            processor.onaudioprocess = (event) => {
                if (this.dataChannel && this.dataChannel.readyState === 'open') {
                    const inputData = event.inputBuffer.getChannelData(0);
                    // Convert to 16-bit PCM
                    const pcmData = new Int16Array(inputData.length);
                    for (let i = 0; i < inputData.length; i++) {
                        pcmData[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
                    }
                    this.dataChannel.send(pcmData.buffer);
                }
            };

            source.connect(processor);
            processor.connect(this.audioContext.destination);

            console.debug('[WebRTC] Intercom started');
            return true;
        } catch (err) {
            console.error('[WebRTC] Failed to start intercom:', err);
            this.onError(err);
            return false;
        }
    }

    /**
     * Stop intercom
     */
    stopIntercom() {
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        console.debug('[WebRTC] Intercom stopped');
    }

    /**
     * Get current connection stats
     */
    getStats() {
        return { ...this.stats };
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    setState(state) {
        this.state = state;
        this.onStateChange(state);
    }

    async sendIceCandidate(candidate) {
        if (!this.sessionId) return;

        try {
            await fetch(`/api/webrtc/session/${this.sessionId}/ice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid,
                    sdpMLineIndex: candidate.sdpMLineIndex,
                }),
            });
        } catch (err) {
            console.warn('[WebRTC] Failed to send ICE candidate:', err);
        }
    }

    async waitForIceGathering(timeoutMs = 3000) {
        if (this.peerConnection.iceGatheringState === 'complete') return;

        return new Promise((resolve) => {
            const timeout = setTimeout(resolve, timeoutMs);

            this.peerConnection.onicegatheringstatechange = () => {
                if (this.peerConnection.iceGatheringState === 'complete') {
                    clearTimeout(timeout);
                    resolve();
                }
            };
        });
    }

    setupDataChannel() {
        if (!this.dataChannel) return;

        this.dataChannel.onopen = () => {
            console.debug('[WebRTC] Intercom data channel opened');
        };

        this.dataChannel.onclose = () => {
            console.debug('[WebRTC] Intercom data channel closed');
        };

        this.dataChannel.onerror = (err) => {
            console.error('[WebRTC] Intercom data channel error:', err);
        };
    }

    setupVideoDataChannel() {
        if (!this.videoDataChannel) return;

        this.videoDataChannel.binaryType = 'arraybuffer';

        this.videoDataChannel.onopen = () => {
            console.debug('[WebRTC] Video data channel opened');
        };

        this.videoDataChannel.onmessage = (event) => {
            this.handleVideoDataChannelMessage(event.data);
        };

        this.videoDataChannel.onclose = () => {
            console.debug('[WebRTC] Video data channel closed');
        };

        this.videoDataChannel.onerror = (err) => {
            console.error('[WebRTC] Video data channel error:', err);
        };
    }

    handleVideoDataChannelMessage(data) {
        // Handle text messages (codec info)
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'codec') {
                    this.videoCodec = msg.codec;
                    this.stats.codec = msg.codec;
                    console.debug(`[WebRTC] Video codec: ${msg.codec} (${msg.width}x${msg.height})`);
                    this.onCodecDetected(msg.codec, msg.width, msg.height);

                    if (msg.codec === 'H265') {
                        this.initH265Decoder(msg.width, msg.height);
                    }
                }
            } catch (e) {
                console.warn('[WebRTC] Failed to parse video message:', e);
            }
            return;
        }

        // Handle binary data (H.265 frames)
        if (data instanceof ArrayBuffer) {
            const arr = new Uint8Array(data);

            // Check if this is a chunked frame or a complete frame
            // Complete frame: starts with 12-byte header where first 4 bytes are frame number (big endian)
            // Chunked frame: first byte is chunk index (0-255), second byte is total chunks (2-255)

            // Heuristic: if arr[1] > 1 and arr[1] < 64 and arr[0] < arr[1], it's likely a chunk
            // Because frame numbers are typically large (>256) and chunk indices are small
            const possibleChunkIndex = arr[0];
            const possibleTotalChunks = arr[1];

            if (possibleTotalChunks > 1 && possibleTotalChunks < 64 && possibleChunkIndex < possibleTotalChunks) {
                // This is a chunked frame
                this.handleChunkedFrame(arr, possibleChunkIndex, possibleTotalChunks);
            } else {
                // This is a complete frame
                if (this.stats.videoFrames < 3) {
                    console.debug(`[WebRTC] Received complete H.265 frame: ${arr.length} bytes`);
                }
                this.handleH265Frame(arr);
            }
        }
    }

    handleChunkedFrame(data, chunkIndex, totalChunks) {
        // Extract chunk data (skip 2-byte chunk header)
        const chunkData = data.slice(2);

        // Initialize pending frame buffer if this is first chunk
        if (chunkIndex === 0) {
            this.pendingChunks = {
                chunks: new Array(totalChunks),
                received: 0,
                totalChunks: totalChunks,
            };
        }

        if (!this.pendingChunks || this.pendingChunks.totalChunks !== totalChunks) {
            console.warn(`[WebRTC] Chunk mismatch: expected ${this.pendingChunks?.totalChunks}, got ${totalChunks}`);
            return;
        }

        // Store chunk
        if (!this.pendingChunks.chunks[chunkIndex]) {
            this.pendingChunks.chunks[chunkIndex] = chunkData;
            this.pendingChunks.received++;
        }

        // Check if all chunks received
        if (this.pendingChunks.received === totalChunks) {
            // Reassemble frame
            const totalLength = this.pendingChunks.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const completeFrame = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of this.pendingChunks.chunks) {
                completeFrame.set(chunk, offset);
                offset += chunk.length;
            }

            if (this.stats.videoFrames < 3) {
                console.debug(`[WebRTC] Reassembled H.265 frame: ${completeFrame.length} bytes from ${totalChunks} chunks`);
            }

            this.pendingChunks = null;
            this.handleH265Frame(completeFrame);
        }
    }

    async initH265Decoder(width, height) {
        if (!WebRTCClient.isWebCodecsSupported()) {
            console.error('[WebRTC] WebCodecs not supported - H.265 playback unavailable');
            this.onError(new Error('H.265 requires WebCodecs support. Please use Chrome 94+ or enable experimental features.'));
            return;
        }

        try {
            // Check if HEVC is supported
            const support = await VideoDecoder.isConfigSupported({
                codec: 'hev1.1.6.L93.B0', // Main profile, Level 3.1
                codedWidth: width || 1920,
                codedHeight: height || 1080,
            });

            if (!support.supported) {
                throw new Error('H.265/HEVC codec not supported by this browser');
            }

            this.videoDecoder = new VideoDecoder({
                output: (frame) => {
                    this.renderVideoFrame(frame);
                    frame.close();
                },
                error: (err) => {
                    console.error('[WebRTC] H.265 decoder error:', err);
                },
            });

            this.videoDecoder.configure({
                codec: 'hev1.1.6.L93.B0',
                codedWidth: width || 1920,
                codedHeight: height || 1080,
                optimizeForLatency: true,
            });

            console.debug('[WebRTC] H.265 decoder initialized');

            // Use canvas for rendering if available, otherwise create one
            if (!this.canvasElement && this.videoElement) {
                // Create a canvas that replaces the video element
                this.canvasElement = document.createElement('canvas');
                this.canvasElement.width = width || 1920;
                this.canvasElement.height = height || 1080;
                this.canvasElement.className = 'webrtc-h265-canvas';

                // Use the same styles as the video element but ensure visibility
                // Copy computed styles from video
                const videoRect = this.videoElement.getBoundingClientRect();
                const videoStyle = window.getComputedStyle(this.videoElement);

                // Insert canvas right after video element (same position in DOM)
                this.videoElement.insertAdjacentElement('afterend', this.canvasElement);

                // Copy video's class for consistent styling
                this.canvasElement.className = this.videoElement.className + ' webrtc-h265-canvas';

                // Style canvas to fill container properly
                this.canvasElement.style.display = 'block';
                this.canvasElement.style.width = '100%';
                this.canvasElement.style.maxWidth = '100%';
                this.canvasElement.style.height = 'auto';
                this.canvasElement.style.aspectRatio = `${width || 1920} / ${height || 1080}`;
                this.canvasElement.style.objectFit = 'contain';
                this.canvasElement.style.backgroundColor = '#000';

                // Hide the video element (it won't be used for H.265)
                this.videoElement.style.display = 'none';

                console.debug(`[WebRTC] Canvas created with aspect ratio ${width || 1920}x${height || 1080}, video was ${videoRect.width}x${videoRect.height}`);
            }

        } catch (err) {
            console.error('[WebRTC] Failed to initialize H.265 decoder:', err);
            this.onError(err);
        }
    }

    handleH265Frame(data) {
        if (!this.videoDecoder) {
            if (this.stats.videoFrames === 0) {
                console.warn('[WebRTC] No video decoder for H.265 frame');
            }
            return;
        }

        if (this.videoDecoder.state !== 'configured') {
            if (this.stats.videoFrames === 0) {
                console.warn('[WebRTC] Video decoder not configured:', this.videoDecoder.state);
            }
            return;
        }

        if (data.length < 12) {
            console.warn('[WebRTC] H.265 frame too short:', data.length);
            return;
        }

        // Parse header: [frameNum(4)][timestamp(4)][flags(1)][keyframe(1)][reserved(2)]
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const frameNumber = view.getUint32(0);
        const timestampMs = view.getUint32(4);
        const flags = view.getUint8(8);
        const isKeyframe = view.getUint8(9) === 1;

        // Extract Annex-B data
        const annexBData = data.slice(12);

        // Log first few frames
        if (this.stats.videoFrames < 5) {
            console.debug(`[WebRTC] H.265 frame ${frameNumber}: ${annexBData.length} bytes, keyframe=${isKeyframe}, ts=${timestampMs}`);
        }

        // WebCodecs requires a keyframe first after configure()
        // Skip non-keyframes until we receive a keyframe
        if (!this.receivedFirstKeyframe) {
            if (!isKeyframe) {
                if (this.stats.videoFrames === 0) {
                    console.debug(`[WebRTC] Waiting for first keyframe (skipping frame ${frameNumber})`);
                }
                return;
            }
            this.receivedFirstKeyframe = true;
            console.debug(`[WebRTC] Received first keyframe at frame ${frameNumber}`);
        }

        try {
            const chunk = new EncodedVideoChunk({
                type: isKeyframe ? 'key' : 'delta',
                timestamp: timestampMs * 1000, // Convert to microseconds
                data: annexBData,
            });

            this.videoDecoder.decode(chunk);
            this.stats.videoFrames++;
            this.stats.bytesReceived += data.length;

            if (this.stats.videoFrames <= 5) {
                console.debug(`[WebRTC] Decoded frame ${frameNumber} successfully`);
            }

        } catch (err) {
            console.warn('[WebRTC] Failed to decode H.265 frame:', err);
            // If decode fails, reset and wait for next keyframe
            if (err.name === 'DataError' && err.message.includes('key frame')) {
                console.debug('[WebRTC] Resetting, waiting for next keyframe');
                this.receivedFirstKeyframe = false;
            }
        }
    }

    renderVideoFrame(frame) {
        if (!this.canvasElement) {
            console.warn('[WebRTC] No canvas element for rendering');
            return;
        }

        const ctx = this.canvasElement.getContext('2d');
        if (!ctx) {
            console.warn('[WebRTC] Cannot get 2d context from canvas');
            return;
        }

        // Resize canvas if needed
        if (this.canvasElement.width !== frame.codedWidth ||
            this.canvasElement.height !== frame.codedHeight) {
            console.debug(`[WebRTC] Resizing canvas to ${frame.codedWidth}x${frame.codedHeight}`);
            this.canvasElement.width = frame.codedWidth;
            this.canvasElement.height = frame.codedHeight;

            // Update aspect ratio for proper CSS sizing
            this.canvasElement.style.aspectRatio = `${frame.codedWidth} / ${frame.codedHeight}`;

            // Ensure canvas is visible
            this.canvasElement.style.display = 'block';
            this.canvasElement.style.visibility = 'visible';

            // Fire a custom event for UI to update
            if (this.onCodecDetected) {
                this.onCodecDetected({
                    codec: 'H265',
                    width: frame.codedWidth,
                    height: frame.codedHeight
                });
            }
        }

        ctx.drawImage(frame, 0, 0);

        // Log first few renders
        if (this.stats.videoFrames <= 3) {
            const canvasRect = this.canvasElement.getBoundingClientRect();
            console.debug(`[WebRTC] Rendered frame ${this.stats.videoFrames}: ${frame.codedWidth}x${frame.codedHeight}, canvas visible: ${canvasRect.width}x${canvasRect.height}`);
        }
    }

    async setupIntercom() {
        // Intercom setup is deferred until user explicitly starts it
        console.debug('[WebRTC] Intercom ready (call startIntercom() to begin)');
    }

    startStatsCollection() {
        this.statsInterval = setInterval(async () => {
            if (!this.peerConnection) return;

            try {
                const stats = await this.peerConnection.getStats();
                stats.forEach((report) => {
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        // Only update from RTP stats if we're using H.264
                        if (this.videoCodec === 'H264' || !this.videoCodec) {
                            this.stats.videoFrames = report.framesDecoded || 0;
                            this.stats.bytesReceived = report.bytesReceived || 0;
                        }
                        this.stats.packetsLost = report.packetsLost || 0;
                        this.stats.jitter = report.jitter || 0;
                    }
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        this.stats.roundTripTime = report.currentRoundTripTime || 0;
                    }
                });
                this.onStats(this.stats);
            } catch (err) {
                // Ignore stats errors
            }
        }, 1000);
    }

    stopStatsCollection() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
    }
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
    window.WebRTCClient = WebRTCClient;
}

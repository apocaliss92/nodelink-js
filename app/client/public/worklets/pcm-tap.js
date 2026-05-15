/**
 * AudioWorklet that taps microphone PCM and posts mono Float32 sample buffers
 * back to the main thread. The main thread accumulates them, slices into
 * fixed-size chunks (1024 samples for Reolink's TalkConfig), converts to
 * Int16 PCM, IMA-ADPCM-encodes them, and ships them over the intercom
 * DataChannel.
 *
 * Mono-only: if the input is stereo we average the two channels. Reolink's
 * TalkAbility audioConfig always announces a single channel.
 *
 * No buffering done here — we post every render quantum (typically 128
 * samples) to keep latency minimal. The main thread does the bigger
 * 1024-sample accumulation.
 */
class PcmTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;
    // Mono: copy ch0 directly; stereo: average ch0+ch1.
    let out;
    if (input.length > 1 && input[1] && input[1].length === ch0.length) {
      out = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        out[i] = (ch0[i] + input[1][i]) * 0.5;
      }
    } else {
      // Slice to copy out of the worklet's owned buffer (the underlying
      // memory is reused across calls; posting it directly would cause the
      // main thread to see stale data on the next tick).
      out = ch0.slice();
    }
    this.port.postMessage(out, [out.buffer]);
    return true;
  }
}
registerProcessor("pcm-tap", PcmTapProcessor);

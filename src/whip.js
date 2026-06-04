// Minimal WHIP publisher (RFC 9725). This is the ONLY non-REST piece of the
// broadcaster flow: it pushes the browser's webcam straight to MediaMTX over
// WebRTC. Your API is never in this path — the SDP offer/answer handshake is
// browser ⇄ MediaMTX directly.
//
//   1. wrap the webcam MediaStream in an RTCPeerConnection
//   2. create an SDP offer, gather ICE candidates
//   3. POST the offer to the WHIP URL (publish_endpoints.whip from the API)
//   4. apply MediaMTX's SDP answer → media starts flowing
export async function whipPublish(whipUrl, mediaStream) {
  const pc = new RTCPeerConnection({ iceServers: [] });

  // Send-only: we publish, we don't receive.
  for (const track of mediaStream.getTracks()) {
    const tx = pc.addTransceiver(track, { direction: 'sendonly', streams: [mediaStream] });
    // CRITICAL: force H.264 for video. WebRTC defaults to VP8, but the
    // packager pulls over RTMP (H.264/AAC only) and does -c copy (no
    // transcode) — a VP8 publish makes ffmpeg fail and no HLS is produced.
    if (track.kind === 'video') preferH264(tx);
  }

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // MediaMTX's WHIP wants a complete offer (non-trickle), so wait for ICE
  // gathering to finish before POSTing — with a 2s safety timeout.
  await waitForIceGathering(pc, 2000);

  const res = await fetch(whipUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription.sdp,
  });
  if (!res.ok) {
    pc.close();
    throw new Error(`WHIP publish failed: HTTP ${res.status} — ${await res.text().catch(() => '')}`);
  }
  const answerSdp = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  return pc; // caller keeps it; call pc.close() to stop broadcasting
}

// preferH264 reorders the transceiver's codec list so H.264 is offered first,
// so MediaMTX negotiates H.264 instead of VP8. If the browser can't encode
// H.264, it silently leaves the default (and the publish will fail at the
// packager — use OBS instead, which is always H.264).
function preferH264(transceiver) {
  if (!transceiver.setCodecPreferences || !window.RTCRtpSender?.getCapabilities) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const h264 = caps.codecs.filter((c) => /h264/i.test(c.mimeType));
  if (!h264.length) {
    console.warn('[whip] browser has no H.264 WebRTC encoder — publish will likely fail; use OBS');
    return;
  }
  const rest = caps.codecs.filter((c) => !/h264/i.test(c.mimeType));
  try {
    transceiver.setCodecPreferences([...h264, ...rest]);
    console.info('[whip] preferring H.264 for publish');
  } catch (e) {
    console.warn('[whip] setCodecPreferences failed', e);
  }
}

function waitForIceGathering(pc, timeoutMs) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

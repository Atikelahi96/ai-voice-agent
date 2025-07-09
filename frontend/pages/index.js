// pages/index.js
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Mic2, CheckCircle2, ChevronUp, ChevronDown } from "lucide-react";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://localhost:8000/ws";

export default function Home() {
  // — Connection & form state —
  const [status, setStatus] = useState("Disconnected");
  const [isRec, setIsRec] = useState(false);
  const [form, setForm] = useState({ name: "", email: "" });
  const [formType, setFormType] = useState("");
  const [submittedData, setSubmittedData] = useState(null);

  // — UI state —
  const [showDebug, setShowDebug] = useState(false);
  const [highlightField, setHighlightField] = useState(null);

  // — Audio & WS refs —
  const audioCtxRef = useRef(null);
  const hpRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const wsRef = useRef(null);
  const micStreamRef = useRef(null);
  const captureCtxRef = useRef(null);

  // — Config —
  const OUTPUT_SAMPLE_RATE = 24000;

  // ─── AUDIO PLAYBACK ────────────────────────────────────────────────────────
  function getAudioContext() {
    if (!audioCtxRef.current) {
      const C = window.AudioContext || window.webkitAudioContext;
      const ctx = new C({ sampleRate: OUTPUT_SAMPLE_RATE });
      ctx.resume(); // ensure not suspended by autoplay policies

      // high-pass filter to remove DC offset
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 20;
      hp.Q.value = 0.7;
      hp.connect(ctx.destination);

      audioCtxRef.current = ctx;
      hpRef.current = hp;
      nextPlayTimeRef.current = ctx.currentTime;
    }
    return audioCtxRef.current;
  }

  function scheduleBufferWithFade(arrayBuffer) {
    // convert PCM16 → Float32
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const ctx = getAudioContext();
    // clamp scheduler if it's fallen behind
    if (nextPlayTimeRef.current < ctx.currentTime) {
      nextPlayTimeRef.current = ctx.currentTime;
    }

    // build a single AudioBuffer for the frame
    const buf = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buf.getChannelData(0).set(float32);

    // create GainNode for fade in/out
    const fade = 0.005;
    const gainNode = ctx.createGain();
    gainNode.connect(hpRef.current);

    // schedule playback
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gainNode);

    const t0 = nextPlayTimeRef.current;
    gainNode.gain.setValueAtTime(0, t0);
    gainNode.gain.linearRampToValueAtTime(1, t0 + fade);
    gainNode.gain.setValueAtTime(1, t0 + buf.duration - fade);
    gainNode.gain.linearRampToValueAtTime(0, t0 + buf.duration);

    src.start(t0);
    nextPlayTimeRef.current += buf.duration;
  }

  // ─── WEBSOCKET SETUP ───────────────────────────────────────────────────────
  const connectWS = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    setStatus("Connecting…");
    wsRef.current = ws;

    ws.onopen = () => setStatus("Connected");
    ws.onclose = () => {
      setStatus("Disconnected");
      setTimeout(connectWS, 2500);
    };
    ws.onerror = (e) => {
      console.error("WS error", e);
      ws.close();
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data === "string") {
        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }
        switch (msg.status) {
          case "opened":
            setFormType(msg.form_type);
            setForm({ name: "", email: "" });
            setSubmittedData(null);
            break;
          case "filled":
            setForm((f) => ({ ...f, [msg.field]: msg.value }));
            setHighlightField(msg.field);
            setTimeout(() => setHighlightField(null), 800);
            break;
          case "submitted":
            setSubmittedData(msg.data);
            break;
        }
      } else {
        scheduleBufferWithFade(evt.data);
      }
    };

    return ws;
  }, []);

  useEffect(() => {
    const ws = connectWS();
    return () => wsRef.current?.close();
  }, [connectWS]);

  // ─── RECORDING TOGGLE ─────────────────────────────────────────────────────
  const toggleRec = async () => {
    if (isRec) {
      // STOP recording
      captureCtxRef.current?.close();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      captureCtxRef.current = null;
      setIsRec(false);
      return;
    }

    try {
      // 1) request mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // 2) ensure playback context is running
      getAudioContext();

      // 3) set up capture context + worklet
      const C = window.AudioContext || window.webkitAudioContext;
      const captureCtx = new C({ sampleRate: 16000 });
      await captureCtx.resume(); // must resume inside user gesture
      await captureCtx.audioWorklet.addModule("/worklet-processor.js");

      // 4) keep worklet alive via silent gain
      const silentGain = captureCtx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(captureCtx.destination);

      // 5) instantiate worklet node
      const workletNode = new AudioWorkletNode(captureCtx, "mic-processor");
      workletNode.port.onmessage = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      workletNode.connect(silentGain);

      // 6) connect mic → worklet
      const src = captureCtx.createMediaStreamSource(stream);
      src.connect(workletNode);

      // 7) mark recording on
      captureCtxRef.current = captureCtx;
      setIsRec(true);
    } catch (err) {
      console.error("Microphone error:", err);
    }
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-blue-50">
      {/* HEADER */}
      <header className="flex items-center justify-between bg-blue-200 shadow p-4 fixed w-full z-10">
        <h1 className="text-xl font-bold text-blue-900">
          🎙 Ultra-Low Latency AI Voice Agent
        </h1>
        <span className={`text-sm ${status === "Connected" ? "text-green-700" : "text-red-700"}`}>
          {status}
        </span>
      </header>

      {/* MAIN */}
      <main className="pt-16 flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4">
        {/* LEFT */}
        <section className="space-y-4">
          <div className="bg-blue-100 rounded-xl shadow p-4">
            <button
              onClick={toggleRec}
              className={`
                flex items-center justify-center space-x-2 rounded-full px-4 py-2 text-white
                ${isRec ? "bg-red-600 rec-pulse" : "bg-green-600 hover:bg-green-700"}
                transition-all duration-200
              `}
            >
              <Mic2 size={20} />
              <span>{isRec ? "Stop" : "Start"} Talking</span>
            </button>
          </div>

          {/* Debug Panel */}
          <div className="bg-blue-100 rounded-xl shadow p-4">
            <button
              onClick={() => setShowDebug((v) => !v)}
              className="flex items-center justify-between w-full text-left"
            >
              <span>🚨 Debug Panel</span>
              {showDebug ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showDebug && (
              <pre className="mt-2 text-xs whitespace-pre-wrap text-blue-900">
                <strong>formType:</strong> {formType}{"\n"}
                <strong>form:</strong> {JSON.stringify(form, null, 2)}{"\n"}
                <strong>submittedData:</strong> {JSON.stringify(submittedData, null, 2)}
              </pre>
            )}
          </div>
        </section>

        {/* RIGHT */}
        <section className="space-y-4">
          {formType && !submittedData && (
            <div className="bg-white rounded-xl shadow p-6">
              <h2 className="text-lg font-semibold mb-4 text-blue-800">Registration Form</h2>
              {["name", "email"].map((field) => (
                <div key={field} className="mb-4">
                  <label className="block text-lg mb-1 capitalize text-blue-700">{field}</label>
                  <input
                    readOnly
                    type={field === "email" ? "email" : "text"}
                    value={form[field]}
                    className={`w-full p-2 rounded border bg-blue-50 ${
                      highlightField === field ? "ring-2 ring-yellow-400 ring-opacity-75" : ""
                    }`}
                  />
                </div>
              ))}
            </div>
          )}

          {submittedData && (
            <div className="bg-green-100 rounded-xl shadow p-6">
              <div className="flex items-center space-x-2 mb-4">
                <CheckCircle2 size={24} className="text-green-600" />
                <h2 className="text-lg font-semibold text-green-700">Form Submitted</h2>
              </div>
              <pre className="text-sm text-gray-700">{JSON.stringify(submittedData, null, 2)}</pre>
            </div>
          )}

          {!formType && !submittedData && (
            <div className="text-blue-700 text-lg leading-relaxed">
              <p>Say: <span className="italic">"I want to fill a form"</span> to begin</p>
              <p className="mt-2">Then: "My name is...", "My email is...", then "submit."</p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

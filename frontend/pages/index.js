
import React, { useEffect, useRef, useState, useCallback } from "react";
import { Mic2, CheckCircle2 } from "lucide-react";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS || "ws://localhost:8000/ws";

export default function Home() {
  // — State —
  const [status, setStatus] = useState("Disconnected");
  const [isRec, setIsRec] = useState(false);
  const [form, setForm] = useState({ name: "", email: "" });
  const [formType, setFormType] = useState("");
  const [submittedData, setSubmittedData] = useState(null);

  // — Refs for audio & WS —
  const audioCtxRef = useRef(null);
  const hpRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const wsRef = useRef(null);
  const micStreamRef = useRef(null);
  const captureCtxRef = useRef(null);

  const OUTPUT_SAMPLE_RATE = 24000;

  // ─── AUDIO PLAYBACK ───────────────────────────
  function getAudioContext() {
    if (!audioCtxRef.current) {
      const C = window.AudioContext || window.webkitAudioContext;
      const ctx = new C({ sampleRate: OUTPUT_SAMPLE_RATE });
      ctx.resume();
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
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }
    const ctx = getAudioContext();
    if (nextPlayTimeRef.current < ctx.currentTime) {
      nextPlayTimeRef.current = ctx.currentTime;
    }
    const buf = ctx.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buf.getChannelData(0).set(float32);

    const fade = 0.005;
    const gainNode = ctx.createGain();
    gainNode.connect(hpRef.current);

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

  // ─── WEBSOCKET SETUP ─────────────────────────
  const connectWS = useCallback(() => {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    setStatus("Connecting…");
    wsRef.current = ws;

    ws.onopen = () => setStatus("Connected");
    ws.onclose = () => {
      setStatus("Disconnected");
      // retry
      setTimeout(connectWS, 2500);
    };
    ws.onerror = (e) => {
      console.error("WS error", e);
      ws.close();
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data === "string") {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        switch (msg.status) {
          case "opened":
            setFormType(msg.form_type);
            setForm({ name: "", email: "" });
            setSubmittedData(null);
            break;
          case "filled":
            setForm((f) => ({ ...f, [msg.field]: msg.value }));
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

  // ─── RECORDING TOGGLE ─────────────────────────
  const toggleRec = async () => {
    if (isRec) {
      captureCtxRef.current?.close();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      captureCtxRef.current = null;
      setIsRec(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      getAudioContext();

      const C = window.AudioContext || window.webkitAudioContext;
      const captureCtx = new C({ sampleRate: 16000 });
      await captureCtx.resume();
      await captureCtx.audioWorklet.addModule("/worklet-processor.js");

      const silentGain = captureCtx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(captureCtx.destination);

      const workletNode = new AudioWorkletNode(captureCtx, "mic-processor");
      workletNode.port.onmessage = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data);
        }
      };
      workletNode.connect(silentGain);

      const src = captureCtx.createMediaStreamSource(stream);
      src.connect(workletNode);

      captureCtxRef.current = captureCtx;
      setIsRec(true);
    } catch (err) {
      console.error("Microphone error:", err);
    }
  };

  // ─── RENDER ────────────────────────────────────

  const IdleCircle = () => (
    <div className="relative z-10 flex items-center justify-center h-screen w-screen">
      <div
        className={`${
          isRec
            ? "h-48 w-48 bg-blue-600 opacity-30 animate-ping"
            : "h-24 w-24 bg-blue-500"
        } rounded-full transition-all duration-300`}
      />
    </div>
  );

  const SubmissionMessage = () => (
    <div className="bg-blue-800 bg-opacity-30 rounded-2xl shadow-lg p-8 max-w-md mx-auto animate-slide-up">
      <div className="flex items-center space-x-3 mb-4">
        <CheckCircle2 size={28} className="text-blue-200" />
        <h2 className="text-xl font-semibold text-blue-50">
          Thank you, {submittedData.name}!
        </h2>
      </div>
      <p className="text-blue-100">
        We’ve received your registration and will contact you at{" "}
        <strong>{submittedData.email}</strong>.
      </p>
    </div>
  );

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background + blur + tint */}
      <div className="absolute inset-0 bg-[url('/images/bg.jpg')] bg-cover bg-center filter blur-sm before:content-[''] before:absolute before:inset-0 before:bg-blue-950 before:bg-opacity-60" />

      {/* NAVBAR */}
      <nav className="relative z-20 flex items-center justify-between bg-blue-800 bg-opacity-90 p-4">
        <h1 className="text-4xl font-bold text-blue-50">
          🎙 AI Voice Agent
        </h1>
        <button
          onClick={toggleRec}
          className="flex items-center space-x-2 rounded-full bg-blue-600 hover:bg-blue-500 px-4 py-2 text-white transition"
        >
          <Mic2 size={20} />
          <span>{isRec ? "Stop Talking" : "Start Talking"}</span>
        </button>
      </nav>

      {/* MAIN CONTENT */}
      <main className="pt-20">
        {/* Idle */}
        {!formType && !submittedData && <IdleCircle />}

        {/* Active form */}
        {formType && !submittedData && (
          <div className="max-w-lg mx-auto p-6">
            <div className="bg-blue-800 bg-opacity-30 rounded-2xl shadow-lg p-6 animate-slide-up">
              <h2 className="text-xl font-semibold mb-4 text-blue-50">
                Registration Form
              </h2>
              {["name", "email"].map((field) => (
                <div key={field} className="mb-4">
                  <label className="block text-lg mb-1 capitalize text-blue-200">
                    {field}
                  </label>
                  <input
                    readOnly
                    type={field === "email" ? "email" : "text"}
                    value={form[field]}
                    className="form-input w-full rounded-lg border border-blue-700 bg-blue-100 px-4 py-2 focus:ring focus:ring-blue-600 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Submission */}
        {submittedData && <SubmissionMessage />}
      </main>
    </div>
  );
}

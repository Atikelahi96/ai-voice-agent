import os  
import time
import json
import logging
from dotenv import load_dotenv

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from websockets.exceptions import ConnectionClosedError

from dataclasses import dataclass, field
from typing import Dict, Any
import re  # <-- for normalization

# ─── Pipecat Core ────────────────────────────────────────────────────────────
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.processors.frameworks.rtvi import RTVIProcessor, RTVIObserver
from pipecat.audio.vad.silero import SileroVADAnalyzer, VADParams
from pipecat.frames.frames import InputAudioRawFrame, OutputAudioRawFrame
from pipecat.serializers.base_serializer import FrameSerializer, FrameSerializerType

# ─── Transports ──────────────────────────────────────────────────────────────
from pipecat.transports.network.fastapi_websocket import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)

# ─── Gemini Live API ─────────────────────────────────────────────────────────
from pipecat.services.gemini_multimodal_live.gemini import (
    GeminiMultimodalLiveLLMService,
    InputParams,
)
from pipecat.services.llm_service import FunctionCallParams

# ─── Tool-calling helpers ────────────────────────────────────────────────────
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext

# ─── Bootstrap & Logging ─────────────────────────────────────────────────────
load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voice-agent")

app = FastAPI(title="Ultra-Low-Latency Voice Agent")


# ─── 1) Robust transport that never drops the pipeline ───────────────────────
class RobustWebsocketTransport(FastAPIWebsocketTransport):
    async def _receive_messages(self):
        try:
            while self._ws and not self._closed:
                try:
                    msg = await self._ws.receive()
                except (WebSocketDisconnect, ConnectionClosedError):
                    return

                if msg.get("bytes") is not None:
                    logger.debug(f"Audio frame received at {time.time()*1000:.1f}ms")
                audio_bytes = msg.get("bytes")
                if audio_bytes and isinstance(audio_bytes, (bytes, bytearray)):
                    frame = InputAudioRawFrame(
                        audio=audio_bytes, sample_rate=16_000, num_channels=1
                    )
                    await self.push_audio_frame(frame)
                    continue

                # drop any text pings
                if msg.get("text") is not None:
                    continue

        except Exception:
            logger.exception("Unexpected error in receive loop")
        finally:
            return


# ─── 2) Form state + PCM serializer ──────────────────────────────────────────
@dataclass
class FormState:
    form_type: str | None = None
    fields: Dict[str, Any] = field(default_factory=dict)

    def open(self):
        self.form_type = "registration"
        self.fields.clear()

    def fill(self, field: str, value: str):
        self.fields[field] = value

    def dump(self) -> Dict[str, Any]:
        return {"form_type": self.form_type, **self.fields}


class PCMBytesSerializer(FrameSerializer):
    @property
    def type(self) -> FrameSerializerType:
        return FrameSerializerType.BINARY

    async def setup(self, frame):
        pass

    async def serialize(self, frame) -> bytes | None:
        if isinstance(frame, OutputAudioRawFrame):
            logger.debug(f"Sending audio frame at {time.time()*1000:.1f}ms")
            return frame.audio
        return None

    async def deserialize(self, data: bytes):
        return InputAudioRawFrame(audio=data, sample_rate=16_000, num_channels=1)


# ─── 3) WebSocket endpoint & pipeline ───────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, voice: str | None = None):
    setup_start = time.time()
    await ws.accept()
    logger.info(f"Connection setup latency: {(time.time()-setup_start)*1000:.1f}ms")

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        await ws.send_json({"error": "GEMINI_API_KEY not set"})
        await ws.close(code=4401)
        return

    transport = RobustWebsocketTransport(
        websocket=ws,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            serializer=PCMBytesSerializer(),
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(confidence=0.8, start_secs=0.1, stop_secs=0.2, min_volume=0.5)
            ),
        ),
    )

    form_state = FormState()

    # ─── tool implementations ─────────────────────────────────────────────────
    async def open_form(params: FunctionCallParams):
        t0 = time.time()
        form_state.open()
        resp = {"status": "opened", "form_type": "registration"}
        await params.result_callback(resp)
        await ws.send_json(resp)
        logger.info(f"open_form() completed in {(time.time()-t0)*1000:.1f}ms")

    async def fill_form_field(params: FunctionCallParams, value: str):
        t0 = time.time()
        if form_state.form_type is None:
            form_state.open()

        text = value.lower().strip()
        text = re.sub(r"\s+at\s+the\s+rate(\s+of)?\s+", "@", text)
        text = re.sub(r"\b(my name is|name is|i am|i'm)\b", "", text).strip()

        if "@" in text:
            field = "email"
            candidate = text
        else:
            field = "name"
            candidate = text

        if not candidate:
            err = {"error": "no_field_detected"}
            await params.result_callback(err)
            await ws.send_json(err)
            logger.info(f"fill_form_field() error in {(time.time()-t0)*1000:.1f}ms")
            return

        form_state.fill(field, candidate)
        resp = {"status": "filled", "field": field, "value": candidate}
        await params.result_callback(resp)
        await ws.send_json(resp)
        logger.info(f"fill_form_field() completed in {(time.time()-t0)*1000:.1f}ms")

    async def submit_form(params: FunctionCallParams):
        t0 = time.time()
        data = form_state.dump()
        resp = {"status": "submitted", "data": data}
        await params.result_callback(resp)
        await ws.send_json(resp)
        form_state.open()
        logger.info(f"submit_form() completed in {(time.time()-t0)*1000:.1f}ms")

    # ─── register + boot LLM ───────────────────────────────────────────────────
    tools = ToolsSchema(standard_tools=[open_form, fill_form_field, submit_form])
    llm = GeminiMultimodalLiveLLMService(
        api_key=api_key,
        voice_id=voice or "Puck",
        tools=tools,
        params=InputParams(temperature=0.0, max_tokens=50),
        run_in_parallel=False,
    )
    llm.register_direct_function(open_form)
    llm.register_direct_function(fill_form_field)
    llm.register_direct_function(submit_form)

    system_prompt = """\
You are an automated form-filling assistant with exactly three functions:
  • open_form()
  • fill_form_field(value: str)
  • submit_form()

You MUST NOT emit any plain chat—only call one of those three functions.

RULES:
1) Immediately call open_form() on any mention of “form” or “fill.”
2) For each user utterance, extract exactly one field:
   – name (anything without “@”)
   – email (must contain “@”)
3) Strip prefixes (“my name is…”) and normalize “at the rate” to “@.”
4) Call fill_form_field(value=…) once per field.
5) When the user says “submit,” immediately call submit_form()."""
    context = OpenAILLMContext([{"role": "system", "content": system_prompt}], tools=tools)
    context_agg = llm.create_context_aggregator(context)

    # ─── pipeline setup ────────────────────────────────────────────────────────
    rtvi = RTVIProcessor()
    pipeline = Pipeline([
        transport.input(),
        rtvi,
        context_agg.user(),
        llm,
        transport.output(),
        context_agg.assistant(),
    ])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(allow_interruptions=True, enable_metrics=True, enable_usage_metrics=True),
        observers=[RTVIObserver(rtvi)],
    )

    try:
        await PipelineRunner(handle_sigint=False).run(task)
    except (WebSocketDisconnect, ConnectionClosedError):
        pass
    finally:
        await ws.close()


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        log_level="info",
    )

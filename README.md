# Ultra-Low Latency AI Voice Agent

Ultra-Low-Latency AI Voice Agent is a real-time voice assistant built with Pipecat and Google Gemini Live API. It captures speech via Silero VAD over WebSockets, sends each audio to Gemini for processing and tool calls (e.g. opening, filling, submitting forms), and streams back TTS audio all while preserving context, handling interruptions.


## 📦 Setup

### Backend
1. `cd backend`
2. Create a virtual environment: `python -m venv venv`
3. Activate it: `source venv/bin/activate` (or `venv\Scripts\activate` on Windows)
4. Install dependencies: `pip install -r requirements.txt`
5. Inside the `.env` and add your Gemini API key.
6. Run: `uvicorn main:app --reload`

### Frontend
1. `cd frontend`
2. Install dependencies: `npm install`
3. Inside the  `.env.local` and set backend URL.
4. Run: `npm run dev`



# TheftGuard AI - Advanced Anti-Theft AI Security System

TheftGuard AI is a video surveillance and anti-theft security solution designed for retail spaces, supermarkets, and smart facilities. It uses Computer Vision, real-time Pose Estimation, Object Detection, and Facial Recognition to detect shoplifting, loitering, restricted area intrusions, and fighting.

The system leverages multi-threaded pipelines to analyze concurrent camera feeds (local webcams or RTSP network cameras), triggering browser-synthesized audio sirens and sending remote alerts via Email and Telegram.

**Live Demo:** [theft-detection-dusky.vercel.app](https://theft-detection-dusky.vercel.app/)

---

## Technical Architecture

*   **Backend Engine:** Python 3.10+, FastAPI (Asynchronous API endpoints & WebSockets), OpenCV (Multi-threaded streaming), Ultralytics YOLOv8 (Pose & Object detection), `face_recognition` (Dlib-based CNN face encodings), SQLite3 (logs & face matrices storage).
*   **Frontend Dashboard:** Next.js 14+ (App Router), React 18, Tailwind CSS, Recharts, Lucide React.

---

## Installation Guide

### Prerequisites
*   Python 3.9 - 3.11
*   Node.js (LTS version)
*   CUDA Enabled NVIDIA GPU (recommended for fluid real-time inference)

### 1. Backend Configuration
Clone the repository and install the Python dependencies:

```bash
git clone https://github.com/jonathanlarrarte/anti-theft.git
cd anti-theft
pip install -r requirements.txt
```

> **Windows Note:** If `python` is not in your PATH, use the `py` launcher instead:
> ```bash
> py -m pip install -r requirements.txt
> ```

#### Required Models
The system uses two pre-trained YOLOv8 models which are included in the repository:
- `yolov8n.pt` — Object detection (person tracking, item monitoring)
- `yolov8n-pose.pt` — Pose estimation (posture analysis, gesture detection)

*Note: If you have a custom pre-trained theft detection model (`shoplifting.pt`), place it in the root directory. The system will automatically detect it and upgrade from default pose algorithms to the specialized neural net.*

#### Optional Dependencies
| Package | Purpose | Status When Missing |
|---------|---------|---------------------|
| `face_recognition` | Face ID & blacklist/whitelist matching | Face recognition panel disabled gracefully |
| `psutil` | Real-time CPU/RAM monitoring | Falls back to simulated system metrics |

> **Windows users:** Installing `face_recognition` on Windows requires Visual Studio Build Tools and CMake (for the `dlib` dependency). The system runs fine without it — only the face recognition tab will show no results. See [face_recognition Windows install guide](https://github.com/ageitgey/face_recognition#installation) for help.

### 2. Dashboard UI Configuration
Install node packages:

```bash
cd dashboard
npm install
```

### 3. Verify Installation
Run the setup tests to confirm everything is working:

```bash
py test_setup.py      # Tests OpenCV + YOLO object detection
py test_pose.py       # Tests YOLO pose model loading
```

---

## Running the System

### Automatic Startup (Windows)
Launch both the FastAPI service and the Next.js development server concurrently with a single click:

```bash
start_system.bat
```

The launcher will:
1. Check and auto-install dashboard npm dependencies if missing
2. Start the Python/FastAPI backend on `http://localhost:8000`
3. Start the Next.js dashboard on `http://localhost:3000`
4. Open the dashboard in your default browser

### Manual Startup
**1. Start the API Server & Inference Loop:**
```bash
py backend.py
```
*(The server will boot on `http://localhost:8000` — Swagger docs at `http://localhost:8000/docs`)*

**2. Start the Frontend Dashboard:**
```bash
cd dashboard
npm run dev
```
*(The panel will be served on `http://localhost:3000`)*

**3. Optional Standalone OpenCV Window Demo:**
```bash
py standalone_demo.py
```

### Docker Setup
For a one-command setup that doesn't require installing Python or Node.js locally, see [SETUP.md](SETUP.md) (Docker Desktop guide, in Spanish).

---

## Troubleshooting

### "python is not recognized" on Windows
Use the Python launcher (`py`) instead. It's included with the official Python installer from python.org:
```bash
py backend.py
```

### "No module named 'face_recognition'"
This is expected on Windows unless you've manually installed dlib. The system logs a warning and disables face recognition — all other features (object detection, pose estimation, loitering, ROI, alerts) continue working normally.

### Camera not opening (Ctrl+C to restart)
- Ensure no other application is using your webcam (Zoom, Teams, etc.)
- Try changing the camera source from `0` to `1` in the Camera Setup panel
- For RTSP streams, verify the URL format: `rtsp://username:password@ip:port/path`

### WebSocket showing "Disconnected" in Dashboard
- Confirm the backend is running (`http://localhost:8000/docs` should load)
- Check Windows Firewall isn't blocking port 8000
- Verify `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000` exists in `dashboard/.env.local`

---

## License

Distributed under the MIT License. See `LICENSE` for more information.

---

*GitHub Repository:* [jonathanlarrarte/anti-theft](https://github.com/jonathanlarrarte/anti-theft)

*Originally based on [vahapogut/Theft-Detection](https://github.com/vahapogut/Theft-Detection) by Abdulvahap Öğüt.*

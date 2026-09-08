import cv2
import asyncio
import base64
import os
from dotenv import load_dotenv
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

load_dotenv()
from ultralytics import YOLO
import numpy as np
import time
from datetime import datetime
import json
import threading
import uuid
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
import requests
from pydantic import BaseModel
import sqlite3
import pickle
import subprocess
import hashlib
from collections import deque
from modules import MODULE_REGISTRY, TrackContext, compute_hip_motion
try:
    import face_recognition
    FACE_REC_AVAILABLE = True
except ImportError:
    FACE_REC_AVAILABLE = False
    print("face_recognition not installed. Face ID disabled.")

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False
    print("psutil not installed. System resource monitor will run in simulation mode.")

if not os.path.exists("alerts"):
    os.makedirs("alerts")

app = FastAPI()

app.mount("/alerts", StaticFiles(directory="alerts"), name="alerts")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Database Setup ---
DB_NAME = "theft_detection.db"

DEFAULT_TENANT_ID = "default"
DEFAULT_SITE_ID = "default"

# Catálogo fijo de módulos de comportamiento (id -> (nombre, parámetros por defecto))
MODULE_CATALOG = {
    "loitering": ("Merodeo (loitering)", {"dwell_seconds": 5.0}),
    "zone_intrusion": ("Intrusión de zona", {}),
    "concealment": ("Ocultamiento de artículo", {}),
    "wall_climbing": ("Escalamiento de muro", {"wall_height_px": 200, "climb_speed_threshold": 15.0}),
}

def init_db():
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS alerts
                     (id TEXT PRIMARY KEY, message TEXT, timestamp TEXT, image_path TEXT)''')
        c.execute('''CREATE TABLE IF NOT EXISTS faces
                     (id TEXT PRIMARY KEY, name TEXT, type TEXT, encoding BLOB)''')
        c.execute('''CREATE TABLE IF NOT EXISTS tenants
                     (id TEXT PRIMARY KEY, name TEXT NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS sites
                     (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS modules
                     (id TEXT PRIMARY KEY, name TEXT NOT NULL, default_params TEXT NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS zones
                     (id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, site_id TEXT NOT NULL, name TEXT NOT NULL)''')
        c.execute('''CREATE TABLE IF NOT EXISTS zone_modules
                     (id TEXT PRIMARY KEY, zone_id TEXT NOT NULL, module_id TEXT NOT NULL,
                      enabled INTEGER NOT NULL DEFAULT 1, params TEXT NOT NULL,
                      UNIQUE(zone_id, module_id))''')

        # Migración idempotente: columnas de evidencia en video (clip corto + hash de integridad)
        c.execute("PRAGMA table_info(alerts)")
        existing_cols = {row[1] for row in c.fetchall()}
        if "clip_path" not in existing_cols:
            c.execute("ALTER TABLE alerts ADD COLUMN clip_path TEXT")
        if "clip_hash" not in existing_cols:
            c.execute("ALTER TABLE alerts ADD COLUMN clip_hash TEXT")

        # Migración idempotente: cada zona guarda su propio polígono (antes vivía en cameras.json,
        # asumiendo 1 zona = 1 cámara; ahora una cámara puede tener varias zonas)
        c.execute("PRAGMA table_info(zones)")
        existing_zone_cols = {row[1] for row in c.fetchall()}
        if "polygon" not in existing_zone_cols:
            c.execute("ALTER TABLE zones ADD COLUMN polygon TEXT NOT NULL DEFAULT '[]'")

        c.execute("INSERT OR IGNORE INTO tenants VALUES (?,?)", (DEFAULT_TENANT_ID, "Tenant por defecto"))
        c.execute("INSERT OR IGNORE INTO sites VALUES (?,?,?)", (DEFAULT_SITE_ID, DEFAULT_TENANT_ID, "Sitio 1"))
        for module_id, (name, default_params) in MODULE_CATALOG.items():
            c.execute("INSERT OR IGNORE INTO modules VALUES (?,?,?)", (module_id, name, json.dumps(default_params)))

        conn.commit()
        conn.close()
        print("Database initialized.")
    except Exception as e:
        print(f"Database error: {e}")

init_db()

# --- Settings & Models ---
SETTINGS_FILE = "settings.json"

class SettingsModel(BaseModel):
    emailEnabled: bool = False
    smtpServer: str = "smtp.gmail.com"
    smtpPort: str = "587"
    senderEmail: str = ""
    senderPassword: str = ""
    receiverEmail: str = ""
    telegramEnabled: bool = False
    telegramBotToken: str = ""
    telegramChatId: str = ""
    roiPoints: list[list[int]] = []
    showHeatmap: bool = False


try:
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE, "r") as f:
            settings_data = json.load(f)
            current_settings = SettingsModel(**settings_data)
            roi_points = current_settings.roiPoints
    else:
        current_settings = SettingsModel()
except Exception as e:
    current_settings = SettingsModel()


# --- Heatmap Logic ---
def update_heatmap(cam_data, center_x, center_y, frame_shape):
    if cam_data.get("heatmap_accumulator") is None or cam_data["heatmap_accumulator"].shape[:2] != frame_shape[:2]:
        cam_data["heatmap_accumulator"] = np.zeros(frame_shape[:2], dtype=np.float32)
    try:
        cam_data["heatmap_accumulator"][center_y, center_x] += 1
    except: pass

def get_heatmap_overlay(cam_data, frame):
    if cam_data.get("heatmap_accumulator") is None: return frame
    msg_max = np.max(cam_data["heatmap_accumulator"])
    if msg_max == 0: return frame
    
    norm_heatmap = cam_data["heatmap_accumulator"] / msg_max
    norm_heatmap = (norm_heatmap * 255).astype(np.uint8)
    color_map = cv2.applyColorMap(norm_heatmap, cv2.COLORMAP_JET)
    result = cv2.addWeighted(frame, 0.7, color_map, 0.3, 0)
    return result

# --- Face ID Logic ---
known_face_encodings = []
known_face_names = []
known_face_types = [] # 'blacklist' or 'whitelist'
faces_lock = threading.Lock()

def load_known_faces():
    global known_face_encodings, known_face_names, known_face_types
    if not FACE_REC_AVAILABLE: return
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("SELECT name, type, encoding FROM faces")
        rows = c.fetchall()
        
        temp_encodings = []
        temp_names = []
        temp_types = []
        for row in rows:
            name, f_type, encoding_blob = row
            encoding = pickle.loads(encoding_blob)
            temp_encodings.append(encoding)
            temp_names.append(name)
            temp_types.append(f_type)
        conn.close()
        
        with faces_lock:
            known_face_encodings = temp_encodings
            known_face_names = temp_names
            known_face_types = temp_types
            
        print(f"Loaded {len(known_face_names)} faces.")
    except Exception as e:
        print(f"Error loading faces: {e}")

load_known_faces()

# --- API Endpoints ---


@app.post("/faces/register")
async def register_face(file: UploadFile = File(...), name: str = Form(...), type: str = Form("blacklist")):
    if not FACE_REC_AVAILABLE: return {"status": "error", "message": "El reconocimiento facial no está disponible"}
    temp_filename = f"temp_{uuid.uuid4()}.jpg"
    try:
        with open(temp_filename, "wb") as buffer:
            buffer.write(await file.read())
        
        image = face_recognition.load_image_file(temp_filename)
        encodings = face_recognition.face_encodings(image)
        
        if len(encodings) > 0:
            encoding = encodings[0]
            encoding_blob = pickle.dumps(encoding)
            face_id = str(uuid.uuid4())
            
            conn = sqlite3.connect(DB_NAME)
            c = conn.cursor()
            c.execute("INSERT INTO faces VALUES (?,?,?,?)", (face_id, name, type, encoding_blob))
            conn.commit()
            conn.close()
            
            load_known_faces() # Reload
            return {"status": "success", "message": f"Rostro registrado: {name}"}
        else:
            return {"status": "error", "message": "No se encontró ningún rostro en la imagen"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    finally:
        if os.path.exists(temp_filename):
            os.remove(temp_filename)

@app.get("/faces")
async def get_faces():
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("SELECT id, name, type FROM faces")
        rows = c.fetchall()
        conn.close()
        return [{"id": r[0], "name": r[1], "type": r[2]} for r in rows]
    except Exception as e:
        return {"error": str(e)}



# --- API Endpoints ---

@app.get("/settings")
async def get_settings():
    return current_settings

@app.post("/settings")
async def save_settings(settings: SettingsModel):
    global current_settings, roi_points
    current_settings = settings
    roi_points = settings.roiPoints # Update global ROI
    
    from dotenv import set_key
    env_path = ".env"
    if not os.path.exists(env_path):
        open(env_path, 'a').close()
        
    if settings.senderPassword and settings.senderPassword != "********":
        set_key(env_path, "SMTP_PASSWORD", settings.senderPassword)
    if settings.telegramBotToken and settings.telegramBotToken != "********":
        set_key(env_path, "TELEGRAM_BOT_TOKEN", settings.telegramBotToken)
        
    safe_settings = settings.dict()
    # Mask sensitive data in JSON
    safe_settings["senderPassword"] = ""
    safe_settings["telegramBotToken"] = ""
    
    with open(SETTINGS_FILE, "w") as f:
        json.dump(safe_settings, f, indent=4)
        
    load_dotenv(override=True)
    return {"status": "success", "message": "Configuración guardada"}

@app.post("/roi")
async def save_roi(data: dict):
    global roi_points, current_settings
    if "points" in data:
        roi_points = data["points"]
        current_settings.roiPoints = roi_points
        with open(SETTINGS_FILE, "w") as f:
            json.dump(current_settings.dict(), f, indent=4)
        print(f"ROI Updated: {roi_points}")
        return {"status": "success"}
    return {"status": "error"}

@app.get("/roi")
async def get_roi():
    return {"points": roi_points}


@app.post("/settings/test")
async def test_settings(settings: SettingsModel):
    original_settings = current_settings.copy()
    
    if settings.emailEnabled:
        try:
            msg = MIMEMultipart()
            msg['From'] = settings.senderEmail
            msg['To'] = settings.receiverEmail
            msg['Subject'] = "TheftGuard - Correo de prueba"
            msg.attach(MIMEText("Este es un correo de prueba de tu sistema TheftGuard.", 'plain'))
            server = smtplib.SMTP(settings.smtpServer, int(settings.smtpPort))
            server.starttls()
            server.login(settings.senderEmail, settings.senderPassword)
            server.send_message(msg)
            server.quit()
        except Exception as e:
            return {"status": "error", "message": f"Prueba de correo fallida: {str(e)}"}

    if settings.telegramEnabled:
        try:
            url = f"https://api.telegram.org/bot{settings.telegramBotToken}/sendMessage"
            data = {"chat_id": settings.telegramChatId, "text": "TheftGuard - Mensaje de prueba"}
            resp = requests.post(url, data=data)
            if resp.status_code != 200:
                 return {"status": "error", "message": f"Prueba de Telegram fallida: {resp.text}"}
        except Exception as e:
            return {"status": "error", "message": f"Prueba de Telegram fallida: {str(e)}"}

    return {"status": "success", "message": "¡Todas las pruebas habilitadas se enviaron correctamente!"}



@app.delete("/faces/{face_id}")
async def delete_face(face_id: str):
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("DELETE FROM faces WHERE id = ?", (face_id,))
        conn.commit()
        conn.close()
        load_known_faces() # Reload
        return {"status": "success", "message": "Rostro eliminado correctamente"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

@app.get("/history")
async def get_history():
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT 100")
        rows = c.fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except Exception as e:
        return {"error": str(e)}

# --- Video Logic ---

# Global variables
roi_points = []
last_alert_time = 0
ALERT_COOLDOWN = 3.0

# --- Evidencia en video (clip corto por alerta) ---
CLIP_PRE_SECONDS = 3.0
CLIP_POST_SECONDS = 3.0
CLIP_WIDTH, CLIP_HEIGHT = 640, 360
CLIP_FPS_FALLBACK = 20
CLIP_BUFFER_MAXLEN = int((CLIP_PRE_SECONDS + CLIP_POST_SECONDS + 2) * 25)  # margen sobre ~25fps

# Colores (BGR) para distinguir zonas a simple vista en el video en vivo
ZONE_COLORS = [(0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 165, 0), (255, 255, 0)]

latest_frame = None
alert_payload = None # Initialize
lock = threading.Lock()
clients = []

if not os.path.exists("alerts"):
    os.makedirs("alerts")

# --- Threaded Camera Stream ---
class ThreadedCamera:
    def __init__(self, src):
        self.src = src
        try:
            self.src_val = int(src)
            is_index = True
        except:
            self.src_val = src
            is_index = False
        self.is_index = is_index

        if is_index and os.name == 'nt':
            self.cap = cv2.VideoCapture(self.src_val, cv2.CAP_DSHOW)
        else:
            self.cap = cv2.VideoCapture(self.src_val)

        if self.cap.isOpened():
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            self.ret, self.frame = self.cap.read()
        else:
            self.ret = False
            self.frame = None

        self.running = True
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.update, args=(), daemon=True)
        if self.cap.isOpened():
            self.thread.start()

    def update(self):
        while self.running:
            if self.cap.isOpened():
                ret, frame = self.cap.read()
                if not ret and not self.is_index:
                    # Likely reached the end of a video file; loop back to the start
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    ret, frame = self.cap.read()
                with self.lock:
                    self.ret = ret
                    if ret:
                        self.frame = frame
                time.sleep(0.01)
            else:
                time.sleep(0.1)

    def read(self):
        with self.lock:
            if self.frame is not None:
                return self.ret, self.frame.copy()
            return False, None

    def isOpened(self):
        return self.cap.isOpened()

    def release(self):
        self.running = False
        self.cap.release()

# --- Zone / Module Engine ---
camera_zones_cache = {}  # camera_id -> [{"zone_id":, "name":, "polygon": [[x,y],...], "modules": [{"module_id":, "params":}, ...]}]
zone_cache_lock = threading.Lock()

def ensure_default_zone(camera_id, initial_polygon=None):
    """Crea la primera zona de una cámara si todavía no tiene ninguna, sembrando
    zone_modules con el comportamiento por defecto (loitering/zone_intrusion/
    concealment encendidos, wall_climbing apagado porque requiere calibración).
    initial_polygon migra sin pérdida el ROI que la cámara ya tuviera antes de
    que existiera multi-zona (venía en cameras.json)."""
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT COUNT(*) FROM zones WHERE camera_id = ?", (camera_id,))
    if c.fetchone()[0] == 0:
        zone_id = str(uuid.uuid4())
        polygon = initial_polygon or []
        c.execute(
            "INSERT INTO zones (id, camera_id, site_id, name, polygon) VALUES (?,?,?,?,?)",
            (zone_id, camera_id, DEFAULT_SITE_ID, "Zona 1", json.dumps(polygon))
        )
        for module_id, (_, default_params) in MODULE_CATALOG.items():
            enabled = 0 if module_id == "wall_climbing" else 1
            c.execute(
                "INSERT OR IGNORE INTO zone_modules VALUES (?,?,?,?,?)",
                (str(uuid.uuid4()), zone_id, module_id, enabled, json.dumps(default_params))
            )
        conn.commit()
    conn.close()

def refresh_zone_cache():
    global camera_zones_cache
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT id, camera_id, name, polygon FROM zones")
        zone_rows = c.fetchall()

        c.execute("""SELECT zone_id, module_id, params FROM zone_modules WHERE enabled = 1""")
        modules_by_zone = {}
        for row in c.fetchall():
            modules_by_zone.setdefault(row["zone_id"], []).append({
                "module_id": row["module_id"],
                "params": json.loads(row["params"])
            })
        conn.close()

        new_cache = {}
        for zone in zone_rows:
            new_cache.setdefault(zone["camera_id"], []).append({
                "zone_id": zone["id"],
                "name": zone["name"],
                "polygon": json.loads(zone["polygon"]),
                "modules": modules_by_zone.get(zone["id"], [])
            })
        with zone_cache_lock:
            camera_zones_cache = new_cache
    except Exception as e:
        print(f"Error refreshing zone cache: {e}")

def zone_cache_refresher_loop():
    while True:
        time.sleep(5)
        refresh_zone_cache()

# --- Camera Management ---
class CameraManager:
    def __init__(self):
        self.cameras = {}
        self.lock = threading.Lock()
        self.load_cameras()

    def load_cameras(self):
        file_path = "cameras.json"
        if os.path.exists(file_path):
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for cam in data:
                        self.add_camera_internal(cam["id"], cam["source"], cam["name"], cam.get("roi_points", []))
                print(f"Loaded {len(self.cameras)} cameras from cameras.json.")
                return
            except Exception as e:
                print(f"Error loading cameras.json: {e}")

        # Fallback to default webcam if no file exists
        self.add_camera_internal("0", "0", "Cámara 1", [])
        self.save_cameras()

    def save_cameras(self):
        file_path = "cameras.json"
        try:
            data = []
            with self.lock:
                for cam_id, cam_data in self.cameras.items():
                    data.append({
                        "id": cam_id,
                        "name": cam_data["name"],
                        "source": cam_data["source"]
                    })
            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=4)
        except Exception as e:
            print(f"Error saving cameras.json: {e}")

    def add_camera_internal(self, cam_id, source, name, roi_points):
        threaded_cap = ThreadedCamera(source)
        self.cameras[cam_id] = {
            "cap": threaded_cap,
            "name": name,
            "source": source,
            "status": "active" if threaded_cap.isOpened() else "error",
            "heatmap_accumulator": None,
            "last_alert_time": 0,
            "clip_buffer": deque(maxlen=CLIP_BUFFER_MAXLEN),
            "clip_pending": []
        }
        # roi_points viene de un cameras.json viejo (pre multi-zona) -- si existe,
        # se usa para no perder el ROI ya dibujado al migrar a la primera zona.
        ensure_default_zone(cam_id, initial_polygon=roi_points)

    def add_camera(self, source, name):
        cam_id = str(uuid.uuid4())
        threaded_cap = ThreadedCamera(source)
        if threaded_cap.isOpened():
            with self.lock:
                self.cameras[cam_id] = {
                    "cap": threaded_cap,
                    "name": name,
                    "source": source,
                    "status": "active",
                    "heatmap_accumulator": None,
                    "last_alert_time": 0,
                    "clip_buffer": deque(maxlen=CLIP_BUFFER_MAXLEN),
                    "clip_pending": []
                }
            self.save_cameras()
            ensure_default_zone(cam_id, initial_polygon=[])
            print(f"Cámara agregada: {name} ({source}) ID: {cam_id}")
            return {"id": cam_id, "status": "connected"}
        else:
            print(f"No se pudo abrir la cámara: {source}")
            return {"id": None, "status": "failed"}

    def remove_camera(self, cam_id):
        with self.lock:
            if cam_id in self.cameras:
                self.cameras[cam_id]["cap"].release()
                del self.cameras[cam_id]
                status = True
            else:
                status = False
        if status:
            self.save_cameras()
            try:
                conn = sqlite3.connect(DB_NAME)
                c = conn.cursor()
                c.execute("DELETE FROM zone_modules WHERE zone_id IN (SELECT id FROM zones WHERE camera_id = ?)", (cam_id,))
                c.execute("DELETE FROM zones WHERE camera_id = ?", (cam_id,))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"Error cleaning up zones for camera {cam_id}: {e}")
            refresh_zone_cache()
        return status

    def get_active_cameras(self):
        try:
            conn = sqlite3.connect(DB_NAME)
            c = conn.cursor()
            c.execute("SELECT camera_id, COUNT(*) FROM zones GROUP BY camera_id")
            zone_counts = dict(c.fetchall())
            conn.close()
        except Exception as e:
            print(f"Error counting zones: {e}")
            zone_counts = {}

        with self.lock:
            return [{
                "id": k,
                "name": v["name"],
                "source": v["source"],
                "status": "active" if v["cap"].isOpened() else "error",
                "zone_count": zone_counts.get(k, 0)
            } for k, v in self.cameras.items()]

camera_manager = CameraManager()

# --- API Endpoints for Cameras ---
class CameraInput(BaseModel):
    name: str
    source: str

@app.post("/cameras")
async def add_new_camera(cam: CameraInput):
    result = camera_manager.add_camera(cam.source, cam.name)
    if result["id"]:
        with camera_manager.lock:
            cam_data = camera_manager.cameras.get(result["id"])
            cam_details = {
                "id": result["id"],
                "name": cam_data["name"] if cam_data else cam.name,
                "source": cam_data["source"] if cam_data else cam.source,
                "status": "active"
            } if cam_data else None
        return {"message": "Cámara agregada", "camera": cam_details}
    else:
        raise HTTPException(status_code=400, detail="No se pudo abrir la cámara")

@app.get("/stats")
def get_stats():
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT substr(timestamp, 1, 8), count(*) FROM alerts GROUP BY substr(timestamp, 1, 8)")
    data = dict(c.fetchall())
    conn.close()
    
    stats = []
    from datetime import timedelta
    today = datetime.now()
    for i in range(6, -1, -1):
        d = today - timedelta(days=i)
        key = d.strftime("%Y%m%d")
        stats.append(data.get(key, 0))

    cpu_load = 0
    ram_load = 0
    if PSUTIL_AVAILABLE:
        try:
            cpu_load = psutil.cpu_percent()
            ram_load = psutil.virtual_memory().percent
        except:
            import random
            cpu_load = random.randint(15, 30)
            ram_load = random.randint(40, 50)
    else:
        import random
        cpu_load = random.randint(15, 30)
        ram_load = random.randint(40, 50)
        
    return {
        "weekly_data": stats,
        "cpu_load": cpu_load,
        "ram_load": ram_load
    }

@app.get("/cameras")
async def list_cameras():
    return camera_manager.get_active_cameras()

@app.delete("/cameras/{camera_id}")
async def delete_camera(camera_id: str):
    if camera_manager.remove_camera(camera_id):
        return {"message": "Cámara eliminada"}
    raise HTTPException(status_code=404, detail="Cámara no encontrada")

@app.get("/modules")
async def list_modules():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT id, name, default_params FROM modules")
    rows = c.fetchall()
    conn.close()
    return [{"id": r["id"], "name": r["name"], "default_params": json.loads(r["default_params"])} for r in rows]

class ModuleUpdate(BaseModel):
    enabled: bool
    params: dict = {}

class ZoneInput(BaseModel):
    name: str

class ZoneUpdate(BaseModel):
    name: str | None = None
    polygon: list | None = None

@app.get("/cameras/{camera_id}/zones")
async def list_zones(camera_id: str):
    with camera_manager.lock:
        if camera_id not in camera_manager.cameras:
            raise HTTPException(status_code=404, detail="Cámara no encontrada")
    ensure_default_zone(camera_id)

    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT id, name, polygon FROM zones WHERE camera_id = ? ORDER BY name", (camera_id,))
    rows = c.fetchall()
    conn.close()
    return [{"id": r["id"], "name": r["name"], "polygon": json.loads(r["polygon"])} for r in rows]

@app.post("/cameras/{camera_id}/zones")
async def create_zone(camera_id: str, zone: ZoneInput):
    with camera_manager.lock:
        if camera_id not in camera_manager.cameras:
            raise HTTPException(status_code=404, detail="Cámara no encontrada")

    zone_id = str(uuid.uuid4())
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute(
        "INSERT INTO zones (id, camera_id, site_id, name, polygon) VALUES (?,?,?,?,?)",
        (zone_id, camera_id, DEFAULT_SITE_ID, zone.name, "[]")
    )
    for module_id, (_, default_params) in MODULE_CATALOG.items():
        enabled = 0 if module_id == "wall_climbing" else 1
        c.execute(
            "INSERT INTO zone_modules VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), zone_id, module_id, enabled, json.dumps(default_params))
        )
    conn.commit()
    conn.close()

    refresh_zone_cache()
    return {"id": zone_id, "name": zone.name, "polygon": []}

@app.put("/zones/{zone_id}")
async def update_zone(zone_id: str, update: ZoneUpdate):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT id FROM zones WHERE id = ?", (zone_id,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Zona no encontrada")

    if update.name is not None:
        c.execute("UPDATE zones SET name = ? WHERE id = ?", (update.name, zone_id))
    if update.polygon is not None:
        c.execute("UPDATE zones SET polygon = ? WHERE id = ?", (json.dumps(update.polygon), zone_id))
    conn.commit()
    conn.close()

    refresh_zone_cache()
    return {"status": "success"}

@app.delete("/zones/{zone_id}")
async def delete_zone(zone_id: str):
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("DELETE FROM zone_modules WHERE zone_id = ?", (zone_id,))
    c.execute("DELETE FROM zones WHERE id = ?", (zone_id,))
    deleted = c.rowcount
    conn.commit()
    conn.close()

    refresh_zone_cache()
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Zona no encontrada")
    return {"message": "Zona eliminada"}

@app.get("/zones/{zone_id}/modules")
async def get_zone_modules(zone_id: str):
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT id FROM zones WHERE id = ?", (zone_id,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Zona no encontrada")

    c.execute("SELECT id, name, default_params FROM modules")
    catalog = c.fetchall()
    c.execute("SELECT module_id, enabled, params FROM zone_modules WHERE zone_id = ?", (zone_id,))
    zone_rows = {r["module_id"]: r for r in c.fetchall()}
    conn.close()

    result = []
    for m in catalog:
        zm = zone_rows.get(m["id"])
        result.append({
            "module_id": m["id"],
            "name": m["name"],
            "enabled": bool(zm["enabled"]) if zm else False,
            "params": json.loads(zm["params"]) if zm else json.loads(m["default_params"])
        })
    return result

@app.post("/zones/{zone_id}/modules/{module_id}")
async def update_zone_module(zone_id: str, module_id: str, update: ModuleUpdate):
    if module_id not in MODULE_CATALOG:
        raise HTTPException(status_code=404, detail="Módulo no encontrado")

    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    c.execute("SELECT id FROM zones WHERE id = ?", (zone_id,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(status_code=404, detail="Zona no encontrada")

    c.execute("SELECT id FROM zone_modules WHERE zone_id = ? AND module_id = ?", (zone_id, module_id))
    existing = c.fetchone()
    if existing:
        c.execute(
            "UPDATE zone_modules SET enabled = ?, params = ? WHERE id = ?",
            (1 if update.enabled else 0, json.dumps(update.params), existing[0])
        )
    else:
        c.execute(
            "INSERT INTO zone_modules VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), zone_id, module_id, 1 if update.enabled else 0, json.dumps(update.params))
        )
    conn.commit()
    conn.close()

    refresh_zone_cache()
    return {"status": "success", "module_id": module_id, "enabled": update.enabled, "params": update.params}



# --- State Tracker for Concealment ---
class PersonState:
    def __init__(self, track_id):
        self.track_id = track_id
        self.state = "NEUTRAL" # NEUTRAL, REACHING, HOLDING, SUSPICIOUS
        self.last_reach_time = 0
        self.holding_object = False
        self.holding_hand = None
        self.last_holding_time = 0
        self.face_checked = False
        self.face_check_time = 0
        # Usados por modules.py (LoiteringModule) -- por zona, porque una persona
        # puede estar dentro de una zona y fuera de otra al mismo tiempo
        self.roi_entry_times = {}       # {zone_id: entry_time}
        self.last_dwell_durations = {}  # {zone_id: duration}
        # Usados por compute_hip_motion()/WallClimbingModule -- una sola vez por
        # persona por frame, no depende de la zona
        self.prev_hip_y = 0
        self.prev_hip_time = 0

person_states = {} # {(cam_id, track_id): PersonState}

# --- Helper Functions for Pose ---
# check_reaching / check_object_in_hand / check_concealment viven ahora en
# modules.py (ZoneIntrusionModule / ConcealmentModule). check_bending se queda
# acá porque solo alimenta un overlay informativo, no un módulo de comportamiento.
def check_bending(keypoints):
    if len(keypoints) < 12: return False
    l_shoulder = keypoints[5]
    l_hip = keypoints[11]
    if l_shoulder[1] == 0 or l_hip[1] == 0: return False
    vertical_dist = l_hip[1] - l_shoulder[1]
    return vertical_dist < 50

# --- Updated Video Loop ---
def video_loop():
    global latest_frame, current_settings, alert_payload, known_face_encodings, known_face_names, known_face_types, person_states
    
    print("Iniciando bucle de video...")
    model_obj = None # Fallback or specialized
    model_is_specialized = False

    try:
        print("Cargando modelo de pose...")
        model_pose = YOLO('yolov8n-pose.pt')

        print("Cargando modelo de detección de robo...")
        try:
            # Try to load specialized model first
            model_obj = YOLO('shoplifting.pt')
            model_is_specialized = True
            print("¡Modelo especializado de robo cargado! (shoplifting.pt)")
        except:
            print("No se encontró un modelo especializado, usando detección de objetos estándar (yolov8n.pt)...")
            try:
                model_obj = YOLO('yolov8n.pt')
            except Exception as e:
                print(f"Tampoco se pudo cargar el modelo estándar: {e}")
                model_obj = None

        print("Modelos listos.")
    except Exception as e:
        print(f"CRITICAL MODEL ERROR: {e}")
        with open("error_log.txt", "a") as f:
             f.write(f"{datetime.now()}: CRITICAL LOAD ERROR: {e}\n")
        return

    frame_count = 0
    no_signal_frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    cv2.putText(no_signal_frame, "SIN SEÑAL", (400, 360), cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 0, 255), 3)

    while True:
        try:
            with camera_manager.lock:
                current_cams = list(camera_manager.cameras.items())

            frames_payload = [] 
            
            # Optimization: Run Object Det every 5 frames
            run_obj_det = (frame_count % 5 == 0) and (model_obj is not None)
            
            for cam_id, cam_data in current_cams:
                cap = cam_data["cap"]
                name = cam_data["name"]
                current_time = time.time()
                
                # Zonas configuradas para esta cámara (con sus módulos ya resueltos)
                with zone_cache_lock:
                    camera_zones = list(camera_zones_cache.get(cam_id, []))
                
                if cap.isOpened():
                    ret, frame = cap.read()
                    if not ret: frame = no_signal_frame.copy()
                else:
                    frame = no_signal_frame.copy()

                if cap.isOpened() and 'ret' in locals() and ret:
                    
                    # 1. POSE INFERENCE (Every Frame for tracking)
                    results_pose = model_pose.track(frame, persist=True, verbose=False, classes=[0]) 
                    
                    # 2. THEFT / OBJECT INFERENCE
                    detected_objects = []
                    suspicious_activity_detected = False
                    
                    if run_obj_det:
                        if model_is_specialized:
                            results_obj = model_obj(frame, verbose=False, conf=0.4)
                            if len(results_obj) > 0:
                                boxes = results_obj[0].boxes.xyxy.cpu().numpy().astype(int)
                                clss = results_obj[0].boxes.cls.cpu().numpy().astype(int)
                                confs = results_obj[0].boxes.conf.cpu().numpy()
                                
                                for b, c, conf in zip(boxes, clss, confs):
                                    class_name = model_obj.names[c].lower()
                                    if "shoplift" in class_name or "suspicious" in class_name or "theft" in class_name or "fight" in class_name:
                                        label = f"{class_name.upper()} {conf:.2f}"
                                        cv2.rectangle(frame, (b[0], b[1]), (b[2], b[3]), (0, 0, 255), 3)
                                        cv2.putText(frame, label, (b[0], b[1]-10), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
                                        suspicious_activity_detected = True
                                        
                                        if current_time - cam_data["last_alert_time"] > ALERT_COOLDOWN:
                                            trigger_alert(cam_id, name, f"ACTIVIDAD SOSPECHOSA: {class_name}", frame, cam_data)
                                            cam_data["last_alert_time"] = current_time
                                    else:
                                         cv2.rectangle(frame, (b[0], b[1]), (b[2], b[3]), (0, 255, 0), 1)
                        else:
                            # Fallback Logic - Target classes for stealable items
                            TARGET_CLASSES = [24, 25, 26, 28, 39, 40, 41, 42, 43, 67, 73, 74, 75, 76, 77, 78, 79] 
                            results_obj = model_obj(frame, verbose=False, conf=0.3) 
                            if len(results_obj) > 0:
                                 boxes_obj = results_obj[0].boxes.xyxy.cpu().numpy().astype(int)
                                 cls_obj = results_obj[0].boxes.cls.cpu().numpy().astype(int)
                                 conf_obj = results_obj[0].boxes.conf.cpu().numpy()
                                 
                                 for b, c, conf in zip(boxes_obj, cls_obj, conf_obj):
                                     if c in TARGET_CLASSES: 
                                         detected_objects.append(b)
                                         label = f"ARTÍCULO: {model_obj.names[c]} {conf:.2f}"
                                         cv2.rectangle(frame, (b[0], b[1]), (b[2], b[3]), (0, 165, 255), 2)
                                         cv2.putText(frame, label, (b[0], b[1]-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 165, 255), 1)
                    
                    if run_obj_det:
                        cam_data["last_objects"] = detected_objects
                    else:
                        detected_objects = cam_data.get("last_objects", [])

                    if results_pose[0].boxes.id is not None:
                        boxes = results_pose[0].boxes.xyxy.cpu().numpy().astype(int)
                        track_ids = results_pose[0].boxes.id.cpu().numpy().astype(int)
                        
                        try:
                            keypoints_all = results_pose[0].keypoints.xy.cpu().numpy()
                        except:
                            keypoints_all = []

                        for i, track_id in enumerate(track_ids):
                            box = boxes[i]
                            kpts = keypoints_all[i] if len(keypoints_all) > i else []
                            
                            # Multi-camera safe tracking key
                            state_key = (cam_id, track_id)
                            if state_key not in person_states:
                                person_states[state_key] = PersonState(track_id)
                            p_state = person_states[state_key]

                            # --- FACE REC ---
                            if FACE_REC_AVAILABLE and (not p_state.face_checked or (current_time - p_state.face_check_time > 2.0)):
                                p_state.face_check_time = current_time
                                fx1, fy1, fx2, fy2 = max(0, box[0]), max(0, box[1]), min(frame.shape[1], box[2]), min(frame.shape[0], box[3])
                                face_img = frame[fy1:fy2, fx1:fx2]
                                rgb_face = cv2.cvtColor(face_img, cv2.COLOR_BGR2RGB)
                                face_locs = face_recognition.face_locations(rgb_face)
                                if face_locs:
                                    encodings = face_recognition.face_encodings(rgb_face, face_locs)
                                    if encodings:
                                        with faces_lock:
                                            matches = face_recognition.compare_faces(known_face_encodings, encodings[0], tolerance=0.5)
                                        if True in matches:
                                            match_index = matches.index(True)
                                            match_name = known_face_names[match_index]
                                            match_type = known_face_types[match_index]
                                            if match_type == "blacklist":
                                                cv2.putText(frame, f"LISTA NEGRA: {match_name}", (box[0], box[1]-30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0,0,255), 3)
                                                if current_time - cam_data["last_alert_time"] > ALERT_COOLDOWN:
                                                    trigger_alert(cam_id, name, f"ROSTRO EN LISTA NEGRA: {match_name}", frame, cam_data)
                                                    cam_data["last_alert_time"] = current_time
                                            else:
                                                cv2.putText(frame, f"VIP: {match_name}", (box[0], box[1]-30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0,255,0), 2)
                                p_state.face_checked = True

                            # --- OVERLAY DE POSTURA (no modelado como módulo de comportamiento) ---
                            is_bending = check_bending(kpts)
                            if is_bending:
                                cv2.putText(frame, "AGACHADO", (box[0], box[1] + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)

                            center_x = int((box[0] + box[2]) / 2)
                            center_y = int((box[1] + box[3]) / 2)
                            update_heatmap(cam_data, center_x, center_y, frame.shape)

                            # --- MOTOR DE MÓDULOS DE COMPORTAMIENTO ---
                            # Qué zonas/módulos corren en esta cámara sale de camera_zones_cache
                            # (config en SQLite, refrescada cada 5s o al instante al guardar desde el dashboard).
                            # hip_y/vertical_speed se calculan una sola vez por persona por frame
                            # (no por zona) -- ver docstring de compute_hip_motion().
                            hip_y, vertical_speed = compute_hip_motion(kpts, p_state, current_time)

                            ctx = TrackContext(
                                track_id=str(track_id),
                                keypoints=kpts,
                                box=box,
                                center=(center_x, center_y),
                                current_time=current_time,
                                p_state=p_state,
                                detected_objects=detected_objects,
                                hip_y=hip_y,
                                vertical_speed=vertical_speed
                            )

                            for zone in camera_zones:
                                for zm in zone["modules"]:
                                    module_id = zm["module_id"]
                                    # concealment depende de detected_objects, que solo se calcula
                                    # en modo fallback (mismo comportamiento que antes del refactor)
                                    if module_id == "concealment" and model_is_specialized:
                                        continue
                                    module = MODULE_REGISTRY.get(module_id)
                                    if not module:
                                        continue

                                    for event in module.analyze(ctx, zone["zone_id"], zone["polygon"], zm["params"]):
                                        if event.type == "zone_intrusion":
                                            cv2.putText(frame, "¡ENTRADA A ZONA RESTRINGIDA!", (box[0], box[1]-40), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
                                        elif event.type == "concealment":
                                            cv2.putText(frame, "¡ROBO DETECTADO!", (box[0], box[1]-80), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 255), 3)
                                            cv2.rectangle(frame, (box[0], box[1]), (box[2], box[3]), (0, 0, 255), 3)
                                        elif event.type == "wall_climbing":
                                            cv2.putText(frame, "¡ESCALANDO MURO!", (box[0], box[1]-100), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 140, 255), 2)

                                        if current_time - cam_data["last_alert_time"] > ALERT_COOLDOWN:
                                            trigger_alert(cam_id, name, event.explanation, frame, cam_data)
                                            cam_data["last_alert_time"] = current_time

                            if p_state.last_dwell_durations:
                                max_dwell = max(p_state.last_dwell_durations.values())
                                cv2.putText(frame, f"{max_dwell:.1f}s", (box[0], box[1] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 165, 255), 2)

                    frame = get_heatmap_overlay(cam_data, frame)

                    if results_pose[0].keypoints is not None:
                         res_plotted = results_pose[0].plot()
                         frame = res_plotted

                    for zone_idx, zone in enumerate(camera_zones):
                        if len(zone["polygon"]) > 0:
                            zone_color = ZONE_COLORS[zone_idx % len(ZONE_COLORS)]
                            pts = np.array(zone["polygon"])
                            cv2.polylines(frame, [pts], isClosed=True, color=zone_color, thickness=2)
                            cv2.putText(frame, zone["name"], tuple(pts[0]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, zone_color, 2)

                clip_frame = cv2.resize(frame, (CLIP_WIDTH, CLIP_HEIGHT))
                cam_data["clip_buffer"].append((clip_frame, current_time))
                finalize_ready_clips(cam_id, cam_data, current_time)

                _, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 60])
                jpg_as_text = base64.b64encode(buffer).decode('utf-8')
                
                frames_payload.append({
                    "camera_id": cam_id,
                    "name": name,
                    "data": jpg_as_text
                })
            
            frame_count += 1
            if frames_payload:
                with lock:
                    latest_frame = {
                        "type": "multi_frame",
                        "cameras": frames_payload,
                        "alert": alert_payload,
                        "audio": "siren" if alert_payload else None
                    }
                    # Clear alert_payload after packing into frame to avoid duplicate siren loops
                    alert_payload = None
            
            time.sleep(0.04) 

        except Exception as e:
            print(f"Loop Error: {e}")
            with open("error_log.txt", "a") as f:
                f.write(f"{datetime.now()}: Loop Runtime Error: {e}\n")
            time.sleep(1)


def trigger_alert(cam_id, cam_name, message, frame, cam_data):
    global alert_payload
    try:
        print(f"ALERT: {message}")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"alerts/alert_{cam_id}_{timestamp}.jpg"
        cv2.imwrite(filename, frame)

        # database
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        alert_id = str(uuid.uuid4())
        c.execute(
            "INSERT INTO alerts (id, message, timestamp, image_path) VALUES (?,?,?,?)",
            (alert_id, message, timestamp, filename)
        )
        conn.commit()
        conn.close()

        # Evidencia en video: se resuelve unos segundos después (post-roll),
        # ver finalize_ready_clips() / encode_and_save_clip()
        cam_data["clip_pending"].append({"alert_id": alert_id, "trigger_time": time.time()})

        with lock:
            alert_payload = {
                "id": alert_id,
                "message": message,
                "timestamp": timestamp,
                "image_path": filename,
                "camera_id": cam_id
            }

        # Send Email/Telegram if enabled (Settings)
        # We can implement a fire-and-forget thread for this to not block loop
        threading.Thread(target=send_notifications, args=(message, filename)).start()

    except Exception as e:
        print(f"Alert Error: {e}")

def finalize_ready_clips(camera_id, cam_data, current_time):
    still_pending = []
    for pending in cam_data["clip_pending"]:
        if current_time - pending["trigger_time"] >= CLIP_POST_SECONDS:
            window_start = pending["trigger_time"] - CLIP_PRE_SECONDS
            window_end = pending["trigger_time"] + CLIP_POST_SECONDS
            frames = [(f, ts) for f, ts in cam_data["clip_buffer"] if window_start <= ts <= window_end]
            threading.Thread(
                target=encode_and_save_clip,
                args=(camera_id, pending["alert_id"], frames),
                daemon=True
            ).start()
        else:
            still_pending.append(pending)
    cam_data["clip_pending"] = still_pending

def encode_and_save_clip(camera_id, alert_id, frames):
    if len(frames) < 2:
        return
    try:
        duration = frames[-1][1] - frames[0][1]
        fps = max(1, round(len(frames) / duration)) if duration > 0 else CLIP_FPS_FALLBACK

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"alerts/clip_{camera_id}_{timestamp}.mp4"

        proc = subprocess.Popen([
            "ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
            "-s", f"{CLIP_WIDTH}x{CLIP_HEIGHT}", "-r", str(fps), "-i", "-",
            "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            filename
        ], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for frame, _ in frames:
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
        proc.wait()

        if proc.returncode != 0 or not os.path.exists(filename):
            print(f"Error codificando clip para alerta {alert_id}")
            return

        with open(filename, "rb") as f:
            clip_hash = hashlib.sha256(f.read()).hexdigest()

        conn = sqlite3.connect(DB_NAME)
        conn.execute("UPDATE alerts SET clip_path = ?, clip_hash = ? WHERE id = ?", (filename, clip_hash, alert_id))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Clip Error: {e}")

def send_notifications(message, image_path):
    try:
        if current_settings.emailEnabled:
            sender_email = os.getenv("SENDER_EMAIL", current_settings.senderEmail)
            sender_password = os.getenv("SMTP_PASSWORD", current_settings.senderPassword)
            if sender_email and sender_password:
                msg = MIMEMultipart()
                msg['From'] = sender_email
                msg['To'] = current_settings.receiverEmail
                msg['Subject'] = "TheftGuard AI - Alerta de seguridad"

                body = f"ALERTA: {message}\nFecha y hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                msg.attach(MIMEText(body, 'plain'))
                
                try:
                    with open(image_path, 'rb') as f:
                        img_data = f.read()
                        image = MIMEImage(img_data, name=os.path.basename(image_path))
                        msg.attach(image)
                except Exception as img_e:
                    print(f"Could not attach image: {img_e}")
                
                server = smtplib.SMTP(current_settings.smtpServer, int(current_settings.smtpPort))
                server.starttls()
                server.login(sender_email, sender_password)
                server.send_message(msg)
                server.quit()
                print("Email notification sent.")

        if current_settings.telegramEnabled:
            bot_token = os.getenv("TELEGRAM_BOT_TOKEN", current_settings.telegramBotToken)
            chat_id = current_settings.telegramChatId
            if bot_token and chat_id:
                url = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
                with open(image_path, 'rb') as photo:
                    data = {"chat_id": chat_id, "caption": f"🚨 ALERTA THEFTGUARD 🚨\n\n{message}"}
                    files = {"photo": photo}
                    resp = requests.post(url, data=data, files=files)
                if resp.status_code == 200:
                    print("Telegram notification sent.")
                else:
                    print(f"Telegram Error: {resp.text}")
    except Exception as e:
        print(f"Notification Error: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("Client connected")
    try:
        while True:
            # Send latest frame
            message_to_send = None
            with lock:
                if latest_frame:
                    message_to_send = json.dumps(latest_frame)
            
            if message_to_send:
                await websocket.send_text(message_to_send)

            await asyncio.sleep(0.04) 
    except WebSocketDisconnect:
        print("Client disconnected")
    except Exception as e:
        print(f"Error: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    refresh_zone_cache()
    threading.Thread(target=zone_cache_refresher_loop, daemon=True).start()
    t = threading.Thread(target=video_loop, daemon=True)
    t.start()
    yield

app.router.lifespan_context = lifespan

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

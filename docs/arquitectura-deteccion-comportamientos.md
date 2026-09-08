# Sistema SaaS de detección de comportamientos sospechosos

Plataforma modular de video-analítica en tiempo real, basada en un pipeline de percepción único
(YOLO + tracking + pose) y un motor de módulos de comportamiento activables por cliente y por zona.

Punto de partida de referencia: [vahapogut/Theft-Detection](https://github.com/vahapogut/Theft-Detection)
(YOLOv8, FastAPI, tracking multi-cámara, editor de ROI, dashboard Next.js).

---

## 1. Principio de diseño

**Separar percepción de análisis de comportamiento.**

- La **percepción** (detección de objetos, tracking multi-cámara, pose estimation) corre siempre igual,
  sin importar el tipo de cliente. Produce un *track stream* estandarizado: por cada persona, su
  posición, keypoints de pose, zona en la que está, velocidad y tiempo de permanencia.
- El **análisis de comportamiento** vive en módulos independientes que consumen ese track stream.
  Cada módulo se activa o desactiva por zona, no de forma global — un conjunto residencial activa
  `loitering`, `zone_intrusion` y `wall_climbing`; un supermercado activa `concealment`.

```
Cámaras (4-10 por sitio)
        │
        ▼
Percepción (siempre activa)
  YOLO + tracking + pose
        │
        ▼
Motor de módulos (config por tenant y zona)
        │
   ┌────┴─────┐
   ▼          ▼
Módulo     Módulo
merodeo    retail
   │          │
   └────┬─────┘
        ▼
Eventos + alertas
Dashboard, email, Telegram
```

---

## 2. Esquema de base de datos

```sql
-- Catálogo de módulos disponibles en la plataforma (fijo, lo defines tú como desarrollador)
CREATE TABLE modules (
    id VARCHAR PRIMARY KEY,          -- 'loitering', 'zone_intrusion', 'wall_climbing', 'concealment'
    name VARCHAR NOT NULL,
    default_params JSONB NOT NULL    -- parámetros por defecto, ej. {"dwell_seconds": 120}
);

CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name VARCHAR NOT NULL,
    plan VARCHAR NOT NULL             -- para lógica de billing por módulo
);

CREATE TABLE sites (
    id UUID PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    name VARCHAR NOT NULL
);

CREATE TABLE cameras (
    id UUID PRIMARY KEY,
    site_id UUID REFERENCES sites(id),
    rtsp_url VARCHAR NOT NULL,
    resolution_w INT,
    resolution_h INT
);

CREATE TABLE zones (
    id UUID PRIMARY KEY,
    camera_id UUID REFERENCES cameras(id),
    name VARCHAR NOT NULL,            -- 'parqueadero', 'góndola pasillo 3'
    polygon JSONB NOT NULL            -- lista de puntos [[x,y], ...] del ROI
);

-- Tabla clave: qué módulo corre en qué zona, con qué parámetros
CREATE TABLE zone_modules (
    id UUID PRIMARY KEY,
    zone_id UUID REFERENCES zones(id),
    module_id VARCHAR REFERENCES modules(id),
    enabled BOOLEAN DEFAULT true,
    params JSONB NOT NULL,            -- override de default_params
    UNIQUE(zone_id, module_id)
);

CREATE TABLE events (
    id UUID PRIMARY KEY,
    zone_id UUID REFERENCES zones(id),
    module_id VARCHAR REFERENCES modules(id),
    track_id VARCHAR NOT NULL,
    severity VARCHAR NOT NULL,
    explanation TEXT NOT NULL,        -- razón en lenguaje humano, para evidencia RRHH/legal
    snapshot_path VARCHAR,
    clip_path VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now()
);
```

Activar/desactivar un módulo para un cliente es una fila en `zone_modules`, nunca un cambio de código.

> **Nota de implementación (ver [SETUP.md](../SETUP.md)):** la versión que corre en este proyecto usa
> SQLite en vez de Postgres. El resto del diseño —múltiples zonas por cámara, catálogo de módulos,
> `zone_modules`, caché de config— está implementado tal cual se describe aquí.

---

## 3. Motor de módulos (runtime)

### Interfaz común

```python
from dataclasses import dataclass

@dataclass
class Event:
    type: str
    track_id: str
    zone_id: str
    explanation: str
    severity: str = "medium"

class BehaviorModule:
    module_id: str
    def analyze(self, track, zone, params: dict) -> list[Event]:
        raise NotImplementedError
```

### Módulos del paquete "merodeo"

```python
class LoiteringModule(BehaviorModule):
    module_id = "loitering"
    def analyze(self, track, zone, params):
        dwell = track.time_in_zone(zone.id)
        if dwell > params["dwell_seconds"]:
            return [Event(
                type="loitering", track_id=track.id, zone_id=zone.id,
                explanation=f"Permanencia de {dwell}s, umbral configurado {params['dwell_seconds']}s"
            )]
        return []

class ZoneIntrusionModule(BehaviorModule):
    module_id = "zone_intrusion"
    def analyze(self, track, zone, params):
        wrist_points = track.pose.wrist_keypoints()
        if any(zone.polygon.contains(p) for p in wrist_points):
            return [Event(
                type="zone_intrusion", track_id=track.id, zone_id=zone.id,
                explanation="Cruce de extremidad hacia zona restringida", severity="high"
            )]
        return []

class WallClimbingModule(BehaviorModule):
    module_id = "wall_climbing"
    def analyze(self, track, zone, params):
        hip_y = track.pose.hip_keypoint.y
        vertical_speed = track.pose.vertical_velocity()
        if hip_y < params["wall_height_px"] and vertical_speed > params["climb_speed_threshold"]:
            return [Event(
                type="wall_climbing", track_id=track.id, zone_id=zone.id,
                explanation=(
                    f"Torso sobre línea de muro ({params['wall_height_px']}px), "
                    f"velocidad vertical {vertical_speed:.1f}"
                ),
                severity="high"
            )]
        return []
```

### Módulo del paquete "retail"

```python
class ConcealmentModule(BehaviorModule):
    module_id = "concealment"
    def analyze(self, track, zone, params):
        # Gesto mano-a-bolsillo/bolsa + tiempo frente a góndola vs. patrón normal.
        ...
```

### Registro y loop principal

```python
MODULE_REGISTRY = {
    "loitering": LoiteringModule(),
    "zone_intrusion": ZoneIntrusionModule(),
    "wall_climbing": WallClimbingModule(),
    "concealment": ConcealmentModule(),
}

def process_frame(camera_id, tracks, zone_config_cache):
    events = []
    for track in tracks:
        for zone in zone_config_cache.zones_for_camera(camera_id):
            if not track.is_in_zone(zone.polygon):
                continue
            active_modules = zone_config_cache.active_modules(zone.id)  # lee zone_modules
            for zm in active_modules:
                module = MODULE_REGISTRY[zm.module_id]
                events.extend(module.analyze(track, zone, zm.params))
    return events
```

`zone_config_cache` es un caché en memoria (Redis o similar) refrescado cada pocos segundos desde
`zone_modules`, para que activar/desactivar un módulo desde el dashboard tenga efecto casi inmediato
sin reiniciar el proceso de inferencia.

---

## 4. Por qué esta arquitectura es apta para SaaS

- **Aislamiento multi-tenant por datos, no por despliegue**: un solo motor sirve a todos los clientes;
  el aislamiento lo da `tenant_id` en cascada (tenant → site → camera → zone → zone_modules).
- **Unidad de billing natural**: cada fila activa en `zone_modules` es una zona-módulo facturable.
- **Extensible sin tocar el core**: un módulo nuevo = una clase que implementa `analyze()` + una fila
  en `modules`. El loop principal y la percepción no cambian.
- **Explicabilidad integrada**: cada `Event` trae `explanation` en lenguaje humano — necesario para
  evidencia defendible ante RRHH/legal, no solo un score numérico.

---

## 5. Roadmap sugerido

1. Clonar `Theft-Detection` como esqueleto (threading multi-cámara, editor de ROI, dashboard, notificaciones). ✅
2. Migrar la config de `cameras.json` al esquema relacional de arriba (`tenants`, `sites`, `cameras`, `zones`, `zone_modules`). ✅ (parcial: `cameras` sigue en `cameras.json`; `zones` — con su polígono, ya soportando varias por cámara — y el resto ya están en SQLite)
3. Implementar `LoiteringModule` y `ZoneIntrusionModule` reutilizando la lógica ya existente en el repo base. ✅
4. Implementar `WallClimbingModule` desde cero (regla geométrica sobre keypoints de pose, sin entrenar modelo nuevo). ✅
5. Portar `ConcealmentModule` desde la lógica de pose del repo base, ajustada a góndolas. ✅
6. Construir `zone_config_cache` (Redis) y el refresco periódico desde base de datos. ✅ (en memoria, no Redis — ver [SETUP.md](../SETUP.md))
7. Añadir capa de evidencia: snapshot + clip de video por evento, almacenamiento inmutable (WORM o hash). ✅ parcial (snapshot + clip de 6s con hash SHA-256 de integridad; falta política de retención y almacenamiento WORM real — ver [SETUP.md](../SETUP.md))
8. Piloto en modo observación 2-4 semanas por sitio antes de activar bloqueos o consecuencias de RRHH. ⏳ pendiente

---

## 6. Pendientes / decisiones abiertas

- [ ] Definir `wall_height_px` por cámara según calibración de perspectiva (no es un valor fijo global).
- [ ] Definir política de retención de clips/snapshots (tiempo, almacenamiento, costo).
- [ ] Revisar tratamiento de datos biométricos (rostro) según normativa aplicable (ej. Ley 1581/2012 en Colombia) antes de habilitar reconocimiento facial en conjuntos residenciales.
- [ ] Definir modelo de precios por zona-módulo activo (billing).
- [ ] Evaluar necesidad de GPU por sitio vs. inferencia centralizada en la nube (latencia vs. costo).
- [ ] Migrar de caché en memoria a Redis si en algún momento hay más de un proceso de backend.

# Guía de configuración — TheftGuard AI (Docker Desktop)

Esta guía cubre todo el camino: desde una máquina limpia con Docker Desktop hasta tener el sistema
completo corriendo — percepción (YOLO + tracking + pose), motor de módulos de comportamiento
(loitering, intrusión de zona, escalamiento de muro, ocultamiento de artículo), dashboard en
español y notificaciones.

Para el diseño conceptual completo (por qué está armado así, esquema de base de datos, roadmap),
ver [docs/arquitectura-deteccion-comportamientos.md](docs/arquitectura-deteccion-comportamientos.md).
Este documento es la guía **práctica** de "cómo lo prendo y lo configuro".

---

## 1. Requisitos previos

- **Docker Desktop** instalado y corriendo (Windows/Mac/Linux). Verificar con:
  ```bash
  docker info
  ```
  Si da error de conexión, abre Docker Desktop y espera a que el ícono de la barra de tareas
  quede en verde antes de continuar.
- **Git** para clonar el repositorio.
- No necesitas Python ni Node.js instalados en el host — todo corre dentro de los contenedores.
- **GPU**: no es necesaria. Este setup corre YOLOv8n (el modelo más liviano) sobre CPU. Es más
  lento que con GPU pero funciona bien para probar y para volúmenes moderados de cámaras.

---

## 2. Obtener el proyecto

Si es la primera vez:

```bash
git clone https://github.com/jonathanlarrarte/anti-theft.git detection
cd detection
```

Si ya tienes esta carpeta (como en este caso), simplemente ubícate en ella:

```bash
cd ruta/a/tu/carpeta/detection
```

### Estructura relevante

```
detection/
├── backend.py                # FastAPI + loop de video (percepción + motor de módulos)
├── modules.py                # Motor de módulos de comportamiento (BehaviorModule, Event, etc.)
├── requirements-docker.txt   # Dependencias Python para el contenedor (sin face_recognition)
├── Dockerfile.backend        # Imagen del backend
├── docker-compose.yml        # Orquesta backend + dashboard
├── .env                      # Credenciales (Telegram/SMTP) — no se sube a git
├── cameras.json              # Cámaras configuradas (persistente)
├── settings.json             # Config de notificaciones (persistente)
├── theft_detection.db        # SQLite: alertas, rostros, zonas, módulos (persistente)
├── videos/                   # Poné acá clips .mp4 para probar cámaras sin webcam/RTSP
├── alerts/                   # Snapshots JPEG de cada alerta disparada
├── docs/
│   └── arquitectura-deteccion-comportamientos.md
└── dashboard/                # Next.js — panel web
    ├── Dockerfile
    └── src/app/{page,cameras,faces,history,settings}.tsx
```

---

## 3. Configurar variables de entorno

Copia el ejemplo si no existe `.env` todavía:

```bash
cp .env.example .env
```

Contenido (podés dejarlo con valores de ejemplo si no vas a usar notificaciones todavía):

```
TELEGRAM_BOT_TOKEN=tu_token_aqui
SMTP_PASSWORD=tu_contraseña_o_app_password
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Estas credenciales también se pueden cargar después desde el dashboard (**Configuración**), que
las guarda automáticamente en este mismo `.env`.

---

## 4. Levantar el sistema

```bash
docker compose build
docker compose up -d
```

La primera vez el build tarda varios minutos (descarga PyTorch/Ultralytics y las imágenes base de
Node/Python). Las siguientes veces es mucho más rápido gracias al cache de capas de Docker.

Verificar que ambos contenedores están arriba:

```bash
docker compose ps
```

Deberías ver `theftguard-backend` y `theftguard-dashboard` en estado `Up`.

- **Dashboard**: http://localhost:3000
- **Backend / Swagger**: http://localhost:8000/docs

Si `/docs` no responde, revisa los logs:

```bash
docker compose logs backend --tail 50
```

---

## 5. Agregar tu primera cámara

### Limitación importante: webcam en Docker Desktop (Windows/Mac)

Los contenedores no tienen acceso directo a la webcam de tu equipo — no hay passthrough USB nativo
en Docker Desktop para Windows/Mac. La cámara `Cámara 1` (índice `0`) que ves por defecto en el
dashboard va a mostrar **error** — es normal y esperado.

Para tener una fuente de video real dentro del contenedor, usa una de estas dos opciones:

**Opción A — Cámara IP / RTSP** (recomendado para producción):
En el dashboard, ve a **Cámaras** → completa nombre y fuente con la URL RTSP:
```
rtsp://usuario:contraseña@ip:puerto/ruta
```

**Opción B — Archivo de video** (recomendado para probar sin cámara física):
1. Copia un `.mp4` a la carpeta `videos/` del proyecto (queda montada automáticamente dentro del
   contenedor, no hace falta reiniciar nada).
2. En el dashboard, **Cámaras** → nombre + fuente `videos/tu_archivo.mp4`.
3. El video hace **loop automático** al llegar al final (no se queda "SIN SEÑAL").

También se puede agregar por API directamente:

```bash
curl -X POST http://localhost:8000/cameras \
  -H "Content-Type: application/json" \
  -d '{"name": "Entrada principal", "source": "videos/tu_archivo.mp4"}'
```

---

## 6. Configurar zonas y módulos de comportamiento

Una cámara puede tener **varias zonas** (polígonos), cada una con su propio nombre y su propia
configuración de módulos — por ejemplo, "Portería" con `zone_intrusion` + `loitering`, y "Muro
perimetral" con `wall_climbing`, sobre la misma cámara.

1. Dashboard → **Cámaras** → botón **Configurar zonas** sobre la cámara que quieras.
2. Arriba del video hay una fila de "chips", una por zona. Creá la primera escribiendo un nombre en
   el campo y tocando el botón **+**.
3. Con una zona seleccionada (resaltada en azul), hacé clic sobre la imagen en vivo para ir
   marcando los puntos del polígono (mínimo 3) — se conectan en el orden en que los marcás. Las
   demás zonas de esa cámara se ven de fondo en gris punteado, como referencia.
4. Clic en **Guardar zona**.
5. Más abajo, sección **Módulos de comportamiento**: aplica a la zona seleccionada. Activá/desactivá
   cada uno y ajustá sus parámetros:

   | Módulo | Qué detecta | Parámetros |
   |---|---|---|
   | `loitering` (merodeo) | Permanencia prolongada dentro de la zona | `dwell_seconds` (default 5) |
   | `zone_intrusion` | Una muñeca (mano) cruza hacia la zona | — |
   | `wall_climbing` | Torso sobre una línea + movimiento vertical rápido | `wall_height_px`, `climb_speed_threshold` |
   | `concealment` | Sostener un objeto y luego "esconderlo" cerca del cuerpo | — |

6. Clic en **Guardar módulos**.

Cambiar de zona sin guardar descarta los puntos del polígono que tenías sin guardar en la anterior
(no hay guardado automático). Podés borrar una zona con el ícono de basura en su chip — se borra
junto con su configuración de módulos.

Los cambios se reflejan casi al instante (la config vive en SQLite y se cachea en memoria,
refrescada cada 5 segundos o al instante cuando guardás desde el dashboard).

**Nota sobre zonas nuevas**: por defecto, al crear una zona, `loitering`, `zone_intrusion` y
`concealment` quedan **activados**; `wall_climbing` queda **desactivado** porque `wall_height_px`
depende de la perspectiva de cada cámara — hay que calibrarlo a mano viendo dónde cae la línea del
muro en tu imagen antes de prender ese módulo.

También se puede consultar/editar por API:

```bash
# Ver catálogo completo de módulos
curl http://localhost:8000/modules

# Listar las zonas de una cámara
curl http://localhost:8000/cameras/<id-de-camara>/zones

# Crear una zona nueva
curl -X POST http://localhost:8000/cameras/<id-de-camara>/zones \
  -H "Content-Type: application/json" -d '{"name": "Muro perimetral"}'

# Guardar el polígono de una zona
curl -X PUT http://localhost:8000/zones/<id-de-zona> \
  -H "Content-Type: application/json" -d '{"polygon": [[10,10],[500,10],[500,400],[10,400]]}'

# Ver estado de los módulos de una zona puntual
curl http://localhost:8000/zones/<id-de-zona>/modules

# Activar wall_climbing con parámetros propios en esa zona
curl -X POST http://localhost:8000/zones/<id-de-zona>/modules/wall_climbing \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "params": {"wall_height_px": 300, "climb_speed_threshold": 12}}'
```

---

## 7. Evidencia en video (clips)

Cada vez que se dispara una alerta, además del snapshot JPEG de siempre, el sistema graba
automáticamente un **clip de 6 segundos** (3s antes del evento + 3s después) con lo que la cámara
vio en el momento — la misma imagen anotada (cajas, ROI, textos de alerta) que se ve en vivo en el
dashboard, no el video crudo.

- El clip tarda unos 3-4 segundos en aparecer después de que se crea la fila de la alerta (tiene que
  esperar el post-roll y después codificarse) — el Historial se refresca solo cada 8s, así que no
  hace falta recargar la página a mano.
- Se guarda en `alerts/clip_<cámara>_<fecha_hora>.mp4`, codificado en H.264 (reproducible en
  cualquier navegador), a 640×360 para mantener el tamaño de archivo razonable.
- Cada clip trae un hash SHA-256 (columna `clip_hash` en la tabla `alerts`) como evidencia de
  integridad básica — permite comprobar que el archivo no fue modificado después de generado, pero
  **no** es almacenamiento inmutable real (WORM); eso sigue pendiente (ver sección 14).
- Desde el dashboard → **Historial de alertas**, la fila de cada evento muestra dos íconos: la foto
  (siempre disponible) y el video (aparece solo cuando termina de codificarse).
- Duración y resolución son constantes en `backend.py` (`CLIP_PRE_SECONDS`, `CLIP_POST_SECONDS`,
  `CLIP_WIDTH`, `CLIP_HEIGHT`) — ajustables si necesitás clips más largos o más livianos.

**Nota de memoria**: cada cámara mantiene en RAM un buffer rodante de los últimos ~8 segundos de
video (para poder armar el pre-roll cuando se dispara una alerta). Con la resolución por defecto
(640×360) son unos 100-150MB por cámara — tenlo en cuenta si vas a correr muchas cámaras a la vez
en una máquina con poca memoria.

---

## 8. Notificaciones (Email / Telegram)

Dashboard → **Configuración**:

- **Telegram**: necesitás un bot token (hablale a [@BotFather](https://t.me/BotFather) en Telegram)
  y el chat ID donde querés recibir las alertas con foto.
- **Email (SMTP)**: servidor, puerto, correo remitente, contraseña de aplicación (para Gmail hay
  que generar una "contraseña de aplicación", no la contraseña normal de la cuenta) y destinatarios.

Guarda con **Guardar cambios**. Las credenciales sensibles se escriben en `.env`, nunca quedan en
`settings.json` (que si se comparte o se sube a git no expone contraseñas).

---

## 9. Reconocimiento facial (opcional)

Viene **desactivado por defecto** en el build de Docker: `face_recognition` depende de `dlib`, que
requiere `cmake` + toolchain de compilación y hace el build mucho más lento. El sistema funciona
perfecto sin esto — solo se desactiva la pestaña de rostros.

Para habilitarlo:

1. Editar `requirements-docker.txt` y agregar la línea `face_recognition`.
2. Editar `Dockerfile.backend` y agregar `cmake` y `build-essential` a la lista de paquetes `apt-get install`.
3. `docker compose build backend && docker compose up -d backend`.

---

## 10. Modelo especializado de detección de robo (opcional)

Si en algún momento entrenás o conseguís un modelo YOLO específico para shoplifting/robo
(`shoplifting.pt`), colocalo en la raíz del proyecto. El backend lo detecta automáticamente al
arrancar y cambia del modo genérico (YOLOv8n + reglas de pose) al modelo especializado — vas a ver
en los logs `¡Modelo especializado de robo cargado!` en vez de `usando detección de objetos estándar`.

Con el modelo especializado activo, el módulo `concealment` (que depende de la lógica genérica de
"objeto en mano") se desactiva automáticamente para esa cámara; las alertas de robo las genera
directamente el modelo especializado (`ACTIVIDAD SOSPECHOSA: <clase>`).

---

## 11. Operación diaria — comandos útiles

```bash
# Ver estado
docker compose ps

# Logs en vivo del backend (para ver alertas disparándose, errores, etc.)
docker compose logs backend -f

# Logs del dashboard
docker compose logs dashboard -f

# Reiniciar solo el backend (necesario tras editar backend.py o modules.py —
# no tiene auto-reload)
docker compose restart backend

# Reiniciar solo el dashboard (Next.js normalmente hace hot-reload solo,
# pero en Windows a veces el watcher de archivos no detecta cambios del
# bind mount — si editás algo y no se refleja, reiniciá el contenedor)
docker compose restart dashboard

# Apagar todo (los datos persisten: cameras.json, settings.json,
# theft_detection.db, alerts/, videos/ viven en tu disco, no en el contenedor)
docker compose down

# Volver a levantar
docker compose up -d

# Reconstruir imágenes después de tocar requirements-docker.txt o package.json
docker compose build
```

---

## 12. Troubleshooting

**"Docker Desktop no está corriendo" / `docker info` falla**
Abrí Docker Desktop manualmente y esperá a que termine de iniciar el engine (unos 10-30s).

**Backend no responde a nada, ni siquiera `/docs`**
Puede estar bloqueado por una excepción no controlada. `docker compose logs backend --tail 50` y
`docker compose restart backend`. (El bug de deadlock original del endpoint de ROI ya está
corregido en este proyecto — si ves algo parecido en un módulo nuevo que agregues, revisá que no
estés tomando el mismo `threading.Lock` dos veces de forma anidada.)

**El dashboard no muestra cambios que acabo de hacer en el código**
`docker compose restart dashboard`. Es un problema conocido de Docker Desktop en Windows con el
watcher de archivos sobre bind mounts (no siempre detecta cambios en vivo).

**Una cámara muestra "SIN SEÑAL"**
- Si es la webcam (fuente `0`): esperado, no hay passthrough de webcam en contenedores Windows/Mac.
  Usá RTSP o un archivo de video (sección 5).
- Si es un archivo de video: confirmá que el path es relativo a la raíz del proyecto (`videos/archivo.mp4`)
  y que el archivo existe ahí. El sistema hace loop automático, así que no debería quedarse sin señal
  salvo que el archivo no se pueda abrir (formato/códec no soportado por FFmpeg).
- Si es RTSP: verificá la URL/credenciales y que la cámara sea alcanzable desde dentro del contenedor
  (misma red, sin bloqueos de firewall).

**Una alerta nunca muestra el ícono de video en el Historial**
El clip depende de `ffmpeg` con soporte `libx264` dentro del contenedor (viene incluido en la imagen
por defecto). Revisá `docker compose logs backend` buscando "Error codificando clip" — si aparece,
confirmá con `docker compose exec backend ffmpeg -encoders | grep 264` que el binario todavía tiene
el codec disponible (por ejemplo, si cambiaste la imagen base de `Dockerfile.backend`).

**Quiero limpiar datos de prueba (cámaras, alertas, snapshots)**
```bash
# Borrar una cámara (borra también sus zonas/módulos en cascada)
curl -X DELETE http://localhost:8000/cameras/<id>

# Los snapshots quedan en alerts/<...>.jpg y las filas en la tabla `alerts`
# de theft_detection.db — se pueden borrar a mano si hace falta.
```

---

## 13. Extender el sistema: agregar un módulo de comportamiento nuevo

1. En `modules.py`, crear una clase que herede de `BehaviorModule`, con un `module_id` único y un
   método `analyze(self, ctx: TrackContext, zone_polygon: list, params: dict) -> list[Event]`.
   `ctx` te da: `track_id`, `keypoints` (pose), `box`, `center`, `current_time`, `p_state`
   (estado persistente por persona/cámara, para guardar cosas entre frames) y `detected_objects`.
2. Agregarlo a `MODULE_REGISTRY` al final de `modules.py`.
3. En `backend.py`, agregar una entrada en `MODULE_CATALOG` con nombre y parámetros por defecto —
   se siembra sola en la base de datos la próxima vez que arranque el backend.
4. Si el evento necesita un overlay visual propio en el video, agregar un `elif event.type == "..."`
   en el bloque `# --- MOTOR DE MÓDULOS DE COMPORTAMIENTO ---` de `video_loop()`.
5. `docker compose restart backend` y activarlo desde el dashboard como cualquier otro módulo.

Para el diseño completo de por qué está estructurado así (multi-tenant, billing por zona-módulo,
explicabilidad), ver [docs/arquitectura-deteccion-comportamientos.md](docs/arquitectura-deteccion-comportamientos.md).

---

## 14. Qué falta para el diseño SaaS completo

No implementado todavía en este proyecto (ver sección 6 de la arquitectura para el detalle):

- **Redis** para el caché de config (hoy es en memoria — suficiente mientras corra un solo proceso
  de backend; migrar si en algún momento hay varios workers).
- **Política de retención** de clips/snapshots y **almacenamiento WORM real** (hoy cada alerta ya
  incluye un clip de 6s con hash SHA-256 de integridad — ver sección 6 — pero no hay borrado
  automático por antigüedad ni almacenamiento inmutable de verdad).
- Gestión de **tenants/sites** desde el dashboard (hoy son filas semilla en la base, sin UI).
- Modelo de **precios/billing** por zona-módulo activa.
- Piloto en modo observación antes de activar consecuencias reales (RRHH/legal).

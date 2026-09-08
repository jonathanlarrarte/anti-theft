import { Terminal, AlertTriangle, Info, Layers, ExternalLink } from "lucide-react";

const CMD_CLONE = `git clone https://github.com/vahapogut/Theft-Detection.git detection
cd detection`;

const CMD_ENV = `cp .env.example .env`;

const ENV_CONTENTS = `TELEGRAM_BOT_TOKEN=tu_token_aqui
SMTP_PASSWORD=tu_contraseña_o_app_password
NEXT_PUBLIC_API_URL=http://localhost:8000`;

const CMD_UP = `docker compose build
docker compose up -d`;

const CMD_PS = `docker compose ps`;

const CMD_LOGS = `docker compose logs backend --tail 50`;

const CMD_ADD_CAMERA_API = `curl -X POST http://localhost:8000/cameras \\
  -H "Content-Type: application/json" \\
  -d '{"name": "Entrada principal", "source": "videos/tu_archivo.mp4"}'`;

const CMD_MODULES_API = `# Ver catálogo completo de módulos
curl http://localhost:8000/modules

# Listar las zonas de una cámara
curl http://localhost:8000/cameras/<id-de-camara>/zones

# Crear una zona nueva
curl -X POST http://localhost:8000/cameras/<id-de-camara>/zones \\
  -H "Content-Type: application/json" -d '{"name": "Muro perimetral"}'

# Guardar el polígono de una zona
curl -X PUT http://localhost:8000/zones/<id-de-zona> \\
  -H "Content-Type: application/json" -d '{"polygon": [[10,10],[500,10],[500,400],[10,400]]}'

# Ver estado de los módulos de una zona puntual
curl http://localhost:8000/zones/<id-de-zona>/modules

# Activar wall_climbing con parámetros propios en esa zona
curl -X POST http://localhost:8000/zones/<id-de-zona>/modules/wall_climbing \\
  -H "Content-Type: application/json" \\
  -d '{"enabled": true, "params": {"wall_height_px": 300, "climb_speed_threshold": 12}}'`;

const CMD_DAILY_OPS = `# Ver estado
docker compose ps

# Logs en vivo del backend (alertas, errores, etc.)
docker compose logs backend -f

# Logs del dashboard
docker compose logs dashboard -f

# Reiniciar solo el backend (no tiene auto-reload)
docker compose restart backend

# Reiniciar solo el dashboard (si un cambio no se refleja solo)
docker compose restart dashboard

# Apagar todo (los datos persisten en disco)
docker compose down

# Volver a levantar
docker compose up -d

# Reconstruir imágenes tras tocar requirements-docker.txt o package.json
docker compose build`;

const CMD_CLEANUP = `# Borrar una cámara (borra también sus zonas/módulos en cascada)
curl -X DELETE http://localhost:8000/cameras/<id>

# Los snapshots quedan en alerts/<...>.jpg y las filas en la tabla "alerts"
# de theft_detection.db -- se pueden borrar a mano si hace falta.`;

const PROJECT_TREE = `detection/
├── backend.py                # FastAPI + loop de video (percepción + motor de módulos)
├── modules.py                # Motor de módulos de comportamiento (BehaviorModule, Event, etc.)
├── requirements-docker.txt   # Dependencias Python para el contenedor (sin face_recognition)
├── Dockerfile.backend        # Imagen del backend
├── docker-compose.yml        # Orquesta backend + dashboard
├── .env                      # Credenciales (Telegram/SMTP) -- no se sube a git
├── cameras.json               # Cámaras configuradas (persistente)
├── settings.json              # Config de notificaciones (persistente)
├── theft_detection.db          # SQLite: alertas, rostros, zonas, módulos (persistente)
├── videos/                    # Clips .mp4 para probar cámaras sin webcam/RTSP
├── alerts/                     # Snapshots JPEG de cada alerta disparada
├── docs/
│   └── arquitectura-deteccion-comportamientos.md
└── dashboard/                  # Next.js -- panel web
    ├── Dockerfile
    └── src/app/{page,cameras,faces,history,settings,docs}.tsx`;

const TOC = [
  { id: "requisitos", label: "1. Requisitos previos" },
  { id: "proyecto", label: "2. Obtener el proyecto" },
  { id: "env", label: "3. Variables de entorno" },
  { id: "levantar", label: "4. Levantar el sistema" },
  { id: "camaras", label: "5. Agregar tu primera cámara" },
  { id: "zonas", label: "6. Zonas (ROI) y módulos" },
  { id: "evidencia", label: "7. Evidencia en video (clips)" },
  { id: "notificaciones", label: "8. Notificaciones" },
  { id: "rostros", label: "9. Reconocimiento facial" },
  { id: "modelo", label: "10. Modelo especializado" },
  { id: "operacion", label: "11. Operación diaria" },
  { id: "troubleshooting", label: "12. Solución de problemas" },
  { id: "extender", label: "13. Agregar un módulo nuevo" },
  { id: "pendiente", label: "14. Qué falta para SaaS completo" },
];

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-black/40 border border-glass-border rounded-lg p-4 overflow-x-auto text-xs font-mono text-foreground/90 leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

function InfoBox({ children, tone = "brand" }: { children: React.ReactNode; tone?: "brand" | "danger" }) {
  const toneClasses =
    tone === "danger"
      ? "bg-danger/10 border-danger/20 text-danger"
      : "bg-brand/10 border-brand/20 text-brand";
  return (
    <div className={`p-3 border rounded-lg text-xs flex items-start gap-2 leading-relaxed ${toneClasses}`}>
      {tone === "danger" ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <Info className="w-4 h-4 mt-0.5 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="glass-panel p-6 scroll-mt-24 space-y-4">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="max-w-5xl mx-auto pb-16">
      <header className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight mb-2">Documentación</h2>
        <p className="text-foreground/60">
          Guía completa: desde una máquina limpia con Docker Desktop hasta el sistema funcionando
          con percepción, motor de módulos de comportamiento y notificaciones.
        </p>
      </header>

      {/* Tabla de contenidos */}
      <nav className="glass-panel p-5 mb-8">
        <h3 className="text-xs uppercase tracking-wider text-foreground/50 mb-3 flex items-center gap-2">
          <Layers className="w-3.5 h-3.5" /> Contenido
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
          {TOC.map(item => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="text-sm text-foreground/70 hover:text-brand transition-colors py-1"
            >
              {item.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-6">
        <Section id="requisitos" title="1. Requisitos previos">
          <ul className="list-disc list-inside space-y-1.5 text-sm text-foreground/80">
            <li>
              <strong>Docker Desktop</strong> instalado y corriendo. Verificar con <code className="text-brand">docker info</code> --
              si da error de conexión, abrí Docker Desktop y esperá a que el ícono quede en verde.
            </li>
            <li><strong>Git</strong> para clonar el repositorio.</li>
            <li>No hace falta Python ni Node.js en el host -- todo corre dentro de los contenedores.</li>
            <li>
              <strong>GPU</strong>: no es necesaria. Corre YOLOv8n (el modelo más liviano) sobre CPU --
              más lento que con GPU, pero funciona bien para probar y para volúmenes moderados de cámaras.
            </li>
          </ul>
        </Section>

        <Section id="proyecto" title="2. Obtener el proyecto">
          <p className="text-sm text-foreground/70">Si es la primera vez:</p>
          <CodeBlock>{CMD_CLONE}</CodeBlock>
          <p className="text-sm text-foreground/70">Estructura relevante del proyecto:</p>
          <CodeBlock>{PROJECT_TREE}</CodeBlock>
        </Section>

        <Section id="env" title="3. Variables de entorno">
          <p className="text-sm text-foreground/70">Copiá el ejemplo si no existe <code className="text-brand">.env</code> todavía:</p>
          <CodeBlock>{CMD_ENV}</CodeBlock>
          <p className="text-sm text-foreground/70">Contenido (podés dejarlo con valores de ejemplo si no vas a usar notificaciones todavía):</p>
          <CodeBlock>{ENV_CONTENTS}</CodeBlock>
          <InfoBox>
            Estas credenciales también se pueden cargar después desde <strong>Configuración</strong>,
            que las guarda automáticamente en este mismo <code>.env</code>.
          </InfoBox>
        </Section>

        <Section id="levantar" title="4. Levantar el sistema">
          <CodeBlock>{CMD_UP}</CodeBlock>
          <p className="text-sm text-foreground/70">
            La primera vez el build tarda varios minutos (descarga PyTorch/Ultralytics y las imágenes
            base de Node/Python). Las siguientes veces es mucho más rápido por el cache de capas de Docker.
          </p>
          <p className="text-sm text-foreground/70">Verificar que ambos contenedores están arriba:</p>
          <CodeBlock>{CMD_PS}</CodeBlock>
          <p className="text-sm text-foreground/70">
            Deberías ver <code className="text-brand">theftguard-backend</code> y{" "}
            <code className="text-brand">theftguard-dashboard</code> en estado <code className="text-brand">Up</code>.
          </p>
          <ul className="list-disc list-inside space-y-1 text-sm text-foreground/80">
            <li>Dashboard: <code className="text-brand">http://localhost:3000</code></li>
            <li>Backend / Swagger: <code className="text-brand">http://localhost:8000/docs</code></li>
          </ul>
          <p className="text-sm text-foreground/70">Si <code>/docs</code> no responde, revisá los logs:</p>
          <CodeBlock>{CMD_LOGS}</CodeBlock>
        </Section>

        <Section id="camaras" title="5. Agregar tu primera cámara">
          <InfoBox tone="danger">
            <strong>Limitación importante:</strong> los contenedores no tienen acceso directo a la webcam
            de tu equipo -- no hay passthrough USB nativo en Docker Desktop para Windows/Mac. La cámara
            por defecto (índice <code>0</code>) va a mostrar <strong>error</strong>, es esperado.
          </InfoBox>
          <p className="text-sm text-foreground/80">
            Para tener una fuente de video real dentro del contenedor, usá una de estas dos opciones:
          </p>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground/90">Opción A -- Cámara IP / RTSP (recomendado para producción)</p>
            <p className="text-sm text-foreground/70">
              En <strong>Cámaras</strong> del dashboard, completá nombre y fuente con la URL RTSP:
            </p>
            <CodeBlock>{`rtsp://usuario:contraseña@ip:puerto/ruta`}</CodeBlock>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground/90">Opción B -- Archivo de video (recomendado para probar sin cámara física)</p>
            <ol className="list-decimal list-inside space-y-1 text-sm text-foreground/70">
              <li>Copiá un <code className="text-brand">.mp4</code> a la carpeta <code className="text-brand">videos/</code> del proyecto (queda montada automáticamente, no hace falta reiniciar nada).</li>
              <li>{"En Cámaras: nombre + fuente "}<code className="text-brand">{"videos/tu_archivo.mp4"}</code>.</li>
              <li>El video hace <strong>loop automático</strong> al llegar al final.</li>
            </ol>
          </div>
          <p className="text-sm text-foreground/70">También se puede agregar por API directamente:</p>
          <CodeBlock>{CMD_ADD_CAMERA_API}</CodeBlock>
        </Section>

        <Section id="zonas" title="6. Configurar zonas y módulos de comportamiento">
          <p className="text-sm text-foreground/80">
            Una cámara puede tener <strong>varias zonas</strong> (polígonos), cada una con su propio
            nombre y su propia configuración de módulos -- por ejemplo "Portería" con{" "}
            <code className="text-brand">zone_intrusion</code> + <code className="text-brand">loitering</code>,
            y "Muro perimetral" con <code className="text-brand">wall_climbing</code>, sobre la misma cámara.
          </p>
          <ol className="list-decimal list-inside space-y-1.5 text-sm text-foreground/80">
            <li>Dashboard → <strong>Cámaras</strong> → botón <strong>Configurar zonas</strong> sobre la cámara que quieras.</li>
            <li>Arriba del video hay chips, uno por zona. Creá la primera escribiendo un nombre y tocando <strong>+</strong>.</li>
            <li>Con una zona seleccionada (resaltada en azul), hacé clic sobre la imagen en vivo para marcar los puntos del polígono (mínimo 3); las demás zonas se ven de fondo en gris punteado.</li>
            <li>Clic en <strong>Guardar zona</strong>.</li>
            <li>Más abajo, sección <strong>Módulos de comportamiento</strong>: aplica a la zona seleccionada -- activá/desactivá cada uno y ajustá sus parámetros.</li>
            <li>Clic en <strong>Guardar módulos</strong>.</li>
          </ol>
          <InfoBox>
            Cambiar de zona sin guardar descarta los puntos del polígono que tenías sin guardar en la
            anterior (no hay guardado automático). El ícono de basura en cada chip borra esa zona junto
            con su configuración de módulos.
          </InfoBox>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-black/20 border-b border-glass-border text-foreground/70">
                  <th className="p-3 font-medium">Módulo</th>
                  <th className="p-3 font-medium">Qué detecta</th>
                  <th className="p-3 font-medium">Parámetros</th>
                </tr>
              </thead>
              <tbody className="text-foreground/80">
                <tr className="border-b border-glass-border/50">
                  <td className="p-3 font-mono text-xs text-brand">loitering</td>
                  <td className="p-3">Permanencia prolongada dentro de la zona (merodeo)</td>
                  <td className="p-3 font-mono text-xs">dwell_seconds (default 5)</td>
                </tr>
                <tr className="border-b border-glass-border/50">
                  <td className="p-3 font-mono text-xs text-brand">zone_intrusion</td>
                  <td className="p-3">Una muñeca (mano) cruza hacia la zona</td>
                  <td className="p-3 font-mono text-xs">--</td>
                </tr>
                <tr className="border-b border-glass-border/50">
                  <td className="p-3 font-mono text-xs text-brand">wall_climbing</td>
                  <td className="p-3">Torso sobre una línea + movimiento vertical rápido</td>
                  <td className="p-3 font-mono text-xs">wall_height_px, climb_speed_threshold</td>
                </tr>
                <tr>
                  <td className="p-3 font-mono text-xs text-brand">concealment</td>
                  <td className="p-3">Sostener un objeto y luego "esconderlo" cerca del cuerpo</td>
                  <td className="p-3 font-mono text-xs">--</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-sm text-foreground/70">
            Los cambios se reflejan casi al instante (la config vive en SQLite y se cachea en memoria,
            refrescada cada 5 segundos o al instante cuando guardás desde el dashboard).
          </p>

          <InfoBox>
            Por defecto, al crear una zona nueva, <code>loitering</code>, <code>zone_intrusion</code> y{" "}
            <code>concealment</code> quedan <strong>activados</strong>; <code>wall_climbing</code> queda{" "}
            <strong>desactivado</strong> porque <code>wall_height_px</code> depende de la perspectiva de
            cada cámara -- hay que calibrarlo a mano antes de prenderlo.
          </InfoBox>

          <p className="text-sm text-foreground/70">También se puede consultar/editar por API:</p>
          <CodeBlock>{CMD_MODULES_API}</CodeBlock>
        </Section>

        <Section id="evidencia" title="7. Evidencia en video (clips)">
          <p className="text-sm text-foreground/80">
            Cada vez que se dispara una alerta, además del snapshot JPEG de siempre, el sistema graba
            automáticamente un <strong>clip de 6 segundos</strong> (3s antes del evento + 3s después)
            con la misma imagen anotada (cajas, ROI, textos de alerta) que se ve en vivo en el dashboard.
          </p>
          <ul className="list-disc list-inside space-y-1.5 text-sm text-foreground/80">
            <li>Tarda unos 3-4 segundos en aparecer después de la alerta -- el Historial se refresca solo cada 8s, no hace falta recargar.</li>
            <li>{"Se guarda en "}<code className="text-brand">{"alerts/clip_<cámara>_<fecha_hora>.mp4"}</code>{", codificado en H.264 (reproducible en cualquier navegador) a 640×360."}</li>
            <li>{"Cada clip trae un hash "}<code className="text-brand">SHA-256</code>{" ("}<code className="text-brand">clip_hash</code>{") como evidencia de integridad básica -- no es almacenamiento inmutable real (WORM), eso sigue pendiente."}</li>
            <li>En <strong>Historial de alertas</strong>, cada fila muestra dos íconos: foto (siempre) y video (cuando termina de codificarse).</li>
          </ul>
          <InfoBox>
            Cada cámara mantiene en RAM un buffer rodante de los últimos ~8 segundos de video para
            poder armar el pre-roll. A 640×360 son unos 100-150MB por cámara -- tenlo en cuenta con
            muchas cámaras activas en una máquina con poca memoria.
          </InfoBox>
        </Section>

        <Section id="notificaciones" title="8. Notificaciones (Email / Telegram)">
          <p className="text-sm text-foreground/80">Dashboard → <strong>Configuración</strong>:</p>
          <ul className="list-disc list-inside space-y-1.5 text-sm text-foreground/80">
            <li>
              <strong>Telegram</strong>: necesitás un bot token (hablale a{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-brand hover:underline inline-flex items-center gap-1">
                @BotFather <ExternalLink className="w-3 h-3" />
              </a>{" "}
              en Telegram) y el chat ID donde querés recibir las alertas con foto.
            </li>
            <li>
              <strong>Email (SMTP)</strong>: servidor, puerto, correo remitente, contraseña de aplicación
              (para Gmail hay que generar una "contraseña de aplicación", no la contraseña normal) y destinatarios.
            </li>
          </ul>
          <p className="text-sm text-foreground/70">
            Guardá con <strong>Guardar cambios</strong>. Las credenciales sensibles se escriben en{" "}
            <code className="text-brand">.env</code>, nunca quedan en <code className="text-brand">settings.json</code>.
          </p>
        </Section>

        <Section id="rostros" title="9. Reconocimiento facial (opcional)">
          <p className="text-sm text-foreground/80">
            Viene <strong>desactivado por defecto</strong> en el build de Docker: <code>face_recognition</code>{" "}
            depende de <code>dlib</code>, que requiere <code>cmake</code> + toolchain de compilación y hace el
            build mucho más lento. El sistema funciona perfecto sin esto -- solo se desactiva la pestaña de rostros.
          </p>
          <p className="text-sm text-foreground/70">Para habilitarlo:</p>
          <ol className="list-decimal list-inside space-y-1 text-sm text-foreground/70">
            <li>{"Editar "}<code className="text-brand">requirements-docker.txt</code>{" y agregar la línea "}<code className="text-brand">face_recognition</code>.</li>
            <li>{"Editar "}<code className="text-brand">Dockerfile.backend</code>{" y agregar "}<code className="text-brand">cmake</code>{" y "}<code className="text-brand">build-essential</code>{" a los paquetes apt-get install."}</li>
            <li><code className="text-brand">{"docker compose build backend && docker compose up -d backend"}</code></li>
          </ol>
        </Section>

        <Section id="modelo" title="10. Modelo especializado de detección de robo (opcional)">
          <p className="text-sm text-foreground/80">
            Si en algún momento entrenás o conseguís un modelo YOLO específico para shoplifting/robo
            (<code className="text-brand">shoplifting.pt</code>), colocalo en la raíz del proyecto. El
            backend lo detecta automáticamente al arrancar y cambia del modo genérico (YOLOv8n + reglas
            de pose) al modelo especializado -- vas a ver en los logs{" "}
            <em>"¡Modelo especializado de robo cargado!"</em> en vez de{" "}
            <em>"usando detección de objetos estándar"</em>.
          </p>
          <p className="text-sm text-foreground/70">
            Con el modelo especializado activo, el módulo <code>concealment</code> (que depende de la
            lógica genérica de "objeto en mano") se desactiva automáticamente para esa cámara; las
            alertas de robo las genera directamente el modelo especializado (<code>ACTIVIDAD SOSPECHOSA: {"<clase>"}</code>).
          </p>
        </Section>

        <Section id="operacion" title="11. Operación diaria -- comandos útiles">
          <CodeBlock>{CMD_DAILY_OPS}</CodeBlock>
        </Section>

        <Section id="troubleshooting" title="12. Solución de problemas">
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> "Docker Desktop no está corriendo" / docker info falla
              </p>
              <p className="text-sm text-foreground/70 mt-1">
                Abrí Docker Desktop manualmente y esperá a que termine de iniciar el engine (unos 10-30s).
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> Backend no responde a nada, ni siquiera /docs
              </p>
              <p className="text-sm text-foreground/70 mt-1">
                Puede estar bloqueado por una excepción no controlada. Revisá los logs y reiniciá el
                backend. (El bug de deadlock original del endpoint de ROI ya está corregido en este
                proyecto -- si agregás un módulo nuevo, no tomes el mismo <code>threading.Lock</code>{" "}
                dos veces de forma anidada.)
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> El dashboard no muestra cambios que acabo de hacer
              </p>
              <p className="text-sm text-foreground/70 mt-1">
                Reiniciá el contenedor del dashboard. Es un problema conocido de Docker Desktop en
                Windows con el watcher de archivos sobre bind mounts (no siempre detecta cambios en vivo).
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> Una cámara muestra "SIN SEÑAL"
              </p>
              <ul className="list-disc list-inside text-sm text-foreground/70 mt-1 space-y-1">
                <li>Si es la webcam (fuente 0): esperado, no hay passthrough en contenedores Windows/Mac. Usá RTSP o un archivo de video.</li>
                <li>{"Si es un archivo: confirmá el path relativo a la raíz ("}<code className="text-brand">videos/archivo.mp4</code>{") y que exista ahí."}</li>
                <li>Si es RTSP: verificá URL/credenciales y que la cámara sea alcanzable desde dentro del contenedor.</li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> Una alerta nunca muestra el ícono de video
              </p>
              <p className="text-sm text-foreground/70 mt-1">
                {"El clip depende de "}<code className="text-brand">ffmpeg</code>{" con soporte "}<code className="text-brand">libx264</code>
                {" dentro del contenedor (viene incluido por defecto). Revisá "}<code className="text-brand">docker compose logs backend</code>
                {" buscando \"Error codificando clip\"; si aparece, confirmá con "}
                <code className="text-brand">{"docker compose exec backend ffmpeg -encoders | grep 264"}</code>{" que el codec sigue disponible."}
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground/90 flex items-center gap-2">
                <Terminal className="w-3.5 h-3.5 text-brand" /> Quiero limpiar datos de prueba
              </p>
              <CodeBlock>{CMD_CLEANUP}</CodeBlock>
            </div>
          </div>
        </Section>

        <Section id="extender" title="13. Extender el sistema: agregar un módulo de comportamiento nuevo">
          <ol className="list-decimal list-inside space-y-2 text-sm text-foreground/80">
            <li>
              {"En "}<code className="text-brand">modules.py</code>{", crear una clase que herede de "}
              <code className="text-brand">BehaviorModule</code>{", con un "}<code className="text-brand">module_id</code>{" único y un método "}
              <code className="text-brand">{"analyze(self, ctx, zone_polygon, params) -> list[Event]"}</code>.
            </li>
            <li>
              {"Agregarlo a "}<code className="text-brand">MODULE_REGISTRY</code>{" al final de "}<code className="text-brand">modules.py</code>.
            </li>
            <li>
              {"En "}<code className="text-brand">backend.py</code>{", agregar una entrada en "}<code className="text-brand">MODULE_CATALOG</code>{" con nombre y parámetros por defecto -- se siembra sola en la base de datos la próxima vez que arranque el backend."}
            </li>
            <li>
              {"Si el evento necesita un overlay visual propio, agregar un caso en el bloque del motor de módulos dentro de "}<code className="text-brand">video_loop()</code>.
            </li>
            <li>Reiniciar el backend y activarlo desde el dashboard como cualquier otro módulo.</li>
          </ol>
          <p className="text-sm text-foreground/70">
            Para el diseño completo (multi-tenant, billing por zona-módulo, explicabilidad), ver{" "}
            <code className="text-brand">docs/arquitectura-deteccion-comportamientos.md</code> en el repositorio.
          </p>
        </Section>

        <Section id="pendiente" title="14. Qué falta para el diseño SaaS completo">
          <ul className="list-disc list-inside space-y-1.5 text-sm text-foreground/80">
            <li><strong>Redis</strong> para el caché de config (hoy es en memoria).</li>
            <li><strong>Política de retención</strong> de clips/snapshots y <strong>almacenamiento WORM real</strong> (hoy cada alerta ya trae un clip de 6s con hash SHA-256, pero no hay borrado automático por antigüedad ni inmutabilidad real).</li>
            <li>Gestión de <strong>tenants/sites</strong> desde el dashboard (hoy son filas semilla).</li>
            <li>Modelo de <strong>precios/billing</strong> por zona-módulo activa.</li>
            <li>Piloto en modo observación antes de activar consecuencias reales (RRHH/legal).</li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

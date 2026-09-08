"use client";

import { useState, useEffect, useRef } from "react";
import { Camera, Plus, Trash2, Edit, Loader2, AlertCircle, CheckCircle, X, RefreshCw, HelpCircle } from "lucide-react";

interface CameraData {
  id: string;
  name: string;
  source: string;
  status: "active" | "error";
  zone_count: number;
}

interface CameraFeed {
  camera_id: string;
  name: string;
  data: string;
}

interface ZoneData {
  id: string;
  name: string;
  polygon: number[][];
}

interface ModuleState {
  module_id: string;
  name: string;
  enabled: boolean;
  params: Record<string, number>;
}

const MODULE_PARAM_FIELDS: Record<string, { key: string; label: string }[]> = {
  loitering: [{ key: "dwell_seconds", label: "Segundos de permanencia" }],
  wall_climbing: [
    { key: "wall_height_px", label: "Altura del muro (px)" },
    { key: "climb_speed_threshold", label: "Velocidad de escalada" },
  ],
};

export default function CamerasPage() {
  const [cameras, setCameras] = useState<CameraData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Add Camera Form
  const [name, setName] = useState("");
  const [source, setSource] = useState("");

  // Zones Modal States
  const [selectedCam, setSelectedCam] = useState<CameraData | null>(null);
  const [zones, setZones] = useState<ZoneData[]>([]);
  const [zonesLoading, setZonesLoading] = useState(false);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [editPoints, setEditPoints] = useState<number[][]>([]);
  const [newZoneName, setNewZoneName] = useState("");
  const [zoneActionLoading, setZoneActionLoading] = useState<string | null>(null); // "new" o el id que se está borrando
  const [activeFrameBase64, setActiveFrameBase64] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Behavior Modules panel (dentro del mismo modal, atado a la zona seleccionada)
  const [modules, setModules] = useState<ModuleState[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [savingModules, setSavingModules] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const fetchCameras = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/cameras`);
      if (res.ok) {
        const data = await res.json();
        setCameras(data);
      }
    } catch (err) {
      console.error("Error fetching cameras:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCameras();
  }, []);

  // Listen to live camera frames when the Zones Modal is open
  useEffect(() => {
    if (!selectedCam) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      setActiveFrameBase64(null);
      return;
    }

    const wsUrl = apiBaseUrl.replace("http", "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "multi_frame" && payload.cameras) {
          const matched = payload.cameras.find((c: CameraFeed) => c.camera_id === selectedCam.id);
          if (matched) {
            setActiveFrameBase64(matched.data);
          }
        }
      } catch (err) {
        console.error("Error parsing WS in zones modal", err);
      }
    };

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [selectedCam]);

  // Redraw Canvas when points, zones or frames change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawPolygonPath = (points: number[][], strokeStyle: string, fillStyle: string, dashed: boolean) => {
      if (points.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();
      ctx.setLineDash(dashed ? [8, 6] : []);
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = dashed ? 2 : 3;
      ctx.stroke();
      ctx.setLineDash([]);
    };

    const drawZones = () => {
      // Otras zonas de la misma cámara: contexto visual, no editables
      zones
        .filter(z => z.id !== selectedZoneId)
        .forEach(z => {
          drawPolygonPath(z.polygon, "#94a3b8", "rgba(148, 163, 184, 0.08)", true);
          if (z.polygon.length > 0) {
            ctx.fillStyle = "#94a3b8";
            ctx.font = "bold 12px sans-serif";
            ctx.fillText(z.name, z.polygon[0][0] + 8, z.polygon[0][1] - 8);
          }
        });

      // Zona seleccionada: editable, con puntos numerados
      if (editPoints.length > 0) {
        drawPolygonPath(editPoints, "#3b82f6", "rgba(59, 130, 246, 0.25)", false);
        editPoints.forEach((pt, index) => {
          ctx.beginPath();
          ctx.arc(pt[0], pt[1], 6, 0, 2 * Math.PI);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.strokeStyle = "#3b82f6";
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 12px sans-serif";
          ctx.fillText((index + 1).toString(), pt[0] + 10, pt[1] - 5);
        });
      }
    };

    const drawCanvas = () => {
      if (activeFrameBase64) {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${activeFrameBase64}`;
        img.onload = () => {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          drawZones();
        };
      } else {
        ctx.fillStyle = "#151824";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
        ctx.font = "20px var(--font-geist-sans), sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Cargando transmisión...", canvas.width / 2, canvas.height / 2 - 10);
        ctx.font = "14px var(--font-geist-sans), sans-serif";
        ctx.fillText("(Verifica que el backend esté activo y transmitiendo)", canvas.width / 2, canvas.height / 2 + 20);

        drawZones();
      }
    };

    drawCanvas();
  }, [editPoints, zones, selectedZoneId, activeFrameBase64, selectedCam]);

  const handleAddCamera = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !source) {
      setMessage({ text: "Ingresa un nombre y una fuente.", type: "error" });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    try {
      const res = await fetch(`${apiBaseUrl}/cameras`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, source }),
      });
      const data = await res.json();

      if (res.ok) {
        setMessage({ text: "¡Cámara agregada correctamente!", type: "success" });
        setName("");
        setSource("");
        await fetchCameras();
      } else {
        setMessage({ text: data.detail || "No se pudo agregar la cámara.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión. Verifica que el backend esté corriendo.", type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteCamera = async (id: string) => {
    if (!confirm("¿Seguro que quieres eliminar esta transmisión de cámara?")) return;
    setMessage(null);

    try {
      const res = await fetch(`${apiBaseUrl}/cameras/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();

      if (res.ok) {
        setMessage({ text: "Cámara eliminada correctamente.", type: "success" });
        await fetchCameras();
      } else {
        setMessage({ text: data.detail || "No se pudo eliminar la cámara.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión.", type: "error" });
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!selectedZoneId) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    // Scale standard mouse clicks exactly to 1280x720 video frames
    const x = Math.round((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));

    setEditPoints(prev => [...prev, [x, y]]);
  };

  const clearEditPoints = () => {
    setEditPoints([]);
  };

  const fetchModules = async (zoneId: string) => {
    setModulesLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/zones/${zoneId}/modules`);
      if (res.ok) {
        const data = await res.json();
        setModules(data);
      }
    } catch (err) {
      console.error("Error fetching modules:", err);
    } finally {
      setModulesLoading(false);
    }
  };

  const selectZone = (zone: ZoneData) => {
    setSelectedZoneId(zone.id);
    setEditPoints(zone.polygon);
    fetchModules(zone.id);
  };

  const openZonesModal = async (cam: CameraData) => {
    setSelectedCam(cam);
    setZonesLoading(true);
    setSelectedZoneId(null);
    setEditPoints([]);
    setModules([]);
    try {
      const res = await fetch(`${apiBaseUrl}/cameras/${cam.id}/zones`);
      if (res.ok) {
        const data: ZoneData[] = await res.json();
        setZones(data);
        if (data.length > 0) {
          selectZone(data[0]);
        }
      }
    } catch (err) {
      console.error("Error fetching zones:", err);
    } finally {
      setZonesLoading(false);
    }
  };

  const handleCreateZone = async () => {
    if (!selectedCam || !newZoneName.trim()) return;
    setZoneActionLoading("new");
    try {
      const res = await fetch(`${apiBaseUrl}/cameras/${selectedCam.id}/zones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newZoneName.trim() }),
      });
      if (res.ok) {
        const newZone: ZoneData = await res.json();
        setZones(prev => [...prev, newZone]);
        setNewZoneName("");
        selectZone(newZone);
        await fetchCameras();
      } else {
        const data = await res.json();
        setMessage({ text: data.detail || "No se pudo crear la zona.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión al crear la zona.", type: "error" });
    } finally {
      setZoneActionLoading(null);
    }
  };

  const handleDeleteZone = async (zoneId: string) => {
    if (!confirm("¿Seguro que quieres eliminar esta zona y sus módulos configurados?")) return;
    setZoneActionLoading(zoneId);
    try {
      const res = await fetch(`${apiBaseUrl}/zones/${zoneId}`, { method: "DELETE" });
      if (res.ok) {
        const remaining = zones.filter(z => z.id !== zoneId);
        setZones(remaining);
        if (selectedZoneId === zoneId) {
          if (remaining.length > 0) {
            selectZone(remaining[0]);
          } else {
            setSelectedZoneId(null);
            setEditPoints([]);
            setModules([]);
          }
        }
        await fetchCameras();
      } else {
        const data = await res.json();
        setMessage({ text: data.detail || "No se pudo eliminar la zona.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión al eliminar la zona.", type: "error" });
    } finally {
      setZoneActionLoading(null);
    }
  };

  const toggleModule = (moduleId: string) => {
    setModules(prev => prev.map(m => m.module_id === moduleId ? { ...m, enabled: !m.enabled } : m));
  };

  const updateModuleParam = (moduleId: string, key: string, value: number) => {
    setModules(prev => prev.map(m => m.module_id === moduleId ? { ...m, params: { ...m.params, [key]: value } } : m));
  };

  const handleSaveModules = async () => {
    if (!selectedZoneId) return;
    setSavingModules(true);
    setMessage(null);
    try {
      await Promise.all(modules.map(m =>
        fetch(`${apiBaseUrl}/zones/${selectedZoneId}/modules/${m.module_id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: m.enabled, params: m.params }),
        })
      ));
      setMessage({ text: "Módulos de comportamiento guardados correctamente.", type: "success" });
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error al guardar los módulos.", type: "error" });
    } finally {
      setSavingModules(false);
    }
  };

  const handleSaveZone = async () => {
    if (!selectedZoneId) return;
    try {
      const res = await fetch(`${apiBaseUrl}/zones/${selectedZoneId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ polygon: editPoints }),
      });

      if (res.ok) {
        setZones(prev => prev.map(z => z.id === selectedZoneId ? { ...z, polygon: editPoints } : z));
        setMessage({ text: "¡Zona guardada correctamente!", type: "success" });
      } else {
        const data = await res.json();
        alert(data.detail || "No se pudo guardar la zona.");
      }
    } catch (err) {
      console.error(err);
      alert("Error de red al guardar la zona.");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-brand" />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto pb-10">
      <header className="mb-8">
        <h2 className="text-3xl font-bold tracking-tight mb-2">Configuración de cámaras</h2>
        <p className="text-foreground/60">
          Administra cámaras USB/RTSP y define varias zonas de interés por cámara, cada una con sus propios módulos de comportamiento.
        </p>
      </header>

      {message && (
        <div
          className={`mb-6 p-4 rounded-lg flex items-center gap-3 border ${
            message.type === "success"
              ? "bg-green-500/10 border-green-500/30 text-green-400"
              : "bg-danger/10 border-danger/30 text-danger"
          }`}
        >
          {message.type === "success" ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <span className="text-sm font-medium">{message.text}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Add Camera Form */}
        <div className="lg:col-span-1">
          <div className="glass-panel p-6 sticky top-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded bg-brand/20 text-brand">
                <Camera className="w-5 h-5" />
              </div>
              <h3 className="text-xl font-semibold">Conectar nueva cámara</h3>
            </div>

            <form onSubmit={handleAddCamera} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">Nombre de la cámara</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="ej. Caja registradora A"
                  className="w-full bg-black/40 border border-glass-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand text-foreground placeholder:text-foreground/30"
                  required
                />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-medium text-foreground/80">Fuente de entrada</label>
                  <span className="text-[10px] text-foreground/45 flex items-center gap-1">
                    <HelpCircle className="w-3 h-3" />
                    Índice de webcam, URL RTSP o ruta de video
                  </span>
                </div>
                <input
                  type="text"
                  value={source}
                  onChange={e => setSource(e.target.value)}
                  placeholder="ej. 0, rtsp://usuario:clave@ip:puerto/h264 o videos/prueba.mp4"
                  className="w-full bg-black/40 border border-glass-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand text-foreground placeholder:text-foreground/30"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full mt-4 flex items-center justify-center gap-2 bg-brand hover:bg-brand/90 disabled:opacity-50 text-white py-2 rounded-lg font-medium transition-colors cursor-pointer"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {submitting ? "Conectando transmisión..." : "Agregar cámara"}
              </button>
            </form>
          </div>
        </div>

        {/* Cameras List */}
        <div className="lg:col-span-2">
          <div className="glass-panel p-6">
            <div className="flex justify-between items-center mb-6">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded bg-purple-500/20 text-purple-400">
                  <Plus className="w-5 h-5" />
                </div>
                <h3 className="text-xl font-semibold">Cámaras activas</h3>
              </div>
              <button
                onClick={fetchCameras}
                className="p-2 hover:bg-glass border border-glass-border rounded-lg text-foreground/60 hover:text-foreground transition-colors cursor-pointer"
                title="Actualizar"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {cameras.length === 0 ? (
              <div className="text-center p-12 text-foreground/40 border border-glass-border border-dashed rounded-lg bg-black/10">
                No hay cámaras configuradas. Usa el formulario para vincular una webcam local (0), un stream RTSP o un video de prueba.
              </div>
            ) : (
              <div className="space-y-4">
                {cameras.map(cam => (
                  <div
                    key={cam.id}
                    className="glass-panel p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border border-glass-border bg-black/20"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center border ${
                          cam.status === "active"
                            ? "bg-green-500/10 border-green-500/30 text-green-400"
                            : "bg-danger/10 border-danger/30 text-danger"
                        }`}
                      >
                        <Camera className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="font-semibold text-foreground flex items-center gap-2">
                          {cam.name}
                          <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${
                            cam.status === "active"
                              ? "bg-green-500/10 border-green-500/20 text-green-400"
                              : "bg-danger/10 border-danger/20 text-danger"
                          }`}>
                            {cam.status === "active" ? "Activa" : "Desconectada / Error"}
                          </span>
                        </h4>
                        <p className="text-xs text-foreground/50 mt-1 font-mono">Fuente: {cam.source}</p>
                        <p className="text-xs text-brand font-medium mt-1">
                          {cam.zone_count > 0
                            ? `✓ ${cam.zone_count} zona${cam.zone_count > 1 ? "s" : ""} configurada${cam.zone_count > 1 ? "s" : ""}`
                            : "⚠️ Sin zonas configuradas. Se monitorea toda la pantalla."}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end md:self-auto">
                      <button
                        onClick={() => openZonesModal(cam)}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-brand/20 border border-brand/35 text-brand hover:bg-brand/30 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
                      >
                        <Edit className="w-3.5 h-3.5" />
                        Configurar zonas
                      </button>
                      <button
                        onClick={() => handleDeleteCamera(cam.id)}
                        className="p-2 text-foreground/50 hover:text-danger hover:bg-danger/10 rounded-lg transition-colors cursor-pointer"
                        title="Eliminar cámara"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Zones Editor Modal */}
      {selectedCam && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md transition-all duration-300">
          <div className="glass-panel w-full max-w-4xl max-h-[90vh] overflow-y-auto border border-glass-border shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="glass-header px-6 py-4 flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold text-foreground">Zonas de la cámara</h3>
                <p className="text-xs text-foreground/60">{selectedCam.name} ({selectedCam.source})</p>
              </div>
              <button
                onClick={() => setSelectedCam(null)}
                className="p-1.5 hover:bg-white/10 rounded-lg text-foreground/70 hover:text-foreground transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-4">
              {/* Zone tabs */}
              <div className="flex flex-wrap items-center gap-2">
                {zonesLoading ? (
                  <div className="flex items-center gap-2 text-xs text-foreground/50">
                    <Loader2 className="w-4 h-4 animate-spin" /> Cargando zonas...
                  </div>
                ) : (
                  <>
                    {zones.map(zone => (
                      <div
                        key={zone.id}
                        className={`flex items-center gap-1.5 pl-3 pr-1.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-colors ${
                          zone.id === selectedZoneId
                            ? "bg-brand/20 border-brand/40 text-brand"
                            : "bg-black/20 border-glass-border text-foreground/70 hover:bg-white/5"
                        }`}
                        onClick={() => selectZone(zone)}
                      >
                        {zone.name}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDeleteZone(zone.id); }}
                          disabled={zoneActionLoading === zone.id}
                          className="p-1 hover:bg-danger/20 hover:text-danger rounded transition-colors cursor-pointer disabled:opacity-50"
                          title="Eliminar zona"
                        >
                          {zoneActionLoading === zone.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newZoneName}
                        onChange={e => setNewZoneName(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") handleCreateZone(); }}
                        placeholder="Nombre de zona nueva"
                        className="w-40 bg-black/40 border border-glass-border rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand text-foreground placeholder:text-foreground/30"
                      />
                      <button
                        onClick={handleCreateZone}
                        disabled={!newZoneName.trim() || zoneActionLoading === "new"}
                        className="p-1.5 bg-brand/20 border border-brand/35 text-brand hover:bg-brand/30 disabled:opacity-50 rounded-lg transition-colors cursor-pointer"
                        title="Crear zona"
                      >
                        {zoneActionLoading === "new" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                      </button>
                    </div>
                  </>
                )}
              </div>

              {!zonesLoading && zones.length === 0 && (
                <div className="p-3 bg-brand/10 border border-brand/20 text-brand rounded-lg text-xs">
                  Esta cámara todavía no tiene zonas. Creá la primera con el campo de arriba para poder
                  dibujar un polígono y activar módulos de comportamiento.
                </div>
              )}

              <div className="p-3 bg-brand/10 border border-brand/20 text-brand rounded-lg text-xs flex items-start gap-2 leading-relaxed">
                <HelpCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  <strong>Cómo dibujar una zona:</strong> elegí o creá una zona arriba, después hacé clic sobre la imagen en vivo para ir colocando los puntos del polígono; se irán uniendo en orden con líneas. Las demás zonas de esta cámara se ven en gris punteado como referencia. Cambiar de zona descarta los puntos sin guardar. Al terminar, hacé clic en <strong>Guardar zona</strong>.
                </span>
              </div>

              {/* Responsive 1280x720 Canvas */}
              <div className="aspect-video w-full bg-black/60 rounded-lg overflow-hidden border border-glass-border relative flex items-center justify-center">
                <canvas
                  ref={canvasRef}
                  width={1280}
                  height={720}
                  onClick={handleCanvasClick}
                  className={`w-full h-auto aspect-video object-contain ${selectedZoneId ? "cursor-crosshair" : "cursor-not-allowed"}`}
                />
              </div>

              <div className="flex justify-between items-center text-xs text-foreground/50 px-1">
                <span>Coordenadas: [{editPoints.map(p => `(${p[0]},${p[1]})`).join(", ")}]</span>
                <span>Cantidad de puntos: {editPoints.length}</span>
              </div>

              {/* Módulos de comportamiento para la zona seleccionada */}
              <div className="border-t border-glass-border pt-4">
                <h4 className="text-sm font-semibold text-foreground mb-3">Módulos de comportamiento</h4>
                {!selectedZoneId ? (
                  <p className="text-xs text-foreground/50">Elegí o creá una zona para configurar sus módulos.</p>
                ) : modulesLoading ? (
                  <div className="flex items-center gap-2 text-xs text-foreground/50">
                    <Loader2 className="w-4 h-4 animate-spin" /> Cargando módulos...
                  </div>
                ) : (
                  <div className="space-y-3">
                    {modules.map(m => (
                      <div key={m.module_id} className="p-3 rounded-lg bg-black/20 border border-glass-border">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={m.enabled}
                            onChange={() => toggleModule(m.module_id)}
                            className="rounded bg-black/40 border-glass-border text-brand"
                          />
                          <span className="text-sm font-medium text-foreground/90">{m.name}</span>
                        </label>
                        {m.enabled && MODULE_PARAM_FIELDS[m.module_id] && (
                          <div className="mt-3 ml-6 grid grid-cols-1 md:grid-cols-2 gap-3">
                            {MODULE_PARAM_FIELDS[m.module_id].map(field => (
                              <div key={field.key} className="space-y-1">
                                <label className="text-[11px] text-foreground/50">{field.label}</label>
                                <input
                                  type="number"
                                  value={m.params[field.key] ?? 0}
                                  onChange={e => updateModuleParam(m.module_id, field.key, Number(e.target.value))}
                                  className="w-full bg-black/40 border border-glass-border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand text-foreground"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={handleSaveModules}
                  disabled={!selectedZoneId || savingModules || modulesLoading}
                  className="mt-4 flex items-center justify-center gap-2 bg-brand/20 border border-brand/35 hover:bg-brand/30 disabled:opacity-50 text-brand px-4 py-2 rounded-lg text-sm font-semibold transition-colors cursor-pointer"
                >
                  {savingModules ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  {savingModules ? "Guardando módulos..." : "Guardar módulos"}
                </button>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="glass-header border-t border-b-0 px-6 py-4 flex justify-between items-center gap-4">
              <button
                onClick={clearEditPoints}
                disabled={!selectedZoneId}
                className="px-4 py-2 border border-glass-border hover:bg-glass rounded-lg text-sm font-semibold transition-colors cursor-pointer text-foreground/80 hover:text-foreground disabled:opacity-50"
              >
                Borrar puntos
              </button>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedCam(null)}
                  className="px-4 py-2 border border-glass-border hover:bg-glass rounded-lg text-sm font-semibold transition-colors cursor-pointer text-foreground/80 hover:text-foreground"
                >
                  Cerrar
                </button>
                <button
                  onClick={handleSaveZone}
                  disabled={!selectedZoneId}
                  className="px-6 py-2 bg-brand hover:bg-brand/90 disabled:opacity-50 text-white rounded-lg text-sm font-bold transition-colors cursor-pointer"
                >
                  Guardar zona
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

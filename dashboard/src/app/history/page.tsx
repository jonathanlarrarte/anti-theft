"use client";

import { useState, useEffect } from "react";
import { Search, Download, ExternalLink, Calendar, Loader2, Image as ImageIcon, Video as VideoIcon } from "lucide-react";

interface AlertHistory {
  id: string;
  message: string;
  timestamp: string;
  image_path: string;
  clip_path?: string;
  clip_hash?: string;
}

export default function HistoryPage() {
  const [history, setHistory] = useState<AlertHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedType, setSelectedType] = useState("Todos los tipos de evento");

  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/history`);
        if (response.ok) {
          const data = await response.json();
          setHistory(data);
        }
      } catch (err) {
        console.error("Failed to fetch history:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchHistory();
    // El clip de evidencia se termina de codificar unos segundos después de
    // que aparece la fila de la alerta -- refrescamos para que el ícono de
    // video aparezca solo, sin recargar la página a mano.
    const interval = setInterval(fetchHistory, 8000);
    return () => clearInterval(interval);
  }, []);

  const formatTime = (ts: string) => {
    if (!ts || ts.length !== 15) return ts;
    const year = ts.slice(0, 4);
    const month = ts.slice(4, 6);
    const day = ts.slice(6, 8);
    const hour = ts.slice(9, 11);
    const min = ts.slice(11, 13);
    const sec = ts.slice(13, 15);
    return `${year}-${month}-${day} ${hour}:${min}:${sec}`;
  };

  // Advanced client-side filtering matching logic
  const filteredHistory = history.filter((event) => {
    const matchesSearch = 
      event.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      event.image_path.toLowerCase().includes(searchQuery.toLowerCase());

    let matchesType = true;
    if (selectedType === "Comportamiento sospechoso") {
      matchesType = event.message.includes("MERODEO") || event.message.includes("RESTRINGIDA") || event.message.includes("SOSPECHOSA") || event.message.includes("ESCALAMIENTO");
    } else if (selectedType === "Rostro en lista negra") {
      matchesType = event.message.includes("LISTA NEGRA");
    } else if (selectedType === "Ocultamiento de artículo") {
      matchesType = event.message.includes("ROBO") || event.message.includes("OCULTADO");
    }

    return matchesSearch && matchesType;
  });

  // Client-side CSV export trigger
  const handleExportCSV = () => {
    if (filteredHistory.length === 0) return;
    const headers = ["ID de evento", "Fecha y hora", "Mensaje de alerta", "Ruta de evidencia", "Ruta del clip"];
    const rows = filteredHistory.map(event => [
      event.id,
      formatTime(event.timestamp),
      event.message,
      event.image_path,
      event.clip_path || ""
    ]);
    
    const csvContent = "data:text/csv;charset=utf-8,\uFEFF" 
      + [headers.join(","), ...rows.map(r => r.map(val => `"${val.replace(/"/g, '""')}"`).join(","))].join("\n");
      
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `TheftGuard_Alertas_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="max-w-6xl mx-auto pb-10">
      <header className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-bold tracking-tight mb-2">Historial de alertas</h2>
          <p className="text-foreground/60">Revisa eventos de seguridad pasados y exporta evidencia.</p>
        </div>
        <div className="flex gap-3">
          <button className="flex items-center gap-2 px-4 py-2 bg-glass border border-glass-border rounded-lg hover:bg-white/5 transition-colors text-sm font-medium">
            <Calendar className="w-4 h-4" />
            Últimos 7 días
          </button>
          <button
            onClick={handleExportCSV}
            disabled={filteredHistory.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-brand/20 border border-brand/35 hover:bg-brand/30 text-brand rounded-lg transition-colors text-sm font-bold cursor-pointer disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            Exportar CSV
          </button>
        </div>
      </header>

      <div className="glass-panel overflow-hidden">
        <div className="p-4 border-b border-glass-border flex gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/50" />
            <input 
              type="text" 
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Buscar por ID de evento, tipo o cámara..."
              className="w-full bg-black/40 border border-glass-border rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <select
            value={selectedType}
            onChange={e => setSelectedType(e.target.value)}
            className="bg-black/40 border border-glass-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand text-foreground"
          >
            <option className="bg-[#0f111a]">Todos los tipos de evento</option>
            <option className="bg-[#0f111a]">Comportamiento sospechoso</option>
            <option className="bg-[#0f111a]">Rostro en lista negra</option>
            <option className="bg-[#0f111a]">Ocultamiento de artículo</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-black/20 border-b border-glass-border text-sm text-foreground/70">
                <th className="p-4 font-medium">ID de evento</th>
                <th className="p-4 font-medium">Fecha y hora</th>
                <th className="p-4 font-medium">Tipo de detección</th>
                <th className="p-4 font-medium">Ruta de imagen</th>
                <th className="p-4 font-medium text-center">Captura</th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {loading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-foreground/60">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Cargando historial...
                  </td>
                </tr>
              ) : filteredHistory.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-foreground/60">
                    No se encontraron alertas que coincidan con la búsqueda.
                  </td>
                </tr>
              ) : (
                filteredHistory.map((event) => (
                  <tr key={event.id} className="border-b border-glass-border/50 hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 font-mono text-brand text-xs">{event.id.slice(0, 8)}...</td>
                    <td className="p-4 text-foreground/80">{formatTime(event.timestamp)}</td>
                    <td className="p-4">
                      <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${
                        event.message.includes('ROBO') || event.message.includes('SOSPECHOSA') ? 'bg-danger/20 text-danger border border-danger/20' :
                        event.message.includes('LISTA NEGRA') || event.message.includes('RESTRINGIDA') || event.message.includes('ESCALAMIENTO') ? 'bg-orange-500/20 text-orange-400 border border-orange-500/20' :
                        'bg-blue-500/20 text-blue-400 border border-blue-500/20'
                      }`}>
                        {event.message}
                      </span>
                    </td>
                    <td className="p-4 font-mono text-xs text-foreground/60">{event.image_path}</td>
                    <td className="p-4 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <a
                          href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/${event.image_path}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Ver captura"
                          className="p-1.5 rounded hover:bg-white/10 text-foreground/70 hover:text-brand transition-colors inline-block cursor-pointer"
                        >
                          <ImageIcon className="w-4 h-4" />
                        </a>
                        {event.clip_path && (
                          <a
                            href={`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/${event.clip_path}`}
                            target="_blank"
                            rel="noreferrer"
                            title={event.clip_hash ? `Ver clip de video (hash: ${event.clip_hash.slice(0, 12)}...)` : "Ver clip de video"}
                            className="p-1.5 rounded hover:bg-white/10 text-foreground/70 hover:text-brand transition-colors inline-block cursor-pointer"
                          >
                            <VideoIcon className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        
        {!loading && filteredHistory.length > 0 && (
          <div className="p-4 border-t border-glass-border flex items-center justify-between text-sm text-foreground/60">
            <div>Mostrando {filteredHistory.length} de {history.length} registros</div>
            <div className="flex gap-1">
              <button className="px-3 py-1 border border-glass-border rounded hover:bg-white/5 disabled:opacity-50" disabled>Anterior</button>
              <button className="px-3 py-1 bg-brand text-white rounded font-bold">1</button>
              <button className="px-3 py-1 border border-glass-border rounded hover:bg-white/5 disabled:opacity-50" disabled>Siguiente</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

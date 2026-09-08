"use client";

import { useState, useEffect } from "react";
import { Users, UserPlus, Trash2, ShieldAlert, ShieldCheck, Loader2, AlertCircle, CheckCircle } from "lucide-react";

interface FaceData {
  id: string;
  name: string;
  type: "blacklist" | "whitelist";
}

export default function FacesPage() {
  const [faces, setFaces] = useState<FaceData[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  
  // Form states
  const [name, setName] = useState("");
  const [type, setType] = useState<"blacklist" | "whitelist">("blacklist");
  const [photo, setPhoto] = useState<File | null>(null);
  
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null);

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const fetchFaces = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/faces`);
      if (res.ok) {
        const data = await res.json();
        setFaces(data);
      }
    } catch (err) {
      console.error("Error fetching faces:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFaces();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setPhoto(e.target.files[0]);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !photo) {
      setMessage({ text: "Completa todos los campos y selecciona una foto.", type: "error" });
      return;
    }

    setSubmitting(true);
    setMessage(null);

    const formData = new FormData();
    formData.append("file", photo);
    formData.append("name", name);
    formData.append("type", type);

    try {
      const res = await fetch(`${apiBaseUrl}/faces/register`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (res.ok && data.status === "success") {
        setMessage({ text: `Rostro registrado correctamente: ${name}`, type: "success" });
        setName("");
        setPhoto(null);
        // Reset file input
        const fileInput = document.getElementById("photo-input") as HTMLInputElement;
        if (fileInput) fileInput.value = "";

        await fetchFaces();
      } else {
        setMessage({ text: data.message || "No se pudo registrar el rostro.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión. Verifica que el backend esté corriendo.", type: "error" });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("¿Seguro que quieres eliminar este registro facial?")) return;

    setDeleteLoadingId(id);
    setMessage(null);

    try {
      const res = await fetch(`${apiBaseUrl}/faces/${id}`, {
        method: "DELETE",
      });
      const data = await res.json();

      if (res.ok && data.status === "success") {
        setMessage({ text: "Registro eliminado correctamente.", type: "success" });
        await fetchFaces();
      } else {
        setMessage({ text: data.message || "No se pudo eliminar el registro.", type: "error" });
      }
    } catch (err) {
      console.error(err);
      setMessage({ text: "Error de conexión.", type: "error" });
    } finally {
      setDeleteLoadingId(null);
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
        <h2 className="text-3xl font-bold tracking-tight mb-2">Gestión de reconocimiento facial</h2>
        <p className="text-foreground/60">
          Registra personas en lista blanca o negra para disparar alertas en tiempo real.
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
        {/* Register Section */}
        <div className="lg:col-span-1">
          <div className="glass-panel p-6 sticky top-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded bg-brand/20 text-brand">
                <UserPlus className="w-5 h-5" />
              </div>
              <h3 className="text-xl font-semibold">Registrar nuevo rostro</h3>
            </div>

            <form onSubmit={handleRegister} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">Nombre completo</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="ej. Juan Pérez"
                  className="w-full bg-black/40 border border-glass-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand text-foreground placeholder:text-foreground/30"
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">Tipo de lista</label>
                <select
                  value={type}
                  onChange={e => setType(e.target.value as "blacklist" | "whitelist")}
                  className="w-full bg-black/40 border border-glass-border rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand text-foreground"
                >
                  <option value="blacklist" className="bg-[#0f111a]">Lista negra (alarmas activas)</option>
                  <option value="whitelist" className="bg-[#0f111a]">Lista blanca (VIP/confiable)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground/80">Foto de referencia</label>
                <div className="mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-glass-border border-dashed rounded-lg bg-black/20 hover:bg-black/30 transition-colors cursor-pointer relative group">
                  <div className="space-y-1 text-center">
                    <svg
                      className="mx-auto h-12 w-12 text-foreground/45 group-hover:text-brand transition-colors"
                      stroke="currentColor"
                      fill="none"
                      viewBox="0 0 48 48"
                      aria-hidden="true"
                    >
                      <path
                        d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <div className="flex text-sm text-foreground/60">
                      <span className="relative rounded-md font-semibold text-brand hover:text-brand/80 focus-within:outline-none">
                        Subir un archivo
                      </span>
                    </div>
                    <p className="text-xs text-foreground/45">PNG, JPG, JPEG hasta 10MB</p>
                  </div>
                  <input 
                    id="photo-input" 
                    type="file" 
                    accept="image/*"
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    required
                  />
                </div>
                {photo && (
                  <p className="text-xs text-brand font-medium">Seleccionado: {photo.name}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full mt-4 flex items-center justify-center gap-2 bg-brand hover:bg-brand/90 disabled:opacity-50 text-white py-2 rounded-lg font-medium transition-colors cursor-pointer"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                {submitting ? "Registrando..." : "Registrar rostro"}
              </button>
            </form>
          </div>
        </div>

        {/* Registered Grid */}
        <div className="lg:col-span-2">
          <div className="glass-panel p-6">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 rounded bg-purple-500/20 text-purple-400">
                <Users className="w-5 h-5" />
              </div>
              <h3 className="text-xl font-semibold">Rostros registrados ({faces.length})</h3>
            </div>

            {faces.length === 0 ? (
              <div className="text-center p-12 text-foreground/40 border border-glass-border border-dashed rounded-lg bg-black/10">
                Aún no hay rostros registrados. Usa el formulario para agregar uno.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {faces.map(face => (
                  <div 
                    key={face.id}
                    className={`glass-panel p-4 flex items-center justify-between border-t-4 transition-all duration-300 hover:bg-white/[0.02] ${
                      face.type === "blacklist" 
                        ? "border-t-danger/70 hover:shadow-[0_0_15px_rgba(239,68,68,0.15)]" 
                        : "border-t-green-500/70 hover:shadow-[0_0_15px_rgba(34,197,94,0.15)]"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div 
                        className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg border-2 ${
                          face.type === "blacklist" 
                            ? "bg-danger/10 border-danger/30 text-danger" 
                            : "bg-green-500/10 border-green-500/30 text-green-500"
                        }`}
                      >
                        {face.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h4 className="font-semibold text-foreground">{face.name}</h4>
                        <div className="flex items-center gap-1.5 mt-1">
                          {face.type === "blacklist" ? (
                            <span className="flex items-center gap-1 text-[10px] uppercase font-bold text-danger bg-danger/10 px-2 py-0.5 rounded-full border border-danger/20">
                              <ShieldAlert className="w-3 h-3" />
                              Lista negra
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-[10px] uppercase font-bold text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full border border-green-500/20">
                              <ShieldCheck className="w-3 h-3" />
                              Lista blanca VIP
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={() => handleDelete(face.id)}
                      disabled={deleteLoadingId === face.id}
                      className="p-2 text-foreground/50 hover:text-danger hover:bg-danger/10 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                      title="Eliminar"
                    >
                      {deleteLoadingId === face.id ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Trash2 className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

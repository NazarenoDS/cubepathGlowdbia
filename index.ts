import { serve, type ServerWebSocket } from "bun"

// --- Tipos ---
// Esto le dice a Bun qué estructura tiene ws.data en cada conexión
type SessionData = {
  geminiWs: WebSocket | null
  geminiReady: boolean
  messageQueue: string[]  // mensajes que llegaron antes de que Gemini esté listo
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_API_KEY) {
  console.error("❌ Falta GEMINI_API_KEY")
  process.exit(1)
}

const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`

// --- Función que abre y configura la conexión con Gemini ---
function connectToGemini(ws: ServerWebSocket<SessionData>) {
  const geminiWs = new WebSocket(GEMINI_WS_URL)

  geminiWs.onopen = () => {
    console.log("✅ Gemini Live conectado")

    // Setup inicial: le decimos al modelo quién es y cómo debe responder
    geminiWs.send(JSON.stringify({
      setup: {
        model: "gemini-3.1-flash-live-preview",
        generationConfig: {
          responseModalities: ["TEXT"]
        },
        systemInstruction: {
          parts: [{
            text: `Sos un asistente de computadora estilo Clippy(office) pero moderno.
El usuario te manda screenshots continuamente de su pantalla.
Tu trabajo es detectar exactamente dónde está parado: qué app está abierta, 
qué botones ve, qué menús hay disponibles.
Cuando te pida ayuda, respondé con pasos cortos, numerados, concretos.
Respondé SIEMPRE en JSON con este formato exacto:
{
    "steps": [
        {
        "id": 1,
        "text": "Haz clic en el botón azul 'Guardar'",
        "action": "click",                    // "click" | "type" | "scroll" | "wait"
        "highlight": {
            "x": 420,       // coordenada X en píxeles (absoluta)
            "y": 310,       // coordenada Y en píxeles (absoluta)
            "width": 140,
            "height": 45
        }
        }
    ]
}
Importante:
- Nada mas que ese Json.
- Las coordenadas deben ser absolutas respecto a la screenshot completa (no relativas).
- Usa siempre números enteros.
- Si no estás seguro de la posición exacta, poné highlight: null
- Sé muy preciso con las coordenadas.`
          }]
        }
      }
    }))

    // Gemini está listo — marcamos y vaciamos la cola de mensajes pendientes
    ws.data.geminiReady = true
    for (const msg of ws.data.messageQueue) {
      geminiWs.send(msg)
    }
    ws.data.messageQueue = []
  }

  geminiWs.onmessage = (event) => {
    // Todo lo que responde Gemini va directo al front
    ws.send(event.data as string)
  }

  geminiWs.onerror = (e) => {
    console.error("❌ Gemini error:", e)
    ws.send(JSON.stringify({ type: "error", error: "Error en conexión con Gemini" }))
  }

  geminiWs.onclose = () => {
    console.log("🔌 Gemini Live cerrado")
    ws.data.geminiReady = false
  }

  ws.data.geminiWs = geminiWs
}

// --- Función que arma el payload para Gemini con screenshot + prompt ---
function buildGeminiPayload(prompt: string, imageBase64?: string, imageWidth?: number, imageHeight?: number) {
  const parts: object[] = [
    { text: prompt || "Seguí el tutorial, ¿qué debo hacer ahora?" }
  ]

  // Solo agregamos la imagen si viene (no siempre va a venir)
  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: imageBase64
      }
    })
  }

  // ← Nueva parte: le decimos el tamaño real de la captura
  if (imageWidth && imageHeight) {
    parts.push({
      text: `La captura de pantalla tiene ${imageWidth}×${imageHeight} píxeles. Usa estas dimensiones exactas para calcular las coordenadas.`
    })
  }

  return JSON.stringify({
    clientContent: {
      turns: [{
        role: "user",
        parts
      }],
      turnComplete: true  // le decimos a Gemini que puede responder
    }
  })
}

// --- Servidor principal ---
serve<SessionData>({
  port: process.env.PORT || 3000,

  fetch(req, server) {
    if (req.url.endsWith("/health")) {
      return new Response("OK")
    }
    // Intentamos upgrade a WebSocket
    // El segundo argumento es el valor inicial de ws.data
    const upgraded = server.upgrade(req, {
      data: {
        geminiWs: null,
        geminiReady: false,
        messageQueue: []
      } satisfies SessionData
    })
    if (upgraded) return

    return new Response("Solo WebSocket", { status: 400 })
  },

  websocket: {
    open(ws) {
      console.log("👋 Electron conectado")
      // Abrimos la sesión con Gemini apenas conecta el front
      connectToGemini(ws)
      ws.send(JSON.stringify({ type: "connected" }))
    },

    message(ws, message) {
      try {
        const data = JSON.parse(message.toString()) as {
          prompt?: string
          image?: string  // base64
          imageWidth?: number
          imageHeight?: number
        }

        const payload = buildGeminiPayload(data.prompt ?? "", data.image, data.imageWidth, data.imageHeight);

        if (ws.data.geminiReady) {
          // Gemini está listo, mandamos directo
          ws.data.geminiWs!.send(payload)
        } else {
          // Gemini todavía está conectando, encolamos
          ws.data.messageQueue.push(payload)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Error desconocido"
        ws.send(JSON.stringify({ type: "error", error: msg }))
      }
    },

    close(ws) {
      console.log("👋 Electron desconectado")
      ws.data.geminiWs?.close()
    }
  }
})

console.log(`🚀 Backend corriendo en puerto ${process.env.PORT || 3000}`)
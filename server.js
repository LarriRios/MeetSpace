/**
 * @file server.js
 * @brief Servidor principal de MeetSpace — SFU WebRTC con mediasoup, Socket.IO y análisis de archivos con IA.
 *
 * @details
 * Este módulo implementa el backend completo de la aplicación MeetSpace:
 * - Servidor HTTPS con Express para servir archivos estáticos.
 * - Servidor Socket.IO para la señalización WebRTC (equivalente al plano de control SIP en IMS).
 * - SFU (Selective Forwarding Unit) implementada con mediasoup: gestión de Workers, Routers,
 *   WebRtcTransports, Producers y Consumers.
 * - Salas de reunión privadas con PIN opcional.
 * - Chat en tiempo real, reacciones, indicador de voz activa y encuestas.
 * - Análisis de imágenes y documentos PDF mediante la API REST de Google Gemini.
 *
 * @architecture
 * - Plano de control: Socket.IO sobre WSS (puerto 3000).
 * - Plano de datos: WebRTC/SRTP sobre UDP (puertos 40000–49999) o TCP (fallback).
 * - Separación análoga a IMS/5G: señalización independiente del flujo de medios.
 *
 * @requires express
 * @requires https
 * @requires fs
 * @requires socket.io
 * @requires mediasoup
 * @requires dotenv
 */

import express from 'express';
import https from 'https';
import fs from 'fs';
import { Server } from 'socket.io';
import mediasoup from 'mediasoup';
import 'dotenv/config';

/** @brief Instancia de la aplicación Express. */
const app = express();

/**
 * @brief Servidor HTTPS creado con certificados TLS autofirmados generados con mkcert.
 * @details Requerido para que los navegadores permitan el acceso a getUserMedia
 *          desde IPs distintas a localhost.
 */
const httpServer = https.createServer({
  key:  fs.readFileSync('./192.168.56.10+3-key.pem'),
  cert: fs.readFileSync('./192.168.56.10+3.pem')
}, app);

/**
 * @brief Instancia del servidor Socket.IO con CORS abierto.
 * @details Permite conexiones desde cualquier origen, necesario para acceso
 *          desde la red pública bridged (192.168.1.125).
 */
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static('.'));

/**
 * @brief Códecs de medios soportados por el Router mediasoup.
 * @details
 * - audio/opus a 48 kHz estéreo: códec de audio estándar en WebRTC.
 * - video/VP8 a 90 kHz: códec de video compatible con todos los navegadores.
 */
const mediaCodecs = [
  { kind: 'audio', mimeType: 'audio/opus',  clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',   clockRate: 90000, parameters: {} }
];

/**
 * @brief Mapa de salas activas.
 * @details Estructura: Map<roomId, { router, pin, peers: Map<socketId, peer>, polls?: Map }>
 *          Cada sala contiene su propio Router mediasoup, PIN opcional y el mapa de peers.
 */
const rooms = new Map();

/**
 * @brief Mapa de asociación socket → sala.
 * @details Permite localizar rápidamente en qué sala está cada socket sin recorrer todas las salas.
 */
const socketRoom = new Map();

/** @brief Instancia del Worker mediasoup. Se inicializa de forma asíncrona al arrancar. */
let worker;

/**
 * @brief Inicialización asíncrona del Worker mediasoup.
 * @details El Worker es un proceso nativo en C++ que gestiona el plano de datos WebRTC.
 *          Se configura con el rango de puertos UDP/TCP reservado para el tráfico RTP.
 */
(async () => {
  worker = await mediasoup.createWorker({ rtcMinPort: 40000, rtcMaxPort: 49999 });
  worker.on('died', () => { console.error('worker died'); process.exit(1); });
  console.log('✅ mediasoup worker creado');
})();

// ═══════════════════════════════════════════════════════════════
// FUNCIONES AUXILIARES
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Obtiene una sala existente o crea una nueva.
 * @param {string} roomId - Identificador único de la sala.
 * @param {string} [pin=''] - PIN de protección opcional.
 * @returns {Promise<Object>} Objeto de sala con router, pin y peers.
 */
async function getOrCreateRoom(roomId, pin = '') {
  if (rooms.has(roomId)) return rooms.get(roomId);
  const router = await worker.createRouter({ mediaCodecs });
  const room = { router, pin, peers: new Map() };
  rooms.set(roomId, room);
  console.log(`✅ room creada: ${roomId}${pin ? ' (con PIN)' : ''}`);
  return room;
}

/**
 * @brief Genera la lista de salas activas para enviar a los clientes.
 * @returns {Array<Object>} Array con id, hasPin, participants y names de cada sala.
 */
function getRoomList() {
  return [...rooms.entries()].map(([id, room]) => ({
    id,
    hasPin: !!room.pin,
    participants: room.peers.size,
    names: [...room.peers.values()].map(p => p.displayName)
  }));
}

/**
 * @brief Emite la lista actualizada de salas a todos los clientes conectados.
 */
function broadcastRoomList() { io.emit('roomList', getRoomList()); }

/**
 * @brief Emite la lista actualizada de peers de una sala a todos sus participantes.
 * @param {string} roomId - Identificador de la sala.
 */
function broadcastPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peers = [...room.peers.entries()].map(([sid, p]) => ({
    socketId: sid, displayName: p.displayName,
    producers: [...p.producers.keys()]
  }));
  io.to(roomId).emit('peers', peers);
}

/**
 * @brief Elimina a un participante de una sala y libera todos sus recursos mediasoup.
 * @details Cierra consumers, producers y transports del peer. Si la sala queda vacía,
 *          cierra también el Router y elimina la sala del mapa.
 * @param {Socket} socket - Socket del participante que abandona.
 * @param {string} roomId - Identificador de la sala.
 * @returns {Promise<void>}
 */
async function leaveRoom(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = room.peers.get(socket.id);
  const displayName = peer?.displayName;
  if (peer) {
    for (const c of peer.consumers.values())  c.close();
    for (const p of peer.producers.values())  p.close();
    for (const t of peer.transports.values()) t.close();
    room.peers.delete(socket.id);
  }
  socket.leave(roomId);
  socketRoom.delete(socket.id);
  socket.to(roomId).emit('peerLeft', { socketId: socket.id, displayName });
  if (room.peers.size === 0) { room.router.close(); rooms.delete(roomId); console.log(`🗑️ room eliminada: ${roomId}`); }
  else broadcastPeers(roomId);
  broadcastRoomList();
}

// ═══════════════════════════════════════════════════════════════
// MANEJO DE CONEXIONES SOCKET.IO
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Manejador principal de conexiones Socket.IO.
 * @details Registra todos los eventos de señalización WebRTC y de aplicación
 *          para cada socket cliente conectado.
 */
io.on('connection', socket => {
  console.log('conectado:', socket.id);
  socket.emit('roomList', getRoomList());

  /**
   * @brief Evento: unirse a una sala.
   * @details Valida el PIN si la sala ya existe, registra al peer, crea el Router
   *          si es necesario y devuelve las rtpCapabilities y producers existentes.
   * @param {Object} data - { roomId, displayName, pin }
   * @param {Function} callback - Devuelve { rtpCapabilities, hasPin, existingProducers } o { error }.
   */
  socket.on('joinRoom', async ({ roomId, displayName, pin }, callback) => {
    if (rooms.has(roomId)) {
      const existing = rooms.get(roomId);
      if (existing.pin && existing.pin !== pin) {
        return callback({ error: 'PIN incorrecto' });
      }
    }

    const room = await getOrCreateRoom(roomId, pin);
    const prevRoom = socketRoom.get(socket.id);
    if (prevRoom) await leaveRoom(socket, prevRoom);

    socket.join(roomId);
    socketRoom.set(socket.id, roomId);
    room.peers.set(socket.id, {
      displayName, transports: new Map(), producers: new Map(), consumers: new Map()
    });

    console.log(`👤 ${displayName} entró a ${roomId}`);
    socket.to(roomId).emit('peerJoined', { socketId: socket.id, displayName });
    broadcastPeers(roomId);
    broadcastRoomList();

    const existingProducers = [];
    for (const [sid, peer] of room.peers) {
      if (sid === socket.id) continue;
      for (const [producerId] of peer.producers) {
        existingProducers.push({ producerId, socketId: sid, displayName: peer.displayName });
      }
    }

    callback({ rtpCapabilities: room.router.rtpCapabilities, hasPin: !!room.pin, existingProducers });
  });

  /**
   * @brief Evento: obtener lista de producers activos en la sala.
   * @details Utilizado por nuevos peers para suscribirse a los flujos existentes.
   * @param {Function} callback - Devuelve array de { producerId, socketId, displayName }.
   */
  socket.on('getProducers', (callback) => {
    if (typeof callback !== 'function') return;
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return callback([]);
    const list = [];
    for (const [sid, peer] of room.peers) {
      if (sid === socket.id) continue;
      for (const [producerId] of peer.producers) {
        list.push({ producerId, socketId: sid, displayName: peer.displayName });
      }
    }
    callback(list);
  });

  /**
   * @brief Evento: crear un WebRtcTransport en el servidor.
   * @details Crea un transporte ICE/DTLS anunciado en ambas IPs de red
   *          (host-only y bridged) para soportar clientes en distintas redes.
   * @param {Object} data - { direction: 'send' | 'recv' }
   * @param {Function} callback - Devuelve parámetros ICE/DTLS del transporte creado.
   */
  socket.on('createTransport', async ({ direction }, callback) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;
    const transport = await room.router.createWebRtcTransport({
      listenIps: [
        { ip: '0.0.0.0', announcedIp: '192.168.56.10' },
        { ip: '0.0.0.0', announcedIp: '192.168.1.125' }
      ],
      enableUdp: true, enableTcp: true, preferUdp: true
    });
    const peer = room.peers.get(socket.id);
    peer.transports.set(transport.id, transport);
    transport.on('dtlsstatechange', state => { if (state === 'closed') peer.transports.delete(transport.id); });
    callback({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
  });

  /**
   * @brief Evento: conectar un WebRtcTransport (completar negociación DTLS).
   * @param {Object} data - { transportId, dtlsParameters }
   * @param {Function} callback - Confirmación sin argumentos.
   */
  socket.on('connectTransport', async ({ transportId, dtlsParameters }, callback) => {
    const peer = rooms.get(socketRoom.get(socket.id))?.peers.get(socket.id);
    await peer?.transports.get(transportId)?.connect({ dtlsParameters });
    callback();
  });

  /**
   * @brief Evento: crear un Producer (publicar flujo de audio o video).
   * @details Notifica a los demás peers de la sala mediante el evento newProducer.
   * @param {Object} data - { transportId, kind, rtpParameters, appData }
   * @param {Function} callback - Devuelve { id } del producer creado.
   */
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, callback) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return;
    const peer = room.peers.get(socket.id);
    const transport = peer.transports.get(transportId);
    const producer = await transport.produce({ kind, rtpParameters, appData });
    peer.producers.set(producer.id, producer);
    producer.on('transportclose', () => peer.producers.delete(producer.id));
    socket.to(roomId).emit('newProducer', { producerId: producer.id, socketId: socket.id, displayName: peer.displayName, kind });
    broadcastPeers(roomId);
    callback({ id: producer.id });
  });

  /**
   * @brief Evento: cerrar un Producer (silenciar mic o apagar cámara).
   * @details Notifica a los demás peers con el evento producerClosed.
   * @param {Object} data - { producerId }
   * @param {Function} [callback] - Confirmación opcional.
   */
  socket.on('closeProducer', ({ producerId }, callback) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    const peer = room?.peers.get(socket.id);
    const producer = peer?.producers.get(producerId);
    if (producer) {
      producer.close(); peer.producers.delete(producerId);
      socket.to(roomId).emit('producerClosed', { producerId, socketId: socket.id });
      broadcastPeers(roomId);
    }
    callback?.();
  });

  /**
   * @brief Evento: crear un Consumer (suscribirse a un flujo remoto).
   * @details Verifica que el Router pueda consumir el producer con las capacidades
   *          RTP del cliente. El consumer se crea en estado pausado.
   * @param {Object} data - { transportId, producerId, rtpCapabilities }
   * @param {Function} callback - Devuelve parámetros del consumer o { error }.
   */
  socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (!room) return callback({ error: 'no room' });
    if (!room.router.canConsume({ producerId, rtpCapabilities })) return callback({ error: 'cannot consume' });
    const peer = room.peers.get(socket.id);
    const transport = peer.transports.get(transportId);
    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    peer.consumers.set(consumer.id, consumer);
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    consumer.on('producerclose', () => { peer.consumers.delete(consumer.id); socket.emit('consumerClosed', { consumerId: consumer.id }); });
    callback({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
  });

  /**
   * @brief Evento: reanudar un Consumer pausado para iniciar la recepción del flujo.
   * @param {Object} data - { consumerId }
   * @param {Function} [callback] - Confirmación opcional.
   */
  socket.on('resumeConsumer', async ({ consumerId }, callback) => {
    const peer = rooms.get(socketRoom.get(socket.id))?.peers.get(socket.id);
    await peer?.consumers.get(consumerId)?.resume();
    callback?.();
  });

  /**
   * @brief Evento: enviar un mensaje de chat a toda la sala.
   * @param {Object} data - { text }
   */
  socket.on('chatMessage', ({ text }) => {
    const roomId = socketRoom.get(socket.id);
    const peer = rooms.get(roomId)?.peers.get(socket.id);
    if (!peer) return;
    io.to(roomId).emit('chatMessage', { from: peer.displayName, text, time: new Date().toISOString() });
  });

  /**
   * @brief Evento: notificar a la sala que el peer levantó la mano.
   * @details Emite handRaised con socketId y displayName a todos en la sala.
   */
  socket.on('raiseHand', () => {
    const roomId = socketRoom.get(socket.id);
    const peer = rooms.get(roomId)?.peers.get(socket.id);
    if (!peer) return;
    io.to(roomId).emit('handRaised', { socketId: socket.id, displayName: peer.displayName });
  });

  /**
   * @brief Evento: notificar a la sala que el peer bajó la mano.
   */
  socket.on('lowerHand', () => {
    const roomId = socketRoom.get(socket.id);
    io.to(roomId).emit('handLowered', { socketId: socket.id });
  });

  /**
   * @brief Evento: retransmitir una reacción emoji a los demás peers de la sala.
   * @param {Object} data - { emoji }
   */
  socket.on('sendReaction', ({ emoji }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('reaction', { socketId: socket.id, emoji });
  });

  /**
   * @brief Evento: retransmitir el estado de voz activa del peer a los demás.
   * @details Basado en análisis de volumen con Web Audio API en el cliente.
   * @param {Object} data - { speaking: boolean }
   */
  socket.on('speaking', ({ speaking }) => {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    socket.to(roomId).emit('peerSpeaking', { socketId: socket.id, speaking });
  });

  /**
   * @brief Evento: crear una encuesta en la sala.
   * @details Asigna un ID basado en timestamp, inicializa votos en 0 y emite
   *          pollCreated a todos los participantes.
   * @param {Object} data - { question: string, options: string[] }
   */
  socket.on('createPoll', ({ question, options }) => {
    const roomId = socketRoom.get(socket.id);
    const peer = rooms.get(roomId)?.peers.get(socket.id);
    if (!peer) return;
    const poll = {
      id: Date.now().toString(),
      question,
      options: options.map((text, i) => ({ id: i, text, votes: 0 })),
      voters: {},
      createdBy: peer.displayName
    };
    const room = rooms.get(roomId);
    if (!room.polls) room.polls = new Map();
    room.polls.set(poll.id, poll);
    io.to(roomId).emit('pollCreated', poll);
    console.log(`📊 encuesta creada en ${roomId}: ${question}`);
  });

  /**
   * @brief Evento: registrar un voto en una encuesta.
   * @details Permite cambiar el voto: elimina el voto anterior si existe
   *          y registra el nuevo. Emite pollUpdated a toda la sala.
   * @param {Object} data - { pollId: string, optionId: number }
   */
  socket.on('votePoll', ({ pollId, optionId }) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    const poll = room?.polls?.get(pollId);
    if (!poll) return;
    const prev = poll.voters[socket.id];
    if (prev !== undefined) poll.options[prev].votes--;
    poll.voters[socket.id] = optionId;
    poll.options[optionId].votes++;
    io.to(roomId).emit('pollUpdated', poll);
  });

  /**
   * @brief Evento: cerrar y eliminar una encuesta.
   * @details Solo el creador debería invocar este evento (validado en el cliente).
   *          Emite pollClosed a toda la sala para que eliminen la UI.
   * @param {Object} data - { pollId: string }
   */
  socket.on('closePoll', ({ pollId }) => {
    const roomId = socketRoom.get(socket.id);
    const room = rooms.get(roomId);
    if (room?.polls) room.polls.delete(pollId);
    io.to(roomId).emit('pollClosed', { pollId });
  });

  /**
   * @brief Evento: analizar un archivo con la API de Google Gemini.
   * @details El archivo llega como base64. Se construye una petición a la API REST
   *          de Gemini (v1beta) con el archivo y un prompt en español. La respuesta
   *          se emite como aiAnalysisResult a toda la sala para que aparezca en el chat.
   * @param {Object} data - { base64: string, mimeType: string, fileName: string }
   * @param {Function} [callback] - Devuelve { ok: true } o { error: string }.
   */
  socket.on('analyzeFile', async ({ base64, mimeType, fileName }, callback = () => {}) => {
    const roomId = socketRoom.get(socket.id);
    const peer = rooms.get(roomId)?.peers.get(socket.id);
    if (!peer) return;

    try {
      io.to(roomId).emit('aiAnalysisStart', { fileName, from: peer.displayName });
      const apiKey = process.env.GEMINI_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${apiKey}`;
      const prompt = `Eres un asistente en una videollamada grupal. Alguien compartió "${fileName}". 
Analízalo brevemente. Máximo 2 párrafos cortos en español. Solo lo más importante.`;
      const body = {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64 } }
          ]
        }]
      };

      const geminiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const geminiJson = await geminiRes.json();

      if (!geminiRes.ok) {
        throw new Error(geminiJson.error?.message || 'Gemini error');
      }

      const explanation = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta';

      io.to(roomId).emit('aiAnalysisResult', {
        from: peer.displayName,
        fileName,
        explanation
      });

      callback({ ok: true });
    } catch (e) {
      console.error('Gemini error:', e.message);
      callback({ error: 'Error al analizar el archivo' });
    }
  });

  /**
   * @brief Evento: abandonar la sala voluntariamente.
   * @param {Function} [callback] - Confirmación opcional.
   */
  socket.on('leaveRoom', async (callback) => {
    const roomId = socketRoom.get(socket.id);
    if (roomId) await leaveRoom(socket, roomId);
    callback?.();
  });

  /**
   * @brief Evento: desconexión del socket (cierre de pestaña o pérdida de conexión).
   * @details Equivalente a leaveRoom pero disparado automáticamente por Socket.IO.
   */
  socket.on('disconnect', async () => {
    const roomId = socketRoom.get(socket.id);
    if (roomId) await leaveRoom(socket, roomId);
    console.log('desconectado:', socket.id);
  });
});

/**
 * @brief Inicia el servidor HTTPS en el puerto 3000.
 */
httpServer.listen(3000, () => console.log('🚀 servidor en puerto 3000'));
/**
 * @file app.js
 * @brief Lógica del cliente WebRTC de MeetSpace — mediasoup-client, Socket.IO y controles de interfaz.
 *
 * @details
 * Este módulo implementa toda la lógica del lado del cliente:
 * - Conexión Socket.IO con el servidor de señalización (plano de control).
 * - Inicialización del Device mediasoup-client y negociación de capacidades RTP.
 * - Creación y conexión de WebRtcTransports de envío (send) y recepción (recv).
 * - Publicación de flujos locales de audio, video y pantalla (Producers).
 * - Suscripción a flujos remotos (Consumers) con lógica de reintento.
 * - Detección de voz activa mediante Web Audio API.
 * - Gestión de tiles de video en la cuadrícula.
 * - Chat, reacciones, mano levantada, encuestas y análisis de archivos con IA.
 *
 * @requires mediasoup-client
 * @requires socket.io-client
 */

import * as mediasoupClient from 'mediasoup-client';
import { io } from 'socket.io-client';

// ═══════════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * @brief URL del servidor de señalización.
 * @details Se construye dinámicamente usando el hostname actual para soportar
 *          acceso tanto desde la red host-only como desde la red bridged.
 */
const SERVER_URL = `https://${window.location.hostname}:3000`;

// ═══════════════════════════════════════════════════════════════
// ESTADO GLOBAL
// ═══════════════════════════════════════════════════════════════

/** @brief Socket Socket.IO activo. Se inicializa en initSocket(). */
let socket;

/** @brief Device mediasoup-client. Representa las capacidades RTP del navegador. */
let device;

/** @brief Transport WebRTC de envío (cámara, micrófono, pantalla → servidor). */
let sendTransport;

/** @brief Transport WebRTC de recepción (servidor → flujos remotos). */
let recvTransport;

/** @brief Producer del micrófono local. Null si el micrófono está desactivado. */
let audioProducer    = null;

/** @brief Producer de la cámara local. Null si la cámara está desactivada. */
let videoProducer    = null;

/** @brief Producer de la compartición de pantalla. Null si no hay pantalla compartida. */
let screenProducer   = null;

/** @brief Nombre del usuario actual. */
let myName           = '';

/** @brief ID de la sala actual. */
let myRoomId         = '';

/** @brief Estado del indicador de mano levantada. */
let handRaised       = false;

/** @brief ID del intervalo de detección de voz activa. Null si está inactivo. */
let speakDetector    = null;

/**
 * @brief Mapa de consumers activos.
 * @details Clave: producerId. Valor: { consumer, kind, socketId, displayName }.
 */
const consumers = new Map();

// ═══════════════════════════════════════════════════════════════
// REFERENCIAS DOM
// ═══════════════════════════════════════════════════════════════

/** @brief Contenedor de la pantalla de lobby. */
const lobbyEl         = document.getElementById('lobby');
/** @brief Contenedor de la sala de videoconferencia. */
const roomEl          = document.getElementById('room');
/** @brief Input del nombre del usuario. */
const nameInput       = document.getElementById('nameInput');
/** @brief Input del nombre de la sala a crear. */
const roomInput       = document.getElementById('roomInput');
/** @brief Input del PIN opcional al crear una sala. */
const roomPinInput    = document.getElementById('roomPin');
/** @brief Botón para crear una nueva sala. */
const createBtn       = document.getElementById('createBtn');
/** @brief Contenedor de la lista de salas disponibles. */
const roomListEl      = document.getElementById('roomList');
/** @brief Elemento para mostrar errores en el lobby. */
const lobbyError      = document.getElementById('lobbyError');
/** @brief Modal de solicitud de PIN para salas protegidas. */
const pinModal        = document.getElementById('pinModal');
/** @brief Input del PIN en el modal de acceso. */
const pinInput        = document.getElementById('pinInput');
/** @brief Botón de confirmación del PIN. */
const pinConfirmBtn   = document.getElementById('pinConfirmBtn');
/** @brief Botón de cancelación del modal de PIN. */
const pinCancelBtn    = document.getElementById('pinCancelBtn');
/** @brief Elemento para mostrar errores de PIN. */
const pinError        = document.getElementById('pinError');
/** @brief Etiqueta con el nombre de la sala actual. */
const roomLabel       = document.getElementById('roomLabel');
/** @brief Badge de candado para salas con PIN. */
const roomPinBadge    = document.getElementById('roomPinBadge');
/** @brief Cuadrícula de tiles de video. */
const videoGrid       = document.getElementById('videoGrid');
/** @brief Lista de participantes en el sidebar. */
const participantList = document.getElementById('participantList');
/** @brief Contenedor de mensajes del chat. */
const chatMessages    = document.getElementById('chatMessages');
/** @brief Input del mensaje de chat. */
const chatInput       = document.getElementById('chatInput');
/** @brief Botón de envío de mensaje. */
const sendBtn         = document.getElementById('sendBtn');
/** @brief Contenedor de notificaciones toast. */
const toastContainer  = document.getElementById('toastContainer');
/** @brief Botón de activar/desactivar micrófono. */
const micBtn          = document.getElementById('micBtn');
/** @brief Botón de activar/desactivar cámara. */
const camBtn          = document.getElementById('camBtn');
/** @brief Botón de compartir/detener pantalla. */
const screenBtn       = document.getElementById('screenBtn');
/** @brief Botón de levantar/bajar la mano. */
const handBtn         = document.getElementById('handBtn');
/** @brief Botón de salir de la sala. */
const leaveBtn        = document.getElementById('leaveBtn');
/** @brief Botón para abrir el modal de nueva encuesta. */
const newPollBtn      = document.getElementById('newPollBtn');
/** @brief Modal de creación de encuesta. */
const pollModal       = document.getElementById('pollModal');
/** @brief Input de la pregunta de la encuesta. */
const pollQuestion    = document.getElementById('pollQuestion');
/** @brief Contenedor de inputs de opciones de la encuesta. */
const pollOptions     = document.getElementById('pollOptions');
/** @brief Botón para agregar una opción a la encuesta. */
const addOptionBtn    = document.getElementById('addOptionBtn');
/** @brief Botón de cancelar en el modal de encuesta. */
const pollCancelBtn   = document.getElementById('pollCancelBtn');
/** @brief Botón de lanzar la encuesta. */
const pollSendBtn     = document.getElementById('pollSendBtn');
/** @brief Elemento para mostrar errores en el modal de encuesta. */
const pollError       = document.getElementById('pollError');
/** @brief Contenedor de tarjetas de encuestas activas. */
const pollContainer   = document.getElementById('pollContainer');
/** @brief Input de archivo oculto para selección de imagen/PDF. */
const fileInput       = document.getElementById('fileInput');
/** @brief Botón visible que dispara el input de archivo. */
const uploadBtn       = document.getElementById('uploadBtn');

// ═══════════════════════════════════════════════════════════════
// PARÁMETRO DE URL — SALA EN LINK
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Lee el parámetro ?sala= de la URL y lo prellena en el input de sala.
 * @details Permite compartir un link directo a una sala específica.
 */
const urlParams = new URLSearchParams(window.location.search);
const roomFromUrl = urlParams.get('sala');
if (roomFromUrl) roomInput.value = decodeURIComponent(roomFromUrl);

// ═══════════════════════════════════════════════════════════════
// SOCKET
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Inicializa el socket Socket.IO y registra todos los listeners de eventos.
 * @details Solo crea la conexión una vez. Los eventos cubren el ciclo completo:
 *          lista de salas, peers, producers/consumers, chat, mano, reacciones,
 *          encuestas y análisis con IA.
 */
function initSocket() {
  if (socket) return;
  socket = io(SERVER_URL);
  socket.on('roomList',       renderRoomList);
  socket.on('peerJoined',     onPeerJoined);
  socket.on('peerLeft',       onPeerLeft);
  socket.on('peers',          onPeers);
  socket.on('newProducer',    onNewProducer);
  socket.on('producerClosed', onProducerClosed);
  socket.on('consumerClosed', onConsumerClosed);
  socket.on('chatMessage',    onChatMessage);
  socket.on('handRaised',     onHandRaised);
  socket.on('handLowered',    onHandLowered);
  socket.on('reaction',       onReaction);
  socket.on('peerSpeaking',   ({ socketId, speaking }) => {
    document.getElementById(`tile-${socketId}`)?.classList.toggle('speaking', speaking);
  });
  socket.on('pollCreated',      onPollCreated);
  socket.on('pollUpdated',      onPollUpdated);
  socket.on('pollClosed',       ({ pollId }) => document.getElementById(`poll-${pollId}`)?.remove());
  socket.on('aiAnalysisStart',  ({ fileName, from }) => {
    appendAiMessage(`🤖 <b>${escHtml(from)}</b> compartió <b>${escHtml(fileName)}</b> — analizando...`, null, true);
  });
  socket.on('aiAnalysisResult', ({ from, fileName, explanation }) => {
    const pending = document.querySelector('.ai-pending');
    if (pending) pending.remove();
    appendAiMessage(`🤖 <b>${escHtml(from)}</b> compartió <b>${escHtml(fileName)}</b>`, explanation);
  });
}

/**
 * @brief Emite un evento Socket.IO de forma segura verificando que el socket exista.
 * @param {string} event - Nombre del evento.
 * @param {*} data - Datos a enviar.
 */
function safeEmit(event, data) {
  if (socket) socket.emit(event, data);
}

// ═══════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Renderiza la lista de salas disponibles en el lobby.
 * @details Muestra un mensaje vacío si no hay salas. Para salas con PIN
 *          muestra el candado y abre el modal de PIN al hacer clic.
 * @param {Array<Object>} rooms - Array con { id, hasPin, participants, names }.
 */
function renderRoomList(rooms) {
  if (rooms.length === 0) {
    roomListEl.innerHTML = '<div class="room-empty">No hay salas activas. ¡Crea una!</div>';
    return;
  }
  roomListEl.innerHTML = '';
  for (const r of rooms) {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.innerHTML = `
      <div class="room-info">
        <div class="room-title">${escHtml(r.id)} ${r.hasPin ? '🔒' : ''}</div>
        <div class="room-count">${r.participants} participante${r.participants !== 1 ? 's' : ''} · ${escHtml(r.names.join(', ') || '—')}</div>
      </div>
      <button class="room-join-btn">Unirse</button>
    `;
    item.querySelector('.room-join-btn').onclick = () => {
      if (r.hasPin) showPinModal(r.id);
      else joinRoom(r.id, '');
    };
    roomListEl.appendChild(item);
  }
}

/**
 * @brief Handler del botón Crear sala.
 * @details Valida nombre y nombre de sala antes de llamar a joinRoom.
 */
createBtn.onclick = () => {
  const name   = nameInput.value.trim();
  const roomId = roomInput.value.trim();
  const pin    = roomPinInput.value.trim();
  if (!name)   { showError('Escribe tu nombre primero'); return; }
  if (!roomId) { showError('Escribe un nombre para la sala'); return; }
  joinRoom(roomId, pin);
};

/** @brief ID de la sala pendiente de verificación de PIN. */
let pendingRoomId = '';

/**
 * @brief Muestra el modal de solicitud de PIN para una sala protegida.
 * @param {string} roomId - ID de la sala que requiere PIN.
 */
function showPinModal(roomId) {
  pendingRoomId = roomId;
  pinInput.value = '';
  pinError.textContent = '';
  pinModal.classList.remove('hidden');
  pinInput.focus();
}

/** @brief Handler de cancelación del modal de PIN. */
pinCancelBtn.onclick = () => pinModal.classList.add('hidden');

/** @brief Handler de confirmación del PIN. Llama a joinRoom con el PIN ingresado. */
pinConfirmBtn.onclick = () => {
  const pin = pinInput.value.trim();
  if (!pin) { pinError.textContent = 'Ingresa el PIN'; return; }
  pinModal.classList.add('hidden');
  joinRoom(pendingRoomId, pin);
};

/** @brief Permite confirmar el PIN presionando Enter en el input. */
pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') pinConfirmBtn.click(); });

/**
 * @brief Muestra un mensaje de error temporal en el lobby.
 * @param {string} msg - Mensaje a mostrar.
 */
function showError(msg) {
  lobbyError.textContent = msg;
  setTimeout(() => { lobbyError.textContent = ''; }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// JOIN ROOM
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Inicia el proceso de unirse a una sala: señalización y configuración WebRTC.
 * @details Flujo completo:
 *  1. Emite joinRoom al servidor y recibe rtpCapabilities + existingProducers.
 *  2. Carga el Device mediasoup-client con las capacidades del Router.
 *  3. Crea los transports de envío y recepción.
 *  4. Cambia la UI al modo sala.
 *  5. Inicia los medios locales (cámara y micrófono).
 *  6. Consume los producers existentes con lógica de reintento.
 * @param {string} roomId - ID de la sala.
 * @param {string} pin - PIN de la sala (vacío si no tiene PIN).
 * @returns {Promise<void>}
 */
async function joinRoom(roomId, pin) {
  const name = nameInput.value.trim();
  if (!name) { showError('Escribe tu nombre primero'); return; }

  initSocket();
  myName   = name;
  myRoomId = roomId;

  const result = await emitAsync('joinRoom', { roomId, displayName: name, pin });

  if (result?.error) {
    showError(result.error);
    pinModal.classList.add('hidden');
    return;
  }

  const { rtpCapabilities, hasPin, existingProducers } = result;

  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities: rtpCapabilities });

  await createSendTransport();
  await createRecvTransport();

  const url = new URL(window.location);
  url.searchParams.set('sala', roomId);
  window.history.replaceState({}, '', url);

  lobbyEl.classList.add('hidden');
  roomEl.classList.remove('hidden');
  roomLabel.textContent = roomId;
  if (hasPin) roomPinBadge.classList.remove('hidden');
  else roomPinBadge.classList.add('hidden');

  addLocalTile();
  addParticipantItem('local', myName, true);

  await startLocalMedia();

  if (existingProducers?.length) {
    await consumeWithRetry(existingProducers);
  }
}

// ═══════════════════════════════════════════════════════════════
// TRANSPORTS
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Crea el WebRtcTransport de envío y registra sus eventos.
 * @details El evento 'connect' completa la negociación DTLS con el servidor.
 *          El evento 'produce' notifica al servidor que se va a publicar un nuevo flujo.
 * @returns {Promise<void>}
 */
async function createSendTransport() {
  const data = await emitAsync('createTransport', { direction: 'send' });
  sendTransport = device.createSendTransport(data);

  sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try { await emitAsync('connectTransport', { transportId: sendTransport.id, dtlsParameters }); callback(); }
    catch (e) { errback(e); }
  });

  sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
    try {
      const { id } = await emitAsync('produce', { transportId: sendTransport.id, kind, rtpParameters, appData });
      callback({ id });
    } catch (e) { errback(e); }
  });
}

/**
 * @brief Crea el WebRtcTransport de recepción y registra su evento de conexión.
 * @details El evento 'connect' completa la negociación DTLS para el canal de entrada.
 * @returns {Promise<void>}
 */
async function createRecvTransport() {
  const data = await emitAsync('createTransport', { direction: 'recv' });
  recvTransport = device.createRecvTransport(data);

  recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    try { await emitAsync('connectTransport', { transportId: recvTransport.id, dtlsParameters }); callback(); }
    catch (e) { errback(e); }
  });
}

// ═══════════════════════════════════════════════════════════════
// MEDIOS LOCALES
// ═══════════════════════════════════════════════════════════════

/** @brief Stream local de cámara y micrófono. Null si no hay medios activos. */
let localStream = null;

/**
 * @brief Solicita acceso a cámara y micrófono y publica los flujos al servidor.
 * @details Intenta primero con video+audio; si falla por cámara, intenta solo audio.
 *          Inicia la detección de voz activa con el audio local.
 * @returns {Promise<void>}
 */
async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    try { localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true }); }
    catch { console.warn('Sin acceso a medios locales'); return; }
  }

  const localTile = document.getElementById('tile-local');
  if (localTile && localStream.getVideoTracks().length > 0) {
    const video = localTile.querySelector('video');
    if (video) { video.srcObject = localStream; video.muted = true; }
    localTile.querySelector('.tile-avatar')?.remove();
  }

  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioProducer = await sendTransport.produce({ track: audioTrack });
    startSpeakDetection(localStream);
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) videoProducer = await sendTransport.produce({ track: videoTrack });
}

// ═══════════════════════════════════════════════════════════════
// DETECCIÓN DE VOZ ACTIVA
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Inicia la detección de voz activa usando Web Audio API.
 * @details Analiza el nivel de volumen del stream de audio cada 150 ms.
 *          Si el volumen promedio supera el umbral de 12, considera que el usuario está hablando
 *          y notifica al servidor mediante el evento 'speaking'. También actualiza la clase CSS
 *          del tile local para mostrar el borde verde animado.
 * @param {MediaStream} stream - Stream de audio local a analizar.
 */
function startSpeakDetection(stream) {
  try {
    const ctx       = new AudioContext();
    const source    = ctx.createMediaStreamSource(stream);
    const analyser  = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    speakDetector = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const vol = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = vol > 12;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        const tile = document.getElementById('tile-local');
        tile?.classList.toggle('speaking', speaking);
        safeEmit('speaking', { speaking });
      }
    }, 150);
  } catch(e) { console.warn('speak detection error', e); }
}

// ═══════════════════════════════════════════════════════════════
// TILES DE VIDEO
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Agrega el tile de video del usuario local a la cuadrícula.
 * @details No hace nada si el tile ya existe (evita duplicados).
 */
function addLocalTile() {
  if (document.getElementById('tile-local')) return;
  videoGrid.appendChild(createTile('local', myName, true));
  updateGridClass();
}

/**
 * @brief Agrega el tile de video de un peer remoto a la cuadrícula.
 * @details No hace nada si el tile ya existe.
 * @param {string} socketId - ID del socket del peer remoto.
 * @param {string} displayName - Nombre del peer remoto.
 */
function addRemoteTile(socketId, displayName) {
  if (document.getElementById(`tile-${socketId}`)) return;
  videoGrid.appendChild(createTile(socketId, displayName, false));
  updateGridClass();
}

/**
 * @brief Elimina el tile de video de un peer de la cuadrícula.
 * @param {string} socketId - ID del socket del peer cuyo tile se elimina.
 */
function removeTile(socketId) {
  document.getElementById(`tile-${socketId}`)?.remove();
  updateGridClass();
}

/**
 * @brief Crea un elemento div de tile de video con avatar, video, etiqueta y overlays.
 * @param {string} id - ID único del tile (socket ID o 'local').
 * @param {string} name - Nombre del participante.
 * @param {boolean} isLocal - true si es el tile del usuario local.
 * @returns {HTMLDivElement} Elemento div del tile listo para insertar en el DOM.
 */
function createTile(id, name, isLocal) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = `tile-${id}`;
  tile.innerHTML = `
    <div class="tile-avatar">${name.charAt(0).toUpperCase()}</div>
    <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
    <div class="tile-label">${escHtml(name)}${isLocal ? ' (Tú)' : ''}</div>
    <div class="tile-muted" style="display:none">🔇</div>
    <div class="tile-hand" style="display:none">✋</div>
    <div class="tile-reactions"></div>
  `;
  return tile;
}

/**
 * @brief Actualiza la clase CSS de la cuadrícula según el número de tiles.
 * @details Las clases count-1 a count-9 definen el layout de columnas en CSS.
 */
function updateGridClass() {
  const count = videoGrid.children.length;
  videoGrid.className = `video-grid count-${Math.min(count, 9)}`;
}

/**
 * @brief Asocia un track de medios al tile de video de un peer remoto.
 * @details Crea el tile si no existe. Para tracks de video, elimina el avatar.
 *          Reutiliza el MediaStream existente del elemento video si ya tiene uno.
 * @param {string} socketId - ID del socket del peer remoto.
 * @param {string} displayName - Nombre del peer remoto.
 * @param {MediaStreamTrack} track - Track de audio o video a adjuntar.
 * @param {string} kind - 'audio' o 'video'.
 */
function attachTrackToTile(socketId, displayName, track, kind) {
  addRemoteTile(socketId, displayName);
  const tile  = document.getElementById(`tile-${socketId}`);
  const video = tile?.querySelector('video');
  if (!video) return;

  let stream = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
  stream.getTracks().filter(t => t.kind === kind).forEach(t => stream.removeTrack(t));
  stream.addTrack(track);
  video.srcObject = stream;
  if (kind === 'video') tile?.querySelector('.tile-avatar')?.remove();
}

// ═══════════════════════════════════════════════════════════════
// CONSUME
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Intenta consumir una lista de producers con reintentos.
 * @details Implementa una estrategia de reintento para manejar el caso en que el
 *          transport de recepción aún no ha completado la negociación ICE/DTLS
 *          cuando llegan los producers existentes al unirse a una sala.
 * @param {Array<Object>} producers - Lista de { producerId, socketId, displayName }.
 * @param {number} [attempts=8] - Número máximo de intentos.
 * @param {number} [delay=800] - Tiempo de espera en ms entre intentos.
 * @returns {Promise<void>}
 */
async function consumeWithRetry(producers, attempts = 8, delay = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      for (const p of producers) {
        if (!consumers.has(p.producerId)) {
          await consumeProducer(p.producerId, p.socketId, p.displayName);
        }
      }
      return;
    } catch (e) {
      console.warn(`consumeWithRetry intento ${i+1}/${attempts}:`, e.message);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * @brief Crea un Consumer para un producer remoto y adjunta su track al tile.
 * @details Emite 'consume' al servidor, crea el consumer local con recvTransport
 *          y luego emite 'resumeConsumer' para iniciar la recepción del flujo.
 * @param {string} producerId - ID del producer remoto a consumir.
 * @param {string} socketId - ID del socket del peer que publica el producer.
 * @param {string} displayName - Nombre del peer remoto.
 * @returns {Promise<void>}
 */
async function consumeProducer(producerId, socketId, displayName) {
  if (consumers.has(producerId)) return;

  const data = await emitAsync('consume', {
    transportId: recvTransport.id, producerId,
    rtpCapabilities: device.rtpCapabilities
  });
  if (data?.error) { console.error('consume error:', data.error); return; }

  const consumer = await recvTransport.consume({
    id: data.id, producerId: data.producerId,
    kind: data.kind, rtpParameters: data.rtpParameters
  });

  consumers.set(producerId, { consumer, kind: data.kind, socketId, displayName });
  attachTrackToTile(socketId, displayName, consumer.track, data.kind);
  await emitAsync('resumeConsumer', { consumerId: consumer.id });
}

// ═══════════════════════════════════════════════════════════════
// EVENTOS SOCKET
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Handler del evento peerJoined — un nuevo peer entró a la sala.
 * @param {Object} data - { socketId, displayName }
 */
function onPeerJoined({ socketId, displayName }) {
  addParticipantItem(socketId, displayName);
  showToast(`👋 ${displayName} se unió`);
}

/**
 * @brief Handler del evento peerLeft — un peer abandonó la sala.
 * @details Elimina su tile, su entrada en la lista de participantes y cierra
 *          todos sus consumers activos.
 * @param {Object} data - { socketId, displayName }
 */
function onPeerLeft({ socketId, displayName }) {
  removeTile(socketId);
  removeParticipantItem(socketId);
  if (displayName) showToast(`👋 ${displayName} salió`);
  for (const [pid, c] of consumers) {
    if (c.socketId === socketId) { c.consumer.close(); consumers.delete(pid); }
  }
}

/**
 * @brief Handler del evento peers — lista actualizada de peers en la sala.
 * @details Se recibe al entrar a una sala con participantes existentes.
 *          Solo actualiza la lista lateral; los tiles se crean al llegar los producers.
 * @param {Array<Object>} peers - Lista de { socketId, displayName, producers }.
 */
function onPeers(peers) {
  participantList.innerHTML = '';
  addParticipantItem('local', myName, true);
  for (const p of peers) addParticipantItem(p.socketId, p.displayName);
}

/**
 * @brief Handler del evento newProducer — un peer publicó un nuevo flujo de medios.
 * @details Ignora producers propios. Consume el nuevo producer y adjunta el track al tile.
 * @param {Object} data - { producerId, socketId, displayName, kind }
 * @returns {Promise<void>}
 */
async function onNewProducer({ producerId, socketId, displayName }) {
  if (socketId === socket.id) return;
  await consumeProducer(producerId, socketId, displayName);
}

/**
 * @brief Handler del evento producerClosed — un peer desactivó su cámara o micrófono.
 * @details Cierra el consumer correspondiente. Para video, restaura el avatar en el tile.
 *          Si el peer ya no tiene ningún consumer activo, elimina su tile.
 * @param {Object} data - { producerId, socketId }
 */
function onProducerClosed({ producerId, socketId }) {
  const entry = consumers.get(producerId);
  if (!entry) return;
  entry.consumer.close();
  consumers.delete(producerId);

  if (entry.kind === 'video') {
    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) {
      const video = tile.querySelector('video');
      if (video) video.srcObject = null;
      if (!tile.querySelector('.tile-avatar')) {
        const label = tile.querySelector('.tile-label')?.textContent || '?';
        const av = document.createElement('div');
        av.className = 'tile-avatar';
        av.textContent = label.charAt(0).toUpperCase();
        tile.prepend(av);
      }
    }
  }

  const stillHas = [...consumers.values()].some(c => c.socketId === socketId);
  if (!stillHas) removeTile(socketId);
}

/**
 * @brief Handler del evento consumerClosed — el servidor cerró un consumer.
 * @param {Object} data - { consumerId }
 */
function onConsumerClosed({ consumerId }) {
  for (const [pid, c] of consumers) {
    if (c.consumer.id === consumerId) { c.consumer.close(); consumers.delete(pid); break; }
  }
}

/**
 * @brief Handler del evento chatMessage — nuevo mensaje de chat recibido.
 * @details Diferencia visualmente los mensajes propios de los ajenos con la clase 'self'.
 * @param {Object} data - { from, text }
 */
function onChatMessage({ from, text }) {
  const isSelf = from === myName;
  const msg = document.createElement('div');
  msg.className = `chat-msg${isSelf ? ' self' : ''}`;
  msg.innerHTML = `<div class="msg-author">${escHtml(from)}</div><div class="msg-text">${escHtml(text)}</div>`;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * @brief Handler del evento handRaised — un peer levantó la mano.
 * @details Muestra el ícono de mano en el tile y en la lista de participantes.
 * @param {Object} data - { socketId, displayName }
 */
function onHandRaised({ socketId, displayName }) {
  const tile = document.getElementById(`tile-${socketId}`);
  tile?.querySelector('.tile-hand')?.removeAttribute('style');
  const item = document.getElementById(`peer-${socketId}`);
  if (item) item.querySelector('.peer-hand')?.classList.remove('hidden');
  showToast(`✋ ${displayName} levantó la mano`);
}

/**
 * @brief Handler del evento handLowered — un peer bajó la mano.
 * @param {Object} data - { socketId }
 */
function onHandLowered({ socketId }) {
  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) tile.querySelector('.tile-hand').style.display = 'none';
  const item = document.getElementById(`peer-${socketId}`);
  if (item) item.querySelector('.peer-hand')?.classList.add('hidden');
}

/**
 * @brief Handler del evento reaction — un peer envió una reacción emoji.
 * @details Crea un elemento span con la clase floating-reaction que flota animado
 *          sobre el tile del peer que envió la reacción.
 * @param {Object} data - { socketId, emoji }
 */
function onReaction({ socketId, emoji }) {
  const tileId = socketId === socket.id ? 'local' : socketId;
  const tile = document.getElementById(`tile-${tileId}`);
  if (!tile) return;
  const container = tile.querySelector('.tile-reactions');
  const el = document.createElement('span');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ═══════════════════════════════════════════════════════════════
// PARTICIPANTES
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Agrega una entrada de participante en la lista lateral del sidebar.
 * @details No hace nada si la entrada ya existe.
 * @param {string} socketId - ID del socket del participante (o 'local' para el usuario actual).
 * @param {string} name - Nombre del participante.
 * @param {boolean} [isSelf=false] - true si es el usuario local.
 */
function addParticipantItem(socketId, name, isSelf = false) {
  if (document.getElementById(`peer-${socketId}`)) return;
  const item = document.createElement('div');
  item.className = 'participant-item';
  item.id = `peer-${socketId}`;
  item.innerHTML = `
    <div class="participant-avatar">${name.charAt(0).toUpperCase()}</div>
    <div class="participant-name">${escHtml(name)}${isSelf ? ' (Tú)' : ''}</div>
    <span class="peer-hand hidden">✋</span>
  `;
  participantList.appendChild(item);
}

/**
 * @brief Elimina la entrada de un participante de la lista lateral.
 * @param {string} socketId - ID del socket del participante a eliminar.
 */
function removeParticipantItem(socketId) {
  document.getElementById(`peer-${socketId}`)?.remove();
}

// ═══════════════════════════════════════════════════════════════
// CONTROLES
// ═══════════════════════════════════════════════════════════════

/** @brief Estado actual del micrófono. true = activo, false = silenciado. */
let micOn = true;
/** @brief Estado actual de la cámara. true = activa, false = desactivada. */
let camOn = true;

/**
 * @brief Handler del botón de micrófono — alterna entre silenciado y activo.
 * @details Al silenciar: cierra el audioProducer en el servidor y deshabilita el track local.
 *          Al activar: solicita nuevo stream de audio y crea un nuevo audioProducer.
 */
micBtn.onclick = async () => {
  if (micOn) {
    if (audioProducer) { await emitAsync('closeProducer', { producerId: audioProducer.id }); audioProducer.close(); audioProducer = null; }
    localStream?.getAudioTracks().forEach(t => t.enabled = false);
    micBtn.classList.add('off');
    micBtn.querySelector('.ctrl-icon').textContent = '🔇';
    micOn = false;
  } else {
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = ns.getAudioTracks()[0];
      audioProducer = await sendTransport.produce({ track });
      startSpeakDetection(ns);
      micBtn.classList.remove('off');
      micBtn.querySelector('.ctrl-icon').textContent = '🎤';
      micOn = true;
    } catch(e) { console.error('mic error', e); }
  }
};

/**
 * @brief Handler del botón de cámara — alterna entre desactivada y activa.
 * @details Al desactivar: cierra el videoProducer, detiene el track y muestra el avatar.
 *          Al activar: solicita nuevo stream de video y crea un nuevo videoProducer.
 */
camBtn.onclick = async () => {
  if (camOn) {
    if (videoProducer) { await emitAsync('closeProducer', { producerId: videoProducer.id }); videoProducer.close(); videoProducer = null; }
    localStream?.getVideoTracks().forEach(t => t.stop());
    const tile = document.getElementById('tile-local');
    const vid = tile?.querySelector('video');
    if (vid) vid.srcObject = null;
    if (tile && !tile.querySelector('.tile-avatar')) {
      const av = document.createElement('div'); av.className = 'tile-avatar';
      av.textContent = myName.charAt(0).toUpperCase(); tile.prepend(av);
    }
    camBtn.classList.add('off'); camBtn.querySelector('.ctrl-icon').textContent = '📵'; camOn = false;
  } else {
    try {
      const ns = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = ns.getVideoTracks()[0];
      videoProducer = await sendTransport.produce({ track });
      const tile = document.getElementById('tile-local');
      if (tile) { tile.querySelector('.tile-avatar')?.remove(); tile.querySelector('video').srcObject = ns; }
      camBtn.classList.remove('off'); camBtn.querySelector('.ctrl-icon').textContent = '📷'; camOn = true;
    } catch(e) { console.error('cam error', e); }
  }
};

/** @brief Estado de compartición de pantalla. true = activa. */
let screenSharing = false;

/**
 * @brief Handler del botón de compartir pantalla — alterna entre compartiendo y detenido.
 * @details Al iniciar: reemplaza el videoProducer por un screenProducer con getDisplayMedia.
 *          Al detener: cierra el screenProducer y restaura la cámara si estaba activa.
 *          El evento track.onended detecta cuando el usuario detiene desde el navegador.
 */
screenBtn.onclick = async () => {
  if (!screenSharing) {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = screenStream.getVideoTracks()[0];

      if (videoProducer) {
        await emitAsync('closeProducer', { producerId: videoProducer.id });
        videoProducer.close(); videoProducer = null;
      }
      screenProducer = await sendTransport.produce({ track, appData: { screen: true } });

      const tile = document.getElementById('tile-local');
      if (tile) { tile.querySelector('.tile-avatar')?.remove(); tile.querySelector('video').srcObject = screenStream; }

      screenBtn.classList.add('off'); screenBtn.querySelector('.ctrl-icon').textContent = '🛑'; screenSharing = true;

      track.onended = () => screenBtn.click();
    } catch(e) { console.warn('screen share cancelled', e); }
  } else {
    if (screenProducer) { await emitAsync('closeProducer', { producerId: screenProducer.id }); screenProducer.close(); screenProducer = null; }
    screenBtn.classList.remove('off'); screenBtn.querySelector('.ctrl-icon').textContent = '🖥️'; screenSharing = false;

    if (camOn && localStream?.getVideoTracks().length > 0) {
      const track = localStream.getVideoTracks()[0];
      videoProducer = await sendTransport.produce({ track });
      const tile = document.getElementById('tile-local');
      if (tile) { tile.querySelector('.tile-avatar')?.remove(); tile.querySelector('video').srcObject = localStream; }
    }
  }
};

/**
 * @brief Handler del botón de levantar/bajar mano.
 * @details Alterna el estado handRaised y notifica al servidor. Actualiza el tile local.
 */
handBtn.onclick = () => {
  handRaised = !handRaised;
  safeEmit(handRaised ? 'raiseHand' : 'lowerHand');
  handBtn.classList.toggle('off', handRaised);
  handBtn.querySelector('.ctrl-icon').textContent = handRaised ? '🤚' : '✋';
  const tile = document.getElementById('tile-local');
  const handEl = tile?.querySelector('.tile-hand');
  if (handEl) handEl.style.display = handRaised ? 'flex' : 'none';
};

/**
 * @brief Registra handlers para todos los botones de reacción emoji.
 * @details Emite sendReaction al servidor para los demás peers y llama a onReaction
 *          localmente para mostrar la animación en el propio tile.
 */
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.onclick = () => {
    const emoji = btn.dataset.emoji;
    safeEmit('sendReaction', { emoji });
    onReaction({ socketId: socket.id, emoji });
  };
});

/**
 * @brief Handler del botón Salir — abandona la sala y libera todos los recursos.
 * @details Detiene el detector de voz, cierra todos los producers, consumers y transports,
 *          emite leaveRoom al servidor, limpia la UI y vuelve al lobby.
 */
leaveBtn.onclick = async () => {
  clearInterval(speakDetector); speakDetector = null;
  localStream?.getTracks().forEach(t => t.stop());
  if (audioProducer)  { audioProducer.close();  audioProducer  = null; }
  if (videoProducer)  { videoProducer.close();  videoProducer  = null; }
  if (screenProducer) { screenProducer.close(); screenProducer = null; }
  for (const c of consumers.values()) c.consumer.close();
  consumers.clear();
  sendTransport?.close(); sendTransport = null;
  recvTransport?.close(); recvTransport = null;
  localStream = null;

  safeEmit('leaveRoom');

  const url = new URL(window.location);
  url.searchParams.delete('sala');
  window.history.replaceState({}, '', url);

  videoGrid.innerHTML = '';
  participantList.innerHTML = '';
  chatMessages.innerHTML = '';
  roomEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  roomPinBadge.classList.add('hidden');

  micOn = true; camOn = true; handRaised = false; screenSharing = false;
  micBtn.classList.remove('off'); camBtn.classList.remove('off');
  screenBtn.classList.remove('off'); handBtn.classList.remove('off');
  micBtn.querySelector('.ctrl-icon').textContent    = '🎤';
  camBtn.querySelector('.ctrl-icon').textContent    = '📷';
  screenBtn.querySelector('.ctrl-icon').textContent = '🖥️';
  handBtn.querySelector('.ctrl-icon').textContent   = '✋';
  myName = ''; myRoomId = ''; device = null;
};

// ═══════════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Envía el mensaje escrito en el input de chat a la sala.
 * @details Limpia el input tras el envío. No envía mensajes vacíos.
 */
function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  safeEmit('chatMessage', { text });
  chatInput.value = '';
}

/** @brief Handler del botón de envío de chat. */
sendBtn.onclick = sendChatMessage;

/** @brief Permite enviar mensajes de chat presionando Enter. */
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(); });

// ═══════════════════════════════════════════════════════════════
// TOASTS
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Muestra una notificación toast temporal en la parte superior de la pantalla.
 * @details La notificación aparece con una animación de entrada, permanece 3 segundos
 *          y desaparece con una animación de salida.
 * @param {string} msg - Texto del mensaje toast.
 */
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// ENCUESTAS
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Handler del botón de nueva encuesta — abre el modal con 2 opciones iniciales.
 */
newPollBtn?.addEventListener('click', () => {
  pollQuestion.value = '';
  pollError.textContent = '';
  pollOptions.innerHTML = `
    <input type="text" class="poll-option-input" placeholder="Opción 1" maxlength="60">
    <input type="text" class="poll-option-input" placeholder="Opción 2" maxlength="60">
  `;
  pollModal.classList.remove('hidden');
  pollQuestion.focus();
});

/**
 * @brief Handler del botón agregar opción — añade un input de opción al modal (máx. 6).
 */
addOptionBtn?.addEventListener('click', () => {
  const inputs = pollOptions.querySelectorAll('.poll-option-input');
  if (inputs.length >= 6) { pollError.textContent = 'Máximo 6 opciones'; return; }
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'poll-option-input';
  input.placeholder = `Opción ${inputs.length + 1}`;
  input.maxLength = 60;
  pollOptions.appendChild(input);
  pollError.textContent = '';
});

/** @brief Handler del botón cancelar del modal de encuesta. */
pollCancelBtn?.addEventListener('click', () => pollModal.classList.add('hidden'));

/**
 * @brief Handler del botón lanzar encuesta — valida y emite createPoll al servidor.
 * @details Requiere al menos una pregunta y dos opciones no vacías.
 */
pollSendBtn?.addEventListener('click', () => {
  const question = pollQuestion.value.trim();
  const options  = [...pollOptions.querySelectorAll('.poll-option-input')]
    .map(i => i.value.trim()).filter(Boolean);
  if (!question) { pollError.textContent = 'Escribe una pregunta'; return; }
  if (options.length < 2) { pollError.textContent = 'Mínimo 2 opciones'; return; }
  safeEmit('createPoll', { question, options });
  pollModal.classList.add('hidden');
});

/**
 * @brief Handler del evento pollCreated — renderiza la nueva encuesta y muestra toast.
 * @param {Object} poll - Objeto encuesta con id, question, options, voters, createdBy.
 */
function onPollCreated(poll) {
  renderPoll(poll);
  showToast(`📊 Nueva encuesta: ${poll.question}`);
}

/**
 * @brief Handler del evento pollUpdated — actualiza la tarjeta de encuesta con los votos.
 * @param {Object} poll - Objeto encuesta actualizado.
 */
function onPollUpdated(poll) {
  const existing = document.getElementById(`poll-${poll.id}`);
  if (existing) existing.replaceWith(buildPollEl(poll));
}

/**
 * @brief Inserta una nueva tarjeta de encuesta en el contenedor de polls.
 * @param {Object} poll - Objeto encuesta.
 */
function renderPoll(poll) {
  pollContainer.appendChild(buildPollEl(poll));
}

/**
 * @brief Construye el elemento DOM de una tarjeta de encuesta.
 * @details Incluye la pregunta, barras de progreso con porcentajes y el botón
 *          de cierre (solo visible para el creador de la encuesta).
 * @param {Object} poll - Objeto encuesta con id, question, options, voters, createdBy.
 * @returns {HTMLDivElement} Elemento div de la tarjeta de encuesta.
 */
function buildPollEl(poll) {
  const total = poll.options.reduce((s, o) => s + o.votes, 0);
  const isCreator = poll.createdBy === myName;
  const div = document.createElement('div');
  div.className = 'poll-card';
  div.id = `poll-${poll.id}`;
  div.innerHTML = `
    <div class="poll-header">
      <div class="poll-question">${escHtml(poll.question)}</div>
      ${isCreator ? `<button class="poll-close-btn" data-poll="${poll.id}" title="Cerrar encuesta">✕</button>` : ''}
    </div>
    <div class="poll-options">
      ${poll.options.map(o => {
        const pct = total ? Math.round(o.votes / total * 100) : 0;
        return `
          <button class="poll-option" data-poll="${poll.id}" data-option="${o.id}">
            <span class="poll-opt-text">${escHtml(o.text)}</span>
            <span class="poll-opt-bar" style="width:${pct}%"></span>
            <span class="poll-opt-pct">${pct}%</span>
          </button>`;
      }).join('')}
    </div>
    <div class="poll-meta">${total} voto${total !== 1 ? 's' : ''} · por ${escHtml(poll.createdBy)}</div>
  `;
  div.querySelectorAll('.poll-option').forEach(btn => {
    btn.addEventListener('click', () => {
      safeEmit('votePoll', { pollId: btn.dataset.poll, optionId: parseInt(btn.dataset.option) });
    });
  });
  div.querySelector('.poll-close-btn')?.addEventListener('click', () => {
    safeEmit('closePoll', { pollId: poll.id });
  });
  return div;
}

// ═══════════════════════════════════════════════════════════════
// ANÁLISIS DE ARCHIVOS CON IA
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Handler del evento change del input de archivo.
 * @details Valida el tamaño (máx. 2 MB), convierte el archivo a base64 con FileReader
 *          y emite analyzeFile al servidor. El servidor procesa con Gemini y devuelve
 *          el resumen a toda la sala mediante aiAnalysisResult.
 */
fileInput?.addEventListener('change', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const file = fileInput.files[0];
  if (!file) return;

  const maxMB = 2;
  if (file.size > maxMB * 1024 * 1024) {
    showToast(`⚠️ Archivo muy grande (máx ${maxMB}MB)`);
    fileInput.value = '';
    return;
  }

  showToast('📤 Analizando con IA...');

  try {
    const base64 = await new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload  = () => res(reader.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });

    const mimeType = file.type || 'application/octet-stream';
    const fileName = file.name;
    safeEmit('analyzeFile', { base64, mimeType, fileName });
  } catch(err) {
    showToast('❌ Error al leer el archivo');
    console.error(err);
  } finally {
    fileInput.value = '';
  }
});

/**
 * @brief Handler del botón de subida de archivos — dispara el input de archivo programáticamente.
 * @details Usa un botón separado en lugar de un label para evitar comportamientos
 *          inesperados en navegadores móviles que pueden interrumpir la conexión WebSocket.
 */
uploadBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  fileInput?.click();
});

/**
 * @brief Agrega un mensaje de análisis de IA al panel de chat.
 * @param {string} header - HTML del encabezado del mensaje (nombre y archivo).
 * @param {string|null} body - Texto del resumen generado por Gemini, o null si está pendiente.
 * @param {boolean} [pending=false] - true si el análisis aún está en proceso.
 */
function appendAiMessage(header, body, pending = false) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ai-msg${pending ? ' ai-pending' : ''}`;
  msg.innerHTML = `
    <div class="msg-author">${header}</div>
    ${body ? `<div class="msg-text ai-text">${escHtml(body)}</div>` : '<div class="msg-text ai-text">⏳ Analizando...</div>'}
  `;
  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

/**
 * @brief Envuelve un emit de Socket.IO en una Promise para uso con async/await.
 * @details Rechaza la promesa si la respuesta contiene un campo error.
 * @param {string} event - Nombre del evento a emitir.
 * @param {*} data - Datos a enviar con el evento.
 * @returns {Promise<*>} Respuesta del servidor.
 */
function emitAsync(event, data) {
  return new Promise((resolve, reject) => {
    socket.emit(event, data, response => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

/**
 * @brief Escapa caracteres HTML especiales para prevenir XSS.
 * @param {string} str - Cadena de texto a escapar.
 * @returns {string} Cadena con &, <, >, " reemplazados por sus entidades HTML.
 */
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

initSocket();
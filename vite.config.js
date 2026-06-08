/**
 * @file vite.config.js
 * @brief Configuración del servidor de desarrollo Vite para MeetSpace.
 *
 * @details
 * Configura Vite para escuchar en todas las interfaces de red (0.0.0.0) en el
 * puerto 5173 con soporte HTTPS mediante certificados TLS autofirmados generados
 * con mkcert. Esto es necesario para que los navegadores permitan el acceso a las
 * APIs de cámara y micrófono (getUserMedia) desde IPs distintas a localhost,
 * requisito impuesto por el modelo de seguridad de contextos seguros de los navegadores.
 *
 * @note Los certificados cubren las IPs 192.168.56.10 (red host-only), 192.168.1.125
 *       (red bridged/pública), localhost y 127.0.0.1.
 *
 * @requires vite
 * @requires fs
 */

import { defineConfig } from 'vite';
import fs from 'fs';

/**
 * @brief Configuración exportada de Vite.
 * @property {Object} server - Opciones del servidor de desarrollo.
 * @property {string} server.host - Interfaz de escucha ('0.0.0.0' = todas las interfaces).
 * @property {number} server.port - Puerto del servidor de desarrollo Vite.
 * @property {Object} server.https - Certificados TLS para HTTPS.
 * @property {Buffer} server.https.key - Clave privada del certificado TLS.
 * @property {Buffer} server.https.cert - Certificado TLS público.
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    https: {
      key: fs.readFileSync('./192.168.56.10+3-key.pem'),
      cert: fs.readFileSync('./192.168.56.10+3.pem')
    }
  }
});
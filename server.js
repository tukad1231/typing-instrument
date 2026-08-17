// ---------------------------------------------------------------------------
// Zero-dependency LOCAL-ONLY development server for the Typing Instrument.
//
//   node server.js            ->  http://127.0.0.1:5173
//   node server.js --open     ->  ... and opens your browser
//
// It serves the APP, not the folder. Everything else in this directory -- the
// git metadata, editor settings, notes, package.json, this file itself -- is
// not reachable over HTTP, because a static server pointed at a working
// directory will happily hand out whatever happens to be sitting in it.
//
// The rules, in order of how a request is judged:
//
//   1. method must be GET or HEAD            else 405
//   2. Host must be exactly 127.0.0.1:PORT   else 421   (blocks DNS rebinding)
//   3. request-target must start with "/"    else 400   (rejects absolute-form)
//   4. percent-decoding must succeed, no NUL else 400
//   5. no "\", no ":", no "..", no leading ".", no trailing "." or " ",
//      no Windows reserved device name       else 403
//   6. must be on the ALLOWLIST              else 404
//   7. must resolve inside ROOT, lexically AND after realpath (so a symlink or
//      junction cannot lead out), and must be a regular file
// ---------------------------------------------------------------------------

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1'; // loopback only, never 0.0.0.0

// --- PORT -------------------------------------------------------------------
const RAW_PORT = process.env.PORT === undefined ? 5173 : process.env.PORT;
const PORT = Number(RAW_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('');
  console.error('  PORT must be a whole number between 1 and 65535. Got: ' + JSON.stringify(RAW_PORT));
  console.error('');
  process.exit(1);
}

const URL = 'http://' + HOST + ':' + PORT;
const EXPECTED_HOST = HOST + ':' + PORT;
const OPEN = process.argv.includes('--open');

function openBrowser() {
  if (!OPEN) return;
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [URL], { detached: true, stdio: 'ignore' }).unref();
}

// --- what the app is actually allowed to ask for ----------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const SRC_EXT = new Set(['.js', '.css']); // everything the app loads from src/

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

class Reject extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {string} target the raw request-target
 * @returns {string} a repo-relative path, guaranteed allowlisted and lexically safe
 */
function vetPath(target) {
  // absolute-form ("GET http://evil/x") and authority-form never start with "/"
  if (typeof target !== 'string' || !target.startsWith('/')) throw new Reject(400, 'bad request');

  const query = target.split('?')[0].split('#')[0];

  let decoded;
  try {
    decoded = decodeURIComponent(query);
  } catch (e) {
    throw new Reject(400, 'bad request'); // "/%", "/%zz", overlong sequences
  }
  if (decoded.indexOf('\0') !== -1) throw new Reject(400, 'bad request');

  // "\" is a separator on Windows; ":" opens drive-relative paths and NTFS
  // alternate data streams ("main.js::$DATA").
  if (decoded.indexOf('\\') !== -1 || decoded.indexOf(':') !== -1) throw new Reject(403, 'forbidden');

  const wanted = decoded === '/' ? '/index.html' : decoded;
  const segments = wanted.split('/').slice(1); // drop the leading ""

  for (const seg of segments) {
    if (seg === '' || seg === '.') throw new Reject(403, 'forbidden'); // "//", "/./"
    if (seg === '..') throw new Reject(403, 'forbidden');
    if (seg.startsWith('.')) throw new Reject(403, 'forbidden'); // .git, .claude, .env
    if (/[. ]$/.test(seg)) throw new Reject(403, 'forbidden'); // Windows strips these
    if (RESERVED.has(seg.split('.')[0].toUpperCase())) throw new Reject(403, 'forbidden');
  }

  // --- the allowlist ---
  const ext = path.extname(wanted).toLowerCase();
  const isIndex = wanted === '/index.html';
  const isSrc = wanted.startsWith('/src/') && segments.length > 1 && SRC_EXT.has(ext);
  if (!isIndex && !isSrc) throw new Reject(404, 'not found');

  return segments.join('/');
}

/** Lexical containment, then the real thing after following any links. */
async function resolveInsideRoot(rel, rootReal) {
  const file = path.resolve(ROOT, rel);
  const inside = path.relative(ROOT, file);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) throw new Reject(403, 'forbidden');

  let real;
  try {
    real = await fsp.realpath(file);
  } catch (e) {
    throw new Reject(404, 'not found');
  }
  const realInside = path.relative(rootReal, real);
  if (realInside === '' || realInside.startsWith('..') || path.isAbsolute(realInside)) {
    throw new Reject(403, 'forbidden'); // symlink or junction pointing out of ROOT
  }

  const st = await fsp.stat(real);
  if (!st.isFile()) throw new Reject(404, 'not found'); // directories are not served
  return real;
}

const ROOT_REAL = fs.realpathSync(ROOT);

const server = http.createServer(async (req, res) => {
  const head = (status, headers) =>
    res.writeHead(status, Object.assign({ 'x-content-type-options': 'nosniff' }, headers));

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      head(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('method not allowed');
      return;
    }

    // Only this exact origin. Anything else -- another name resolving to
    // 127.0.0.1, or "localhost" -- is refused, which is what stops a hostile
    // page from rebinding a domain to loopback and reading these files.
    if (req.headers.host !== EXPECTED_HOST) {
      head(421, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('misdirected request');
      return;
    }

    const rel = vetPath(req.url);
    const file = await resolveInsideRoot(rel, ROOT_REAL);
    const buf = await fsp.readFile(file);

    head(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      // no-store, not no-cache: during development a stale cached module is
      // indistinguishable from a broken app, and costs hours to diagnose.
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
      expires: '0',
    });
    if (req.method === 'HEAD') res.end();
    else res.end(buf);
  } catch (err) {
    const status = err instanceof Reject ? err.status : 500;
    const body = err instanceof Reject ? err.message : 'server error';
    if (!res.headersSent) head(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Something else holds this port. It may not be this app at all, so do NOT
    // open a browser at it -- just say so and stop.
    console.error('');
    console.error('  Port ' + PORT + ' is already in use.');
    console.error('  Stop whatever is using it, or start this with a different port:');
    console.error('    set PORT=5174 && node server.js        (Windows cmd)');
    console.error('    $env:PORT=5174; node server.js         (PowerShell)');
    console.error('');
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // ASCII only: the Windows console codepage mangles UTF-8 Japanese.
  console.log('');
  console.log('  TYPING INSTRUMENT  ->  ' + URL);
  console.log('  Open that exact address in Chrome.  (Ctrl+C to stop)');
  console.log('  Local only: binds ' + HOST + ', serves index.html and src/ only.');
  console.log('');
  openBrowser();
});

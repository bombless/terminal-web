/**
 * Kitty Graphics Protocol Handler for terminal-web
 * Converts Kitty Graphics Protocol APC sequences (\x1b_G...;\x1b\) into
 * iTerm2 inline image sequences (\x1b]1337;File=...:\x07) supported by @xterm/addon-image,
 * and replies to capability/query/transmission probes (\x1b_Gi=...;OK\x1b\).
 */

interface KittyImageRecord {
  payload: string;
  format: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

export function rawToPngBase64(
  rawBase64: string,
  width: number,
  height: number,
  format: number
): string {
  // If format is PNG (100) or dimensions are unknown, return as-is
  if (format === 100 || !width || !height) {
    return rawBase64;
  }

  try {
    const binary = atob(rawBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return rawBase64;

    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;

    if (format === 24) {
      let srcIdx = 0;
      let dstIdx = 0;
      const totalPixels = width * height;
      for (let i = 0; i < totalPixels; i++) {
        data[dstIdx++] = bytes[srcIdx++] ?? 0;
        data[dstIdx++] = bytes[srcIdx++] ?? 0;
        data[dstIdx++] = bytes[srcIdx++] ?? 0;
        data[dstIdx++] = 255;
      }
    } else if (format === 32) {
      data.set(bytes.subarray(0, width * height * 4));
    } else {
      return rawBase64;
    }

    ctx.putImageData(imgData, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1] ?? rawBase64;
  } catch (err) {
    console.error('[KittyGraphics] Failed to convert raw RGB/RGBA to PNG:', err);
    return rawBase64;
  }
}

/**
 * Ensure raw iTerm2 sequences have size=<bytes> parameter,
 * which @xterm/addon-image requires to allocate the decode buffer.
 */
function fixIterm2Size(data: string): string {
  if (!data.includes('\x1b]1337;File=')) return data;
  return data.replace(
    /\x1b\]1337;File=([^\x07\x1b:]*):([A-Za-z0-9+/=\s]+?)(\x07|\x1b\\)/g,
    (match, header: string, b64: string, term: string) => {
      if (!header.includes('size=')) {
        const cleanB64 = b64.replace(/\s+/g, '');
        const padding = cleanB64.endsWith('==') ? 2 : cleanB64.endsWith('=') ? 1 : 0;
        const byteSize = Math.max(1, Math.floor((cleanB64.length * 3) / 4) - padding);
        return `\x1b]1337;File=size=${byteSize};${header}:${b64}${term}`;
      }
      return match;
    }
  );
}

export function getPngDimensions(b64: string): { width: number; height: number } | null {
  try {
    const bin = atob(b64.slice(0, 44));
    if (
      bin.charCodeAt(0) === 0x89 &&
      bin.charCodeAt(1) === 0x50 &&
      bin.charCodeAt(2) === 0x4e &&
      bin.charCodeAt(3) === 0x47
    ) {
      const w =
        (bin.charCodeAt(16) << 24) |
        (bin.charCodeAt(17) << 16) |
        (bin.charCodeAt(18) << 8) |
        bin.charCodeAt(19);
      const h =
        (bin.charCodeAt(20) << 24) |
        (bin.charCodeAt(21) << 16) |
        (bin.charCodeAt(22) << 8) |
        bin.charCodeAt(23);
      if (w > 0 && h > 0) return { width: w, height: h };
    }
  } catch {}
  return null;
}

export class KittyProtocolHandler {
  private inApc = false;
  private apcBuffer = '';
  private pendingEsc = false;
  private pendingApcEsc = false;
  private chunkPayload = '';
  private currentControls: Record<string, string> = {};
  private storedImages = new Map<string, KittyImageRecord>();

  constructor(
    private sendToTerminal: (data: string) => void,
    private sendToServer: (data: string) => void,
    private getCellSize?: () => { width: number; height: number }
  ) {}

  public process(data: string) {
    let i = 0;
    while (i < data.length) {
      if (this.pendingEsc) {
        this.pendingEsc = false;
        if (data[i] === '_') {
          this.inApc = true;
          this.apcBuffer = '';
          this.pendingApcEsc = false;
          i++;
          continue;
        } else {
          this.sendToTerminal('\x1b');
        }
      }

      if (!this.inApc) {
        const escIdx = data.indexOf('\x1b', i);
        if (escIdx === -1) {
          this.sendToTerminal(fixIterm2Size(data.slice(i)));
          break;
        }

        if (escIdx > i) {
          this.sendToTerminal(fixIterm2Size(data.slice(i, escIdx)));
        }

        if (escIdx === data.length - 1) {
          this.pendingEsc = true;
          break;
        }

        if (data[escIdx + 1] === '_') {
          this.inApc = true;
          this.apcBuffer = '';
          this.pendingApcEsc = false;
          i = escIdx + 2;
        } else {
          this.sendToTerminal(fixIterm2Size('\x1b' + data[escIdx + 1]));
          i = escIdx + 2;
        }
      } else {
        // Inside APC sequence
        // Check if an ESC was pending from the end of the previous chunk
        if (this.pendingApcEsc) {
          this.pendingApcEsc = false;
          if (data[i] === '\\') {
            // String Terminator matched across chunk boundary!
            this.handleApc(this.apcBuffer);
            this.inApc = false;
            this.apcBuffer = '';
            i++;
            continue;
          } else {
            this.apcBuffer += '\x1b';
          }
        }

        // Scan for terminator ST (\x1b\) or BEL (\x07)
        let endIdx = -1;
        let termLen = 0;

        for (let j = i; j < data.length; j++) {
          if (data[j] === '\x07') {
            endIdx = j;
            termLen = 1;
            break;
          }
          if (data[j] === '\x1b') {
            if (j + 1 < data.length) {
              if (data[j + 1] === '\\') {
                endIdx = j;
                termLen = 2;
                break;
              }
            } else {
              // ESC is at the very end of chunk, wait for next chunk
              this.apcBuffer += data.slice(i, j);
              this.pendingApcEsc = true;
              i = data.length;
              break;
            }
          }
        }

        if (endIdx !== -1) {
          this.apcBuffer += data.slice(i, endIdx);
          this.handleApc(this.apcBuffer);
          this.inApc = false;
          this.apcBuffer = '';
          i = endIdx + termLen;
        } else if (i < data.length) {
          this.apcBuffer += data.slice(i);
          break;
        }
      }
    }
  }

  private handleApc(content: string) {
    if (!content.startsWith('G')) {
      // Not Kitty graphics, pass through to terminal
      this.sendToTerminal('\x1b_' + content + '\x1b\\');
      return;
    }

    const payloadIdx = content.indexOf(';');
    const controlStr = payloadIdx === -1 ? content.slice(1) : content.slice(1, payloadIdx);
    const chunkPayload = payloadIdx === -1 ? '' : content.slice(payloadIdx + 1);

    const controls: Record<string, string> = {};
    for (const part of controlStr.split(',')) {
      const eq = part.indexOf('=');
      if (eq !== -1) {
        controls[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      }
    }

    // 1. Check if Query action: a=q
    if (controls.a === 'q') {
      const id = controls.i || '0';
      this.sendToServer(`\x1b_Gi=${id};OK\x1b\\`);
      return;
    }

    // 2. Chunk assembly: m=1 indicates more chunks to follow
    const m = controls.m || '0';
    if (m === '1') {
      if (!this.chunkPayload) {
        this.currentControls = controls;
      }
      this.chunkPayload += chunkPayload;
      return;
    }

    // Final chunk (m=0 or omitted)
    const allControls = this.chunkPayload ? { ...this.currentControls, ...controls } : controls;
    const finalPayload = this.chunkPayload + chunkPayload;
    this.chunkPayload = '';
    this.currentControls = {};

    const action = allControls.a || 'T';
    const imageId = allControls.i || '';
    const format = parseInt(allControls.f || '100', 10);
    const s = parseInt(allControls.s || '0', 10);
    const v = parseInt(allControls.v || '0', 10);
    const c = parseInt(allControls.c || '0', 10);
    const r = parseInt(allControls.r || '0', 10);

    // If an image ID was specified and quiet mode (q=1/2) was not requested,
    // send the Kitty protocol completion acknowledgment
    if (imageId && allControls.q !== '1' && allControls.q !== '2') {
      this.sendToServer(`\x1b_Gi=${imageId};OK\x1b\\`);
    }

    if (action === 't') {
      // Transmit only - store image
      this.storedImages.set(imageId || '0', {
        payload: finalPayload,
        format,
        width: s,
        height: v,
        cols: c,
        rows: r
      });
      return;
    }

    if (action === 'd') {
      // Delete
      if (imageId) this.storedImages.delete(imageId);
      return;
    }

    if (action === 'p') {
      // Place previously stored image
      const stored = this.storedImages.get(imageId || '0');
      if (stored) {
        const targetCols = c || stored.cols;
        const targetRows = r || stored.rows;
        this.renderImage(stored.payload, stored.width, stored.height, stored.format, targetCols, targetRows);
      }
      return;
    }

    if (action === 'T') {
      // Transmit and display immediately
      this.renderImage(finalPayload, s, v, format, c, r);
    }
  }

  private renderImage(
    base64Data: string,
    width: number,
    height: number,
    format: number,
    cols: number,
    rows: number
  ) {
    if (!base64Data) return;
    const pngBase64 = rawToPngBase64(base64Data, width, height, format);

    const padding = pngBase64.endsWith('==') ? 2 : pngBase64.endsWith('=') ? 1 : 0;
    const byteSize = Math.max(1, Math.floor((pngBase64.length * 3) / 4) - padding);

    let imgW = width;
    let imgH = height;
    if (!imgW || !imgH) {
      const dims = getPngDimensions(pngBase64);
      if (dims) {
        imgW = dims.width;
        imgH = dims.height;
      }
    }

    const cell = this.getCellSize ? this.getCellSize() : { width: 7.8, height: 17.5 };
    const cw = cell.width > 0 ? cell.width : 7.8;
    const ch = cell.height > 0 ? cell.height : 17.5;

    let fitCols = cols;
    let fitRows = rows;

    if (imgW > 0 && imgH > 0) {
      if (cols > 0 && rows > 0) {
        const boxW = cols * cw;
        const boxH = rows * ch;
        if (imgW / imgH > boxW / boxH) {
          fitCols = cols;
          fitRows = Math.max(1, Math.round((cols * cw * imgH) / (imgW * ch)));
        } else {
          fitRows = rows;
          fitCols = Math.max(1, Math.round((rows * ch * imgW) / (imgH * cw)));
        }
      } else if (cols > 0) {
        fitCols = cols;
        fitRows = Math.max(1, Math.round((cols * cw * imgH) / (imgW * ch)));
      } else if (rows > 0) {
        fitRows = rows;
        fitCols = Math.max(1, Math.round((rows * ch * imgW) / (imgH * cw)));
      }
    }

    let itermSeq = `\x1b]1337;File=inline=1;size=${byteSize};preserveAspectRatio=1`;
    if (fitCols > 0) itermSeq += `;width=${fitCols}`;
    if (fitRows > 0) itermSeq += `;height=${fitRows}`;
    itermSeq += `:${pngBase64}\x07`;

    this.sendToTerminal(itermSeq);
  }
}

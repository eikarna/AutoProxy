// Fake raw-TCP socket for testing the checker without workerd.
// `onWrite(chunk, push, writes)` runs on every write; push(bytes[, close])
// feeds bytes back into the readable side.
export function fakeSocket(onWrite) {
  let controller;
  const readable = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  const writes = [];
  const push = (bytes, close = false) => {
    controller.enqueue(Uint8Array.from(bytes));
    if (close) controller.close();
  };
  const writer = {
    write: async (chunk) => {
      writes.push(Uint8Array.from(chunk));
      await onWrite(chunk, push, writes);
    },
    close: async () => {},
    releaseLock: () => {},
  };
  return {
    readable,
    writable: { getWriter: () => writer },
    close: () => {
      try {
        controller.close();
      } catch {
        /* noop */
      }
    },
  };
}

export const HTTP_OK_HEAD = 'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n';
export const HTTP_400_HEAD = 'HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n';

export const SOCKS5_GREET_OK = [0x05, 0x00];
export const SOCKS5_GREET_NO_METHOD = [0x05, 0xff];
export const SOCKS5_CONN_OK = [0x05, 0x00, 0x00, 0x01, 1, 2, 3, 4, 0, 80];
export const SOCKS5_CONN_REFUSED = [0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0];
export const SOCKS4_GRANT = [0x00, 0x5a, 0, 80, 1, 2, 3, 4];
export const SOCKS4_REJECT = [0x00, 0x5b, 0, 80, 0, 0, 0, 0];

export const enc = (s) => new TextEncoder().encode(s);

// A proxy that completes the given protocol flow and answers the probe with head.
export function protocolProxy(head = HTTP_OK_HEAD) {
  return fakeSocket(async (chunk, push, writes) => {
    const first = writes[0][0];
    if (first === 0x05) {
      // SOCKS5
      if (writes.length === 1) push(SOCKS5_GREET_OK);
      else if (writes.length === 2) push(SOCKS5_CONN_OK);
      else push(enc(head), true);
    } else if (first === 0x04) {
      // SOCKS4
      if (writes.length === 1) push(SOCKS4_GRANT);
      else push(enc(head), true);
    } else {
      // HTTP absolute-form
      push(enc(head), true);
    }
  });
}
